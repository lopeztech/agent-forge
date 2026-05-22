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
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
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
      } catch (err) {
        if (!isConditionalCheckFailed(err)) {
          throw err;
        }
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
