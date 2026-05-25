// Security Reviewer — Slice E.
//
// Trigger: issue gets label `state:awaiting-security` (Functional transitions
// here on outcome=passed).
//
// Job: clone the PR branch, run a security review on the diff using:
//   - npm audit (built into npm; no extra install)
//   - LLM-driven review against OWASP Top 10
//   - bash for any ad-hoc inspection (grep for secrets, inspect lockfile
//     diffs, etc.)
//
// Outcomes:
//   - clean (no findings, or only info/low/medium) → state:awaiting-po
//   - blocked or high/critical findings           → kick back to Dev
//                                                     until iter:3 cap,
//                                                     then human-needed
//
// Security-sensitive model escalation is not wired yet. Per CLAUDE.md, diffs
// touching auth, crypto, payments, PII, or anything tagged security-sensitive
// should eventually escalate to Opus; today that flag only tightens the
// review prompt and Security still runs Sonnet 4.6.
//
// As of B2 (2026-05-25) the runtime image ships with semgrep + gitleaks
// pre-installed (see agents/security/Dockerfile). The agent should call
// them directly via bash without a per-run install step.

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
  FLAG_LABELS,
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
  isBlocking,
  normalizeSecurityReport,
  type SecurityReport,
} from "./plan.ts";
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
You are agent-forge's Security Reviewer role. Functional has just verified
that the change works end-to-end; your job is the security gate before PO
sees the PR.

The shallow clone is checked out to the PR branch. You have:

- list_directory(path)              — enumerate children.
- grep(pattern, path)               — recursive regex search.
- read_file(path)                   — fetch one file (100 KB cap).
- write_file(path, content)         — create or overwrite a transient file
                                     (e.g. a scratch input). NOT
                                     committed; the workdir is thrown away
                                     after the loop.
- bash(cmd, cwd?, timeout_seconds?) — /bin/bash -c. Use for:
                                       * \`semgrep scan --error\`  (SAST,
                                         pre-installed)
                                       * \`gitleaks dir .\`  (secret scan
                                         on the working tree)
                                       * \`gitleaks git --redact\`  (secret
                                         scan across the diff's history)
                                       * \`npm audit --omit=dev\`  (CVE
                                         scan if package.json is present)
                                       * \`git log --oneline origin/HEAD..HEAD\`
                                       * \`git diff origin/HEAD..HEAD -- <path>\`
                                       * \`grep\` for additional secret
                                         patterns the scanners might miss
                                       * ad-hoc \`find\` / \`sed\` to inspect
- submit_security_done(outcome, worst_severity, summary, findings) —
                                     TERMINAL.

What to look at (this is a guide, not exhaustive):

  1. \`git diff origin/HEAD..HEAD\` — every code change.
  2. \`semgrep scan --error --quiet\` — SAST. Default registry covers a
     broad set of OWASP-aligned rules; use \`--config=auto\` or pin a
     specific ruleset if you want narrower coverage.
  3. \`gitleaks dir .\` and \`gitleaks git --redact\` — secret scanning
     (working tree + commit history on this branch). Cheap; run by default.
  4. \`npm audit --omit=dev\` (if package.json present) — known CVEs.
  5. LLM-grade review of the diff for OWASP Top 10 concerns: injection,
     broken auth, sensitive data exposure, SSRF, XXE, deserialization,
     known-bad dependencies, etc. Use your judgment — most diffs are
     boring docs/config; a small fraction genuinely matter.

Severity calibration:
  - **critical**: exploitable bug shipping to users in this PR
                  (auth bypass, RCE, secret in code).
  - **high**:     dependency CVE with a public exploit; PII leak; XSS
                  in a customer-facing surface.
  - **medium**:   defence-in-depth gap, sketchy input validation,
                  use of a known-deprecated API.
  - **low**:      style issues (\`eval()\` for a constant string, etc.).
  - **info**:     observations worth noting but not actionable.

Outcome:
  - **clean**:    no findings, or only info / low / medium that don't
                  block. PO sees the PR next.
  - **findings**: findings exist but don't block. Posts as PR comment,
                  PO decides.
  - **blocked**:  high or critical finding. Parks the issue at
                  human-needed only when the Dev attempt cap is reached;
                  otherwise kicks back to Dev.

Anything labelled \`high\` or \`critical\` in worst_severity always blocks,
regardless of \`outcome\`. So setting outcome=clean with worst=high is
contradictory — pick one.

Do not produce free-form text outside the tool-call exchange.
`.trim();

const SUBMIT_SECURITY_DONE_TOOL: ToolDefinition = {
  name: "submit_security_done",
  description:
    "Declare the security review complete. outcome must be one of " +
    "'clean' | 'findings' | 'blocked'. worst_severity is one of " +
    "'info' | 'low' | 'medium' | 'high' | 'critical' and reflects the " +
    "worst finding observed. A high/critical worst_severity always blocks " +
    "regardless of outcome — keep them consistent.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["outcome", "worst_severity", "summary", "findings"],
    properties: {
      outcome: {
        enum: ["clean", "findings", "blocked"],
        description: "Gate verdict for the PR.",
      },
      worst_severity: {
        enum: ["info", "low", "medium", "high", "critical"],
        description: "Severity of the worst finding (or 'info' when clean).",
      },
      summary: {
        type: "string",
        description:
          "1-2 sentence headline for the PR-style comment ('Clean — npm " +
          "audit reports 0 vulnerabilities; LLM review of the diff found " +
          "no OWASP concerns').",
      },
      findings: {
        type: "string",
        description:
          "Markdown body listing each finding (or 'No findings.'). For " +
          "each: file:line(s) + severity + rule reference (OWASP A0X, " +
          "CWE-N, or tool name) + recommended fix.",
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
    "Use this to understand what data the product handles and what",
    "security posture is expected (e.g. is this customer-facing? does",
    "it touch auth or payments? what does the threat model assume?).",
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
  securitySensitive: boolean;
}): string {
  const sensitiveLine = args.securitySensitive
    ? "**Flag:** This issue carries the `security-sensitive` label. Treat the diff with extra scrutiny — auth, crypto, payments, PII, or similar."
    : "";
  return [
    `Issue #${args.issue.number}: ${args.issue.title}`,
    "",
    "## Issue body",
    args.issue.body ?? "(no body)",
    "",
    "## What BA wrote about scope",
    `**Complexity:** ${args.baExpansion.complexity ?? "(unset)"}`,
    "",
    "**Areas:** " + ((args.baExpansion.areas ?? []).join(", ") || "_(unset)_"),
    "",
    sensitiveLine,
    "",
    "## Workspace",
    `You're on branch \`${args.branchName}\` with Dev + Test commits applied. ` +
      "`git log origin/HEAD..HEAD` is your starting point.",
  ].filter((s) => s !== "").join("\n");
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

function commentSecurityClean(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: SecurityReport;
}): string {
  return [
    `## Security review: CLEAN (Slice E, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    `**Worst severity:** \`${args.report.worst_severity}\``,
    "",
    args.report.summary,
    "",
    args.report.findings ? "### Findings\n\n" + args.report.findings + "\n" : "",
    `Transitioning \`${STATE_LABELS.awaitingSecurity}\` → \`${STATE_LABELS.awaitingPo}\`. PO decides ship/no-ship next.`,
  ].filter((s) => s !== "").join("\n");
}

function commentSecurityBlockedKickback(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: SecurityReport;
  newAttempt: number;
  kickbackCount: number;
}): string {
  return [
    `## Security review: BLOCKED → KICKBACK (Slice E, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    `**Worst severity:** \`${args.report.worst_severity}\``,
    "",
    args.report.summary,
    "",
    args.report.findings ? "### Findings\n\n" + args.report.findings + "\n" : "",
    `Kicking back to Dev — transitioning \`${STATE_LABELS.awaitingSecurity}\` → \`${STATE_LABELS.ready}\` with \`iter:${args.newAttempt}\`. (Kickback count for this issue: ${args.kickbackCount}.)`,
  ].filter((s) => s !== "").join("\n");
}

function commentSecurityBlockedCapped(args: {
  runId: string;
  modelId: string;
  turns: number;
  report: SecurityReport;
  forensicUri?: string;
}): string {
  return [
    `## Security review: BLOCKED → AT CAP (Slice E, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"})`,
    "",
    `**Worst severity:** \`${args.report.worst_severity}\``,
    "",
    args.report.summary,
    "",
    args.report.findings ? "### Findings\n\n" + args.report.findings + "\n" : "",
    `Already at \`iter:3\` (the per-issue Dev attempt cap). Parking at \`${HUMAN_NEEDED_LABEL}\` rather than re-kickback — a human must triage the finding (close the issue, accept the risk + skip Security, etc.).`,
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
    `## Security review did not complete (Slice E, run \`${args.runId}\`, ${args.modelId}, ${args.turns} turn${args.turns === 1 ? "" : "s"}, stop=\`${args.stopReason}\`)`,
    "",
    "Agent exited without calling `submit_security_done`.",
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`.`,
    args.forensicUri ? "\n" + forensicFooter(args.forensicUri) : "",
  ].filter((s) => s !== "").join("\n");
}

function commentMissingExpansion(runId: string): string {
  return [
    `## Security blocked (run \`${runId}\`)`,
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
    `## Security did not run (run \`${args.runId}\`)`,
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
    `## Security did not run (run \`${args.runId}\`)`,
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

function hasSecuritySensitiveLabel(issue: GitHubIssue): boolean {
  return (issue.labels ?? []).some((l) => l.name === FLAG_LABELS.securitySensitive);
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

  if (LABEL && LABEL !== STATE_LABELS.awaitingSecurity) {
    log({ msg: "non-state:awaiting-security label fired; nothing to do", label: LABEL });
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
  const securitySensitive = hasSecuritySensitiveLabel(issue);
  log({ msg: "security-sensitive label", present: securitySensitive });

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
      STATE_LABELS.awaitingSecurity,
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
      STATE_LABELS.awaitingSecurity,
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
      STATE_LABELS.awaitingSecurity,
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

    const model = getModelByTier("sonnet-4-6");
    const userMessage = buildUserMessage({
      issue, baExpansion, branchName, securitySensitive,
    });

    let capturedReport: SecurityReport | undefined;
    const toolCallCounts: Record<string, number> = {};
    const wd = workdir.path;
    const executeTool = async (call: ToolCall) => {
      toolCallCounts[call.name] = (toolCallCounts[call.name] ?? 0) + 1;
      if (call.name === "submit_security_done") {
        const report = normalizeSecurityReport(call.input);
        capturedReport = report;
        log({
          msg: "submit_security_done received",
          raw: call.input,
          normalized: report,
          blocking: isBlocking(report),
        });
        return {
          tool_use_id: call.id,
          content: `Review recorded (outcome=${report.outcome}, worst=${report.worst_severity}). The loop ends here.`,
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
          "grep, write_file, bash, record_lesson, or submit_security_done.",
        is_error: true,
      };
    };

    const tools = [
      ...buildReadToolDefinitions(),
      ...buildWriteToolDefinitions(),
      RECORD_LESSON_TOOL,
      SUBMIT_SECURITY_DONE_TOOL,
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
      outcome: capturedReport?.outcome,
      worst_severity: capturedReport?.worst_severity,
    });

    if (capturedReport && !isBlocking(capturedReport)) {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentSecurityClean({
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
        STATE_LABELS.awaitingSecurity,
        STATE_LABELS.awaitingPo,
      );
    } else if (capturedReport) {
      // E.2 / F.2.b: kick back to Dev unless at iter:3 cap.
      const currentAttempt = parseIterLabel(issue.labels ?? []);
      const k = await kickbackToDev({
        ghOpts,
        repo: REPO,
        issueNumber: ISSUE_NUMBER,
        currentState: STATE_LABELS.awaitingSecurity,
        currentAttempt,
        issueStateTable: ISSUE_STATE_TABLE,
        productId: PRODUCT_ID,
        fromRole: ROLE,
        runId,
      });
      if (k.kind === "kickback") {
        log({
          msg: "kicked back to Dev",
          from_state: STATE_LABELS.awaitingSecurity,
          new_attempt: k.newAttempt,
          kickback_count: k.kickbackCount,
        });
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentSecurityBlockedKickback({
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
          reason: "Security blocked but issue is at iter:3 cap; parked",
          stopReason: loop.stopReason,
          turns: loop.turns,
          toolCallCounts,
          loopMessages: loop.messages,
          costUsd: loop.costUsd,
          extra: {
            outcome: capturedReport.outcome,
            worst_severity: capturedReport.worst_severity,
            report: capturedReport,
          },
          runId,
        });
        await postComment(
          ghOpts,
          REPO,
          ISSUE_NUMBER,
          commentSecurityBlockedCapped({
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
          STATE_LABELS.awaitingSecurity,
          HUMAN_NEEDED_LABEL,
        );
      }
    } else {
      const forensicUri = await dumpForensicForPark({
        reason: `Security did not call submit_security_done (stop=${loop.stopReason})`,
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
        STATE_LABELS.awaitingSecurity,
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
