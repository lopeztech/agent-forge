// DynamoDB-backed wait list for Dev area-lock contention.
//
// Per CLAUDE.md → Concurrency model and the 2026-05-25 "Sweeper Lambda
// lookup" decision: when Dev tries to acquire an area lock and finds it
// held, it writes a row here and exits cleanly (issue stays at
// state:ready). When the holding Dev later releases the lock, an
// `area-lock-released` EventBridge event fires the sweeper Lambda, which
// picks the oldest waiter for that area and re-triggers Dev for it.
//
// Schema notes:
//
//   PK = product_id
//   SK = "<area_id>#<created_at_iso>#<issue_number>"
//
// The SK shape makes "find oldest waiter for area X on product P" a
// partition Query with `begins_with(SK, "X#")`, sorted ascending — first
// item is the oldest. Lexicographic ordering of ISO timestamps matches
// chronological ordering.
//
// Idempotency: re-firing Dev on the same (product, area, issue) writes the
// same SK (or a new one only differing by a milliseconds-precision
// created_at). The TTL prunes leftovers; benign double-waiters are
// dequeued in FIFO order anyway.

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _ddb: DynamoDBDocumentClient | undefined;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  }
  return _ddb;
}

// SK encoding. Pure so callers can unit-test the round-trip without DDB.
export function buildAreaWaiterId(
  areaId: string,
  createdAtIso: string,
  issueNumber: number,
): string {
  return `${areaId}#${createdAtIso}#${issueNumber}`;
}

export type ParsedAreaWaiterId = {
  areaId: string;
  createdAtIso: string;
  issueNumber: number;
};

export function parseAreaWaiterId(sk: string): ParsedAreaWaiterId | undefined {
  // Split into exactly three parts. ISO timestamps contain ':' but not '#',
  // and the area_id format is constrained to non-# names by areas.yml
  // conventions, so a plain split on '#' is unambiguous.
  const parts = sk.split("#");
  if (parts.length !== 3) return undefined;
  const [areaId, createdAtIso, issueNumStr] = parts;
  if (!areaId || !createdAtIso || !issueNumStr) return undefined;
  const issueNumber = Number(issueNumStr);
  if (!Number.isFinite(issueNumber)) return undefined;
  return { areaId, createdAtIso, issueNumber };
}

export type AddWaiterOpts = {
  tableName: string;
  productId: string;
  areaId: string;
  issueNumber: number;
  // Repo's GitHub `owner/name`. The sweeper builds the synthetic SF input
  // from this so we don't need to re-look-it-up.
  repo: string;
  // For audit + the SF input shape (mimics webhook delivery_id).
  deliveryId?: string;
  // Self-clean stale rows. Matches Dev's wall-clock cap (~2h).
  ttlSeconds: number;
  now?: Date;
};

export type Waiter = {
  productId: string;
  areaId: string;
  createdAtIso: string;
  issueNumber: number;
  repo: string;
  deliveryId?: string;
  expiresAt: number;
};

export async function addWaiter(opts: AddWaiterOpts): Promise<Waiter> {
  if (opts.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be greater than zero");
  }
  const now = opts.now ?? new Date();
  const createdAtIso = now.toISOString();
  const expiresAt = Math.floor(now.getTime() / 1000) + opts.ttlSeconds;
  const sk = buildAreaWaiterId(opts.areaId, createdAtIso, opts.issueNumber);

  await ddb().send(
    new PutCommand({
      TableName: opts.tableName,
      Item: {
        product_id: opts.productId,
        area_waiter_id: sk,
        area_id: opts.areaId,
        issue_number: opts.issueNumber,
        repo: opts.repo,
        ...(opts.deliveryId ? { delivery_id: opts.deliveryId } : {}),
        created_at: createdAtIso,
        expires_at: expiresAt,
      },
    }),
  );

  const w: Waiter = {
    productId: opts.productId,
    areaId: opts.areaId,
    createdAtIso,
    issueNumber: opts.issueNumber,
    repo: opts.repo,
    expiresAt,
  };
  if (opts.deliveryId !== undefined) {
    w.deliveryId = opts.deliveryId;
  }
  return w;
}

export type FindOldestWaiterOpts = {
  tableName: string;
  productId: string;
  areaId: string;
  // Items with expires_at <= nowEpoch are filtered out — DDB's TTL purge
  // is best-effort within ~48h, so the sweeper must defensively skip
  // expired rows itself.
  now?: Date;
};

// Returns the oldest non-expired waiter for (productId, areaId). Returns
// undefined when the wait list is empty.
export async function findOldestWaiter(
  opts: FindOldestWaiterOpts,
): Promise<Waiter | undefined> {
  const now = opts.now ?? new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);

  const r = await ddb().send(
    new QueryCommand({
      TableName: opts.tableName,
      KeyConditionExpression:
        "product_id = :p AND begins_with(area_waiter_id, :prefix)",
      FilterExpression: "expires_at > :now",
      ExpressionAttributeValues: {
        ":p": opts.productId,
        ":prefix": `${opts.areaId}#`,
        ":now": nowEpoch,
      },
      // Oldest first.
      ScanIndexForward: true,
      // We only need one. Paginate-safe because each (PK, SK begins_with)
      // shard ordering is preserved; FilterExpression may drop the first
      // page entirely if everything's expired, so the caller pages too if
      // it gets undefined on the first response with a LastEvaluatedKey.
      Limit: 1,
    }),
  );

  const item = r.Items?.[0];
  if (!item) return undefined;

  const parsed = parseAreaWaiterId(String(item["area_waiter_id"]));
  if (!parsed) return undefined;

  const w: Waiter = {
    productId: opts.productId,
    areaId: parsed.areaId,
    createdAtIso: parsed.createdAtIso,
    issueNumber: parsed.issueNumber,
    repo: String(item["repo"] ?? ""),
    expiresAt: Number(item["expires_at"] ?? 0),
  };
  if (item["delivery_id"] !== undefined) {
    w.deliveryId = String(item["delivery_id"]);
  }
  return w;
}

export type RemoveWaiterOpts = {
  tableName: string;
  productId: string;
  areaId: string;
  createdAtIso: string;
  issueNumber: number;
};

// Idempotent: tolerates a missing row (no ConditionExpression). The
// sweeper calls this after StartExecution succeeds; if two sweeper runs
// race the same waiter, only one wins the SF start but both Delete are
// benign.
export async function removeWaiter(opts: RemoveWaiterOpts): Promise<void> {
  const sk = buildAreaWaiterId(
    opts.areaId,
    opts.createdAtIso,
    opts.issueNumber,
  );
  await ddb().send(
    new DeleteCommand({
      TableName: opts.tableName,
      Key: {
        product_id: opts.productId,
        area_waiter_id: sk,
      },
    }),
  );
}
