// Per-(product, role) team memory — lessons the agents accumulate over
// time. CLAUDE.md → Long-running concerns lists this as the headline
// feature that makes a months-long run cheaper than a one-shot.
//
// Schema (DDB `team_memory` table, declared in infra/modules/dynamodb):
//
//   PK product_id  — target product id, or "*" for org-global rows.
//   SK role_key    — "<role>#<key>" where key is a slug the agent picks.
//
// Reading conventions (2026-05-01 + 2026-05-25 decisions):
//
//   - Agents read `global UNION product`, with product winning on key
//     conflict. Lets a product override a global lesson and lets new
//     products inherit reasonable defaults.
//   - usage_count increments on every read by every role run (no
//     "cite_lesson" tool). Quietly noisy lessons get inflated counts
//     but recency-decay still degrades them.
//
// Writing conventions:
//
//   - Agents always write to their own product (PK = productId, never "*").
//     Promotion to global is a human-gated CLI operation (out of scope here).
//   - record_lesson tool carries a required `confidence` enum
//     (low | medium | high). Score formula uses {0.5, 0.75, 1.0}.
//   - On write, if (product, role) already has >= MAX_LESSONS_PER_SCOPE
//     lessons, evict the lowest-scored non-pinned lesson before write.
//
// Score: `recency_decay × usage_count × confidence`.
//
//   recency_decay = 2^(-age_days / HALF_LIFE_DAYS)
//
// A 90-day-old lesson with usage_count=10 and confidence=high scores 5;
// the same lesson a year later scores ~0.6. Pinned lessons never evict.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
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

export const GLOBAL_PRODUCT_ID = "*";
export const MAX_LESSONS_PER_SCOPE = 100;
export const HALF_LIFE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

export type Confidence = "low" | "medium" | "high";

export const CONFIDENCE_WEIGHT: Record<Confidence, number> = {
  low: 0.5,
  medium: 0.75,
  high: 1.0,
};

export type Lesson = {
  product_id: string;
  // SK: "<role>#<key>" — full DDB key. `role` and `key` below are the
  // parsed components, kept separate for ergonomic use.
  role_key: string;
  role: string;
  key: string;
  text: string;
  confidence: Confidence;
  created_at: string;
  usage_count: number;
  last_read?: string;
  pinned?: boolean;
  // Optional audit trail.
  written_by_role?: string;
  written_by_run_id?: string;
};

// Pure score function. Trivially testable; no DDB.
export function scoreLesson(lesson: Lesson, nowMs: number): number {
  const ageMs = nowMs - new Date(lesson.created_at).getTime();
  const ageDays = Math.max(0, ageMs / DAY_MS);
  const recencyDecay = Math.pow(2, -ageDays / HALF_LIFE_DAYS);
  const usage = Math.max(1, lesson.usage_count);
  const conf = CONFIDENCE_WEIGHT[lesson.confidence] ?? 0.5;
  return recencyDecay * usage * conf;
}

// Build the DDB SK from role + key. Pure.
export function roleKey(role: string, key: string): string {
  return `${role}#${key}`;
}

// Parse role + key from the SK. Returns undefined for malformed SKs.
export function parseRoleKey(
  sk: string,
): { role: string; key: string } | undefined {
  const i = sk.indexOf("#");
  if (i <= 0 || i === sk.length - 1) return undefined;
  return { role: sk.slice(0, i), key: sk.slice(i + 1) };
}

// Merge `global` ∪ `product` lessons. Product wins on key conflict.
// Returns the merged list keyed by `key` (per-role-scoped, so no
// cross-role aliasing). Pure.
export function mergeLessons(
  global: Lesson[],
  product: Lesson[],
): Lesson[] {
  const byKey = new Map<string, Lesson>();
  for (const l of global) byKey.set(l.key, l);
  for (const l of product) byKey.set(l.key, l); // product overrides
  return [...byKey.values()];
}

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

export type GetLessonsOpts = {
  tableName: string;
  productId: string;
  role: string;
  // When true (default), bump usage_count + last_read on every returned
  // lesson before returning. Fire-and-forget; doesn't block the read.
  bumpUsage?: boolean;
  now?: Date;
};

// Returns the merged set of lessons for (productId, role). Includes
// org-global rows (productId="*"); product rows win on key conflict.
//
// Each returned lesson has its `usage_count` and `last_read` updated
// asynchronously (fire-and-forget) before the function resolves — the
// caller sees the pre-bump count, but the next reader sees the bumped one.
export async function getLessons(opts: GetLessonsOpts): Promise<Lesson[]> {
  const [product, global] = await Promise.all([
    queryLessonsForScope(opts.tableName, opts.productId, opts.role),
    opts.productId === GLOBAL_PRODUCT_ID
      ? Promise.resolve([])
      : queryLessonsForScope(opts.tableName, GLOBAL_PRODUCT_ID, opts.role),
  ]);
  const merged = mergeLessons(global, product);

  if (opts.bumpUsage !== false && merged.length > 0) {
    const nowIso = (opts.now ?? new Date()).toISOString();
    // Don't await — usage updates are best-effort and shouldn't gate the run.
    // Errors are logged but never thrown.
    void Promise.all(
      merged.map((l) =>
        bumpUsageCount(opts.tableName, l.product_id, l.role_key, nowIso).catch(
          (err) => {
            console.warn(
              JSON.stringify({
                msg: "team_memory usage bump failed (non-fatal)",
                product_id: l.product_id,
                role_key: l.role_key,
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          },
        ),
      ),
    );
  }

  return merged;
}

async function queryLessonsForScope(
  tableName: string,
  productId: string,
  role: string,
): Promise<Lesson[]> {
  const out: Lesson[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression:
          "product_id = :p AND begins_with(role_key, :prefix)",
        ExpressionAttributeValues: {
          ":p": productId,
          ":prefix": `${role}#`,
        },
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      const lesson = itemToLesson(item);
      if (lesson) out.push(lesson);
    }
    exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return out;
}

async function bumpUsageCount(
  tableName: string,
  productId: string,
  roleKey: string,
  nowIso: string,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName,
      Key: { product_id: productId, role_key: roleKey },
      UpdateExpression:
        "SET usage_count = if_not_exists(usage_count, :zero) + :one, last_read = :now",
      ExpressionAttributeValues: {
        ":zero": 0,
        ":one": 1,
        ":now": nowIso,
      },
    }),
  );
}

// ----------------------------------------------------------------------------
// Writes
// ----------------------------------------------------------------------------

export type RecordLessonOpts = {
  tableName: string;
  productId: string;
  role: string;
  // Slug the agent picks. Reused across attempts to refine the same lesson.
  key: string;
  text: string;
  confidence: Confidence;
  runId?: string;
  pinned?: boolean;
  now?: Date;
};

export type RecordLessonResult = {
  lesson: Lesson;
  // Lesson key that was evicted to make room, if any.
  evicted?: { role: string; key: string };
};

// Idempotent: writing the same (product, role, key) overwrites the prior
// row's text + confidence + audit fields. usage_count + last_read are
// preserved across rewrites so a refined lesson keeps its momentum.
export async function recordLesson(
  opts: RecordLessonOpts,
): Promise<RecordLessonResult> {
  const now = opts.now ?? new Date();
  const sk = roleKey(opts.role, opts.key);

  // Eviction pass: if we're at the cap *for our scope* (productId, role),
  // evict the lowest-scored non-pinned lesson before writing. Cap is per
  // (product, role) only; global lessons live in their own (*, role) scope.
  const evicted = await maybeEvictForScope(
    opts.tableName,
    opts.productId,
    opts.role,
    sk,
    now,
  );

  // Use UpdateExpression so we don't clobber usage_count/last_read on
  // rewrite. attribute_not_exists initializes them on first write.
  const updateValues: Record<string, unknown> = {
    ":text": opts.text,
    ":conf": opts.confidence,
    ":created": now.toISOString(),
    ":zero": 0,
    ":pinned": opts.pinned ?? false,
  };
  let updateExpr =
    "SET #text = :text, confidence = :conf, " +
    "usage_count = if_not_exists(usage_count, :zero), " +
    "created_at = if_not_exists(created_at, :created), " +
    "pinned = :pinned";
  const exprNames: Record<string, string> = { "#text": "text" };
  if (opts.runId !== undefined) {
    updateExpr += ", written_by_run_id = :run";
    updateValues[":run"] = opts.runId;
  }
  updateExpr += ", written_by_role = :role";
  updateValues[":role"] = opts.role;

  await ddb().send(
    new UpdateCommand({
      TableName: opts.tableName,
      Key: { product_id: opts.productId, role_key: sk },
      UpdateExpression: updateExpr,
      ExpressionAttributeNames: exprNames,
      ExpressionAttributeValues: updateValues,
    }),
  );

  const lesson: Lesson = {
    product_id: opts.productId,
    role_key: sk,
    role: opts.role,
    key: opts.key,
    text: opts.text,
    confidence: opts.confidence,
    created_at: now.toISOString(),
    usage_count: 0,
    pinned: opts.pinned ?? false,
    written_by_role: opts.role,
  };
  if (opts.runId !== undefined) lesson.written_by_run_id = opts.runId;

  return evicted ? { lesson, evicted } : { lesson };
}

async function maybeEvictForScope(
  tableName: string,
  productId: string,
  role: string,
  newSk: string,
  now: Date,
): Promise<{ role: string; key: string } | undefined> {
  const existing = await queryLessonsForScope(tableName, productId, role);
  // If we're rewriting an existing row, no growth → no eviction.
  if (existing.some((l) => l.role_key === newSk)) return undefined;
  if (existing.length < MAX_LESSONS_PER_SCOPE) return undefined;

  const nowMs = now.getTime();
  const evictable = existing.filter((l) => !l.pinned);
  if (evictable.length === 0) {
    // Cap full but every lesson is pinned. The write still goes through
    // (caller's lesson takes us to cap+1); a future janitor pass will
    // either bump cap or unpin something. Don't fail the write.
    return undefined;
  }
  // Lowest-scored first.
  evictable.sort((a, b) => scoreLesson(a, nowMs) - scoreLesson(b, nowMs));
  const victim = evictable[0];
  if (!victim) return undefined;
  await ddb().send(
    new DeleteCommand({
      TableName: tableName,
      Key: { product_id: productId, role_key: victim.role_key },
    }),
  );
  return { role: victim.role, key: victim.key };
}

function itemToLesson(item: Record<string, unknown>): Lesson | undefined {
  const sk = String(item["role_key"] ?? "");
  const parsed = parseRoleKey(sk);
  if (!parsed) return undefined;
  const confidence = item["confidence"] as Confidence | undefined;
  if (confidence !== "low" && confidence !== "medium" && confidence !== "high") {
    return undefined;
  }
  const lesson: Lesson = {
    product_id: String(item["product_id"] ?? ""),
    role_key: sk,
    role: parsed.role,
    key: parsed.key,
    text: String(item["text"] ?? ""),
    confidence,
    created_at: String(item["created_at"] ?? new Date(0).toISOString()),
    usage_count: Number(item["usage_count"] ?? 0),
    pinned: Boolean(item["pinned"] ?? false),
  };
  if (item["last_read"] !== undefined) {
    lesson.last_read = String(item["last_read"]);
  }
  if (item["written_by_role"] !== undefined) {
    lesson.written_by_role = String(item["written_by_role"]);
  }
  if (item["written_by_run_id"] !== undefined) {
    lesson.written_by_run_id = String(item["written_by_run_id"]);
  }
  return lesson;
}
