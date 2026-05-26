// Shared helpers for the products DynamoDB table.
//
// products is the source of truth for target-repo configuration: GitHub App
// installation IDs, spec paths, budget thresholds, and runtime knobs.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
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

export type FunctionalRuntimeMode = "ephemeral" | "warm";

export type ProductConfig = {
  product_id: string;
  repo_full_name: string;
  repo_url?: string;
  writer_install_id?: string;
  merger_install_id?: string;
  spec_path?: string;
  areas_path?: string;
  functional_runtime_mode?: FunctionalRuntimeMode;
  cost_approval_threshold_usd?: number;
  concurrency_cap?: number;
  // Per-attempt wall-clock cap for a Dev run. Doubles as the area-lock TTL when
  // Dev acquires (the lock-holder always has at most this long before the lock
  // self-releases via DynamoDB TTL). Defaults to 7200 (2h) at the agent layer.
  // Slice B.1 declares the field; B.3 wires it through to the Fargate task.
  dev_attempt_ttl_seconds?: number;
  // Shell command Dev runs to verify the change before `submit_done`. Falls
  // back to `npm test` when package.json is present, otherwise no-op (the
  // agent is told no tests are configured and may submit without running any).
  // Slice B.1 declares the field; B.3 wires it through to the agent loop.
  test_command?: string;
  // Shell command the code-pushing roles (Dev, Test) run *before* the test
  // command in their finalize gate. Falls back to `npm run typecheck` when
  // package.json declares a `typecheck` script, otherwise no-op. Catches
  // changes that pass tests but fail the repo's `tsc --noEmit` CI gate.
  typecheck_command?: string;
  // Per-issue hard spend cap in USD across all attempts (Dev role). Sum of
  // budget_ledger.cost_usd for this issue beyond this value parks the issue
  // at human-needed before the next model call. Default 12 USD per CLAUDE.md
  // → Cost model.
  per_issue_budget_cap_usd?: number;
  // Daily caps from CLAUDE.md → Cost model. Per-day = UTC midnight to UTC
  // midnight. When a scope's daily spend exceeds its cap, that scope's
  // budget_tripped_* fields are set and subsequent role runs short-circuit
  // until a human clears them (delete the field) or until the next UTC day.
  per_role_daily_budget_cap_usd?: number;       // default $30
  per_product_daily_budget_cap_usd?: number;    // default $75
  // Only honored on the `product_id="*"` row. Default $250.
  global_daily_budget_cap_usd?: number;
  // Trip flags. Set by shared/budget/caps.ts when a cap is exceeded; read
  // by the same module at pre-flight to short-circuit a role's run.
  //
  //   - Per-product flag: set on `products[product_id]`.
  //   - Per-role flag: set under `budget_tripped_roles[<role>]` on the
  //                    same products row.
  //   - Global flag: set on `products["*"]`.
  //
  // `for_date` is a YYYY-MM-DD UTC string. Old trip flags (different date)
  // are ignored — daily caps reset at UTC midnight by design.
  budget_tripped_at_iso?: string;
  budget_tripped_for_date?: string;
  budget_tripped_reason?: string;
  budget_tripped_roles?: Record<
    string,
    {
      at_iso: string;
      for_date: string;
      reason: string;
    }
  >;
  // When true, PO autonomously merges the PR on verdict=approve via the
  // merger App. When false (default), PO posts a "recommend approve"
  // comment and parks at human-needed for a human to merge. Per CLAUDE.md
  // → Human gates ("first 30 days of a new target repo, the PO step is a
  // Slack approval gate before merge, not autonomous merge"). Flip to true
  // per-product after observed merge accuracy is acceptable.
  auto_merge?: boolean;
  // Phase E approval gate. ISO timestamp; while now < this, PO behaves as
  // if auto_merge=false regardless of the flag's actual value, and posts
  // a Slack notification (when slack_webhook_url is set) instead of
  // silently parking at human-needed. Onboarding (scripts/seed-product.ts)
  // writes `now + 30d` per the 2026-05-25 design decision. To bypass the
  // gate early, set to a past ISO (or remove the field).
  approval_gate_until?: string;
  // Slack incoming-webhook URL the gate posts to on verdict=approve while
  // active. Unset = gate still skips auto-merge but no Slack notification
  // is sent.
  slack_webhook_url?: string;
  updated_at?: string;
};

export type GetProductOpts = {
  tableName: string;
  productId: string;
};

export async function getProduct(
  opts: GetProductOpts,
): Promise<ProductConfig | undefined> {
  const r = await ddb().send(
    new GetCommand({
      TableName: opts.tableName,
      Key: { product_id: opts.productId },
    }),
  );
  return r.Item as ProductConfig | undefined;
}

export async function requireProduct(
  opts: GetProductOpts,
): Promise<ProductConfig> {
  const product = await getProduct(opts);
  if (!product) {
    throw new Error(`No products row for product_id=${opts.productId}`);
  }
  return product;
}

export type ListProductsOpts = {
  tableName: string;
  // When true (default), skip the org-global row at product_id="*".
  excludeGlobal?: boolean;
};

// Scans the products table. Used by org-wide jobs (drift audit,
// scheduled rollups) that need to iterate every target product. Small
// table in practice (~1-10 rows in v1), so Scan is acceptable; revisit
// when products grow past ~100.
export async function listProducts(
  opts: ListProductsOpts,
): Promise<ProductConfig[]> {
  const excludeGlobal = opts.excludeGlobal !== false;
  const products: ProductConfig[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const r = await ddb().send(
      new ScanCommand({
        TableName: opts.tableName,
        ...(exclusiveStartKey ? { ExclusiveStartKey: exclusiveStartKey } : {}),
      }),
    );
    for (const item of r.Items ?? []) {
      const p = item as ProductConfig;
      if (excludeGlobal && p.product_id === "*") continue;
      products.push(p);
    }
    exclusiveStartKey = r.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (exclusiveStartKey);
  return products;
}

export type ResolveProductByRepoOpts = {
  tableName: string;
  repoIndexName: string;
  repoFullName: string;
};

export async function resolveProductByRepo(
  opts: ResolveProductByRepoOpts,
): Promise<ProductConfig | undefined> {
  const r = await ddb().send(
    new QueryCommand({
      TableName: opts.tableName,
      IndexName: opts.repoIndexName,
      KeyConditionExpression: "repo_full_name = :repo",
      ExpressionAttributeValues: { ":repo": opts.repoFullName },
      Limit: 1,
    }),
  );
  return r.Items?.[0] as ProductConfig | undefined;
}

export function requireWriterInstallId(
  product: ProductConfig,
): string {
  if (!product.writer_install_id) {
    throw new Error(`products[${product.product_id}] has no writer_install_id`);
  }
  return product.writer_install_id;
}

export function requireMergerInstallId(
  product: ProductConfig,
): string {
  if (!product.merger_install_id) {
    throw new Error(`products[${product.product_id}] has no merger_install_id`);
  }
  return product.merger_install_id;
}
