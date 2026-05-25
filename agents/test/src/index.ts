// Test Engineer — Slice C.
//
// Trigger: issue gets label `state:awaiting-tests` (Dev transitions here after
// opening the PR). EventBridge → Step Function → this Fargate task.
//
// Flow:
//   1. Clone the existing Dev PR branch (convention: agent-forge/dev/issue-<N>).
//   2. Read the BA expansion (acceptance criteria — what the tests must cover).
//   3. Read the diff Dev shipped (git log against the default branch).
//   4. Run a Sonnet 4.6 loop with read/write/bash tools + a terminal
//      `submit_tests_done` tool.
//   5. On submit_tests_done: auto-commit any uncommitted tree state, re-run
//      the product's test command as the gate, push to origin (the same PR
//      branch — no new PR), transition state:awaiting-tests →
//      state:awaiting-functional.
//
// Test does NOT acquire area locks (per CLAUDE.md: "Other roles do not lock.
// Test/Functional/Security/PO operate on already-existing PR branches that
// are isolated from each other and from main.").
//
// Out of scope this slice:
//   - Coverage gates + Opus escalation after 2 failures (would need a counter
//     similar to iter:N for Test — likely test-iter:N)
//   - PR comments (currently posts comments on the linked Issue only)
//   - Kickback to Dev on coverage misses (the PR review feedback flow)

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
  getIssue,
  postComment,
  transitionLabel,
  type GitHubIssue,
} from "../../../shared/github/repo.ts";
import { readSpecTree, type SpecReadResult } from "../../../shared/github/spec.ts";
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
import { requireBAExpansion } from "../../../shared/state/issue-state.ts";
import {
  requireProduct,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../shared/state/products.ts";
import {
  finalizeTest,
  setupTestWorkdir,
  type FinalizeTestResult,
} from "./finalize.ts";
import { normalizeTestSubmission, type TestSubmission } from "./plan.ts";
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
You are agent-forge's Test Engineer role. A Developer has just shipped a code
change as a pull request; your job is to add unit and integration tests that
cover the acceptance criteria, push those tests to the existing PR branch, and
hand off to the Functional Tester.

You are NOT the developer. Do not modify product code beyond what's strictly
necessary to test it (e.g. exporting an internal symbol, fixing a clear bug
that blocks testing). Your goal is coverage of the acceptance criteria, not
reimplementing the feature.

The shallow clone is already checked out to the PR branch. You have:

- list_directory(path)              — enumerate children, skipping heavy dirs.
- grep(pattern, path)               — recursive regex search.
- read_file(path)                   — fetch one file (100 KB cap).
- write_file(path, content)         — overwrite or create a file (1 MB cap).
- bash(cmd, cwd?, timeout_seconds?) — /bin/bash -c; cwd defaults to repo root.
- submit_tests_done(outcome, summary, coverage_notes) — TERMINAL.
                                      outcome="passed": wrapper
                                      auto-commits any uncommitted changes,
                                      re-runs the test command as the gate,
                                      pushes the branch, transitions the
                                      issue to state:awaiting-functional. On
                                      tests_failed / no_changes the wrapper
                                      hands control back so you can fix.
                                      outcome="needs_dev_change": wrapper
                                      kicks back to Dev — increments iter:N,
                                      transitions state:awaiting-tests →
                                      state:ready, posts coverage_notes as
                                      the kickback comment. Any uncommitted
                                      test files you wrote are discarded.

Recommended flow:

  1. bash \`git log --oneline origin/HEAD..HEAD\` to see what Dev shipped.
  2. bash \`git diff origin/HEAD..HEAD\` for the actual changes.
  3. read_file the files Dev modified so you understand them.
  4. list_directory the existing tests/ folder (or framework-equivalent) to
     learn the convention.
  5. write_file new test files covering each acceptance criterion.
  6. bash to run the test command. Iterate until green.
  7. Call submit_tests_done with outcome="passed", a brief summary, and
     which acceptance criteria each test covers.

When to use outcome="needs_dev_change":
- The PR has a clear bug you'd need to fix to make tests pass (e.g. wrong
  return type, missing null check, off-by-one). Fixing product bugs is
  Dev's job, not Test's — kick back with a specific delta.
- The change can't be exercised without a Dev-side hook (e.g. an internal
  symbol needs to be exported, a hardcoded value needs to become an arg,
  a side-effect needs to become observable). Describe the exact change
  Dev should make.
- DON'T use needs_dev_change for tests that you couldn't figure out how
  to write — that's an outcome="passed" with frank coverage_notes about
  what you skipped. needs_dev_change is reserved for cases where the
  product code itself needs to change.

Constraints:
- Stay on the PR branch. Don't merge, don't open new PRs.
- Don't disable failing tests to make them pass.
- Don't exfiltrate secrets via bash. The Fargate task has IAM credentials
  reachable via instance metadata; treat that surface as off-limits.

Do not produce free-form text outside the tool-call exchange.
`.trim();

const SUBMIT_TESTS_DONE_TOOL: ToolDefinition = {
  name: "submit_tests_done",
  description:
    "Declare Test's verdict on this PR. outcome=passed: wrapper auto-commits " +
    "any uncommitted changes, re-runs the test command, pushes the PR branch, " +
    "and transitions the issue to state:awaiting-functional (if tests fail or " +
    "no changes were made the wrapper hands control back to you so you can " +
    "fix). outcome=needs_dev_change: wrapper kicks back to Dev — bumps iter:N " +
    "and transitions state:awaiting-tests → state:ready. Uncommitted test " +
    "files you wrote are discarded.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "summary", "coverage_notes"],
    properties: {
      outcome: {
        enum: ["passed", "needs_dev_change"],
        description:
          "passed: tests added, all green. needs_dev_change: PR has a bug " +
          "or missing testability hook that requires a Dev-side change " +
          "before tests can meaningfully cover it.",
      },
      summary: {
        type: "string",
        description:
          "1-2 sentence high-level verdict. Used as the auto-commit message " +
          "on passed; used as the kickback comment headline on " +
          "needs_dev_change.",
      },
      coverage_notes: {
        type: "string",
        description:
          "For passed: markdown listing each acceptance criterion you " +
          "tested and how. For needs_dev_change: the specific deltas Dev " +
          "must make (file:line, what to change, why), mapped to acceptance " +
          "criteria. Posted as the issue comment.",
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
  const truncationNote = spec.truncated_by
    ? `\n\nNote: spec was truncated by ${spec.truncated_by} cap.`
    : "";
  const specText = [
    "=====================",
    "PRODUCT SPECIFICATION",
    "=====================",
    "The following is the product's spec/ directory. Reference it when",
    "deciding what 'covering an acceptance criterion' means in product terms.",
    "",
    specBlocks,
    truncationNote,
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
  testCommand: string | undefined;
}): string {
  const ac = (args.baExpansion.acceptance_criteria ?? [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const testLine = args.testCommand
    ? `**Test command** (wrapper re-runs as the gate): \`${args.testCommand}\``
    : "**Test command:** none configured. The wrapper won't gate on tests; you should still run them via bash before submitting.";
  return [
    `Issue #${args.issue.number}: ${args.issue.title}`,
    "",
    "## Issue body",
    args.issue.body ?? "(no body)",
    "",
    "## Acceptance criteria (what your tests must cover)",
    ac || "_(none — treat the issue body as the spec)_",
    "",
    "## Workspace",
    `You're on branch \`${args.branchName}\` with Dev's commits already applied. ` +
      "Run `git log origin/HEAD..HEAD` to see what shipped.",
    "",
    testLine,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentTestsAdded(args: {
  runId: string;
  modelId: string;
  turns: number;
  submission: TestSubmission;
  pushedHead: string;
}): string {
  return [
    `## Tests added (Slice C, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.submission.summary,
    "",
    args.submission.coverage_notes ? "### Coverage notes\n\n" + args.submission.coverage_notes + "\n" : "",
    `Pushed to PR branch at \`${args.pushedHead.slice(0, 12)}\`.`,
    "",
    `Transitioning \`${STATE_LABELS.awaitingTests}\` → \`${STATE_LABELS.awaitingFunctional}\`.`,
  ].filter((s) => s !== "").join("\n");
}

function commentTestKickback(args: {
  runId: string;
  modelId: string;
  turns: number;
  submission: TestSubmission;
  newAttempt: number;
  kickbackCount: number;
}): string {
  return [
    `## Test: NEEDS DEV CHANGE → KICKBACK (Slice C, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.submission.summary,
    "",
    args.submission.coverage_notes
      ? "### Deltas to fix\n\n" + args.submission.coverage_notes + "\n"
      : "",
    `Kicking back to Dev — transitioning \`${STATE_LABELS.awaitingTests}\` → \`${STATE_LABELS.ready}\` with \`iter:${args.newAttempt}\`. (Kickback count for this issue: ${args.kickbackCount}.)`,
  ].filter((s) => s !== "").join("\n");
}

function commentTestKickbackCapped(args: {
  runId: string;
  modelId: string;
  turns: number;
  submission: TestSubmission;
}): string {
  return [
    `## Test: NEEDS DEV CHANGE → AT CAP (Slice C, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.submission.summary,
    "",
    args.submission.coverage_notes
      ? "### Deltas to fix\n\n" + args.submission.coverage_notes + "\n"
      : "",
    `Already at \`iter:3\` (the per-issue Dev attempt cap). Parking at \`${HUMAN_NEEDED_LABEL}\` rather than re-kickback. A human should rescope the issue or accept the gap in coverage.`,
  ].filter((s) => s !== "").join("\n");
}

function commentTestFailed(args: {
  runId: string;
  modelId: string;
  turns: number;
  stopReason: string;
  finalize: FinalizeTestResult | undefined;
  forensicUri?: string;
}): string {
  const lines = [
    `## Test did not push (Slice C, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"}, stop=\`${args.stopReason}\`)`,
    "",
  ];
  const f = args.finalize;
  if (!f) {
    lines.push("Agent exited without calling `submit_tests_done`.");
  } else if (f.kind === "no_changes") {
    lines.push("Agent called `submit_tests_done` but no test files were added or modified.");
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
  }
  lines.push("");
  lines.push(`Parking at \`${HUMAN_NEEDED_LABEL}\`.`);
  if (args.forensicUri) {
    lines.push("");
    lines.push(forensicFooter(args.forensicUri));
  }
  return lines.join("\n");
}

function commentMissingExpansion(runId: string): string {
  return [
    `## Test blocked (run \`${runId}\`)`,
    "",
    "Can't run: `issue_state.ba_expansion` is missing for this issue, which " +
      "means BA never ran or got short-circuited. Test needs the acceptance " +
      "criteria to know what to cover.",
    "",
    `Adding \`${GAP_LABELS.areasIncomplete}\` and parking at \`${HUMAN_NEEDED_LABEL}\`.`,
  ].join("\n");
}

function commentBudgetCapTripped(args: {
  runId: string;
  spentSoFar: number;
  capUsd: number;
}): string {
  return [
    `## Test did not run (run \`${args.runId}\`)`,
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
    `## Test did not run (run \`${args.runId}\`)`,
    "",
    formatBudgetTripComment(args.trip),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runIdFromEnv(): string {
  return (
    process.env.ECS_TASK_ARN ??
    process.env.AGENT_FORGE_DELIVERY_ID ??
    `local-${Date.now()}`
  )
    .split("/")
    .slice(-1)[0]!;
}

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

function handleFinalizeResult(
  callId: string,
  f: FinalizeTestResult,
): { tool_use_id: string; content: string; is_error?: boolean; terminate?: boolean } {
  switch (f.kind) {
    case "ok":
      return {
        tool_use_id: callId,
        content: `Tests pushed to ${f.pushedHead.slice(0, 12)}. The loop ends here.`,
        terminate: true,
      };
    case "no_changes":
      return {
        tool_use_id: callId,
        content:
          "No changes detected. Add or modify test files (and any required test " +
          "fixtures) with write_file or bash, then call submit_tests_done again.",
        is_error: true,
        terminate: false,
      };
    case "tests_failed":
      return {
        tool_use_id: callId,
        content:
          "Tests failed after the wrapper auto-committed your changes. Tail:\n\n" +
          f.output,
        is_error: true,
        terminate: false,
      };
    case "push_failed":
      return {
        tool_use_id: callId,
        content: `git push failed: ${f.output}`,
        is_error: true,
        terminate: true,
      };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log({ msg: "starting", repo: REPO, label: LABEL });

  if (LABEL && LABEL !== STATE_LABELS.awaitingTests) {
    log({ msg: "non-state:awaiting-tests label fired; nothing to do", label: LABEL });
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
      STATE_LABELS.awaitingTests,
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
      STATE_LABELS.awaitingTests,
      HUMAN_NEEDED_LABEL,
    );
    return;
  }

  // BA expansion is required — we need the acceptance criteria.
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
      STATE_LABELS.awaitingTests,
      HUMAN_NEEDED_LABEL,
    );
    return;
  }

  // Clone Dev's PR branch by convention.
  const branchName = `agent-forge/dev/issue-${ISSUE_NUMBER}`;
  let workdir: ClonedPrWorkdir | undefined;
  let finalizeResult: FinalizeTestResult | undefined;
  try {
    workdir = await clonePrBranch({ token, repo: REPO, runId, branchName });
    log({ msg: "cloned PR branch", workdir: workdir.path, branch: branchName });

    await setupTestWorkdir({
      workdir: workdir.path,
      identity: {
        name: `agent-forge-${ROLE}[bot]`,
        email: `${ROLE}@agent-forge-${ENV}.local`,
      },
    });

    const specPath = product.spec_path ?? "spec/";
    const spec = await readSpecTree({
      token, userAgent: USER_AGENT, repo: REPO, path: specPath,
    });
    log({
      msg: "read spec", spec_path: specPath, files: spec.files.length,
      total_bytes: spec.total_bytes,
    });

    const testCommand = await resolveTestCommand(workdir.path, product.test_command);
    log({ msg: "resolved test_command", command: testCommand ?? "(none)" });

    const lessons = await getLessons({
      tableName: TEAM_MEMORY_TABLE,
      productId: PRODUCT_ID,
      role: ROLE,
    });
    const memoryBlock = buildMemoryBlock(ROLE, lessons);
    log({ msg: "loaded team memory", lessons: lessons.length });

    const model = getModelByTier("sonnet-4-6");
    const userMessage = buildUserMessage({
      issue, baExpansion, branchName, testCommand,
    });

    let capturedSubmission: TestSubmission | undefined;
    const toolCallCounts: Record<string, number> = {};
    const wd = workdir.path;
    const executeTool = async (call: ToolCall) => {
      toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;
      if (call.name === "submit_tests_done") {
        const submission = normalizeTestSubmission(call.input);
        capturedSubmission = submission;
        log({
          msg: "submit_tests_done received",
          raw: call.input,
          normalized: submission,
        });
        if (submission.outcome === "needs_dev_change") {
          // No finalize on kickback — wrapper discards in-flight test work and
          // hands the branch back to Dev. The loop ends here; main() does the
          // actual kickback after the loop returns.
          return {
            tool_use_id: call.id,
            content:
              `Kickback recorded (outcome=needs_dev_change). The loop ends here; ` +
              "wrapper will transition the issue back to state:ready and Dev " +
              "picks it up.",
            terminate: true,
          };
        }
        const f = await finalizeTest({
          workdir: wd,
          branchName,
          commitMessage: submission.summary,
          ...(testCommand ? { testCommand } : {}),
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
          `Unknown tool: ${call.name}. Call one of read_file, list_directory, ` +
          "grep, write_file, bash, record_lesson, or submit_tests_done.",
        is_error: true,
      };
    };

    const tools = [
      ...buildReadToolDefinitions(),
      ...buildWriteToolDefinitions(),
      RECORD_LESSON_TOOL,
      SUBMIT_TESTS_DONE_TOOL,
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
        commentTestsAdded({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          submission: capturedSubmission,
          pushedHead: finalizeResult.pushedHead,
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingTests,
        STATE_LABELS.awaitingFunctional,
      );
    } else if (
      capturedSubmission !== undefined &&
      capturedSubmission.outcome === "needs_dev_change"
    ) {
      // B1: agent declared the PR needs Dev-side changes before tests can
      // cover it. Reuse the shared kickback helper. Cap-park if at iter:3.
      const currentAttempt = parseIterLabel(issue.labels ?? []);
      const k = await kickbackToDev({
        ghOpts,
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        currentState: STATE_LABELS.awaitingTests,
        currentAttempt,
        issueStateTable: ISSUE_STATE_TABLE,
        productId: PRODUCT_ID,
        fromRole: ROLE,
        runId,
      });
      if (k.kind === "kickback") {
        log({
          msg: "kicked back to Dev",
          from_state: STATE_LABELS.awaitingTests,
          new_attempt: k.newAttempt,
          kickback_count: k.kickbackCount,
        });
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentTestKickback({
            runId,
            modelId: model.bedrockModelId,
            turns: loop.turns,
            submission: capturedSubmission,
            newAttempt: k.newAttempt,
            kickbackCount: k.kickbackCount,
          }),
        );
      } else {
        log({ msg: "at iter cap; parking instead of kicking back" });
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentTestKickbackCapped({
            runId,
            modelId: model.bedrockModelId,
            turns: loop.turns,
            submission: capturedSubmission,
          }),
        );
        await transitionLabel(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          STATE_LABELS.awaitingTests,
          HUMAN_NEEDED_LABEL,
        );
      }
    } else {
      const forensicUri = await dumpForensicForPark({
        reason: `Test did not push (finalize_kind=${finalizeResult?.kind ?? "no-submit"}; stop=${loop.stopReason})`,
        stopReason: loop.stopReason,
        turns: loop.turns,
        toolCallCounts,
        loopMessages: loop.messages,
        costUsd: loop.costUsd,
        extra: {
          finalize: finalizeResult,
          submission: capturedSubmission,
        },
        runId,
      });
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentTestFailed({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          stopReason: loop.stopReason,
          finalize: finalizeResult,
          ...(forensicUri ? { forensicUri } : {}),
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingTests,
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

    const recomputed = costUsd("sonnet-4-6", {
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
