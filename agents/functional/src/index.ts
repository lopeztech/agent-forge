// Functional Tester — Slice D.1.
//
// Trigger: issue gets label `state:awaiting-functional` (Test transitions
// here after pushing tests).
//
// Job: clone the PR branch, exercise the change end-to-end against the
// product's acceptance criteria, and post a structured report. Functional
// does NOT modify code, does NOT push, does NOT open a new PR.
//
// Outcomes:
//   - passed → transition state:awaiting-functional → state:awaiting-security
//   - failed → park at human-needed (D.2 will wire the kickback flow:
//              increment iter:N + transition back to state:in-dev for
//              another Dev attempt)
//
// Tools: read_file, list_directory, grep, bash (no write_file — Functional
// is read-only). The bash tool is the workhorse: run the test suite, run
// smoke scripts, run the app's CLI, etc.
//
// Out of scope this slice:
//   - Kickback to Dev on `failed` (today: parks at human-needed; D.2 will
//     transition to state:in-dev and increment iter:N).
//   - PR-side comments (posts on the Issue only).
//   - `warm` runtime mode for products with heavy stateful deps (per
//     CLAUDE.md products.functional_runtime_mode).

import { runAgentLoop, type ToolCall } from "../../../shared/agent-loop.ts";
import { getIssueSpendUsd, recordSpend } from "../../../shared/budget.ts";
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
import { normalizeFunctionalReport, type FunctionalReport } from "./plan.ts";
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

// ---------------------------------------------------------------------------
// System prompt + tool
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `
You are agent-forge's Functional Tester role. The Developer shipped a change
and the Test Engineer added unit/integration tests; your job is to exercise
the change end-to-end against the acceptance criteria — the way a human QA
would.

The shallow clone is already checked out to the PR branch. You have:

- list_directory(path)              — enumerate children.
- grep(pattern, path)               — recursive regex search.
- read_file(path)                   — fetch one file (100 KB cap).
- write_file(path, content)         — create or overwrite a temporary file
                                     (e.g. a fixture you need for a smoke
                                     run). Anything you write here will be
                                     thrown away — Functional does NOT
                                     commit or push.
- bash(cmd, cwd?, timeout_seconds?) — /bin/bash -c. Use for: running the
                                     test command, running smoke scripts,
                                     spinning the app's CLI, inspecting
                                     output. cwd defaults to repo root.
- submit_functional_done(outcome, summary, evidence) — TERMINAL.
                                     outcome="passed" hands off to
                                     Security; outcome="failed" parks the
                                     issue at human-needed (this slice;
                                     future slice will kick back to Dev).

Approach:

  1. bash \`git log --oneline origin/HEAD..HEAD\` to see what shipped.
  2. read_file the modified files.
  3. Map each BA acceptance criterion to a concrete observation you can
     make on this clone (run X, check output Y, read file Z).
  4. Run those observations via bash. Capture the evidence.
  5. submit_functional_done with outcome + evidence covering each
     criterion.

If the product is a library/CLI/SDK without a "running app", "end-to-end"
means: build it (if applicable), run its test suite + any smoke scripts,
inspect the artefacts the change produced (changed files, generated
output, etc.). For docs/config changes there may be no behavioural test;
saying so in evidence is fine.

You CANNOT modify or commit code. Don't push or open PRs. If the change
appears broken in a way that needs a Dev fix, set outcome="failed" and
explain in evidence — the wrapper handles the kickback.

Do not produce free-form text outside the tool-call exchange.
`.trim();

const SUBMIT_FUNCTIONAL_DONE_TOOL: ToolDefinition = {
  name: "submit_functional_done",
  description:
    "Declare functional verification complete. outcome must be 'passed' or " +
    "'failed'. Posted as a structured PR-style comment on the linked Issue. " +
    "On passed: wrapper transitions state:awaiting-functional → " +
    "state:awaiting-security. On failed: wrapper parks at human-needed " +
    "(future slice will kick back to Dev).",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "summary", "evidence"],
    properties: {
      outcome: {
        enum: ["passed", "failed"],
        description: "Pass/fail verdict for the change as a whole.",
      },
      summary: {
        type: "string",
        description:
          "1-2 sentence verdict. Lead with the outcome and the why " +
          "(\"All four acceptance criteria observed; the new section is " +
          "rendered correctly and references the actual npm script.\").",
      },
      evidence: {
        type: "string",
        description:
          "Markdown listing the observations you made. For each acceptance " +
          "criterion: what command you ran (or what file you inspected) and " +
          "what you observed. If you skipped a criterion, say why.",
      },
    },
  },
};

function buildSystemBlocks(spec: SpecReadResult): SystemBlock[] {
  if (spec.missing || spec.files.length === 0) {
    return [{ type: "text", text: BASE_SYSTEM_PROMPT }];
  }
  const specBlocks = spec.files
    .map((f) => `<file path="${f.path}">\n${f.content.trim()}\n</file>`)
    .join("\n\n");
  const specText = [
    "=====================",
    "PRODUCT SPECIFICATION",
    "=====================",
    "Use this to understand what 'correct behaviour' means in product terms.",
    "",
    specBlocks,
  ].join("\n");
  return [
    { type: "text", text: BASE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: specText, cache_control: { type: "ephemeral" } },
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
    ? `**Project test command:** \`${args.testCommand}\` (run this and capture output as evidence)`
    : "**Project test command:** none configured. Run whatever smoke scripts the repo provides, or describe what you'd verify manually.";
  return [
    `Issue #${args.issue.number}: ${args.issue.title}`,
    "",
    "## Issue body",
    args.issue.body ?? "(no body)",
    "",
    "## Acceptance criteria (these must each be observable on the PR branch)",
    ac || "_(none — treat the issue body as the spec)_",
    "",
    "## Workspace",
    `You're on branch \`${args.branchName}\` with Dev + Test commits applied. ` +
      "Run `git log origin/HEAD..HEAD` to see the change set.",
    "",
    testLine,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentFunctionalPassed(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: FunctionalReport;
}): string {
  return [
    `## Functional verification: PASSED (Slice D, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.evidence ? "### Evidence\n\n" + args.report.evidence + "\n" : "",
    `Transitioning \`${STATE_LABELS.awaitingFunctional}\` → \`${STATE_LABELS.awaitingSecurity}\`.`,
  ].filter((s) => s !== "").join("\n");
}

function commentFunctionalFailed(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: FunctionalReport;
}): string {
  return [
    `## Functional verification: FAILED (Slice D, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    args.report.summary,
    "",
    args.report.evidence ? "### Evidence\n\n" + args.report.evidence + "\n" : "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`. A future slice (D.2) will instead ` +
      "kick this back to Dev by transitioning to `state:in-dev` and incrementing `iter:N`.",
  ].filter((s) => s !== "").join("\n");
}

function commentNoReport(args: {
  runId: string;
  modelId: string;
  turns: number;
  stopReason: string;
}): string {
  return [
    `## Functional verification did not complete (Slice D, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"}, stop=\`${args.stopReason}\`)`,
    "",
    "Agent exited without calling `submit_functional_done`.",
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
  ].join("\n");
}

function commentMissingExpansion(runId: string): string {
  return [
    `## Functional blocked (run \`${runId}\`)`,
    "",
    "Can't run: `issue_state.ba_expansion` is missing for this issue. " +
      "Functional needs the acceptance criteria to verify against.",
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
    `## Functional did not run (run \`${args.runId}\`)`,
    "",
    `Per-issue budget cap tripped: spent so far **$${args.spentSoFar.toFixed(4)}**, ` +
      `cap is **$${args.capUsd.toFixed(2)}**.`,
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log({ msg: "starting", repo: REPO, label: LABEL });

  if (LABEL && LABEL !== STATE_LABELS.awaitingFunctional) {
    log({ msg: "non-state:awaiting-functional label fired; nothing to do", label: LABEL });
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
      STATE_LABELS.awaitingFunctional,
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
      STATE_LABELS.awaitingFunctional,
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

    const testCommand = await resolveTestCommand(workdir.path, product.test_command);
    log({ msg: "resolved test_command", command: testCommand ?? "(none)" });

    const model = getModelByTier("sonnet-4-6");
    const userMessage = buildUserMessage({
      issue, baExpansion, branchName, testCommand,
    });

    let capturedReport: FunctionalReport | undefined;
    const toolCallCounts: Record<string, number> = {};
    const wd = workdir.path;
    const executeTool = async (call: ToolCall) => {
      toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;
      if (call.name === "submit_functional_done") {
        const report = normalizeFunctionalReport(call.input);
        capturedReport = report;
        log({
          msg: "submit_functional_done received",
          raw: call.input,
          normalized: report,
        });
        return {
          tool_use_id: call.id,
          content: `Report recorded (outcome=${report.outcome}). The loop ends here.`,
          terminate: true,
        };
      }
      const read = await dispatchReadTool(wd, call.name, call.input);
      if (read) return wrapToolResult(call.id, read);
      const write = await dispatchWriteTool(wd, call.name, call.input);
      if (write) return wrapToolResult(call.id, write);
      return {
        tool_use_id: call.id,
        content:
          `Unknown tool: ${call.name}. Call one of read_file, list_directory, ` +
          "grep, write_file, bash, or submit_functional_done.",
        is_error: true,
      };
    };

    const tools = [
      ...buildReadToolDefinitions(),
      ...buildWriteToolDefinitions(),
      SUBMIT_FUNCTIONAL_DONE_TOOL,
    ];
    const loop = await runAgentLoop({
      model,
      system: buildSystemBlocks(spec),
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
      outcome: capturedReport?.outcome,
    });

    if (capturedReport && capturedReport.outcome === "passed") {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentFunctionalPassed({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          report: capturedReport,
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingFunctional,
        STATE_LABELS.awaitingSecurity,
      );
    } else if (capturedReport && capturedReport.outcome === "failed") {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentFunctionalFailed({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          report: capturedReport,
        }),
      );
      // Slice D.1: park at human-needed on failure. D.2 will instead
      // increment iter:N and transition to state:in-dev (kickback to Dev).
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingFunctional,
        HUMAN_NEEDED_LABEL,
      );
    } else {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentNoReport({
          runId,
          modelId: model.bedrockModelId,
          turns: loop.turns,
          stopReason: loop.stopReason,
        }),
      );
      await transitionLabel(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        STATE_LABELS.awaitingFunctional,
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
