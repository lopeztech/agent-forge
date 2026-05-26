// Product Owner — Slice F.
//
// Trigger: issue gets label `state:awaiting-po` (Security transitions here
// on outcome=clean).
//
// Job: read the BA expansion + spec + PR diff + comments from every prior
// role. Decide whether the PR matches the issue's acceptance criteria and
// the spec. Post a structured ship/no-ship recommendation.
//
// CLAUDE.md default model for PO is Opus 4.7 ("this is the gate. The cost
// of a wrong merge is much higher than the cost of running Opus on a few
// PRs per day"). 4.7 isn't yet available on the dev AWS account; we route
// through Opus 4.6 (the "best available Opus" the rest of the platform
// already uses).
//
// Outcomes:
//   - approve    → if products.auto_merge=true, merge through the merger App
//                  and transition state:awaiting-po → state:done. Otherwise
//                  post "recommend-merge" and park at human-needed.
//   - kickback   → kick back to Dev by incrementing iter:N and transitioning
//                  state:awaiting-po → state:ready. At iter:3 cap, park at
//                  human-needed instead.
//   - spec_ambig → post comment + park at human-needed.

import { runAgentLoop, type ToolCall } from "../../../shared/agent-loop.ts";
import { getIssueSpendUsd, recordSpend } from "../../../shared/budget.ts";
import {
  checkBudgetCaps,
  formatBudgetTripComment,
  type BudgetTrip,
} from "../../../shared/budget/caps.ts";
import { forensicFooter, makeParkDumper } from "../../../shared/forensic/dump.ts";
import { kickbackToDev } from "../../../shared/agent/kickback.ts";
import {
  RECORD_LESSON_TOOL,
  buildMemoryBlock,
  dispatchRecordLesson,
} from "../../../shared/agent/memory-tool.ts";
import { getLessons } from "../../../shared/state/team-memory.ts";
import {
  buildReadToolDefinitions,
  dispatchReadTool,
} from "../../../shared/agent/read-tools.ts";
import {
  buildWriteToolDefinitions,
  dispatchWriteTool,
} from "../../../shared/agent/write-tools.ts";
import { getInstallationTokenFromSecret } from "../../../shared/github/auth.ts";
import {
  addLabels,
  findOpenPRByHead,
  getIssue,
  mergePR,
  postComment,
  transitionLabel,
  type GitHubIssue,
  type MergePRResult,
} from "../../../shared/github/repo.ts";
import { readSpecTree, type SpecReadResult } from "../../../shared/github/spec.ts";
import { hashSpecTree } from "../../../shared/github/spec-hashes.ts";
import { isGateActive, notifySlack } from "../../../shared/slack/notify.ts";
import {
  GAP_LABELS,
  HUMAN_NEEDED_LABEL,
  STATE_LABELS,
  parseIterLabel,
} from "../../../shared/labels.ts";
import {
  costUsd,
  getModelByTier,
  type SystemBlock,
  type ToolDefinition,
} from "../../../shared/models.ts";
import { requiredEnv } from "../../../shared/env.ts";
import {
  putSpecHashesAtMerge,
  requireBAExpansion,
} from "../../../shared/state/issue-state.ts";
import {
  requireMergerInstallId,
  requireProduct,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../shared/state/products.ts";
import { normalizePOReport, type POReport } from "./plan.ts";
import { clonePrBranch, type ClonedPrWorkdir } from "./workdir.ts";

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
const TEAM_MEMORY_TABLE = requiredEnv("AGENT_FORGE_TEAM_MEMORY_TABLE");
const FORENSIC_BUCKET = process.env.AGENT_FORGE_FORENSIC_BUCKET;
// Optional: only required when product.auto_merge is true. F.2.a wires PO's
// merge call through the merger App (writer App can't merge against branch
// protection that requires the merger).
const MERGER_SECRET_NAME = process.env.AGENT_FORGE_MERGER_SECRET_NAME;
const ROLE = requiredEnv("AGENT_FORGE_ROLE");
const ENV = requiredEnv("AGENT_FORGE_ENV");
const DELIVERY_ID = process.env.AGENT_FORGE_DELIVERY_ID ?? "unknown";
const LABEL = process.env.AGENT_FORGE_LABEL ?? "unknown";

const USER_AGENT = `agent-forge-${ROLE}`;
const DEFAULT_PER_ISSUE_BUDGET_CAP_USD = 12;
const AGENT_MAX_TURNS = 30;
const AGENT_MAX_TOKENS_PER_TURN = 4096;

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

const dumpForensicForPark = makeParkDumper({
  bucket: FORENSIC_BUCKET,
  issueStateTable: ISSUE_STATE_TABLE,
  productId: PRODUCT_ID,
  issueNumber: ISSUE_NUMBER,
  role: ROLE,
  log,
});

// ---------------------------------------------------------------------------
// System prompt + tool
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `
You are agent-forge's Product Owner (PO) role. Every other role has done
their part; you are the final gate before a PR ships. Your job is one
question: does this PR fulfil the issue's acceptance criteria as
specified, with no gaps or scope creep?

The shallow clone is checked out to the PR branch. You have:

- list_directory(path)              — enumerate children.
- grep(pattern, path)               — recursive regex search.
- read_file(path)                   — fetch one file (100 KB cap).
- write_file(path, content)         — for scratch only; nothing you write
                                     is committed or pushed.
- bash(cmd, cwd?, timeout_seconds?) — /bin/bash -c. Use for:
                                       * \`git log --oneline origin/HEAD..HEAD\`
                                       * \`git diff origin/HEAD..HEAD\`
                                       * \`git show --stat <sha>\` per commit
                                       * Re-reading a spec section or a
                                         relevant area of the codebase.
- submit_po_verdict(verdict, summary, details) — TERMINAL.

What to check:

  1. Read the BA expansion (passed in the user message). Each acceptance
     criterion must be observably met by the PR's actual changes.
  2. Read the cited spec section(s). Does the PR match what the spec
     describes? Anything contradicting the spec is a kickback regardless
     of whether ACs pass.
  3. Read the Test + Functional + Security comments on the linked issue
     (use \`gh issue view\` via bash, or just trust their summaries from
     the user message). They've already done their part; you're not
     re-running their work, you're verifying nothing slipped between them.
  4. Look at the whole diff. Anything outside the locked areas? Anything
     dead-code, anything left undone (TODOs, half-implementations)?

Verdicts:

  - **approve**: every AC is observably met, no spec conflicts, no scope
                 creep, no obvious quality issues. Recommend merge.
  - **kickback**: one or more ACs missed, or a spec conflict, or work
                  outside scope, or quality issues that need a Dev fix.
                  Be specific in \`details\` — name the file/line, point
                  to the AC or spec section.
  - **spec_ambig**: the spec doesn't actually answer "is this correct?"
                    The issue or spec must change, not Dev. Pause for a
                    human.

Approve verdicts auto-merge only when the product row has
\`auto_merge=true\`. Otherwise the wrapper posts a "recommend-merge"
comment and parks at human-needed for a human to merge. This supports the
architecture's "first 30 days" approval-gate pattern.

You CANNOT modify or commit code. You CANNOT merge PRs. Just review.

Do not produce free-form text outside the tool-call exchange.
`.trim();

const SUBMIT_PO_VERDICT_TOOL: ToolDefinition = {
  name: "submit_po_verdict",
  description:
    "Declare PO review complete. verdict must be one of " +
    "'approve' | 'kickback' | 'spec_ambig'. approve auto-merges only when " +
    "products.auto_merge=true; kickback returns to Dev unless the iter cap " +
    "has been reached; spec_ambig always parks for human clarification.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["verdict", "summary", "details"],
    properties: {
      verdict: {
        enum: ["approve", "kickback", "spec_ambig"],
        description: "Ship/no-ship gate.",
      },
      summary: {
        type: "string",
        description:
          "1-2 sentence headline ('Recommend merge — all four ACs met; " +
          "the new section is in the right place and references the actual " +
          "npm script').",
      },
      details: {
        type: "string",
        description:
          "For approve: brief justification per AC. For kickback: concrete " +
          "deltas, named files/lines, mapped to ACs or spec. For spec_ambig: " +
          "the unclear spec section + why it's unclear.",
      },
    },
  },
};

function buildSystemBlocks(
  spec: SpecReadResult,
  memoryBlock: string,
): SystemBlock[] {
  const memoryBlocks: SystemBlock[] = memoryBlock
    ? [{ type: "text", text: memoryBlock, cache_control: { type: "ephemeral" } }]
    : [];
  if (spec.missing || spec.files.length === 0) {
    return [
      { type: "text", text: BASE_SYSTEM_PROMPT },
      ...memoryBlocks,
    ];
  }
  const specBlocks = spec.files
    .map((f) => `<file path="${f.path}">\n${f.content.trim()}\n</file>`)
    .join("\n\n");
  const specText = [
    "=====================",
    "PRODUCT SPECIFICATION",
    "=====================",
    "This is what 'correct' means for this product. The PR must match it.",
    "",
    specBlocks,
  ].join("\n");
  return [
    { type: "text", text: BASE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: specText, cache_control: { type: "ephemeral" } },
    ...memoryBlocks,
  ];
}

function buildUserMessage(args: {
  issue: GitHubIssue;
  baExpansion: Awaited<ReturnType<typeof requireBAExpansion>>;
  branchName: string;
}): string {
  const ac = (args.baExpansion.acceptance_criteria ?? [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const oos = (args.baExpansion.out_of_scope ?? [])
    .map((s) => `- ${s}`)
    .join("\n") || "_(none)_";
  return [
    `Issue #${args.issue.number}: ${args.issue.title}`,
    "",
    "## Issue body",
    args.issue.body ?? "(no body)",
    "",
    "## BA expansion (the source of truth for what this PR must do)",
    `**Complexity:** ${args.baExpansion.complexity ?? "(unset)"}`,
    "",
    "**Areas:** " + ((args.baExpansion.areas ?? []).join(", ") || "_(unset)_"),
    "",
    "### Acceptance criteria",
    ac || "_(none extracted — treat the issue body as the spec)_",
    "",
    "### Out of scope per BA",
    oos,
    "",
    "## Workspace",
    `You're on branch \`${args.branchName}\` with Dev + Test commits applied. ` +
      "Run `git log origin/HEAD..HEAD` to see the change set and " +
      "`git diff origin/HEAD..HEAD` for the whole diff.",
    "",
    "Prior-role reports (Test, Functional, Security) are visible as " +
      `comments on the linked issue. You can read them via \`gh issue view ${args.issue.number}\` ` +
      "in bash if helpful, or just trust their summaries — you're verifying " +
      "the PR against the BA expansion, not redoing their work.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentPoApprove(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: POReport;
  gateActive?: boolean;
  gateUntil?: string;
}): string {
  const gateLine = args.gateActive
    ? `Parking at \`${HUMAN_NEEDED_LABEL}\`. The **30-day approval gate** is ` +
      `active for this product${args.gateUntil ? ` (expires ${args.gateUntil})` : ""} — ` +
      `auto-merge is suppressed during the confidence-building window even if ` +
      `\`products.auto_merge = true\`. A human should merge the PR and ` +
      "transition this issue to `state:done`. The team's Slack channel has " +
      "been notified (when `products.slack_webhook_url` is configured)."
    : `Parking at \`${HUMAN_NEEDED_LABEL}\`. The PR is **not auto-merged** ` +
      "because `products.auto_merge` is false for this product. A human should " +
      "merge the PR and transition this issue to `state:done`.";
  const flipLine = args.gateActive
    ? "After the gate expires, `products.auto_merge = true` lets PO merge directly on `approve`."
    : "Flip `products.auto_merge = true` for this product to let PO merge directly on `approve`.";
  return [
    `## PO review: RECOMMEND APPROVE (Slice F.1, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.details ? "### Reasoning\n\n" + args.report.details + "\n" : "",
    gateLine,
    "",
    flipLine,
  ].filter((s) => s !== "").join("\n");
}

function buildSlackApprovalBlocks(args: {
  repo: string;
  issueNumber: number;
  issueTitle: string;
  report: POReport;
  gateActive: boolean;
  gateUntil?: string;
}): Array<Record<string, unknown>> {
  const issueUrl = `https://github.com/${args.repo}/issues/${args.issueNumber}`;
  const gateLine = args.gateActive
    ? `:lock: 30-day approval gate active${args.gateUntil ? ` (until ${args.gateUntil})` : ""}`
    : ":unlock: approval gate inactive";
  return [
    {
      type: "header",
      text: { type: "plain_text", text: `agent-forge: recommend merge #${args.issueNumber}` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${args.issueTitle}*\n${issueUrl}\n\n${args.report.summary}`,
      },
    },
    ...(args.report.details
      ? [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                "*Reasoning*\n" +
                args.report.details.slice(0, 1500) +
                (args.report.details.length > 1500 ? "…" : ""),
            },
          },
        ]
      : []),
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: gateLine },
        {
          type: "mrkdwn",
          text: "Merge directly on GitHub. State transition is manual until the gate expires.",
        },
      ],
    },
  ];
}

function commentPoMerged(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: POReport;
  prNumber: number;
  prUrl: string;
  sha: string;
}): string {
  return [
    `## PO review: MERGED (Slice F.2, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.details ? "### Reasoning\n\n" + args.report.details + "\n" : "",
    `Squash-merged ${args.prUrl} (#${args.prNumber}) onto the default branch at \`${args.sha.slice(0, 12)}\`.`,
    "",
    `Transitioning \`${STATE_LABELS.awaitingPo}\` → \`${STATE_LABELS.done}\`.`,
  ].filter((s) => s !== "").join("\n");
}

function commentPoMergeFailed(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: POReport;
  prNumber?: number;
  prUrl?: string;
  reason: string;
  forensicUri?: string;
}): string {
  return [
    `## PO review: APPROVE but MERGE FAILED (Slice F.2, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.details ? "### Reasoning\n\n" + args.report.details + "\n" : "",
    args.prNumber !== undefined && args.prUrl
      ? `Tried to merge ${args.prUrl} (#${args.prNumber}) but the merge call failed:`
      : "Tried to merge but couldn't find the open PR for this issue's Dev branch:",
    "",
    "```",
    args.reason,
    "```",
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`. A human should investigate (branch protection / out-of-date / conflict / etc.) and merge manually, or revert the PO verdict.`,
    args.forensicUri ? "\n" + forensicFooter(args.forensicUri) : "",
  ].filter((s) => s !== "").join("\n");
}

function commentPoKickbackToDev(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: POReport;
  newAttempt: number;
  kickbackCount: number;
}): string {
  return [
    `## PO review: KICKBACK (Slice F.2.b, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.details ? "### Deltas to fix\n\n" + args.report.details + "\n" : "",
    `Kicking back to Dev — transitioning \`${STATE_LABELS.awaitingPo}\` → \`${STATE_LABELS.ready}\` with \`iter:${args.newAttempt}\`. (Kickback count for this issue: ${args.kickbackCount}.)`,
  ].filter((s) => s !== "").join("\n");
}

function commentPoKickbackCapped(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: POReport;
  forensicUri?: string;
}): string {
  return [
    `## PO review: KICKBACK → AT CAP (Slice F.2.b, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.details ? "### Deltas to fix\n\n" + args.report.details + "\n" : "",
    `Already at \`iter:3\` (the per-issue Dev attempt cap). Parking at \`${HUMAN_NEEDED_LABEL}\` rather than re-kickback. A human should rescope the issue, accept the PR as-is, or close it.`,
    args.forensicUri ? "\n" + forensicFooter(args.forensicUri) : "",
  ].filter((s) => s !== "").join("\n");
}

function commentPoSpecAmbig(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: POReport;
  forensicUri?: string;
}): string {
  return [
    `## PO review: SPEC AMBIGUOUS (Slice F.1, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.details ? "### What's unclear\n\n" + args.report.details + "\n" : "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`. The spec needs clarification, not ` +
      "Dev — humans should resolve the ambiguity (revise the spec, refine the " +
      "issue, or close as won't-do).",
    args.forensicUri ? "\n" + forensicFooter(args.forensicUri) : "",
  ].filter((s) => s !== "").join("\n");
}

function commentNoReport(args: {
  runId: string;
  modelId: string;
  turns: number;
  stopReason: string;
  forensicUri?: string;
}): string {
  return [
    `## PO review did not complete (Slice F.1, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"}, stop=\`${args.stopReason}\`)`,
    "",
    "Agent exited without calling `submit_po_verdict`.",
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
    args.forensicUri ? "\n" + forensicFooter(args.forensicUri) : "",
  ].filter((s) => s !== "").join("\n");
}

function commentMissingExpansion(runId: string): string {
  return [
    `## PO blocked (run \`${runId}\`)`,
    "",
    "Can't run: `issue_state.ba_expansion` is missing for this issue.",
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
  ].join("\n");
}

function commentBudgetCapTripped(args: {
  runId: string;
  spentSoFar: number;
  capUsd: number;
}): string {
  return [
    `## PO did not run (run \`${args.runId}\`)`,
    "",
    `Per-issue budget cap tripped: spent so far **$${args.spentSoFar.toFixed(4)}**, ` +
      `cap is **$${args.capUsd.toFixed(2)}**.`,
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
  ].join("\n");
}

function commentDayBudgetTripped(args: {
  runId: string;
  trip: BudgetTrip;
}): string {
  return [
    `## PO did not run (run \`${args.runId}\`)`,
    "",
    formatBudgetTripComment(args.trip),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type AutoMergeResult =
  | {
      kind: "merged";
      prNumber: number;
      prUrl: string;
      sha: string;
    }
  | {
      kind: "failed";
      reason: string;
      prNumber?: number;
      prUrl?: string;
    };

async function tryAutoMerge(args: {
  ghOpts: { token: string; userAgent: string };
  product: ProductConfig;
  report: POReport;
  model: { bedrockModelId: string };
  turns: number;
  runId: string;
}): Promise<AutoMergeResult> {
  if (!MERGER_SECRET_NAME) {
    return {
      kind: "failed",
      reason:
        "products.auto_merge is true but AGENT_FORGE_MERGER_SECRET_NAME isn't " +
        "set in the PO task environment. Configure infra to pass it through.",
    };
  }

  // 1. Find the PR Dev opened (by branch convention).
  const branchName = `agent-forge/dev/issue-${ISSUE_NUMBER}`;
  const pr = await findOpenPRByHead(args.ghOpts, REPO, branchName);
  if (!pr) {
    return {
      kind: "failed",
      reason:
        `No open PR found for branch \`${branchName}\`. Did Dev's PR already ` +
        "get merged or closed?",
    };
  }

  // 2. Mint a merger-App token. Branch protection on `main` requires review
  //    from the merger App per CLAUDE.md, so the writer App's token (which
  //    PO uses everywhere else) cannot actually merge.
  let mergerInstallId: string;
  try {
    mergerInstallId = requireMergerInstallId(args.product);
  } catch (err) {
    return {
      kind: "failed",
      reason: `products[${PRODUCT_ID}] has no merger_install_id; merger App must be installed on this target repo.`,
      prNumber: pr.number,
      prUrl: pr.html_url,
    };
  }

  let mergerToken: string;
  try {
    const minted = await getInstallationTokenFromSecret(
      MERGER_SECRET_NAME,
      mergerInstallId,
    );
    mergerToken = minted.token;
  } catch (err) {
    return {
      kind: "failed",
      reason: `Could not mint merger installation token: ${err instanceof Error ? err.message : String(err)}`,
      prNumber: pr.number,
      prUrl: pr.html_url,
    };
  }

  // 3. Squash-merge. Commit title = report summary; body = report details.
  //    Squash so main's history stays a single commit per issue regardless
  //    of how many Dev + Test + Functional commits the PR carried.
  const mergerGhOpts = { token: mergerToken, userAgent: USER_AGENT };
  const result = await mergePR(mergerGhOpts, REPO, pr.number, {
    mergeMethod: "squash",
    commitTitle: args.report.summary,
    commitMessage: args.report.details,
  });
  if (result.ok) {
    return {
      kind: "merged",
      prNumber: pr.number,
      prUrl: pr.html_url,
      sha: result.sha,
    };
  }
  return {
    kind: "failed",
    reason: `HTTP ${result.status}: ${result.body.slice(0, 800)}`,
    prNumber: pr.number,
    prUrl: pr.html_url,
  };
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

const TOOL_OUTPUT_CAP_BYTES = 16384;

type DispatcherResult = { content: string; is_error?: boolean };

function wrapToolResult(
  callId: string,
  r: DispatcherResult,
): { tool_use_id: string; content: string; is_error?: boolean } {
  const out =
    r.content.length > TOOL_OUTPUT_CAP_BYTES
      ? `${r.content.slice(0, TOOL_OUTPUT_CAP_BYTES)}\n[... tool output truncated at ${TOOL_OUTPUT_CAP_BYTES} bytes ...]`
      : r.content;
  const wrapped: { tool_use_id: string; content: string; is_error?: boolean } = {
    tool_use_id: callId,
    content: out,
  };
  if (r.is_error) wrapped.is_error = true;
  return wrapped;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log({ msg: "starting", repo: REPO, label: LABEL });

  if (LABEL && LABEL !== STATE_LABELS.awaitingPo) {
    log({ msg: "non-state:awaiting-po label fired; nothing to do", label: LABEL });
    return;
  }

  const product = await fetchProductRow();
  const writerInstallId = requireWriterInstallId(product);

  const { token } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    writerInstallId,
  );
  log({ msg: "minted installation token" });

  const issue = await getIssue({ token, userAgent: USER_AGENT }, REPO, ISSUE_NUMBER);
  log({ msg: "fetched issue", title: issue.title });

  const ghOpts = { token, userAgent: USER_AGENT };
  const runId = runIdFromEnv();

  // Budget cap pre-check.
  const budgetCapUsd =
    product.per_issue_budget_cap_usd ?? DEFAULT_PER_ISSUE_BUDGET_CAP_USD;
  const spentSoFar = await getIssueSpendUsd({
    tableName: BUDGET_LEDGER_TABLE,
    productId: PRODUCT_ID,
    issueNumber: ISSUE_NUMBER,
  });
  log({ msg: "budget pre-check", spent_so_far_usd: spentSoFar, cap_usd: budgetCapUsd });
  if (spentSoFar >= budgetCapUsd) {
    await postComment(ghOpts, REPO, ISSUE_NUMBER, commentBudgetCapTripped({
      runId, spentSoFar, capUsd: budgetCapUsd,
    }));
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.awaitingPo,
      HUMAN_NEEDED_LABEL,
    );
    return;
  }

  const capCheck = await checkBudgetCaps({
    productsTable: PRODUCTS_TABLE,
    budgetLedgerTable: BUDGET_LEDGER_TABLE,
    productId: PRODUCT_ID,
    role: ROLE,
    product,
  });
  if (!capCheck.ok) {
    log({ msg: "day-scope budget cap tripped", trip: capCheck.trip });
    await postComment(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      commentDayBudgetTripped({ runId, trip: capCheck.trip }),
    );
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.awaitingPo,
      HUMAN_NEEDED_LABEL,
    );
    return;
  }

  let baExpansion;
  try {
    baExpansion = await requireBAExpansion({
      tableName: ISSUE_STATE_TABLE,
      productId: PRODUCT_ID,
      issueNumber: ISSUE_NUMBER,
    });
  } catch (err) {
    log({ msg: "missing BA expansion; parking", error: String(err) });
    await postComment(ghOpts, REPO, ISSUE_NUMBER, commentMissingExpansion(runId));
    await addLabels(ghOpts, REPO, ISSUE_NUMBER, [GAP_LABELS.areasIncomplete]);
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.awaitingPo,
      HUMAN_NEEDED_LABEL,
    );
    return;
  }

  const branchName = `agent-forge/dev/issue-${ISSUE_NUMBER}`;
  let workdir: ClonedPrWorkdir | undefined;
  try {
    workdir = await clonePrBranch({ token, repo: REPO, runId, branchName });
    log({ msg: "cloned PR branch", workdir: workdir.path, branch: branchName });

    const specPath = product.spec_path ?? "spec/";
    const spec = await readSpecTree({
      token, userAgent: USER_AGENT, repo: REPO, path: specPath,
    });
    log({ msg: "read spec", spec_path: specPath, files: spec.files.length });

    const lessons = await getLessons({
      tableName: TEAM_MEMORY_TABLE,
      productId: PRODUCT_ID,
      role: ROLE,
    });
    const memoryBlock = buildMemoryBlock(ROLE, lessons);
    log({ msg: "loaded team memory", lessons: lessons.length });

    // PO runs on Opus — the gate where a wrong merge costs more than the
    // model premium per CLAUDE.md → Roles → Product Owner.
    const model = getModelByTier("opus-4-6");
    const userMessage = buildUserMessage({ issue, baExpansion, branchName });

    let capturedReport: POReport | undefined;
    const toolCallCounts: Record<string, number> = {};
    const wd = workdir.path;
    const executeTool = async (call: ToolCall) => {
      toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;
      if (call.name === "submit_po_verdict") {
        const report = normalizePOReport(call.input);
        capturedReport = report;
        log({
          msg: "submit_po_verdict received",
          raw: call.input,
          normalized: report,
        });
        return {
          tool_use_id: call.id,
          content: `Verdict recorded (${report.verdict}). The loop ends here.`,
          terminate: true,
        };
      }
      if (call.name === RECORD_LESSON_TOOL.name) {
        const r = await dispatchRecordLesson({
          tableName: TEAM_MEMORY_TABLE,
          productId: PRODUCT_ID,
          role: ROLE,
          runId,
          rawInput: call.input,
        });
        return wrapToolResult(call.id, r);
      }
      const read = await dispatchReadTool(wd, call.name, call.input);
      if (read) return wrapToolResult(call.id, read);
      const write = await dispatchWriteTool(wd, call.name, call.input);
      if (write) return wrapToolResult(call.id, write);
      return {
        tool_use_id: call.id,
        content:
          `Unknown tool: ${call.name}. Call one of read_file, list_directory, ` +
          "grep, write_file, bash, record_lesson, or submit_po_verdict.",
        is_error: true,
      };
    };

    const tools = [
      ...buildReadToolDefinitions(),
      ...buildWriteToolDefinitions(),
      RECORD_LESSON_TOOL,
      SUBMIT_PO_VERDICT_TOOL,
    ];
    const loop = await runAgentLoop({
      model,
      system: buildSystemBlocks(spec, memoryBlock),
      initialMessages: [{ role: "user", content: userMessage }],
      tools,
      executeTool,
      maxTurns: AGENT_MAX_TURNS,
      maxTokensPerTurn: AGENT_MAX_TOKENS_PER_TURN,
      temperature: 0,
    });

    log({
      msg: "agent loop done",
      stop_reason: loop.stopReason,
      turns: loop.turns,
      tool_calls: toolCallCounts,
      usage: loop.usage,
      cost_usd: loop.costUsd,
      verdict: capturedReport?.verdict,
    });

    if (capturedReport && capturedReport.verdict === "approve") {
      // D2: snapshot per-file spec hashes onto issue_state so the weekly
      // drift audit has a baseline to compare against. Done for both the
      // auto-merge and recommend-only paths — a human-merged issue
      // benefits from drift detection just as much as an auto-merged one.
      // Best-effort: a write failure here logs but doesn't block the
      // merge/recommend; drift audit just skips issues with no baseline.
      try {
        const hashes = hashSpecTree(spec);
        if (Object.keys(hashes).length > 0) {
          await putSpecHashesAtMerge({
            tableName: ISSUE_STATE_TABLE,
            productId: PRODUCT_ID,
            issueNumber: ISSUE_NUMBER,
            hashes: {
              hashed_at: new Date().toISOString(),
              hashes,
            },
          });
          log({ msg: "wrote spec_hashes_at_merge", files: Object.keys(hashes).length });
        } else {
          log({ msg: "spec is empty; skipping spec_hashes_at_merge" });
        }
      } catch (err) {
        log({
          msg: "putSpecHashesAtMerge failed (non-fatal)",
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Phase E: 30-day approval gate. While active, force auto_merge off
      // regardless of the product's flag — a human must merge through the
      // first 30 days to establish PR-accuracy confidence. After the gate
      // expires (`approval_gate_until` in the past or unset), auto_merge
      // takes effect as configured.
      const gateActive = isGateActive(product.approval_gate_until);
      const autoMergeAllowed = product.auto_merge === true && !gateActive;
      log({
        msg: "approval gate check",
        gate_active: gateActive,
        approval_gate_until: product.approval_gate_until ?? "(unset)",
        auto_merge_configured: product.auto_merge === true,
        auto_merge_allowed: autoMergeAllowed,
      });

      // F.2.a: if products.auto_merge is true (and the approval gate isn't
      // active), mint a merger-App token and attempt the actual merge. On
      // success → state:done. On failure or misconfig → park at human-needed
      // with the failure reason in the comment. If auto_merge is false (or
      // gate-suppressed), fall back to F.1 behavior — post a
      // recommend-approve comment and park.
      if (autoMergeAllowed) {
        const mergeResult = await tryAutoMerge({
          ghOpts,
          product,
          report: capturedReport,
          model,
          turns: loop.turns,
          runId,
        });
        if (mergeResult.kind === "merged") {
          await postComment(
            ghOpts,
            REPO,
            ISSUE_NUMBER,
            commentPoMerged({
              runId,
              modelId: model.bedrockModelId,
              turns: loop.turns,
              report: capturedReport,
              prNumber: mergeResult.prNumber,
              prUrl: mergeResult.prUrl,
              sha: mergeResult.sha,
            }),
          );
          await transitionLabel(
            ghOpts,
            REPO,
            ISSUE_NUMBER,
            STATE_LABELS.awaitingPo,
            STATE_LABELS.done,
          );
        } else {
          const forensicUri = await dumpForensicForPark({
            reason: `PO approved but auto-merge failed: ${mergeResult.reason}`,
            stopReason: loop.stopReason,
            turns: loop.turns,
            toolCallCounts,
            loopMessages: loop.messages,
            costUsd: loop.costUsd,
            extra: {
              verdict: capturedReport.verdict,
              report: capturedReport,
              merge_failure: mergeResult,
            },
            runId,
          });
          await postComment(
            ghOpts,
            REPO,
            ISSUE_NUMBER,
            commentPoMergeFailed({
              runId,
              modelId: model.bedrockModelId,
              turns: loop.turns,
              report: capturedReport,
              ...(mergeResult.prNumber !== undefined ? { prNumber: mergeResult.prNumber } : {}),
              ...(mergeResult.prUrl !== undefined ? { prUrl: mergeResult.prUrl } : {}),
              reason: mergeResult.reason,
              ...(forensicUri ? { forensicUri } : {}),
            }),
          );
          await transitionLabel(
            ghOpts,
            REPO,
            ISSUE_NUMBER,
            STATE_LABELS.awaitingPo,
            HUMAN_NEEDED_LABEL,
          );
        }
      } else {
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentPoApprove({
            runId,
            modelId: model.bedrockModelId,
            turns: loop.turns,
            report: capturedReport,
            gateActive,
            ...(product.approval_gate_until ? { gateUntil: product.approval_gate_until } : {}),
          }),
        );
        // Phase E: notify Slack so the team sees the recommend-merge in
        // their channel of choice. Only fires when the webhook is
        // configured; gate-active runs still post even if auto_merge was
        // off, so the channel sees every recommendation during the
        // confidence-building window.
        if (product.slack_webhook_url) {
          const slackResult = await notifySlack(product.slack_webhook_url, {
            text: `agent-forge PO recommends merging issue #${ISSUE_NUMBER} in ${REPO}`,
            blocks: buildSlackApprovalBlocks({
              repo: REPO,
              issueNumber: ISSUE_NUMBER,
              issueTitle: issue.title,
              report: capturedReport,
              gateActive,
              ...(product.approval_gate_until ? { gateUntil: product.approval_gate_until } : {}),
            }),
          });
          if (!slackResult.ok) {
            log({
              msg: "slack notify failed (non-fatal)",
              status: slackResult.status,
              body: slackResult.body,
            });
          } else {
            log({ msg: "slack notified", status: slackResult.status });
          }
        }
        await transitionLabel(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          STATE_LABELS.awaitingPo,
          HUMAN_NEEDED_LABEL,
        );
      }
    } else if (capturedReport && capturedReport.verdict === "kickback") {
      // F.2.b: kickback to Dev unless at iter:3 cap.
      const currentAttempt = parseIterLabel(issue.labels ?? []);
      const k = await kickbackToDev({
        ghOpts,
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        currentState: STATE_LABELS.awaitingPo,
        currentAttempt,
        issueStateTable: ISSUE_STATE_TABLE,
        productId: PRODUCT_ID,
        fromRole: ROLE,
        runId,
      });
      if (k.kind === "kickback") {
        log({
          msg: "kicked back to Dev",
          from_state: STATE_LABELS.awaitingPo,
          new_attempt: k.newAttempt,
          kickback_count: k.kickbackCount,
        });
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentPoKickbackToDev({
            runId,
            modelId: model.bedrockModelId,
            turns: loop.turns,
            report: capturedReport,
            newAttempt: k.newAttempt,
            kickbackCount: k.kickbackCount,
          }),
        );
      } else {
        log({ msg: "at iter cap; parking instead of kicking back" });
        const forensicUri = await dumpForensicForPark({
          reason: "PO kickback but issue is at iter:3 cap; parked",
          stopReason: loop.stopReason,
          turns: loop.turns,
          toolCallCounts,
          loopMessages: loop.messages,
          costUsd: loop.costUsd,
          extra: {
            verdict: capturedReport.verdict,
            report: capturedReport,
          },
          runId,
        });
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentPoKickbackCapped({
            runId,
            modelId: model.bedrockModelId,
            turns: loop.turns,
            report: capturedReport,
            ...(forensicUri ? { forensicUri } : {}),
          }),
        );
        await transitionLabel(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          STATE_LABELS.awaitingPo,
          HUMAN_NEEDED_LABEL,
        );
      }
    } else if (capturedReport && capturedReport.verdict === "spec_ambig") {
      const forensicUri = await dumpForensicForPark({
        reason: "PO flagged spec as ambiguous; parked for human resolution",
        stopReason: loop.stopReason,
        turns: loop.turns,
        toolCallCounts,
        loopMessages: loop.messages,
        costUsd: loop.costUsd,
        extra: {
          verdict: capturedReport.verdict,
          report: capturedReport,
        },
        runId,
      });
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentPoSpecAmbig({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          report: capturedReport,
          ...(forensicUri ? { forensicUri } : {}),
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingPo,
        HUMAN_NEEDED_LABEL,
      );
    } else {
      const forensicUri = await dumpForensicForPark({
        reason: `PO did not call submit_po_verdict (stop=${loop.stopReason})`,
        stopReason: loop.stopReason,
        turns: loop.turns,
        toolCallCounts,
        loopMessages: loop.messages,
        costUsd: loop.costUsd,
        runId,
      });
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentNoReport({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          stopReason: loop.stopReason,
          ...(forensicUri ? { forensicUri } : {}),
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingPo,
        HUMAN_NEEDED_LABEL,
      );
    }

    await recordSpend({
      tableName: BUDGET_LEDGER_TABLE,
      runId,
      spend: {
        product_id: PRODUCT_ID,
        issue_number: ISSUE_NUMBER,
        role: ROLE,
        model: model.bedrockModelId,
        input_tokens: loop.usage.input_tokens,
        cached_tokens: loop.usage.cached_tokens,
        output_tokens: loop.usage.output_tokens,
        cost_usd: loop.costUsd,
      },
    });

    const recomputed = costUsd("opus-4-6", {
      input: loop.usage.input_tokens,
      cached: loop.usage.cached_tokens,
      output: loop.usage.output_tokens,
    });
    if (Math.abs(recomputed - loop.costUsd) > 1e-9) {
      log({
        msg: "cost mismatch — pricing table may have drifted",
        recomputed,
        reported: loop.costUsd,
      });
    }
  } finally {
    if (workdir) {
      try {
        await workdir.cleanup();
        log({ msg: "cleaned up workdir", path: workdir.path });
      } catch (err) {
        log({
          msg: "workdir cleanup failed (non-fatal)",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  log({ msg: "done" });
}

async function fetchProductRow(): Promise<ProductConfig> {
  return requireProduct({
    tableName: PRODUCTS_TABLE,
    productId: PRODUCT_ID,
  });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(JSON.stringify({ role: ROLE, level: "error", msg }));
  process.exit(1);
});
