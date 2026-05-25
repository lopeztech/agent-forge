// Token-bucket rate limiter backed by a single DynamoDB row.
//
// Per CLAUDE.md → Cost model and the 2026-05-25 "Bedrock rate-limit scope"
// decision, every Bedrock `InvokeModel` acquires a token from
// `(model_id, region)`-keyed buckets before invoking. The bucket is shared
// org-wide (no per-product fan-out); per-product fairness is enforced at the
// coarser per-day budget layer.
//
// Two complementary safeguards work together:
//
//   - This module: proactive throttle. Stops a burst before Bedrock returns
//     429, so the SDK's `adaptive` retry doesn't have to do as much.
//
//   - shared/models.ts Bedrock client: reactive retry (adaptive, 10
//     attempts). Handles whatever throttling slips through anyway.
//
// The math is a standard token bucket with lazy refill on read: at acquire
// time, compute `elapsed * rate` tokens to add (capped at capacity), then
// attempt to deduct via a conditional UpdateItem keyed on the previously-
// observed `last_refill_at_ms`. On conditional-check failure (another
// acquirer raced us), we retry up to MAX_RETRIES times before giving up.
//
// The pure math lives in `computeAcquire()` so it can be unit-tested without
// a DynamoDB mock; the I/O wrapper is `acquireToken()`.

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _ddb: DynamoDBDocumentClient | undefined;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  }
  return _ddb;
}

// How long a bucket row sticks around after its last touch before DDB's TTL
// purges it. 24h: long enough that a quiet bucket isn't constantly being
// recreated, short enough that stale capacity from a since-changed config
// gets cleaned out.
const BUCKET_TTL_SECONDS = 24 * 60 * 60;

const MAX_OPTIMISTIC_RETRIES = 5;

export type BucketState = {
  tokens: number;
  lastRefillAtMs: number;
};

export type BucketConfig = {
  // Maximum tokens the bucket holds. Burst capacity.
  capacity: number;
  // Refill rate. Steady-state throughput when the bucket is empty.
  refillPerSecond: number;
};

export type AcquireRequest = {
  state: BucketState;
  cfg: BucketConfig;
  tokensNeeded: number;
  nowMs: number;
};

export type AcquireOutcome =
  | { ok: true; newState: BucketState }
  | { ok: false; retryAfterMs: number };

// Pure: given the current bucket state and config, decide whether the
// requested tokens can be acquired right now and return the post-acquire
// state. No I/O; trivially testable.
//
// `retryAfterMs` on failure is "if you slept this long, the bucket would
// have refilled enough tokens for your request". Callers use it as the
// next-poll interval.
export function computeAcquire(req: AcquireRequest): AcquireOutcome {
  const elapsedMs = Math.max(0, req.nowMs - req.state.lastRefillAtMs);
  const refilled = (elapsedMs / 1000) * req.cfg.refillPerSecond;
  const tokensNow = Math.min(req.cfg.capacity, req.state.tokens + refilled);

  if (tokensNow >= req.tokensNeeded) {
    return {
      ok: true,
      newState: {
        tokens: tokensNow - req.tokensNeeded,
        lastRefillAtMs: req.nowMs,
      },
    };
  }

  const deficit = req.tokensNeeded - tokensNow;
  const retryAfterMs = Math.ceil((deficit / req.cfg.refillPerSecond) * 1000);
  return { ok: false, retryAfterMs };
}

export type AcquireTokenOpts = {
  tableName: string;
  bucketId: string;
  cfg: BucketConfig;
  tokensNeeded?: number;
  nowMs?: number;
};

export type AcquireTokenResult =
  | { acquired: true; tokensRemaining: number }
  | { acquired: false; retryAfterMs: number };

// Attempt to acquire `tokensNeeded` (default 1) from the bucket exactly once
// — no waiting. On contention with another acquirer (conditional-check
// failure), retries the read-and-update loop up to MAX_OPTIMISTIC_RETRIES
// times before surfacing failure.
//
// Bucket rows are created lazily: if the row doesn't exist, an attribute_not_
// exists PutItem seeds it with `capacity - tokensNeeded` tokens.
export async function acquireToken(
  opts: AcquireTokenOpts,
): Promise<AcquireTokenResult> {
  const tokensNeeded = opts.tokensNeeded ?? 1;
  if (tokensNeeded <= 0) {
    throw new Error("tokensNeeded must be > 0");
  }
  if (tokensNeeded > opts.cfg.capacity) {
    throw new Error(
      `tokensNeeded=${tokensNeeded} exceeds capacity=${opts.cfg.capacity}`,
    );
  }

  let attempt = 0;
  // Re-read on conditional-failure; bounded retries prevent a livelock from
  // sustained contention. In practice the outer wait-loop will catch any
  // sustained pressure as a "not acquired" anyway.
  while (attempt < MAX_OPTIMISTIC_RETRIES) {
    attempt++;
    const nowMs = opts.nowMs ?? Date.now();

    const got = await ddb().send(
      new GetCommand({
        TableName: opts.tableName,
        Key: { bucket_id: opts.bucketId },
        ConsistentRead: true,
      }),
    );

    if (!got.Item) {
      // First sighting — seed the bucket with full capacity minus this acquire.
      const seedTokens = opts.cfg.capacity - tokensNeeded;
      try {
        await ddb().send(
          new PutCommand({
            TableName: opts.tableName,
            Item: {
              bucket_id: opts.bucketId,
              tokens: seedTokens,
              last_refill_at_ms: nowMs,
              capacity: opts.cfg.capacity,
              refill_per_second: opts.cfg.refillPerSecond,
              expires_at: Math.floor(nowMs / 1000) + BUCKET_TTL_SECONDS,
            },
            ConditionExpression: "attribute_not_exists(bucket_id)",
          }),
        );
        return { acquired: true, tokensRemaining: seedTokens };
      } catch (err) {
        if (isConditionalCheckFailed(err)) {
          // Another worker seeded the bucket between our Get and Put.
          continue;
        }
        throw err;
      }
    }

    const state: BucketState = {
      tokens: Number(got.Item.tokens),
      lastRefillAtMs: Number(got.Item.last_refill_at_ms),
    };
    const outcome = computeAcquire({
      state,
      cfg: opts.cfg,
      tokensNeeded,
      nowMs,
    });
    if (!outcome.ok) {
      return { acquired: false, retryAfterMs: outcome.retryAfterMs };
    }

    try {
      await ddb().send(
        new UpdateCommand({
          TableName: opts.tableName,
          Key: { bucket_id: opts.bucketId },
          UpdateExpression:
            "SET tokens = :tokens, last_refill_at_ms = :now, expires_at = :exp",
          ConditionExpression: "last_refill_at_ms = :prev",
          ExpressionAttributeValues: {
            ":tokens": outcome.newState.tokens,
            ":now": outcome.newState.lastRefillAtMs,
            ":prev": state.lastRefillAtMs,
            ":exp": Math.floor(nowMs / 1000) + BUCKET_TTL_SECONDS,
          },
        }),
      );
      return { acquired: true, tokensRemaining: outcome.newState.tokens };
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        // Lost the race; another acquirer beat us to the update. Re-read.
        continue;
      }
      throw err;
    }
  }

  // Out of optimistic retries. Treat as a transient acquisition failure with
  // a short retry hint so the caller's wait-loop can have another go.
  return { acquired: false, retryAfterMs: 100 };
}

export type AcquireTokenWaitingOpts = AcquireTokenOpts & {
  // Total time to spend waiting for the bucket to refill before giving up.
  // Capped at `maxWaitMs`; partial waits between polls are capped at
  // `maxSleepMs` so the caller responds quickly when capacity opens.
  maxWaitMs: number;
  maxSleepMs?: number;
  // Test seam.
  sleep?: (ms: number) => Promise<void>;
};

// Wait up to `maxWaitMs` for a token to become available. Polls
// `acquireToken` and sleeps for the bucket's reported `retryAfterMs` between
// attempts. Returns the final acquire result; on timeout, returns `acquired:
// false` with the most-recent `retryAfterMs`.
export async function acquireTokenWaiting(
  opts: AcquireTokenWaitingOpts,
): Promise<AcquireTokenResult> {
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxSleepMs = opts.maxSleepMs ?? 5000;
  const deadlineMs = Date.now() + opts.maxWaitMs;

  // First try cheaply with no sleep — fast path when there's capacity.
  let result = await acquireToken(opts);
  while (!result.acquired && Date.now() < deadlineMs) {
    const sleepMs = Math.min(
      maxSleepMs,
      Math.max(50, result.retryAfterMs),
      deadlineMs - Date.now(),
    );
    if (sleepMs <= 0) break;
    await sleep(sleepMs);
    result = await acquireToken(opts);
  }
  return result;
}

function isConditionalCheckFailed(err: unknown): boolean {
  if (err instanceof ConditionalCheckFailedException) return true;
  if (
    err &&
    typeof err === "object" &&
    "name" in err &&
    (err as { name: string }).name === "ConditionalCheckFailedException"
  ) {
    return true;
  }
  return false;
}
