// Budget circuit-breaker. Every role's pre-flight check calls
// `checkBudgetCaps` after the per-issue cap check it already does, and
// short-circuits with a park comment if any of the four scopes is over.
//
// Per CLAUDE.md → Cost model and the resolved "Failure handling" decisions:
//
//   - Per-issue cap:  $12 default (caller still owns this — kept where it
//                     was for ease of reading).
//   - Per-role/day:   $30 default. Scoped to one (product, role) on a UTC day.
//   - Per-product/d:  $75 default. Sum across all roles for one product.
//   - Global/day:     $250 default. Sum across all products.
//
// Caps are read from the products row (per-product override) and from the
// `products["*"]` row (global). When a scope exceeds its cap, a trip flag
// is written to the relevant products row with `budget_tripped_*` fields
// (per the 2026-05-25 design decision; flags live on products to avoid a
// new DDB table). Subsequent runs hit the flag and short-circuit without
// recomputing the rollup.
//
// Flags reset implicitly: each flag carries `budget_tripped_for_date`
// (YYYY-MM-DD UTC). Pre-flight ignores flags whose `for_date` isn't today,
// so the cap resets at UTC midnight by design. To clear early, a human
// deletes the field (CLI command landing in a later slice).
//
// Global daily compute is intentionally NOT performed at pre-flight (would
// require scanning all products). The global flag is set externally by a
// scheduled daily rollup Lambda — yet to land. For now, the global flag is
// honored when present but never written from the role pre-flight path.

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { getSpendTodayUsd, utcDayFor } from "../budget.ts";
import { getProduct, type ProductConfig } from "../state/products.ts";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _ddb: DynamoDBDocumentClient | undefined;
function ddb(): DynamoDBDocumentClient {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  }
  return _ddb;
}

// `products["*"]` is the org-global row (mirrors the team_memory convention
// from CLAUDE.md → Cross-product memory).
export const GLOBAL_PRODUCT_ID = "*";

export const DEFAULT_PER_ROLE_DAILY_CAP_USD = 30;
export const DEFAULT_PER_PRODUCT_DAILY_CAP_USD = 75;
export const DEFAULT_GLOBAL_DAILY_CAP_USD = 250;

export type BudgetScope = "role" | "product" | "global";

export type BudgetTrip = {
  scope: BudgetScope;
  capUsd: number;
  spentUsd: number;
  trippedAtIso: string;
  forDate: string;
  reason: string;
};

export type CheckBudgetCapsOpts = {
  productsTable: string;
  budgetLedgerTable: string;
  productId: string;
  role: string;
  // Pre-loaded products row (avoids a redundant Get — every role's pre-flight
  // already loads this).
  product: ProductConfig;
  now?: Date;
  // Test seam.
  ddbClient?: DynamoDBDocumentClient;
};

export type CheckBudgetCapsResult =
  | { ok: true }
  | { ok: false; trip: BudgetTrip };

// Pre-flight check. Returns `ok: false` with the tripping scope when any of
// the daily caps would be (or already has been) exceeded; caller posts a
// comment + parks the issue.
//
// Order of checks (cheapest first):
//   1. Existing flags on the products row (no DDB call beyond what's
//      already done).
//   2. Global flag on products["*"] (one Get).
//   3. Per-product daily rollup. Trips on overshoot.
//   4. Per-role daily rollup. Trips on overshoot.
export async function checkBudgetCaps(
  opts: CheckBudgetCapsOpts,
): Promise<CheckBudgetCapsResult> {
  const now = opts.now ?? new Date();
  const day = utcDayFor(now);

  // 1. Flags already on this product (no Get — caller passed it in).
  const productFlag = readProductFlag(opts.product, day.date);
  if (productFlag) return { ok: false, trip: productFlag };

  const roleFlag = readRoleFlag(opts.product, opts.role, day.date);
  if (roleFlag) return { ok: false, trip: roleFlag };

  // 2. Global flag — small extra Get.
  const globalRow = await getProduct({
    tableName: opts.productsTable,
    productId: GLOBAL_PRODUCT_ID,
  });
  if (globalRow) {
    const globalFlag = readProductFlag(globalRow, day.date, "global");
    if (globalFlag) return { ok: false, trip: globalFlag };
  }

  // 3. Per-product daily rollup.
  const productCap =
    opts.product.per_product_daily_budget_cap_usd ??
    DEFAULT_PER_PRODUCT_DAILY_CAP_USD;
  const productSpend = await getSpendTodayUsd({
    tableName: opts.budgetLedgerTable,
    productId: opts.productId,
    now,
  });
  if (productSpend >= productCap) {
    const trip: BudgetTrip = {
      scope: "product",
      capUsd: productCap,
      spentUsd: productSpend,
      trippedAtIso: now.toISOString(),
      forDate: day.date,
      reason: `Per-product daily spend reached cap: $${productSpend.toFixed(4)} ≥ $${productCap.toFixed(2)}`,
    };
    await writeProductTrip(opts.productsTable, opts.productId, trip);
    return { ok: false, trip };
  }

  // 4. Per-role daily rollup.
  const roleCap =
    opts.product.per_role_daily_budget_cap_usd ??
    DEFAULT_PER_ROLE_DAILY_CAP_USD;
  const roleSpend = await getSpendTodayUsd({
    tableName: opts.budgetLedgerTable,
    productId: opts.productId,
    role: opts.role,
    now,
  });
  if (roleSpend >= roleCap) {
    const trip: BudgetTrip = {
      scope: "role",
      capUsd: roleCap,
      spentUsd: roleSpend,
      trippedAtIso: now.toISOString(),
      forDate: day.date,
      reason: `Per-role daily spend reached cap for ${opts.role}: $${roleSpend.toFixed(4)} ≥ $${roleCap.toFixed(2)}`,
    };
    await writeRoleTrip(opts.productsTable, opts.productId, opts.role, trip);
    return { ok: false, trip };
  }

  return { ok: true };
}

// Read-helpers: turn a stored flag into a BudgetTrip if and only if it
// belongs to `today`. Older flags are ignored — caps reset daily.

function readProductFlag(
  row: ProductConfig,
  todayDate: string,
  scopeLabel: BudgetScope = "product",
): BudgetTrip | undefined {
  if (
    !row.budget_tripped_at_iso ||
    !row.budget_tripped_for_date ||
    row.budget_tripped_for_date !== todayDate
  ) {
    return undefined;
  }
  return {
    scope: scopeLabel,
    capUsd:
      scopeLabel === "global"
        ? (row.global_daily_budget_cap_usd ?? DEFAULT_GLOBAL_DAILY_CAP_USD)
        : (row.per_product_daily_budget_cap_usd ??
          DEFAULT_PER_PRODUCT_DAILY_CAP_USD),
    spentUsd: 0, // Not stored on the flag; the original trip's reason has the figure.
    trippedAtIso: row.budget_tripped_at_iso,
    forDate: row.budget_tripped_for_date,
    reason: row.budget_tripped_reason ?? `Pre-existing ${scopeLabel} trip`,
  };
}

function readRoleFlag(
  row: ProductConfig,
  role: string,
  todayDate: string,
): BudgetTrip | undefined {
  const entry = row.budget_tripped_roles?.[role];
  if (!entry || entry.for_date !== todayDate) return undefined;
  return {
    scope: "role",
    capUsd:
      row.per_role_daily_budget_cap_usd ?? DEFAULT_PER_ROLE_DAILY_CAP_USD,
    spentUsd: 0,
    trippedAtIso: entry.at_iso,
    forDate: entry.for_date,
    reason: entry.reason,
  };
}

// Write-helpers: idempotent UpdateItems on the products row.

async function writeProductTrip(
  tableName: string,
  productId: string,
  trip: BudgetTrip,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: tableName,
      Key: { product_id: productId },
      UpdateExpression:
        "SET budget_tripped_at_iso = :at, budget_tripped_for_date = :date, budget_tripped_reason = :reason",
      ExpressionAttributeValues: {
        ":at": trip.trippedAtIso,
        ":date": trip.forDate,
        ":reason": trip.reason,
      },
    }),
  );
}

async function writeRoleTrip(
  tableName: string,
  productId: string,
  role: string,
  trip: BudgetTrip,
): Promise<void> {
  // DynamoDB disallows setting a parent map AND a nested path in the same
  // expression ("Two document paths overlap"). Fix: initialise the map in a
  // separate conditional write, then set the role entry.
  const flag = {
    at_iso: trip.trippedAtIso,
    for_date: trip.forDate,
    reason: trip.reason,
  };
  try {
    // Attempt 1: parent map already exists → write only the role sub-path.
    await ddb().send(
      new UpdateCommand({
        TableName: tableName,
        Key: { product_id: productId },
        ConditionExpression: "attribute_exists(budget_tripped_roles)",
        UpdateExpression: "SET budget_tripped_roles.#role = :flag",
        ExpressionAttributeNames: { "#role": role },
        ExpressionAttributeValues: { ":flag": flag },
      }),
    );
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "name" in e &&
      (e as { name: string }).name === "ConditionalCheckFailedException"
    ) {
      // Parent map missing — create it with this role entry in one write.
      await ddb().send(
        new UpdateCommand({
          TableName: tableName,
          Key: { product_id: productId },
          UpdateExpression: "SET budget_tripped_roles = :map",
          ExpressionAttributeValues: { ":map": { [role]: flag } },
        }),
      );
    } else {
      throw e;
    }
  }
}

// Formatter for the comment a role posts on park. Caller's role-specific
// comment-formatter prepends its own header.
export function formatBudgetTripComment(trip: BudgetTrip): string {
  const scopeWords: Record<BudgetScope, string> = {
    role: "Per-role daily",
    product: "Per-product daily",
    global: "Global daily",
  };
  return [
    `${scopeWords[trip.scope]} budget cap tripped (for \`${trip.forDate}\` UTC).`,
    "",
    `**Cap:** $${trip.capUsd.toFixed(2)}`,
    trip.spentUsd > 0 ? `**Spent so far:** $${trip.spentUsd.toFixed(4)}` : "",
    "",
    trip.reason,
    "",
    "Park until a human clears the trip flag on the relevant `products` row, " +
      "or until the next UTC day (caps reset at midnight UTC).",
  ].filter((s) => s !== "").join("\n");
}
