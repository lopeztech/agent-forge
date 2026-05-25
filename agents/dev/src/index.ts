// Dev (Developer) — Slice B.3: code changes + git push + PR open.
//
// Trigger: issue gets label `state:ready`. EventBridge → Step Function → this
// Fargate task. Env vars come from RunTask container overrides
// (see infra/modules/step-functions/asl/dev-issue-lifecycle.asl.json).
//
// B.3 makes Dev actually do the work. After area-lock acquisition:
//   1. shallow-clone the target repo's default branch into /tmp/<runId>
//   2. configure git (committer name/email per role) + check out a fresh
//      feature branch `agent-forge/dev/issue-<N>`
//   3. run a Sonnet 4.6 loop with read tools (read_file/list_directory/grep),
//      write tools (write_file/bash), and a terminal `submit_done` tool
//   4. on submit_done: auto-commit any uncommitted tree state with the
//      agent's submission summary, run product.test_command (or npm test
//      fallback when package.json exists), push the branch, open the PR,
//      transition state:ready → state:awaiting-tests.
//
// If submit_done fails partway (no changes, tests failed, push refused, PR
// API non-2xx), the wrapper returns the error to the agent with terminate=false
// (for changes/tests) or terminate=true (for infra-level failures), so the
// agent gets another shot at the recoverable cases.
//
// Branch behaviours:
//   1. No `area:*` labels at all              → park with gap:areas-incomplete.
//   2. `area:*` and areas.yml missing         → park with gap:areas-incomplete.
//   3. Concrete or area:* (expanded) areas    → acquire locks → clone + setup →
//      Sonnet 4.6 loop → submit_done flow → either PR-shipped or human-needed
//      → release locks + cleanup workdir → record spend.
//   4. Lock contention                        → park at `human-needed`.
//
// Out of scope this slice (deliberate):
//   - iter:N attempt counter + Sonnet → Opus escalation (B.4)
//   - Per-issue budget cap check before model call (B.4)
//   - Kickback handling for failed PRs (B.4)

import { runAgentLoop, type ToolCall } from "../../../shared/agent-loop.ts";
import { getIssueSpendUsd, recordSpend } from "../../../shared/budget.ts";
import {
  checkBudgetCaps,
  formatBudgetTripComment,
  type BudgetTrip,
} from "../../../shared/budget/caps.ts";
import { forensicFooter, makeParkDumper } from "../../../shared/forensic/dump.ts";
import {
  RECORD_LESSON_TOOL,
  buildMemoryBlock,
  dispatchRecordLesson,
} from "../../../shared/agent/memory-tool.ts";
import { getLessons } from "../../../shared/state/team-memory.ts";
import { getInstallationTokenFromSecret } from "../../../shared/github/auth.ts";
import { readAreasFile } from "../../../shared/github/areas.ts";
import {
  addLabels,
  getIssue,
  postComment,
  transitionLabel,
  type GitHubIssue,
} from "../../../shared/github/repo.ts";
import { readSpecTree, type SpecReadResult } from "../../../shared/github/spec.ts";
import {
  AREA_ALL_LABEL,
  GAP_LABELS,
  HUMAN_NEEDED_LABEL,
  STATE_LABELS,
  hasComplexityHighLabel,
  iterLabel,
  parseAreaLabels,
  parseIterLabel,
  type IterAttempt,
} from "../../../shared/labels.ts";
import { acquireAreaLocks } from "../../../shared/locks/area-locks.ts";
import { addWaiter } from "../../../shared/locks/waiters.ts";
import {
  costUsd,
  getModelByTier,
  tierForDev,
  type ModelTier,
  type SystemBlock,
  type ToolDefinition,
} from "../../../shared/models.ts";
import { requiredEnv } from "../../../shared/env.ts";
import { requireBAExpansion } from "../../../shared/state/issue-state.ts";
import {
  requireProduct,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../shared/state/products.ts";
import { finalize, setupWorkdir, type FinalizeResult } from "./finalize.ts";
import { normalizeSubmission, type Submission } from "./plan.ts";
import {
  buildReadToolDefinitions,
  dispatchReadTool,
} from "../../../shared/agent/read-tools.ts";
import {
  buildWriteToolDefinitions,
  dispatchWriteTool,
} from "../../../shared/agent/write-tools.ts";
import { cloneTargetRepo, type ClonedWorkdir } from "./workdir.ts";

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
const AREA_LOCKS_TABLE = requiredEnv("AGENT_FORGE_AREA_LOCKS_TABLE");
const TEAM_MEMORY_TABLE = requiredEnv("AGENT_FORGE_TEAM_MEMORY_TABLE");
const LOCK_WAITERS_TABLE = requiredEnv("AGENT_FORGE_LOCK_WAITERS_TABLE");
const FORENSIC_BUCKET = process.env.AGENT_FORGE_FORENSIC_BUCKET;
const ROLE = requiredEnv("AGENT_FORGE_ROLE");
const ENV = requiredEnv("AGENT_FORGE_ENV");
const DELIVERY_ID = process.env.AGENT_FORGE_DELIVERY_ID ?? "unknown";
const LABEL = process.env.AGENT_FORGE_LABEL ?? "unknown";

const USER_AGENT = `agent-forge-${ROLE}`;

// Lock TTL ceiling. Architecture treats this as 2× the per-issue spend cap.
// B.1 holds the lock for a single Sonnet call (seconds); when B.3 lands and
// runs tests, this ceiling becomes the wall-clock cap for the whole attempt.
const LOCK_TTL_SECONDS = 2 * 60 * 60;

// Per-issue budget cap from CLAUDE.md → Cost model ("$12 per-issue cap").
// Overridable per product via products.per_issue_budget_cap_usd.
const DEFAULT_PER_ISSUE_BUDGET_CAP_USD = 12;

// Agent loop bounds. B.2 added read tools, so the agent typically spends 5-15
// turns investigating before calling propose_plan. 30 turns is the hard cap
// before we declare the agent stuck and park the issue.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const dumpForensicForPark = makeParkDumper({
  bucket: FORENSIC_BUCKET,
  issueStateTable: ISSUE_STATE_TABLE,
  productId: PRODUCT_ID,
  issueNumber: ISSUE_NUMBER,
  role: ROLE,
  log,
});

function runIdFromEnv(): string {
  return (
    process.env.ECS_TASK_ARN ??
    process.env.AGENT_FORGE_DELIVERY_ID ??
    `local-${Date.now()}`
  )
    .split("/")
    .slice(-1)[0]!;
}

async function fetchIssue(token: string): Promise<GitHubIssue> {
  return getIssue({ token, userAgent: USER_AGENT }, REPO, ISSUE_NUMBER);
}

async function fetchProductRow(): Promise<ProductConfig> {
  return requireProduct({
    tableName: PRODUCTS_TABLE,
    productId: PRODUCT_ID,
  });
}

// ---------------------------------------------------------------------------
// Comment formatting
// ---------------------------------------------------------------------------

const HEADER = (runId: string) => `## Dev (run \`${runId}\`)`;

function commentMissingAreas(runId: string): string {
  return [
    HEADER(runId),
    "",
    `Issue has no \`${AREA_ALL_LABEL.slice(0, -1)}<name>\` labels, so Dev cannot acquire an area lock.`,
    "",
    `Adding \`${GAP_LABELS.areasIncomplete}\` and parking at \`${HUMAN_NEEDED_LABEL}\`. ` +
      "A human should either:",
    "",
    `1. Add concrete \`area:<name>\` labels matching the work, **or**`,
    `2. Add \`${AREA_ALL_LABEL}\` if the issue genuinely spans every declared area.`,
    "",
    "Then clear `human-needed` to re-run.",
  ].join("\n");
}

function commentMissingAreasYaml(runId: string, areasPath: string): string {
  return [
    HEADER(runId),
    "",
    `Issue carries \`${AREA_ALL_LABEL}\`, but the target repo has no \`${areasPath}\` ` +
      "to expand it against.",
    "",
    `Adding \`${GAP_LABELS.areasIncomplete}\` and parking at \`${HUMAN_NEEDED_LABEL}\`. ` +
      `A human should commit \`${areasPath}\` (see CLAUDE.md → Concurrency model) ` +
      "and clear the label.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Sonnet 4.6 tool-use: submit_done
// ---------------------------------------------------------------------------

const SUBMIT_DONE_TOOL: ToolDefinition = {
  name: "submit_done",
  description:
    "Declare that the code change is complete and ready to ship. The wrapper " +
    "will auto-commit any uncommitted working-tree changes using your summary " +
    "as the commit message, run the product's test command, push the branch, " +
    "and open a pull request. If tests fail or no changes exist, the wrapper " +
    "returns an error and you can keep working — submit_done is only TERMINAL " +
    "on success. Do not call submit_done before you've made the change.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "pr_title", "pr_body"],
    properties: {
      summary: {
        type: "string",
        description:
          "1-2 sentence high-level description. Used as the auto-commit message " +
          "and as the lead paragraph of the PR body.",
      },
      pr_title: {
        type: "string",
        description:
          "GitHub PR title. Lead with a verb in imperative mood (\"Add\", \"Fix\", " +
          "\"Refactor\"). Under 70 chars when possible.",
      },
      pr_body: {
        type: "string",
        description:
          "GitHub PR body in Markdown. Cover what changed and why; reference " +
          "the issue you're closing. The wrapper appends an attribution footer.",
      },
    },
  },
};

const BASE_SYSTEM_PROMPT = `
You are agent-forge's Developer (Dev) role. Your job is to take a structured
issue (already expanded by BA, already cost-approved) and produce the actual
code change against the target product repository.

A shallow clone of the target repo is available at the working directory.
A fresh feature branch has already been created and checked out for you, so
your commits/edits stack on top of the default branch. You have these tools:

- list_directory(path)             — enumerate children, skipping heavy dirs.
- grep(pattern, path)              — recursive regex search.
- read_file(path)                  — fetch one file (100 KB cap).
- write_file(path, content)        — overwrite or create a file (1 MB cap).
- bash(cmd, cwd?, timeout_seconds?) — run /bin/bash -c; cwd defaults to repo
                                     root. Use for tests, lint, sed/awk
                                     edits, multi-file ops, git inspection.
- submit_done(summary, pr_title, pr_body) — TERMINAL on success: wrapper
                                     auto-commits any uncommitted changes,
                                     runs the test command, pushes the
                                     branch, opens the PR. If tests fail or
                                     no changes exist, you get an error and
                                     the loop continues — fix and retry.

Recommended flow:

  1. list_directory + grep + read_file the affected paths under your locked
     areas. Don't guess about file contents — read them.
  2. write_file (or bash with sed/awk) to make the change.
  3. bash to run the test command yourself (typically \`npm test\`,
     \`pytest\`, etc. — derive from the project). Iterate until green.
  4. Call submit_done with a concise summary + PR title/body.

Constraints:
- Stay within your locked areas. The wrapper does not enforce this, but the
  Product Owner reviews against it; cross-area edits get kicked back.
- One feature branch, one PR. Don't push or open PRs yourself via bash —
  let submit_done do it. (You CAN run git commit yourself if you want
  multiple atomic commits; the wrapper will add any leftover working-tree
  changes as a final commit.)
- Do not exfiltrate secrets via bash. The Fargate task has IAM credentials
  reachable via instance metadata; treat that surface as off-limits.

Do not produce free-form text outside the tool-call exchange.
`.trim();

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

  const truncationNote = spec.truncated_by
    ? `\n\nNote: spec was truncated by ${spec.truncated_by} cap; ` +
      `lower-priority files (alphabetical order) were dropped. ` +
      `Work from what's here.`
    : "";

  const specBlockText = [
    "=====================",
    "PRODUCT SPECIFICATION",
    "=====================",
    "The following is the product's spec/ directory. Use it as the source of",
    "truth for product scope, conventions, and constraints.",
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
    ...memoryBlocks,
  ];
}

function buildUserMessage(args: {
  issue: GitHubIssue;
  baExpansion: Awaited<ReturnType<typeof requireBAExpansion>>;
  lockedAreaIds: string[];
  branchName: string;
  defaultBranch: string;
  resumed: boolean;
  attempt: number;
  testCommand: string | undefined;
}): string {
  const ac = (args.baExpansion.acceptance_criteria ?? [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const risks = (args.baExpansion.risks ?? []).map((r) => `- ${r}`).join("\n") || "_(none)_";
  const oos = (args.baExpansion.out_of_scope ?? []).map((s) => `- ${s}`).join("\n") || "_(none)_";
  const testLine = args.testCommand
    ? `**Test command** (the wrapper will re-run before opening the PR): \`${args.testCommand}\``
    : "**Test command:** _none configured for this product — submit_done will not run tests. You should still verify your change manually._";
  const workspaceLine = args.resumed
    ? `You're on branch \`${args.branchName}\` — **this is attempt ${args.attempt}**, resumed from the previous attempt's tip. Test's commits + your prior commits are already on this branch (run \`git log --oneline ${args.defaultBranch}..HEAD\` to see them). The PR is still open; you're adding to it.`
    : `You're on branch \`${args.branchName}\`, branched from \`${args.defaultBranch}\`. The PR opens against \`${args.defaultBranch}\` when you call submit_done.`;
  const kickbackHint = args.resumed
    ? "Because this is a kickback re-run, look at the most recent comment from the kicking role (Functional / Security / PO) on the issue — it lists the specific deltas you need to address."
    : "";

  return [
    `Issue #${args.issue.number}: ${args.issue.title}`,
    "",
    "## Issue body",
    args.issue.body ?? "(no body)",
    "",
    "## BA expansion",
    `**Complexity:** ${args.baExpansion.complexity ?? "(unset)"}`,
    "",
    "### Acceptance criteria",
    ac || "_(none — BA did not extract any; treat the issue body as the spec)_",
    "",
    "### Risks BA flagged",
    risks,
    "",
    "### Out of scope per BA",
    oos,
    "",
    "## Workspace",
    workspaceLine,
    kickbackHint,
    "",
    testLine,
    "",
    "## Locked areas",
    `You hold area locks on: ${args.lockedAreaIds.map((a) => `\`${a}\``).join(", ")}.`,
    "Stay within those areas; if you need to touch outside them, surface it in submit_done.pr_body so the PO can decide.",
  ].filter((s) => s !== "").join("\n");
}

// ---------------------------------------------------------------------------
// Tool dispatch helpers
// ---------------------------------------------------------------------------

const TOOL_OUTPUT_CAP_BYTES = 16384;

type DispatcherResult = { content: string; is_error?: boolean };

function wrapToolResult(
  callId: string,
  r: DispatcherResult,
): {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
} {
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

function handleFinalizeResult(
  callId: string,
  f: FinalizeResult,
): {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  terminate?: boolean;
} {
  switch (f.kind) {
    case "ok":
      return {
        tool_use_id: callId,
        content: `PR opened: ${f.prUrl} (#${f.prNumber}). The loop ends here.`,
        terminate: true,
      };
    case "no_changes":
      return {
        tool_use_id: callId,
        content:
          "No changes detected in the workdir (no commits, no uncommitted edits). " +
          "Use write_file or bash (sed/awk/etc.) to make your change, then call submit_done again.",
        is_error: true,
        terminate: false,
      };
    case "tests_failed":
      return {
        tool_use_id: callId,
        content:
          "Tests failed after the wrapper auto-committed your changes. " +
          "Fix the failures and call submit_done again. Tail of test output:\n\n" +
          f.output,
        is_error: true,
        terminate: false,
      };
    case "push_failed":
      // Infra-level failure; don't burn more agent turns trying to recover.
      return {
        tool_use_id: callId,
        content: `git push failed: ${f.output}`,
        is_error: true,
        terminate: true,
      };
    case "pr_failed":
      return {
        tool_use_id: callId,
        content: `PR creation failed (HTTP ${f.status}): ${f.body.slice(0, 500)}`,
        is_error: true,
        terminate: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Test command resolution + PR body composition
// ---------------------------------------------------------------------------

async function resolveTestCommand(
  workdir: string,
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured && configured.trim().length > 0) return configured;
  try {
    const stat = await import("node:fs/promises").then((m) => m.stat);
    await stat(`${workdir}/package.json`);
    return "npm test";
  } catch {
    return undefined;
  }
}

function buildPrBody(agentBody: string, issueNumber: number): string {
  const closes = `Closes #${issueNumber}.`;
  const footer =
    "\n\n---\n\n_Opened by agent-forge Dev role. Test Engineer picks this up next via `state:awaiting-tests`._";
  // If the agent already cited the issue, don't duplicate.
  const includesClose = /#\d+/.test(agentBody) && agentBody.includes(`${issueNumber}`);
  const header = includesClose ? "" : `${closes}\n\n`;
  return `${header}${agentBody}${footer}`;
}

// Comment posted when one of the day-scope caps (per-role / per-product /
// global daily) was already tripped today, or just got tripped by today's
// accumulated spend. Caps reset at UTC midnight; a human can clear the
// trip earlier via the products row.
function commentDayBudgetTripped(args: {
  runId: string;
  attempt: IterAttempt;
  trip: BudgetTrip;
}): string {
  return [
    `## Dev did not run (run \`${args.runId}\`)`,
    "",
    `Day-scope budget cap tripped before attempt ${args.attempt}.`,
    "",
    formatBudgetTripComment(args.trip),
  ].join("\n");
}

// Comment posted when sum(spent) on the issue has already crossed the
// per-issue cap before this attempt could even start the model call.
function commentBudgetCapTripped(args: {
  runId: string;
  spentSoFar: number;
  capUsd: number;
  attempt: IterAttempt;
}): string {
  return [
    `## Dev did not run (run \`${args.runId}\`)`,
    "",
    `Per-issue budget cap tripped before attempt ${args.attempt}: spent so far ` +
      `**$${args.spentSoFar.toFixed(4)}**, cap is **$${args.capUsd.toFixed(2)}**.`,
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`. To resume, either raise ` +
      "`products.per_issue_budget_cap_usd` for this product, or close the " +
      "issue as too expensive.",
  ].join("\n");
}

// Comment posted when the agent loop hits max_turns without calling
// submit_done (distinct from "agent called submit_done but it failed").
function commentLoopRunaway(args: {
  runId: string;
  modelId: string;
  turns: number;
  costUsd: number;
  attempt: IterAttempt;
  forensicUri?: string;
}): string {
  const lines = [
    `## Dev ran out of turns (run \`${args.runId}\`, ${args.modelId}, attempt ${args.attempt})`,
    "",
    `The Sonnet/Haiku/Opus loop hit the ${args.turns}-turn ceiling without ` +
      "calling `submit_done`. This usually means the model couldn't converge " +
      "(stuck in a debugging cycle, repeating reads, etc.).",
    "",
    `Spend on this attempt: **$${args.costUsd.toFixed(4)}**.`,
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
  ];
  if (args.forensicUri) {
    lines.push("");
    lines.push(forensicFooter(args.forensicUri));
  }
  return lines.join("\n");
}

function commentPRShipped(args: {
  runId: string;
  modelId: string;
  turns: number;
  lockedAreaIds: string[];
  submission: Submission;
  pr: { prNumber: number; prUrl: string };
}): string {
  return [
    `## Dev shipped (Slice B.3, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    `Locked areas: ${args.lockedAreaIds.map((a) => `\`${a}\``).join(", ")}`,
    "",
    args.submission.summary,
    "",
    `Opened PR: ${args.pr.prUrl} (#${args.pr.prNumber}).`,
    "",
    `Transitioning \`${STATE_LABELS.ready}\` → \`${STATE_LABELS.awaitingTests}\`. The Test Engineer picks this up next.`,
  ].join("\n");
}

function commentFinalizeFailed(args: {
  runId: string;
  modelId: string;
  turns: number;
  stopReason: string;
  lockedAreaIds: string[];
  finalize: FinalizeResult | undefined;
  forensicUri?: string;
}): string {
  const lockedLine = `Locked areas: ${args.lockedAreaIds.map((a) => `\`${a}\``).join(", ")}`;
  const lines = [
    `## Dev did not ship (Slice B.3, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"}, stop=\`${args.stopReason}\`)`,
    "",
    lockedLine,
    "",
  ];
  const f = args.finalize;
  if (!f) {
    lines.push(
      `Agent exited without calling \`submit_done\`. Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
    );
  } else if (f.kind === "no_changes") {
    lines.push(
      "Agent called `submit_done` but the workdir had no changes (no commits, no uncommitted edits).",
    );
  } else if (f.kind === "tests_failed") {
    lines.push("Tests failed during finalize:\n");
    lines.push("```");
    lines.push(f.output);
    lines.push("```");
  } else if (f.kind === "push_failed") {
    lines.push("git push failed:\n");
    lines.push("```");
    lines.push(f.output);
    lines.push("```");
  } else if (f.kind === "pr_failed") {
    lines.push(`PR creation failed (HTTP ${f.status}):\n`);
    lines.push("```");
    lines.push(f.body.slice(0, 1500));
    lines.push("```");
  }
  lines.push("");
  lines.push(`Parking at \`${HUMAN_NEEDED_LABEL}\`.`);
  if (args.forensicUri) {
    lines.push("");
    lines.push(forensicFooter(args.forensicUri));
  }
  return lines.join("\n");
}

function commentLockContended(
  runId: string,
  attempted: string[],
  blockedAreaId: string,
  waitingAreaIds: string[],
): string {
  const attemptedList = attempted.map((a) => `\`${a}\``).join(", ");
  const waitingList = waitingAreaIds.map((a) => `\`${a}\``).join(", ");
  return [
    HEADER(runId),
    "",
    `Tried to acquire locks (alphabetical): ${attemptedList}.`,
    `Blocked at \`${blockedAreaId}\` — another Dev currently holds it.`,
    "",
    `Queued at: ${waitingList || "_(none)_"}. The sweeper Lambda re-fires Dev ` +
      "for the oldest waiter on each area when the holder releases. Issue stays " +
      "at `state:ready`; no human action needed.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log({ msg: "starting", repo: REPO, label: LABEL });

  if (LABEL && LABEL !== STATE_LABELS.ready) {
    log({ msg: "non-state:ready label fired this run; nothing to do", label: LABEL });
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

  const ghOpts = { token, userAgent: USER_AGENT };
  const runId = runIdFromEnv();

  const areas = parseAreaLabels(issue.labels ?? []);
  log({
    msg: "parsed area labels",
    has_all: areas.hasAll,
    area_ids: areas.areaIds,
  });

  // Branch 1: no area labels at all.
  if (!areas.hasAll && areas.areaIds.length === 0) {
    await postComment(ghOpts, REPO, ISSUE_NUMBER, commentMissingAreas(runId));
    await addLabels(ghOpts, REPO, ISSUE_NUMBER, [GAP_LABELS.areasIncomplete]);
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.ready,
      HUMAN_NEEDED_LABEL,
    );
    log({ msg: "no area labels; parked at human-needed" });
    return;
  }

  // Branch 2: area:* wildcard — read areas.yml from the target repo, then
  // either acquire the full area set or park (if the file is missing).
  // (If both `area:*` and concrete `area:<foo>` are present, the wildcard
  // wins by design — locks span every declared area.)
  let lockAreaIds: string[] | null = null;
  let allAreaIds: string[] | undefined;
  let lockSource: "concrete" | "wildcard" = "concrete";
  let areasPath = product.areas_path ?? ".agent-forge/areas.yml";

  if (areas.hasAll) {
    const areasFile = await readAreasFile({
      token,
      userAgent: USER_AGENT,
      repo: REPO,
      ...(product.areas_path ? { path: product.areas_path } : {}),
    });
    areasPath = areasFile.path;

    if (areasFile.missing) {
      log({ msg: "area:* requested but areas.yml missing", path: areasPath });
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentMissingAreasYaml(runId, areasPath),
      );
      await addLabels(ghOpts, REPO, ISSUE_NUMBER, [GAP_LABELS.areasIncomplete]);
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.ready,
        HUMAN_NEEDED_LABEL,
      );
      return;
    }

    log({
      msg: "loaded areas.yml",
      path: areasPath,
      area_names: areasFile.areas.areaNames,
    });
    allAreaIds = areasFile.areas.areaNames;
    lockAreaIds = ["*"];
    lockSource = "wildcard";
  } else {
    // Branch 3: concrete area:<name> labels — acquire just those.
    lockAreaIds = areas.areaIds;
    lockSource = "concrete";
  }

  const result = await acquireAreaLocks({
    tableName: AREA_LOCKS_TABLE,
    productId: PRODUCT_ID,
    areaIds: lockAreaIds,
    ...(allAreaIds ? { allAreaIds } : {}),
    ownerId: runId,
    ttlSeconds: LOCK_TTL_SECONDS,
  });

  const attemptedAreaIds =
    lockSource === "wildcard" ? (allAreaIds ?? []) : areas.areaIds;

  if (!result.acquired) {
    log({
      msg: "lock contention",
      blocked_area_id: result.blockedAreaId,
      lock_source: lockSource,
    });
    // Phase C: write a waiter row for every area we wanted (not just the
    // one we blocked on — when one area releases we still won't be able
    // to acquire if another we need is held; the sweeper re-fires Dev,
    // Dev's next attempt re-checks contention, and either acquires all or
    // requeues). Issue stays at state:ready; no human action needed.
    const waiterTtl = LOCK_TTL_SECONDS;
    const waiterAreaIds = attemptedAreaIds;
    for (const areaId of waiterAreaIds) {
      try {
        await addWaiter({
          tableName: LOCK_WAITERS_TABLE,
          productId: PRODUCT_ID,
          areaId,
          issueNumber: ISSUE_NUMBER,
          repo: REPO,
          deliveryId: DELIVERY_ID,
          ttlSeconds: waiterTtl,
        });
      } catch (err) {
        // A waiter-write failure isn't fatal — at worst this issue won't
        // be auto-re-fired by the sweeper, but the next webhook (any
        // label change) will re-fire Dev which re-tries the acquire.
        log({
          msg: "addWaiter failed (non-fatal)",
          area_id: areaId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    log({
      msg: "queued waiters",
      area_ids: waiterAreaIds,
      ttl_seconds: waiterTtl,
    });
    await postComment(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      commentLockContended(
        runId,
        attemptedAreaIds,
        result.blockedAreaId,
        waiterAreaIds,
      ),
    );
    // Issue stays at state:ready — sweeper re-fires Dev when a holder
    // releases. No label transition.
    return;
  }

  log({
    msg: "acquired area locks",
    area_ids: result.lease.areaIds,
    expires_at: result.lease.expiresAt,
    lock_source: lockSource,
  });

  let workdir: ClonedWorkdir | undefined;
  let finalizeResult: FinalizeResult | undefined;
  try {
    // 1. Clone the target repo's default branch.
    workdir = await cloneTargetRepo({ token, repo: REPO, runId });
    log({ msg: "cloned target repo", workdir: workdir.path });

    // 2. Configure git committer (per-role audit hook on author.email) and
    //    check out a fresh feature branch.
    const branchName = `agent-forge/dev/issue-${ISSUE_NUMBER}`;
    const { defaultBranch, resumed } = await setupWorkdir({
      workdir: workdir.path,
      identity: {
        name: `agent-forge-${ROLE}[bot]`,
        email: `${ROLE}@agent-forge-${ENV}.local`,
      },
      branchName,
    });
    log({
      msg: "set up workdir",
      branch: branchName,
      default_branch: defaultBranch,
      resumed,
    });

    // 3. Read BA expansion + spec for context.
    const baExpansion = await requireBAExpansion({
      tableName: ISSUE_STATE_TABLE,
      productId: PRODUCT_ID,
      issueNumber: ISSUE_NUMBER,
    });
    log({ msg: "loaded BA expansion", complexity: baExpansion.complexity });

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

    // Team memory: load lessons from prior Dev runs on this product
    // (plus org-global Dev lessons). usage_count bumps fire-and-forget.
    const lessons = await getLessons({
      tableName: TEAM_MEMORY_TABLE,
      productId: PRODUCT_ID,
      role: ROLE,
    });
    const memoryBlock = buildMemoryBlock(ROLE, lessons);
    log({ msg: "loaded team memory", lessons: lessons.length });

    // 4. Resolve test command per Q5: explicit product config wins; npm test
    //    fallback when package.json exists; otherwise skip.
    const testCommand = await resolveTestCommand(workdir.path, product.test_command);
    log({
      msg: "resolved test_command",
      command: testCommand ?? "(none — finalize will skip tests)",
    });

    // Attempt counter: read iter:N off the issue. Missing → first attempt,
    // we apply iter:1 below. Future kickback handlers (Test/Functional/etc.)
    // are responsible for incrementing iter:N before re-triggering Dev.
    const issueLabels = issue.labels ?? [];
    const existingAttempt = parseIterLabel(issueLabels);
    const attempt: IterAttempt = existingAttempt ?? 1;
    log({ msg: "resolved attempt", attempt, existing_iter_label: existingAttempt });

    // Per-issue budget cap pre-check. If the sum of every prior model call
    // on this issue already exceeds the cap, don't spend another dollar —
    // park immediately. This catches stuck loops across attempts.
    const budgetCapUsd =
      product.per_issue_budget_cap_usd ?? DEFAULT_PER_ISSUE_BUDGET_CAP_USD;
    const spentSoFar = await getIssueSpendUsd({
      tableName: BUDGET_LEDGER_TABLE,
      productId: PRODUCT_ID,
      issueNumber: ISSUE_NUMBER,
    });
    log({
      msg: "budget pre-check",
      spent_so_far_usd: spentSoFar,
      cap_usd: budgetCapUsd,
    });
    if (spentSoFar >= budgetCapUsd) {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentBudgetCapTripped({
          runId,
          spentSoFar,
          capUsd: budgetCapUsd,
          attempt,
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.ready,
        HUMAN_NEEDED_LABEL,
      );
      log({ msg: "budget cap tripped; parked", spent_so_far_usd: spentSoFar });
      return;
    }

    // Day-scope caps (per-role daily, per-product daily, global daily).
    // Reads existing trip flags first (cheap), then computes rollups if
    // not already tripped. On overshoot, sets the flag for today's UTC
    // date and parks the issue. Caps reset at UTC midnight by design.
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
        commentDayBudgetTripped({ runId, attempt, trip: capCheck.trip }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.ready,
        HUMAN_NEEDED_LABEL,
      );
      return;
    }

    // Apply iter:1 if no iter:* label yet. (Don't re-apply on attempts 2/3 —
    // those labels were set by the kicker.)
    if (existingAttempt === undefined) {
      await addLabels(ghOpts, REPO, ISSUE_NUMBER, [iterLabel(attempt)]);
      log({ msg: "applied iter label", label: iterLabel(attempt) });
    }

    // Tier driven by BA's complexity tag, with two overrides:
    //   - complexity:high label (human override) → treat as "large"
    //   - attempt >= 2 floors at Sonnet; attempt 3 always Opus (in tierForDev)
    const complexityHigh = hasComplexityHighLabel(issueLabels);
    const effectiveComplexity = complexityHigh ? "large" : baExpansion.complexity;
    const tier: ModelTier = tierForDev({
      complexity: effectiveComplexity,
      attempt,
    });
    log({
      msg: "selected model tier",
      tier,
      complexity: baExpansion.complexity ?? "(unset)",
      complexity_high_override: complexityHigh,
      effective_complexity: effectiveComplexity ?? "(unset)",
      attempt,
    });
    const model = getModelByTier(tier);
    const userMessage = buildUserMessage({
      issue,
      baExpansion,
      lockedAreaIds: result.lease.areaIds,
      branchName,
      defaultBranch,
      resumed,
      attempt,
      testCommand,
    });

    let capturedSubmission: Submission | undefined;
    const toolCallCounts: Record<string, number> = {};
    const wd = workdir.path;
    const executeTool = async (call: ToolCall) => {
      toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;
      if (call.name === "submit_done") {
        const submission = normalizeSubmission(call.input);
        capturedSubmission = submission;
        log({
          msg: "submit_done received",
          raw: call.input,
          normalized: submission,
        });
        const f = await finalize({
          workdir: wd,
          branchName,
          defaultBranch,
          commitMessage: submission.summary,
          ...(testCommand ? { testCommand } : {}),
          token,
          repo: REPO,
          userAgent: USER_AGENT,
          prTitle: submission.pr_title,
          prBody: buildPrBody(submission.pr_body, ISSUE_NUMBER),
        });
        finalizeResult = f;
        return handleFinalizeResult(call.id, f);
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
          `Unknown tool: ${call.name}. ` +
          "Call one of read_file, list_directory, grep, write_file, bash, record_lesson, or submit_done.",
        is_error: true,
      };
    };

    const tools = [
      ...buildReadToolDefinitions(),
      ...buildWriteToolDefinitions(),
      RECORD_LESSON_TOOL,
      SUBMIT_DONE_TOOL,
    ];
    const loop = await runAgentLoop({
      model,
      system: buildSystemBlocks(spec, memoryBlock),
      initialMessages: [{ role: "user", content: userMessage }],
      tools,
      executeTool,
      // submit_done is conditionally terminal — handleFinalizeResult sets
      // `terminate` per call. No global terminalTools list needed.
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
      finalize_kind: finalizeResult?.kind,
    });

    if (
      finalizeResult !== undefined &&
      finalizeResult.kind === "ok" &&
      capturedSubmission !== undefined
    ) {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentPRShipped({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          lockedAreaIds: result.lease.areaIds,
          submission: capturedSubmission,
          pr: { prNumber: finalizeResult.prNumber, prUrl: finalizeResult.prUrl },
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.ready,
        STATE_LABELS.awaitingTests,
      );
    } else if (loop.stopReason === "max_turns" && finalizeResult === undefined) {
      // Runaway loop: agent never reached submit_done. Distinct comment so
      // humans can tell this apart from "submit_done failed validation".
      const forensicUri = await dumpForensicForPark({
        reason: `Loop hit max_turns=${AGENT_MAX_TURNS} without calling submit_done`,
        stopReason: loop.stopReason,
        turns: loop.turns,
        toolCallCounts,
        loopMessages: loop.messages,
        costUsd: loop.costUsd,
        extra: { attempt },
        runId,
      });
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentLoopRunaway({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          costUsd: loop.costUsd,
          attempt,
          ...(forensicUri ? { forensicUri } : {}),
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.ready,
        HUMAN_NEEDED_LABEL,
      );
    } else {
      const forensicUri = await dumpForensicForPark({
        reason: `submit_done failed (finalize_kind=${finalizeResult?.kind ?? "no-submit"}; stop=${loop.stopReason})`,
        stopReason: loop.stopReason,
        turns: loop.turns,
        toolCallCounts,
        loopMessages: loop.messages,
        costUsd: loop.costUsd,
        extra: {
          attempt,
          finalize: finalizeResult,
          submission: capturedSubmission,
        },
        runId,
      });
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentFinalizeFailed({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          stopReason: loop.stopReason,
          lockedAreaIds: result.lease.areaIds,
          finalize: finalizeResult,
          ...(forensicUri ? { forensicUri } : {}),
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.ready,
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

    const recomputed = costUsd(tier, {
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
    await result.lease.release();
    log({ msg: "released area locks", area_ids: result.lease.areaIds });
    if (workdir) {
      try {
        await workdir.cleanup();
        log({ msg: "cleaned up workdir", path: workdir.path });
      } catch (err) {
        // Fargate disposes /tmp on task exit anyway; this is best-effort.
        log({
          msg: "workdir cleanup failed (non-fatal)",
          path: workdir.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  log({ msg: "done" });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(JSON.stringify({ role: ROLE, level: "error", msg }));
  process.exit(1);
});
