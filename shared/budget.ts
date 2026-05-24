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
