// DynamoDB-backed Dev-role area locks.
//
// The architecture requires multi-area issues to acquire locks in alphabetical
// order so parallel Dev runs cannot deadlock. If any lock cannot be acquired,
// this helper releases the locks it already took and reports contention.

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
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
    _ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
    );
  }
  return _ddb;
}

let _eb: EventBridgeClient | undefined;
function eb(): EventBridgeClient {
  if (!_eb) _eb = new EventBridgeClient({ region: REGION });
  return _eb;
}

// Phase C — when the sweeper Lambda is wired (release fires an
// `area-lock-released` EventBridge event per area, the sweeper picks the
// oldest waiter and re-fires Dev). No-op when env is unset (local dev).
const EVENT_BUS_NAME = process.env.AGENT_FORGE_EVENT_BUS_NAME;
const EVENT_SOURCE = "agent-forge.area-locks";
const EVENT_DETAIL_TYPE = "area-lock-released";

async function emitAreaLockReleased(
  productId: string,
  areaId: string,
): Promise<void> {
  if (!EVENT_BUS_NAME) return;
  try {
    await eb().send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: EVENT_BUS_NAME,
            Source: EVENT_SOURCE,
            DetailType: EVENT_DETAIL_TYPE,
            Detail: JSON.stringify({
              product_id: productId,
              area_id: areaId,
              released_at: new Date().toISOString(),
            }),
          },
        ],
      }),
    );
  } catch (err) {
    // Best-effort. A missed event means the next Dev attempt on this
    // product/area will be triggered by some other mechanism (next
    // webhook, manual re-fire, or the TTL on the waiter row eventually
    // pruning it). Failing the release call is much worse — the lock
    // would stay held until DDB TTL purges it.
    console.warn(
      JSON.stringify({
        msg: "area-lock-released PutEvents failed (non-fatal)",
        product_id: productId,
        area_id: areaId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

export type AreaLockRequest = {
  tableName: string;
  productId: string;
  areaIds: string[];
  ownerId: string;
  ttlSeconds: number;
  allAreaIds?: string[];
  now?: Date;
};

export type AreaLockLease = {
  productId: string;
  areaIds: string[];
  ownerId: string;
  acquiredAt: string;
  expiresAt: number;
  release(): Promise<void>;
};

export type AreaLockAcquireResult =
  | { acquired: true; lease: AreaLockLease }
  | { acquired: false; blockedAreaId: string };

export function normalizeAreaIds(
  areaIds: string[],
  allAreaIds?: string[],
): string[] {
  const wantsGlobal = areaIds.includes("*");
  const selected = wantsGlobal ? allAreaIds : areaIds;

  if (!selected || selected.length === 0) {
    throw new Error(
      wantsGlobal
        ? "area:* lock acquisition requires allAreaIds"
        : "at least one area id is required",
    );
  }

  return [...new Set(selected)].sort((a, b) => a.localeCompare(b));
}

export async function acquireAreaLocks(
  opts: AreaLockRequest,
): Promise<AreaLockAcquireResult> {
  if (opts.ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be greater than zero");
  }

  const areaIds = normalizeAreaIds(opts.areaIds, opts.allAreaIds);
  const now = opts.now ?? new Date();
  const nowEpoch = Math.floor(now.getTime() / 1000);
  const expiresAt = nowEpoch + opts.ttlSeconds;
  const acquired: string[] = [];

  for (const areaId of areaIds) {
    try {
      await ddb().send(
        new PutCommand({
          TableName: opts.tableName,
          Item: {
            product_id: opts.productId,
            area_id: areaId,
            owner_id: opts.ownerId,
            acquired_at: now.toISOString(),
            expires_at: expiresAt,
          },
          ConditionExpression:
            "(attribute_not_exists(product_id) AND attribute_not_exists(area_id)) OR expires_at < :now",
          ExpressionAttributeValues: {
            ":now": nowEpoch,
          },
        }),
      );
      acquired.push(areaId);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        await releaseAreaLocks({
          tableName: opts.tableName,
          productId: opts.productId,
          areaIds: acquired,
          ownerId: opts.ownerId,
        });
        return { acquired: false, blockedAreaId: areaId };
      }

      await releaseAreaLocks({
        tableName: opts.tableName,
        productId: opts.productId,
        areaIds: acquired,
        ownerId: opts.ownerId,
      });
      throw err;
    }
  }

  return {
    acquired: true,
    lease: {
      productId: opts.productId,
      areaIds,
      ownerId: opts.ownerId,
      acquiredAt: now.toISOString(),
      expiresAt,
      release: () =>
        releaseAreaLocks({
          tableName: opts.tableName,
          productId: opts.productId,
          areaIds,
          ownerId: opts.ownerId,
        }),
    },
  };
}

export type ReleaseAreaLocksRequest = {
  tableName: string;
  productId: string;
  areaIds: string[];
  ownerId: string;
};

export async function releaseAreaLocks(
  opts: ReleaseAreaLocksRequest,
): Promise<void> {
  await Promise.all(
    normalizeAreaIds(opts.areaIds).map(async (areaId) => {
      let released = false;
      try {
        await ddb().send(
          new DeleteCommand({
            TableName: opts.tableName,
            Key: {
              product_id: opts.productId,
              area_id: areaId,
            },
            ConditionExpression: "owner_id = :ownerId",
            ExpressionAttributeValues: {
              ":ownerId": opts.ownerId,
            },
          }),
        );
        released = true;
      } catch (err) {
        if (!isConditionalCheckFailed(err)) {
          throw err;
        }
        // Conditional-check fail: another owner holds the lock (or it's
        // already gone via TTL). Don't emit — there's no genuine
        // transition for waiters to act on.
      }
      if (released) {
        // Sweeper Lambda subscribes to these and re-fires Dev for the
        // oldest waiter on this (product, area).
        await emitAreaLockReleased(opts.productId, areaId);
      }
    }),
  );
}

function isConditionalCheckFailed(
  err: unknown,
): err is ConditionalCheckFailedException {
  return (
    err instanceof ConditionalCheckFailedException ||
    (typeof err === "object" &&
      err !== null &&
      "name" in err &&
      err.name === "ConditionalCheckFailedException")
  );
}

// Read-only listing. Used by the ops CLI's `status product` drill-down to
// surface which areas are currently held + who owns them. Filters out
// rows whose TTL has effectively expired (DDB's TTL purge runs within
// ~48h; this layer is defensive).
export type HeldAreaLock = {
  productId: string;
  areaId: string;
  ownerId: string;
  acquiredAt: string;
  expiresAt: number;
};

export async function listHeldAreaLocks(opts: {
  tableName: string;
  productId: string;
  now?: Date;
}): Promise<HeldAreaLock[]> {
  const nowEpoch = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const out: HeldAreaLock[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: opts.tableName,
        KeyConditionExpression: "product_id = :p",
        FilterExpression: "expires_at > :now",
        ExpressionAttributeValues: {
          ":p": opts.productId,
          ":now": nowEpoch,
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      out.push({
        productId: opts.productId,
        areaId: String(item["area_id"] ?? ""),
        ownerId: String(item["owner_id"] ?? ""),
        acquiredAt: String(item["acquired_at"] ?? ""),
        expiresAt: Number(item["expires_at"] ?? 0),
      });
    }
    exclusiveStartKey = r.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;
  } while (exclusiveStartKey);
  return out;
}
