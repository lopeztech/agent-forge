// BA (Business Analyst) — first real Claude-powered role.
//
// Trigger: issue gets label `state:idea`. EventBridge → Step Function → this
// Fargate task. Env vars come from RunTask container overrides
// (see infra/modules/step-functions/asl/ba-issue-lifecycle.asl.json).
//
// Job (BA-thin per the BA-real slice scope):
//   1. Fetch the issue (title + body) from GitHub.
//   2. Call Sonnet 4.6 via Bedrock with tool-use forced output: expand into
//      acceptance criteria, surface risks, capture out-of-scope notes,
//      tag complexity. NO spec/ reading yet — that's a follow-up slice.
//   3. Post a structured markdown comment with the expansion.
//   4. Write issue_state.ba_expansion so the Cost Estimator can read
//      structured criteria instead of raw issue body.
//   5. Transition state:idea → state:cost-estimating.
//   6. Record the Sonnet spend in budget_ledger.
//
// Failure modes:
//   - Bedrock 5xx, tool not called, etc. → process exits non-zero, Step
//     Function transitions to TaskFailed. Issue keeps state:idea so the
//     next label touch re-fires the rule.
//
// Out of scope this slice (deliberate):
//   - Reading spec/ from the target repo
//   - Sub-issue splitting on "large" complexity
//   - team_memory read/write
//   - Opus 4.7 escalation for brand-new spec hydration

import { getInstallationTokenFromSecret } from "../../../shared/github/auth.ts";
import {
  addLabels,
  getIssue,
  postComment,
  transitionLabel,
  type GitHubIssue,
} from "../../../shared/github/repo.ts";
import { readSpecTree, type SpecReadResult } from "../../../shared/github/spec.ts";
import {
  type ContentBlock,
  type SystemBlock,
  costUsd,
  getModelByTier,
} from "../../../shared/models.ts";
import { recordSpend } from "../../../shared/budget.ts";
import { putBAExpansion } from "../../../shared/state/issue-state.ts";
import {
  GAP_LABELS,
  HUMAN_NEEDED_LABEL,
  STATE_LABELS,
} from "../../../shared/labels.ts";
import {
  requireProduct,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../shared/state/products.ts";
import { requiredEnv } from "../../../shared/env.ts";

// ---------------------------------------------------------------------------
// Env
// ---------------------------------------------------------------------------

const PRODUCT_ID = requiredEnv("AGENT_FORGE_PRODUCT_ID");
const ISSUE_NUMBER = Number(requiredEnv("AGENT_FORGE_ISSUE_NUMBER"));
const REPO = requiredEnv("AGENT_FORGE_REPO");
const APP_SECRET_NAME = requiredEnv("AGENT_FORGE_APP_SECRET_NAME");
const PRODUCTS_TABLE = requiredEnv("AGENT_FORGE_PRODUCTS_TABLE");
const ISSUE_STATE_TABLE = requiredEnv("AGENT_FORGE_ISSUE_STATE_TABLE");
const BUDGET_LEDGER_TABLE = requiredEnv("AGENT_FORGE_BUDGET_LEDGER_TABLE");
const ROLE = requiredEnv("AGENT_FORGE_ROLE");
const ENV = requiredEnv("AGENT_FORGE_ENV");
const DELIVERY_ID = process.env.AGENT_FORGE_DELIVERY_ID ?? "unknown";
const LABEL = process.env.AGENT_FORGE_LABEL ?? "unknown";

const USER_AGENT = `agent-forge-${ROLE}`;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({
    role: ROLE,
    env: ENV,
    product_id: PRODUCT_ID,
    issue: ISSUE_NUMBER,
    delivery_id: DELIVERY_ID,
    ...obj,
  }));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProductRow = ProductConfig;

type Complexity = "trivial" | "small" | "medium" | "large";

type SpecConflict = {
  detected: boolean;
  reason: string;
};

type BAExpansion = {
  acceptance_criteria: string[];
  risks: string[];
  out_of_scope: string[];
  complexity: Complexity;
  rationale: string;
  spec_conflict: SpecConflict;
};

// ---------------------------------------------------------------------------
// Sonnet 4.6 tool-use call
// ---------------------------------------------------------------------------

const SUBMIT_EXPANSION_TOOL = {
  name: "submit_expansion",
  description:
    "Submit the structured expansion of this issue: acceptance criteria, " +
    "risks, out-of-scope notes, a complexity tag, and a spec-conflict flag. " +
    "You MUST call this exactly once. Do not produce any free-form text.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "acceptance_criteria",
      "risks",
      "out_of_scope",
      "complexity",
      "rationale",
      "spec_conflict",
    ],
    properties: {
      acceptance_criteria: {
        type: "array",
        minItems: 1,
        maxItems: 15,
        items: { type: "string" },
        description:
          "Concrete, testable conditions for this issue to be considered done. " +
          "Each one should be a single observable behaviour or property.",
      },
      risks: {
        type: "array",
        maxItems: 8,
        items: { type: "string" },
        description:
          "Technical risks, edge cases, or implementation pitfalls a Dev " +
          "should be aware of. Empty array if none.",
      },
      out_of_scope: {
        type: "array",
        maxItems: 8,
        items: { type: "string" },
        description:
          "Adjacent work that might seem in-scope but isn't — to prevent " +
          "scope creep. Empty array if obvious.",
      },
      complexity: {
        enum: ["trivial", "small", "medium", "large"],
        description:
          "Rough size: trivial (<2h), small (<half day), medium (~1 day), " +
          "large (>1 day, likely needs splitting — a follow-up slice will " +
          "auto-split these).",
      },
      rationale: {
        type: "string",
        description:
          "1-3 sentences explaining the expansion — primary driver of " +
          "complexity, why these specific risks matter, anything else worth noting.",
      },
      spec_conflict: {
        type: "object",
        additionalProperties: false,
        required: ["detected", "reason"],
        properties: {
          detected: {
            type: "boolean",
            description:
              "True if the issue directly contradicts the product spec — " +
              "especially anything explicitly listed in non-goals or " +
              "ruled out elsewhere in spec/. False otherwise.",
          },
          reason: {
            type: "string",
            description:
              "When detected=true: the verbatim spec text + a one-sentence " +
              "statement of the contradiction. Empty string when detected=false.",
          },
        },
      },
    },
  },
};

const BASE_SYSTEM_PROMPT = `
You are agent-forge's Business Analyst (BA). You read an incoming GitHub
issue and expand it into a structured backlog item that downstream roles
(Cost Estimator, Developer, Tester, etc.) can act on.

You are NOT the developer. Do not write code, do not propose implementations,
do not commit to a design. Your job is purely to clarify scope:

- Acceptance criteria: what observable behaviour signals "done"?
- Risks: what could trip an implementer up?
- Out of scope: what does this issue NOT include?
- Complexity: rough size, used downstream to decide if the issue should be split.

Be concise — short bullet points, not paragraphs. Prefer concrete, testable
statements over abstract ones. If the issue body already gives some of these,
preserve them and fill gaps; don't restate them verbatim.

**Spec conflict handling.** If the issue proposes work that directly
contradicts the product spec (especially anything in non-goals or explicitly
ruled out elsewhere in spec/), set spec_conflict.detected=true with reason
containing the verbatim conflicting spec text plus a one-sentence statement
of the contradiction. This pauses the pipeline for human resolution rather
than letting downstream estimate and implement forbidden work. Do not set
detected=true for soft tensions, nuanced trade-offs, or anything the spec
merely doesn't address — only for clear, citable contradictions.

You MUST call the submit_expansion tool exactly once. Do not produce any
free-form text response.
`.trim();

// System prompt is split into two cache-controlled blocks so Anthropic can
// reuse the prefix across BA calls within the 5-min ephemeral TTL.
//
//   block 1: BASE_SYSTEM_PROMPT — stable across products
//   block 2: spec/ contents     — stable across issues for one product
//
// Minimum cached prefix is 1024 tokens. The base alone (~700 tokens) is below
// that threshold, so when spec is missing we drop caching entirely and pass a
// single uncached block. When spec is present (~5+ KB), the combined prefix
// easily clears the threshold and gets cached.
function buildSystemBlocks(spec: SpecReadResult): SystemBlock[] {
  if (spec.missing || spec.files.length === 0) {
    return [{ type: "text", text: BASE_SYSTEM_PROMPT }];
  }

  const specBlocks = spec.files
    .map((f) => `<file path="${f.path}">\n${f.content.trim()}\n</file>`)
    .join("\n\n");

  const truncationNote = spec.truncated_by
    ? `\n\nNote: spec was truncated by ${spec.truncated_by} cap; ` +
      `lower-priority files (alphabetical order) were dropped. ` +
      `Work from what's here.`
    : "";

  const specBlockText = [
    "=====================",
    "PRODUCT SPECIFICATION",
    "=====================",
    "The following is the product's spec/ directory. Treat this as the",
    "authoritative source for product scope, conventions, and constraints.",
    "When relevant, reference specific spec sections or file paths in your",
    "acceptance criteria, risks, or out-of-scope notes. If the issue and",
    "spec conflict, surface that via the spec_conflict tool field.",
    "",
    specBlocks,
    truncationNote,
  ].join("\n");

  return [
    {
      type: "text",
      text: BASE_SYSTEM_PROMPT,
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: specBlockText,
      cache_control: { type: "ephemeral" },
    },
  ];
}

async function runBA(
  issue: GitHubIssue,
  spec: SpecReadResult,
): Promise<{
  expansion: BAExpansion;
  model: ReturnType<typeof getModelByTier>;
  costUsd: number;
  usage: { input_tokens: number; cached_tokens: number; output_tokens: number };
}> {
  const model = getModelByTier("sonnet-4-6");

  const userMessage =
    `Issue #${issue.number}: ${issue.title}\n\n---\n\n${issue.body ?? "(no body)"}`;

  const result = await model.invoke({
    system: buildSystemBlocks(spec),
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 2048,
    tools: [SUBMIT_EXPANSION_TOOL],
    toolChoice: { type: "tool", name: "submit_expansion" },
    temperature: 0,
  });

  const toolUse = result.content.find(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use" && b.name === "submit_expansion",
  );
  if (!toolUse) {
    throw new Error(
      `BA did not call submit_expansion (stop_reason=${result.stopReason}, ` +
        `content=${JSON.stringify(result.content)})`,
    );
  }

  log({
    msg: "BA expansion returned",
    model: model.bedrockModelId,
    usage: result.usage,
    cost_usd: result.costUsd,
  });

  return {
    expansion: toolUse.input as BAExpansion,
    model,
    costUsd: result.costUsd,
    usage: result.usage,
  };
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function fetchIssue(token: string): Promise<GitHubIssue> {
  return getIssue({ token, userAgent: USER_AGENT }, REPO, ISSUE_NUMBER);
}

async function fetchProductRow(): Promise<ProductRow> {
  return requireProduct({
    tableName: PRODUCTS_TABLE,
    productId: PRODUCT_ID,
  });
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

function bullets(items: string[], fallback = "_(none)_"): string {
  if (items.length === 0) return fallback;
  return items.map((s) => `- ${s}`).join("\n");
}

function fmtSpecFooter(spec: SpecReadResult, specPath: string): string {
  if (spec.missing) {
    return `<sub>spec: no \`${specPath}\` directory found in repo — expansion based on issue body only.</sub>`;
  }
  if (spec.files.length === 0) {
    return `<sub>spec: \`${specPath}\` exists but is empty — expansion based on issue body only.</sub>`;
  }
  const kb = (spec.total_bytes / 1024).toFixed(1);
  const trunc = spec.truncated_by ? `, truncated by ${spec.truncated_by} cap` : "";
  return `<sub>spec: ${spec.files.length} file${spec.files.length === 1 ? "" : "s"} from \`${specPath}\` (${kb} KB${trunc}).</sub>`;
}

function buildComment(
  expansion: BAExpansion,
  spec: SpecReadResult,
  specPath: string,
  modelId: string,
  runId: string,
): string {
  const conflicted = expansion.spec_conflict.detected;
  const transitionLine = conflicted
    ? `**⚠️  Spec conflict detected — parking at \`human-needed\`.** Pipeline does NOT proceed to estimation or development. A human must resolve the conflict (revise the issue, amend the spec, or close as won't-do) and clear the \`human-needed\` label.`
    : `Transitioning \`${STATE_LABELS.idea}\` → \`${STATE_LABELS.costEstimating}\`.`;

  const conflictBlock = conflicted
    ? [
        "### Spec conflict",
        "> " + expansion.spec_conflict.reason.replace(/\n/g, "\n> "),
        "",
      ]
    : [];

  return [
    `## BA expansion (run \`${runId}\`, ${modelId})`,
    "",
    ...conflictBlock,
    `**Complexity:** \`${expansion.complexity}\``,
    "",
    `### Acceptance criteria`,
    bullets(expansion.acceptance_criteria),
    "",
    `### Risks`,
    bullets(expansion.risks),
    "",
    `### Out of scope`,
    bullets(expansion.out_of_scope),
    "",
    `_${expansion.rationale}_`,
    "",
    transitionLine,
    "",
    fmtSpecFooter(spec, specPath),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// State writes
// ---------------------------------------------------------------------------

async function writeIssueState(args: {
  expansion: BAExpansion;
  spec: SpecReadResult;
  spec_path: string;
  model_id: string;
  run_id: string;
}): Promise<void> {
  await putBAExpansion({
    tableName: ISSUE_STATE_TABLE,
    productId: PRODUCT_ID,
    issueNumber: ISSUE_NUMBER,
    expansion: {
      ...args.expansion,
      model: args.model_id,
      run_id: args.run_id,
      spec: {
        path: args.spec_path,
        files: args.spec.files.length,
        total_bytes: args.spec.total_bytes,
        truncated_by: args.spec.truncated_by,
        missing: args.spec.missing,
      },
    },
  });
}

function runIdFromEnv(): string {
  return (
    process.env.ECS_TASK_ARN ??
    process.env.AGENT_FORGE_DELIVERY_ID ??
    `local-${Date.now()}`
  )
    .split("/")
    .slice(-1)[0]!;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log({ msg: "starting", repo: REPO, label: LABEL });

  if (LABEL && LABEL !== STATE_LABELS.idea) {
    log({ msg: "non-state:idea label fired this run; nothing to do", label: LABEL });
    return;
  }

  const product = await fetchProductRow();
  const writerInstallId = requireWriterInstallId(product);

  const { token } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    writerInstallId,
  );
  log({ msg: "minted installation token" });

  const issue = await fetchIssue(token);
  log({ msg: "fetched issue", title: issue.title });

  const specPath = product.spec_path ?? "spec/";
  const spec = await readSpecTree({
    token,
    userAgent: USER_AGENT,
    repo: REPO,
    path: specPath,
  });
  log({
    msg: "read spec",
    spec_path: specPath,
    files: spec.files.length,
    total_bytes: spec.total_bytes,
    truncated_by: spec.truncated_by,
    missing: spec.missing,
  });

  const runId = runIdFromEnv();

  const {
    expansion,
    model,
    costUsd: baCostUsd,
    usage,
  } = await runBA(issue, spec);

  await writeIssueState({
    expansion,
    spec,
    spec_path: specPath,
    model_id: model.bedrockModelId,
    run_id: runId,
  });
  log({ msg: "wrote issue_state.ba_expansion" });

  await postComment(
    { token, userAgent: USER_AGENT },
    REPO,
    ISSUE_NUMBER,
    buildComment(expansion, spec, specPath, model.bedrockModelId, runId),
  );
  log({ msg: "posted expansion comment" });

  const ghOpts = { token, userAgent: USER_AGENT };
  if (expansion.spec_conflict.detected) {
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.idea,
      HUMAN_NEEDED_LABEL,
    );
    await addLabels(ghOpts, REPO, ISSUE_NUMBER, [GAP_LABELS.specConflict]);
    log({
      msg: "spec conflict detected; parked at human-needed",
      reason: expansion.spec_conflict.reason,
    });
  } else {
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.idea,
      STATE_LABELS.costEstimating,
    );
    log({
      msg: "label transitioned",
      from: STATE_LABELS.idea,
      to: STATE_LABELS.costEstimating,
    });
  }

  await recordSpend({
    tableName: BUDGET_LEDGER_TABLE,
    runId,
    spend: {
      product_id: PRODUCT_ID,
      issue_number: ISSUE_NUMBER,
      role: ROLE,
      model: model.bedrockModelId,
      input_tokens: usage.input_tokens,
      cached_tokens: usage.cached_tokens,
      output_tokens: usage.output_tokens,
      cost_usd: baCostUsd,
    },
  });
  log({ msg: "recorded spend", cost_usd: baCostUsd });

  // Safety: assert reported cost matches the pricing table.
  const recomputed = costUsd("sonnet-4-6", {
    input: usage.input_tokens,
    cached: usage.cached_tokens,
    output: usage.output_tokens,
  });
  if (Math.abs(recomputed - baCostUsd) > 1e-9) {
    log({
      msg: "cost mismatch — pricing table may have drifted",
      recomputed,
      reported: baCostUsd,
    });
  }

  log({ msg: "done" });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(JSON.stringify({ role: ROLE, level: "error", msg }));
  process.exit(1);
});
