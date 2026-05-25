// Cost Estimator gate (CLAUDE.md "Cost Estimator (gate, between BA and Dev)").
//
// Trigger: EventBridge rule on issues.labeled where the added label is
// state:cost-estimating. The webhook-verifier wraps GitHub events as
// { product_id, action, delivery_id, payload }, so the rule already matched
// on (detail-type=issues, action=labeled, payload.label.name=state:cost-estimating).
//
// Job:
//   1. Read products row → repo, writer_install_id, cost_approval_threshold_usd
//   2. Call Haiku 4.5 once with tool-use forced output for p50/p90 per role
//   3. Post markdown-table comment on the issue
//   4. Decide label transition:
//        p50_total ≤ threshold      → state:ready  (auto-approved)
//        p50_total > $12 hard cap   → human-needed (no /approve-cost override)
//        else                       → state:awaiting-cost-approval (parked)
//   5. Write estimate to issue_state for calibration when the issue hits done
//   6. Write the estimator's own spend to budget_ledger
//
// Failure modes (all → human-needed with a comment, never silently swallow):
//   - Bedrock throws (5xx, throttle, timeout)
//   - Model returns text instead of tool_use, or invalid tool args
//   - Any GitHub or DDB call fails after the model call (estimate was made
//     but couldn't be acted on — human should look)

import { makeParkDumper } from "../../../../shared/forensic/dump.ts";
import { getInstallationTokenFromSecret } from "../../../../shared/github/auth.ts";
import { postComment, transitionLabel } from "../../../../shared/github/repo.ts";
import {
  type ContentBlock,
  type RoleKey,
  costUsd,
  getModelByTier,
} from "../../../../shared/models.ts";
import { recordSpend } from "../../../../shared/budget.ts";
import {
  getIssueState,
  putCostEstimate,
} from "../../../../shared/state/issue-state.ts";
import {
  HUMAN_NEEDED_LABEL,
  STATE_LABELS,
} from "../../../../shared/labels.ts";
import {
  requireProduct,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../../shared/state/products.ts";
import { requiredEnv } from "../../../../shared/env.ts";

// ---------------------------------------------------------------------------
// Env + clients
// ---------------------------------------------------------------------------

const PRODUCTS_TABLE = requiredEnv("PRODUCTS_TABLE");
const ISSUE_STATE_TABLE = requiredEnv("ISSUE_STATE_TABLE");
const BUDGET_LEDGER_TABLE = requiredEnv("BUDGET_LEDGER_TABLE");
const APP_SECRET_NAME = requiredEnv("APP_SECRET_NAME");
const FORENSIC_BUCKET = process.env.AGENT_FORGE_FORENSIC_BUCKET;
const HARD_PER_ISSUE_CAP_USD = Number(
  process.env.HARD_PER_ISSUE_CAP_USD ?? "12",
);
const DEFAULT_THRESHOLD_USD = Number(
  process.env.DEFAULT_COST_APPROVAL_THRESHOLD_USD ?? "1",
);
const USER_AGENT = "agent-forge-cost-estimator";

// ---------------------------------------------------------------------------
// EventBridge event shape
// ---------------------------------------------------------------------------

type EventBridgeEvent = {
  id: string;
  detail: {
    product_id: string;
    action?: string;
    delivery_id?: string;
    payload: {
      issue: { number: number; title: string; body?: string | null };
      repository: { full_name: string };
      label: { name: string };
    };
  };
};

type ProductRow = ProductConfig;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ role: "cost-estimator", ...obj }));
}

// ---------------------------------------------------------------------------
// Estimate shape (matches the submit_estimate tool schema below)
// ---------------------------------------------------------------------------

type RolePoint = {
  input_tokens: number;
  output_tokens: number;
  usd: number;
};

type RoleEstimate = {
  role: RoleKey;
  p50: RolePoint;
  p90: RolePoint;
};

type Estimate = {
  per_role: RoleEstimate[];
  rationale: string;
};

const ROLE_ORDER: RoleKey[] = [
  "ba",
  "dev",
  "test",
  "functional",
  "security",
  "po",
];

// ---------------------------------------------------------------------------
// Model call — Haiku 4.5 with tool-use forced output
// ---------------------------------------------------------------------------

const SUBMIT_ESTIMATE_TOOL = {
  name: "submit_estimate",
  description:
    "Submit the per-role token + USD estimate for processing this issue " +
    "through the agent-forge pipeline. You MUST call this exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["per_role", "rationale"],
    properties: {
      per_role: {
        type: "array",
        minItems: 6,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["role", "p50", "p90"],
          properties: {
            role: { enum: ROLE_ORDER },
            p50: {
              type: "object",
              additionalProperties: false,
              required: ["input_tokens", "output_tokens", "usd"],
              properties: {
                input_tokens: { type: "number" },
                output_tokens: { type: "number" },
                usd: { type: "number" },
              },
            },
            p90: {
              type: "object",
              additionalProperties: false,
              required: ["input_tokens", "output_tokens", "usd"],
              properties: {
                input_tokens: { type: "number" },
                output_tokens: { type: "number" },
                usd: { type: "number" },
              },
            },
          },
        },
      },
      rationale: {
        type: "string",
        description:
          "1-3 sentences explaining the sizing — primary cost driver, " +
          "comparable issues if any, why this differs from the rate-card default.",
      },
    },
  },
};

// Per-role expected baselines for the prompt. These are the happy-path
// (no-kickback) numbers from CLAUDE.md "Cost model". Haiku adjusts up/down
// from here based on the issue.
const RATE_CARD = `
Per-role happy-path baseline (no kickbacks, with prompt caching). Adjust up
for issues that are larger/cross-cutting/novel, down for trivial ones. Total
must accommodate the kickback model (Dev escalates Sonnet→Opus on attempt 3).

| Role        | Model      | In tokens | Out tokens | $/issue baseline |
| ----------- | ---------- | --------- | ---------- | ---------------- |
| ba          | Sonnet 4.6 | ~12K      | ~2K        | $0.05            |
| dev         | Sonnet 4.6 | ~250K     | ~50K       | $1.00            |
| test        | Sonnet 4.6 | ~80K      | ~20K       | $0.40            |
| functional  | Sonnet 4.6 | ~40K      | ~10K       | $0.20            |
| security    | Sonnet 4.6 | ~60K      | ~10K       | $0.25            |
| po          | Opus 4.7   | ~30K      | ~5K        | $0.75            |

p90 should reflect the realistic worst case including likely kickbacks
(expected ~$3.60 with 30% kickback rate). Hard per-issue cap is $${HARD_PER_ISSUE_CAP_USD}
— if your p50 exceeds that, the issue will be parked for human review, so
don't pad estimates beyond what the work actually warrants.
`.trim();

const SYSTEM_PROMPT = `
You are agent-forge's cost estimator. You estimate how many tokens and USD
each of six pipeline roles (BA, Dev, Test, Functional, Security, PO) will
spend processing one GitHub issue end-to-end.

You are called exactly once per issue, after the BA has expanded the issue
with acceptance criteria. Read the issue title, body, and any
acceptance-criteria block. Produce a per-role p50 (median) and p90
(realistic worst-case including kickbacks) estimate.

${RATE_CARD}

You MUST call the submit_estimate tool exactly once. Do not produce any
free-form text response.
`.trim();

type BAExpansionSummary = {
  acceptance_criteria?: string[];
  risks?: string[];
  out_of_scope?: string[];
  complexity?: string;
  rationale?: string;
};

function formatBAExpansion(b: BAExpansionSummary): string {
  const lines: string[] = ["", "---", "**BA expansion** (use this as the authoritative scope; the issue body above is the raw user request):"];
  if (b.complexity) lines.push(`- complexity: ${b.complexity}`);
  if (b.acceptance_criteria?.length) {
    lines.push(`- acceptance criteria:`);
    for (const c of b.acceptance_criteria) lines.push(`  - ${c}`);
  }
  if (b.risks?.length) {
    lines.push(`- risks:`);
    for (const r of b.risks) lines.push(`  - ${r}`);
  }
  if (b.out_of_scope?.length) {
    lines.push(`- out of scope:`);
    for (const o of b.out_of_scope) lines.push(`  - ${o}`);
  }
  if (b.rationale) lines.push(`- BA rationale: ${b.rationale}`);
  return lines.join("\n");
}

async function runEstimator(
  issue: { number: number; title: string; body?: string | null },
  product_id: string,
  baExpansion: BAExpansionSummary | undefined,
): Promise<{
  estimate: Estimate;
  totals: { p50_total_usd: number; p90_total_usd: number };
  model: ReturnType<typeof getModelByTier>;
  costUsd: number;
  usage: { input_tokens: number; cached_tokens: number; output_tokens: number };
}> {
  const model = getModelByTier("haiku-4-5");

  const userMessage =
    `Issue #${issue.number}: ${issue.title}\n\n---\n\n${issue.body ?? "(no body)"}` +
    (baExpansion ? formatBAExpansion(baExpansion) : "");

  const result = await model.invoke({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 2048,
    tools: [SUBMIT_ESTIMATE_TOOL],
    toolChoice: { type: "tool", name: "submit_estimate" },
    temperature: 0,
  });

  const toolUse = result.content.find(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use" && b.name === "submit_estimate",
  );
  if (!toolUse) {
    throw new Error(
      `Estimator did not call submit_estimate (stop_reason=${result.stopReason}, ` +
        `content=${JSON.stringify(result.content)})`,
    );
  }

  const estimate = toolUse.input as Estimate;

  // Defence-in-depth: ensure every role is present and ordered correctly.
  const byRole = new Map(estimate.per_role.map((r) => [r.role, r]));
  const orderedRoles = ROLE_ORDER.map((r) => {
    const got = byRole.get(r);
    if (!got) throw new Error(`Estimator omitted role "${r}"`);
    return got;
  });
  estimate.per_role = orderedRoles;

  const p50_total_usd = orderedRoles.reduce((s, r) => s + r.p50.usd, 0);
  const p90_total_usd = orderedRoles.reduce((s, r) => s + r.p90.usd, 0);

  log({
    msg: "estimator returned",
    product_id,
    issue_number: issue.number,
    p50_total_usd,
    p90_total_usd,
    model: model.bedrockModelId,
    usage: result.usage,
    cost_usd: result.costUsd,
  });

  return {
    estimate,
    totals: { p50_total_usd, p90_total_usd },
    model,
    costUsd: result.costUsd,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
  return String(n);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

type Decision =
  | { kind: "auto-approved"; nextLabel: typeof STATE_LABELS.ready }
  | {
      kind: "parked";
      nextLabel: typeof STATE_LABELS.awaitingCostApproval;
    }
  | { kind: "rejected-above-cap"; nextLabel: typeof HUMAN_NEEDED_LABEL };

function buildComment(
  estimate: Estimate,
  totals: { p50_total_usd: number; p90_total_usd: number },
  threshold_usd: number,
  decision: Decision,
  modelId: string,
  runId: string,
): string {
  const rows = estimate.per_role
    .map(
      (r) =>
        `| ${r.role.padEnd(11)} | ${fmtTokens(r.p50.input_tokens)} / ${fmtTokens(r.p50.output_tokens)} | ` +
        `${fmtTokens(r.p90.input_tokens)} / ${fmtTokens(r.p90.output_tokens)} | ` +
        `${fmtUsd(r.p50.usd)} | ${fmtUsd(r.p90.usd)} |`,
    )
    .join("\n");

  const cta =
    decision.kind === "auto-approved"
      ? `Under approval threshold (${fmtUsd(threshold_usd)}). Promoting to \`state:ready\` automatically.`
      : decision.kind === "parked"
        ? `Above approval threshold (${fmtUsd(threshold_usd)}). Reply \`/approve-cost\` to proceed or \`/cancel\` to drop.`
        : `Above hard per-issue cap (${fmtUsd(HARD_PER_ISSUE_CAP_USD)}); \`/approve-cost\` cannot override the circuit breaker. Parking with \`human-needed\` — split this issue or raise the cap.`;

  return [
    `## Cost estimate (run \`${runId}\`, ${modelId})`,
    "",
    `| Role        | p50 tokens | p90 tokens | p50 USD | p90 USD |`,
    `| ----------- | ---------- | ---------- | ------- | ------- |`,
    rows,
    `| **Total**   |            |            | **${fmtUsd(totals.p50_total_usd)}** | **${fmtUsd(totals.p90_total_usd)}** |`,
    "",
    `_${estimate.rationale}_`,
    "",
    cta,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// DynamoDB helpers
// ---------------------------------------------------------------------------

async function fetchProductRow(product_id: string): Promise<ProductRow> {
  return requireProduct({
    tableName: PRODUCTS_TABLE,
    productId: product_id,
  });
}

async function fetchBAExpansion(
  product_id: string,
  issue_number: number,
): Promise<BAExpansionSummary | undefined> {
  try {
    const state = await getIssueState({
      tableName: ISSUE_STATE_TABLE,
      productId: product_id,
      issueNumber: issue_number,
    });
    return state?.ba_expansion as BAExpansionSummary | undefined;
  } catch (err) {
    // Best-effort: never let a state-lookup failure block the estimator.
    log({
      msg: "ba_expansion fetch failed; proceeding without it",
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

async function writeIssueState(args: {
  product_id: string;
  issue_number: number;
  estimate: Estimate;
  totals: { p50_total_usd: number; p90_total_usd: number };
  threshold_usd: number;
  decision: Decision;
  model_id: string;
  run_id: string;
  posted_comment_id: number | undefined;
}): Promise<void> {
  await putCostEstimate({
    tableName: ISSUE_STATE_TABLE,
    productId: args.product_id,
    issueNumber: args.issue_number,
    estimate: {
      per_role: args.estimate.per_role,
      rationale: args.estimate.rationale,
      p50_total_usd: args.totals.p50_total_usd,
      p90_total_usd: args.totals.p90_total_usd,
      threshold_usd: args.threshold_usd,
      decision: args.decision.kind,
      model: args.model_id,
      run_id: args.run_id,
      posted_comment_id: args.posted_comment_id ?? null,
    },
  });
}

// ---------------------------------------------------------------------------
// Failure path — post a comment and park the issue
// ---------------------------------------------------------------------------

async function parkAsFailure(
  token: string,
  repo: string,
  issueNumber: number,
  reason: string,
  forensicUri?: string,
): Promise<void> {
  const body =
    `🤖 **Cost Estimator failed.** Parking with \`human-needed\` — please clear the label after investigating.\n\n> ${reason.replace(/\n/g, "\n> ")}` +
    (forensicUri
      ? `\n\n<sub>Forensic dump: \`${forensicUri}\` (\`aws s3 cp <uri> -\` to inspect).</sub>`
      : "");
  await postComment(
    { token, userAgent: USER_AGENT },
    repo,
    issueNumber,
    body,
  );
  await transitionLabel(
    { token, userAgent: USER_AGENT },
    repo,
    issueNumber,
    STATE_LABELS.costEstimating,
    HUMAN_NEEDED_LABEL,
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: EventBridgeEvent): Promise<void> {
  const { product_id, payload } = event.detail;
  const issue = payload.issue;
  const repo = payload.repository.full_name;
  const label = payload.label?.name;
  const runId = event.id;

  log({
    msg: "starting",
    product_id,
    issue_number: issue.number,
    repo,
    label,
    delivery_id: event.detail.delivery_id,
    run_id: runId,
  });

  // The EventBridge rule already filters on label.name=state:cost-estimating,
  // but defend against rule drift / replays.
  if (label !== STATE_LABELS.costEstimating) {
    log({ msg: "label is not state:cost-estimating; skipping", label });
    return;
  }

  const product = await fetchProductRow(product_id);
  const writerInstallId = requireWriterInstallId(product);
  const threshold_usd =
    product.cost_approval_threshold_usd ?? DEFAULT_THRESHOLD_USD;

  const { token } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    writerInstallId,
  );

  // ---- read BA expansion if BA wrote one --------------------------------
  // BA-real writes issue_state.ba_expansion before transitioning the label.
  // Missing expansion is normal during a slice-A→slice-B transition window
  // (or if BA was bypassed); fall through with raw issue body in that case.
  const baExpansion = await fetchBAExpansion(product_id, issue.number);
  log({ msg: "ba_expansion lookup", present: Boolean(baExpansion) });

  // Park-time forensic dump. Captures a structured "why we parked" record
  // to S3 + appends a pointer to issue_state.forensic_reports[]. Covers the
  // two unexpected-park paths per the 2026-05-25 decision: Bedrock 5xx /
  // timeout, and post-estimate side-effect failure. No-op when
  // FORENSIC_BUCKET is unset (local-dev convenience).
  const dumpForensicForPark = makeParkDumper({
    bucket: FORENSIC_BUCKET,
    issueStateTable: ISSUE_STATE_TABLE,
    productId: product_id,
    issueNumber: issue.number,
    role: "cost-estimator",
    log,
  });

  // ---- run the estimator ------------------------------------------------
  let estimatorOutput: Awaited<ReturnType<typeof runEstimator>>;
  try {
    estimatorOutput = await runEstimator(issue, product_id, baExpansion);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ msg: "estimator threw; parking", error: msg });
    const forensicUri = await dumpForensicForPark({
      reason: `Estimator threw (Bedrock 5xx / timeout / parse error): ${msg.slice(0, 200)}`,
      runId,
      extra: {
        error_message: msg,
        ba_expansion_present: Boolean(baExpansion),
      },
    });
    await parkAsFailure(
      token,
      repo,
      issue.number,
      `Estimator error: ${msg}`,
      forensicUri,
    );
    // Even on failure, log a (zero/best-effort) ledger row so the run is auditable.
    await recordSpend({
      tableName: BUDGET_LEDGER_TABLE,
      runId,
      spend: {
        product_id,
        issue_number: issue.number,
        role: "cost-estimator",
        model: "haiku-4-5",
        input_tokens: 0,
        cached_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        note: `failed: ${msg}`.slice(0, 256),
      },
    });
    return;
  }

  const { estimate, totals, model, usage, costUsd: estimatorCostUsd } =
    estimatorOutput;

  // ---- decide the gate --------------------------------------------------
  const decision: Decision =
    totals.p50_total_usd > HARD_PER_ISSUE_CAP_USD
      ? { kind: "rejected-above-cap", nextLabel: HUMAN_NEEDED_LABEL }
      : totals.p50_total_usd <= threshold_usd
        ? { kind: "auto-approved", nextLabel: STATE_LABELS.ready }
        : {
            kind: "parked",
            nextLabel: STATE_LABELS.awaitingCostApproval,
          };

  log({ msg: "decision", decision: decision.kind, p50_total_usd: totals.p50_total_usd, threshold_usd });

  // ---- post comment + transition + persist ------------------------------
  const commentBody = buildComment(
    estimate,
    totals,
    threshold_usd,
    decision,
    model.bedrockModelId,
    runId,
  );

  let postedCommentId: number | undefined;
  try {
    const posted = await postComment(
      { token, userAgent: USER_AGENT },
      repo,
      issue.number,
      commentBody,
    );
    postedCommentId = posted.id;
    log({ msg: "posted comment", comment_id: postedCommentId });

    await transitionLabel(
      { token, userAgent: USER_AGENT },
      repo,
      issue.number,
      STATE_LABELS.costEstimating,
      decision.nextLabel,
    );
    log({ msg: "label transitioned", to: decision.nextLabel });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log({ msg: "post-estimate side-effect failed; parking", error: msg });
    const forensicUri = await dumpForensicForPark({
      reason: `Estimator succeeded but post-estimate side-effect failed: ${msg.slice(0, 200)}`,
      runId,
      costUsd: estimatorCostUsd,
      extra: {
        error_message: msg,
        estimate: { p50_total_usd: totals.p50_total_usd, p90_total_usd: totals.p90_total_usd },
        decision: decision.kind,
        comment_posted_id: postedCommentId,
      },
    });
    // Don't double-fail if parking itself errors — let it bubble.
    await parkAsFailure(
      token,
      repo,
      issue.number,
      `Estimate succeeded but follow-up failed: ${msg}`,
      forensicUri,
    );
    // Still record spend below — the model call did happen.
  }

  // ---- persist estimate + spend (always, even on partial failure) -------
  await writeIssueState({
    product_id,
    issue_number: issue.number,
    estimate,
    totals,
    threshold_usd,
    decision,
    model_id: model.bedrockModelId,
    run_id: runId,
    posted_comment_id: postedCommentId,
  });
  log({ msg: "wrote issue_state" });

  await recordSpend({
    tableName: BUDGET_LEDGER_TABLE,
    runId,
    spend: {
      product_id,
      issue_number: issue.number,
      role: "cost-estimator",
      model: model.bedrockModelId,
      input_tokens: usage.input_tokens,
      cached_tokens: usage.cached_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: estimatorCostUsd,
    },
  });
  log({ msg: "recorded spend", cost_usd: estimatorCostUsd });

  // Safety: re-derive cost from tier+usage to assert cost_usd / costUsd agree.
  // If they diverge, the pricing table in shared/models.ts has drifted.
  const recomputed = costUsd("haiku-4-5", {
    input: usage.input_tokens,
    cached: usage.cached_tokens,
    output: usage.output_tokens,
  });
  if (Math.abs(recomputed - estimatorCostUsd) > 1e-9) {
    log({
      msg: "cost mismatch — pricing table may have drifted",
      recomputed,
      reported: estimatorCostUsd,
    });
  }

  log({ msg: "done" });
}
