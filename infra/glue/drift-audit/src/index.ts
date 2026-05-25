// Drift audit Lambda — Phase D2 of the engine-completion plan.
//
// Trigger: EventBridge Scheduler, weekly (default Monday 09:00 UTC per
// infra/envs/<env>/drift-audit.tf).
//
// Job, per product:
//   1. Read current spec/ from the target repo via GitHub.
//   2. Query issue_state for up to N=5 recently-done issues that have
//      spec_hashes_at_merge stored.
//   3. For each, diff current vs stored hashes. On drift, file a new
//      state:idea issue describing what changed under the shipped issue.
//
// Configurable per-product:
//   products[product_id].drift_audit_sample_size      default 5
//   products[product_id].drift_audit_horizon_days     default 90
// (Not wired through products row yet; v1 uses the constants below.)
//
// Failure modes:
//   - Listing products fails → fail the whole run (caught by Lambda runtime,
//     EventBridge retries default).
//   - Per-product failure → logged, but the loop continues to the next product.
//   - GitHub or DDB transient errors → logged; that product is skipped this
//     week, picked up next week.

import type { ScheduledEvent } from "aws-lambda";

import { getInstallationTokenFromSecret } from "../../../../shared/github/auth.ts";
import {
  createIssue,
  type RequestOptions,
} from "../../../../shared/github/repo.ts";
import { readSpecTree } from "../../../../shared/github/spec.ts";
import {
  diffSpecHashes,
  hasDrift,
  hashSpecTree,
  type SpecHashDiff,
} from "../../../../shared/github/spec-hashes.ts";
import {
  listDoneIssuesWithSpecHashes,
  type IssueState,
} from "../../../../shared/state/issue-state.ts";
import {
  listProducts,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../../shared/state/products.ts";
import { requiredEnv } from "../../../../shared/env.ts";

const PRODUCTS_TABLE = requiredEnv("PRODUCTS_TABLE");
const ISSUE_STATE_TABLE = requiredEnv("ISSUE_STATE_TABLE");
const APP_SECRET_NAME = requiredEnv("APP_SECRET_NAME");

const DEFAULT_SAMPLE_SIZE = 5;
const DEFAULT_HORIZON_DAYS = 90;
const USER_AGENT = "agent-forge-drift-audit";

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ role: "drift-audit", ...obj }));
}

export async function handler(_event: ScheduledEvent): Promise<void> {
  log({ msg: "starting drift audit run" });

  const products = await listProducts({ tableName: PRODUCTS_TABLE });
  log({ msg: "loaded products", count: products.length });

  let totalIssuesChecked = 0;
  let totalIssuesDrifted = 0;
  let totalIssuesFiled = 0;

  for (const product of products) {
    try {
      const r = await auditProduct(product);
      totalIssuesChecked += r.checked;
      totalIssuesDrifted += r.drifted;
      totalIssuesFiled += r.filed;
    } catch (err) {
      log({
        msg: "product audit failed (non-fatal); will retry next week",
        product_id: product.product_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({
    msg: "done",
    products: products.length,
    issues_checked: totalIssuesChecked,
    issues_drifted: totalIssuesDrifted,
    issues_filed: totalIssuesFiled,
  });
}

type AuditProductResult = {
  checked: number;
  drifted: number;
  filed: number;
};

async function auditProduct(
  product: ProductConfig,
): Promise<AuditProductResult> {
  const productId = product.product_id;
  log({ msg: "auditing product", product_id: productId, repo: product.repo_full_name });

  const writerInstallId = requireWriterInstallId(product);
  const { token } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    writerInstallId,
  );
  const ghOpts: RequestOptions = { token, userAgent: USER_AGENT };

  const specPath = product.spec_path ?? "spec/";
  const spec = await readSpecTree({
    token,
    userAgent: USER_AGENT,
    repo: product.repo_full_name,
    path: specPath,
  });
  if (spec.missing) {
    log({ msg: "spec missing; skipping product", product_id: productId, spec_path: specPath });
    return { checked: 0, drifted: 0, filed: 0 };
  }
  const currentHashes = hashSpecTree(spec);

  const horizonMs = DEFAULT_HORIZON_DAYS * 24 * 60 * 60 * 1000;
  const sinceIso = new Date(Date.now() - horizonMs).toISOString();
  const issues = await listDoneIssuesWithSpecHashes({
    tableName: ISSUE_STATE_TABLE,
    productId,
    sinceIso,
    limit: DEFAULT_SAMPLE_SIZE,
  });
  log({
    msg: "sampled candidates",
    product_id: productId,
    count: issues.length,
    horizon_days: DEFAULT_HORIZON_DAYS,
  });

  let drifted = 0;
  let filed = 0;
  for (const issue of issues) {
    const baseline = issue.spec_hashes_at_merge?.hashes ?? {};
    const diff = diffSpecHashes(baseline, currentHashes);
    if (!hasDrift(diff)) continue;
    drifted++;

    try {
      const created = await fileDriftIssue({
        ghOpts,
        repo: product.repo_full_name,
        merged: issue,
        diff,
      });
      log({
        msg: "filed drift issue",
        product_id: productId,
        for_issue: issue.issue_id,
        new_issue: created.number,
        new_issue_url: created.html_url,
      });
      filed++;
    } catch (err) {
      log({
        msg: "filing drift issue failed (non-fatal)",
        product_id: productId,
        for_issue: issue.issue_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { checked: issues.length, drifted, filed };
}

async function fileDriftIssue(args: {
  ghOpts: RequestOptions;
  repo: string;
  merged: IssueState;
  diff: SpecHashDiff;
}): Promise<{ number: number; html_url: string }> {
  const mergedNumber = args.merged.issue_id;
  const sections: string[] = [];

  if (args.diff.changed.length > 0) {
    sections.push(
      "### Spec files changed\n\n" +
        args.diff.changed.map((p) => `- \`${p}\``).join("\n"),
    );
  }
  if (args.diff.added.length > 0) {
    sections.push(
      "### Spec files added since merge\n\n" +
        args.diff.added.map((p) => `- \`${p}\``).join("\n"),
    );
  }
  if (args.diff.removed.length > 0) {
    sections.push(
      "### Spec files removed since merge\n\n" +
        args.diff.removed.map((p) => `- \`${p}\``).join("\n"),
    );
  }

  const body = [
    `Drift detected: the product spec has changed since issue #${mergedNumber} shipped, ` +
      `and the implementation may no longer match what the current spec says.`,
    "",
    `Merged-at hashes baseline: \`${args.merged.spec_hashes_at_merge?.hashed_at ?? "(unknown)"}\``,
    "",
    ...sections,
    "",
    "## Next steps",
    "",
    "BA picks this up via the normal `state:idea` flow. Treat it as a fresh issue: " +
      "read the current spec sections listed above, decide whether the changes invalidate " +
      "what #" + mergedNumber + " implemented, and either:",
    "",
    `- Open a follow-up issue to update the implementation, or`,
    `- Mark this issue as won't-do and update CLAUDE.md / the spec to reflect that the ` +
      `drift is intentional.`,
    "",
    "<sub>Filed automatically by the agent-forge weekly drift audit (Phase D2).</sub>",
  ].join("\n");

  return createIssue(args.ghOpts, args.repo, {
    title: `Spec drift since #${mergedNumber}`,
    body,
    labels: ["state:idea", "drift-audit"],
  });
}
