// Append-only spend writer for the budget_ledger table.
//
// Every model call across agent-forge logs here. The circuit breaker (per-issue,
// per-role-per-day, per-product-per-day, global) reads from this table; that
// read path lands in a later slice. This module is only the writer.
//
// SK shape `<iso_ts>#<run_id>` matches what BA's slice-A stub writes
// (agents/ba/src/index.ts:170), so daily/weekly rollups can Query on a SK
// BETWEEN range without an extra GSI.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _ddb: DynamoDBDocumentClient | undefined;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
    );
  }
  return _ddb;
}

export type SpendRecord = {
  product_id: string;
  issue_number: number;
  role: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
  note?: string;
};

export type RecordSpendOpts = {
  tableName: string;
  runId: string;
  spend: SpendRecord;
  timestamp?: Date;
};

export async function recordSpend(opts: RecordSpendOpts): Promise<void> {
  const ts = (opts.timestamp ?? new Date()).toISOString();
  await ddb().send(
    new PutCommand({
      TableName: opts.tableName,
      Item: {
        ...opts.spend,
        ts_run_id: `${ts}#${opts.runId}`,
      },
    }),
  );
}

export type GetIssueSpendOpts = {
  tableName: string;
  productId: string;
  issueNumber: number | string;
};

// Sums cost_usd across all budget_ledger rows for a single (product, issue).
//
// The table's PK is product_id, SK is `<iso_ts>#<run_id>`. There's no GSI on
// issue_number, so this is a partition Query with a FilterExpression. For
// products with thousands of historical rows this becomes a noticeable read;
// the long-term fix is a GSI on (product_id, issue_number). For Dev's pre-
// attempt budget-cap check this fires once per attempt, so the cost is
// acceptable today.
export async function getIssueSpendUsd(
  opts: GetIssueSpendOpts,
): Promise<number> {
  const issueNumberValue = Number(opts.issueNumber);
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: opts.tableName,
        KeyConditionExpression: "product_id = :p",
        FilterExpression: "issue_number = :i",
        ExpressionAttributeValues: {
          ":p": opts.productId,
          ":i": issueNumberValue,
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      const cost = item["cost_usd"];
      if (typeof cost === "number") total += cost;
    }
    exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return total;
}

// ----------------------------------------------------------------------------
// Day-range rollups
// ----------------------------------------------------------------------------
//
// The SK shape `<iso_ts>#<run_id>` lets us cheaply Query a partition for
// rows within a [start_iso, end_iso) window — both inclusive ts_run_id
// boundaries can be computed by appending sentinel suffixes to the ISO
// timestamp. We use this to compute today's spend per product (and per role
// within a product) without needing a GSI.
//
// Global daily rollup (across all products) isn't done here because it
// requires scanning the products table; today's pre-flight check stays
// per-(product, role) for cheapness, and global enforcement is via the trip
// flag (a scheduled rollup Lambda writes it).

export type DayUtc = {
  // YYYY-MM-DD in UTC.
  date: string;
  // ISO timestamp at 00:00:00.000Z.
  startIso: string;
  // ISO timestamp at the next UTC midnight (exclusive).
  endIso: string;
};

// Computes the UTC day for a given Date (or `new Date()`). UTC keeps daily
// caps deterministic across regions.
export function utcDayFor(d: Date = new Date()): DayUtc {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const date = `${y}-${m}-${dd}`;
  const startIso = `${date}T00:00:00.000Z`;
  const endDate = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() + 1));
  const endIso = endDate.toISOString();
  return { date, startIso, endIso };
}

export type GetSpendBetweenOpts = {
  tableName: string;
  productId: string;
  fromIso: string; // inclusive
  toIso: string; // exclusive
  // Optional role filter. When set, only rows where `role` matches accumulate.
  role?: string;
};

// Sum cost_usd for budget_ledger rows in [fromIso, toIso) for a product,
// optionally filtered by role. Uses the partition's SK BETWEEN to keep the
// scan tight; a role filter adds a FilterExpression. Paginates.
//
// SK format: `<iso_ts>#<run_id>`. We use the ISO timestamps directly as SK
// bounds — lexicographic ordering matches chronological ordering, and the
// suffix `#<run_id>` is irrelevant for BETWEEN bounds at day boundaries.
export async function getSpendBetweenUsd(
  opts: GetSpendBetweenOpts,
): Promise<number> {
  let total = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const expressionAttributeValues: Record<string, unknown> = {
      ":p": opts.productId,
      ":from": opts.fromIso,
      ":to": opts.toIso,
    };
    const queryParams: import("@aws-sdk/lib-dynamodb").QueryCommandInput = {
      TableName: opts.tableName,
      KeyConditionExpression:
        "product_id = :p AND ts_run_id BETWEEN :from AND :to",
      ExpressionAttributeValues: expressionAttributeValues,
    };
    if (opts.role) {
      expressionAttributeValues[":role"] = opts.role;
      queryParams.FilterExpression = "#r = :role";
      queryParams.ExpressionAttributeNames = { "#r": "role" };
    }
    if (exclusiveStartKey) queryParams.ExclusiveStartKey = exclusiveStartKey;

    const r = await ddb().send(new QueryCommand(queryParams));
    for (const item of r.Items ?? []) {
      const cost = item["cost_usd"];
      if (typeof cost === "number") total += cost;
    }
    exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return total;
}

export type SpendRow = SpendRecord & { ts: string; run_id: string };

// Read-only listing of every budget_ledger row for one (product, issue).
// Used by the ops CLI's `status pipeline` view to itemize spend per role
// attempt. Sorted chronologically (SK ascending).
export async function listSpendForIssue(
  opts: GetIssueSpendOpts,
): Promise<SpendRow[]> {
  const issueNumberValue = Number(opts.issueNumber);
  const out: SpendRow[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: opts.tableName,
        KeyConditionExpression: "product_id = :p",
        FilterExpression: "issue_number = :i",
        ExpressionAttributeValues: {
          ":p": opts.productId,
          ":i": issueNumberValue,
        },
        ScanIndexForward: true,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      const tsRun = String(item["ts_run_id"] ?? "");
      const hashIdx = tsRun.indexOf("#");
      const ts = hashIdx > 0 ? tsRun.slice(0, hashIdx) : tsRun;
      const runId = hashIdx > 0 ? tsRun.slice(hashIdx + 1) : "";
      out.push({
        product_id: String(item["product_id"] ?? ""),
        issue_number: Number(item["issue_number"] ?? 0),
        role: String(item["role"] ?? ""),
        model: String(item["model"] ?? ""),
        input_tokens: Number(item["input_tokens"] ?? 0),
        cached_tokens: Number(item["cached_tokens"] ?? 0),
        output_tokens: Number(item["output_tokens"] ?? 0),
        cost_usd: Number(item["cost_usd"] ?? 0),
        ts,
        run_id: runId,
        ...(item["note"] !== undefined ? { note: String(item["note"]) } : {}),
      });
    }
    exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return out;
}

export type GetSpendTodayOpts = {
  tableName: string;
  productId: string;
  role?: string;
  now?: Date;
};

// Convenience wrapper: today's spend for a (product, [role]) scope.
export async function getSpendTodayUsd(
  opts: GetSpendTodayOpts,
): Promise<number> {
  const day = utcDayFor(opts.now ?? new Date());
  return getSpendBetweenUsd({
    tableName: opts.tableName,
    productId: opts.productId,
    fromIso: day.startIso,
    toIso: day.endIso,
    ...(opts.role ? { role: opts.role } : {}),
  });
}
