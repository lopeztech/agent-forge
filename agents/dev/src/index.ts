// Dev (Developer) — Slice B.1: thin Sonnet 4.6 loop, parks after proposing.
//
// Trigger: issue gets label `state:ready`. EventBridge → Step Function → this
// Fargate task. Env vars come from RunTask container overrides
// (see infra/modules/step-functions/asl/dev-issue-lifecycle.asl.json).
//
// This slice proves the multi-turn tool-use loop end-to-end (via
// `shared/agent-loop.ts`) and the BA→Dev state handoff (issue_state read),
// but does NOT yet edit code. The agent reads the BA expansion, reads the
// target repo's spec, and calls a single `propose_plan` tool. The wrapper
// posts the plan as a PR-ready outline, releases area locks, and parks the
// issue at `human-needed`. Branches that fail earlier (no areas, missing
// areas.yml, lock contention) skip the model call entirely.
//
// Branch behaviours (B.1):
//   1. No `area:*` labels at all              → park with gap:areas-incomplete.
//   2. `area:*` and areas.yml missing         → park with gap:areas-incomplete.
//   3. Concrete or area:* (expanded) areas    → acquire locks → Sonnet 4.6
//      loop with `propose_plan` tool → post plan comment → park at
//      `human-needed` → release locks → record spend.
//   4. Lock contention                        → park at `human-needed`.
//
// Out of scope this slice (deliberate):
//   - File reads/writes from the target repo (lands in B.2)
//   - Git operations + PR creation (B.3)
//   - Sonnet → Opus escalation on attempt N (B.4)
//   - Per-issue budget cap check before model call (B.4)

import { runAgentLoop, type ToolCall } from "../../../shared/agent-loop.ts";
import { recordSpend } from "../../../shared/budget.ts";
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
  parseAreaLabels,
} from "../../../shared/labels.ts";
import { acquireAreaLocks } from "../../../shared/locks/area-locks.ts";
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
const ROLE = requiredEnv("AGENT_FORGE_ROLE");
const ENV = requiredEnv("AGENT_FORGE_ENV");
const DELIVERY_ID = process.env.AGENT_FORGE_DELIVERY_ID ?? "unknown";
const LABEL = process.env.AGENT_FORGE_LABEL ?? "unknown";

const USER_AGENT = `agent-forge-${ROLE}`;

// Lock TTL ceiling. Architecture treats this as 2× the per-issue spend cap.
// B.1 holds the lock for a single Sonnet call (seconds); when B.3 lands and
// runs tests, this ceiling becomes the wall-clock cap for the whole attempt.
const LOCK_TTL_SECONDS = 2 * 60 * 60;

// Agent loop bounds. The propose_plan tool is terminal, so a healthy run
// returns after 1 turn. A few extra turns absorb the case where the model
// hedges with text before the tool call.
const AGENT_MAX_TURNS = 5;
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
// Sonnet 4.6 tool-use: propose_plan
// ---------------------------------------------------------------------------

type ProposedPlan = {
  summary: string;
  steps: string[];
  files_to_touch: string[];
  open_questions: string[];
};

const PROPOSE_PLAN_TOOL: ToolDefinition = {
  name: "propose_plan",
  description:
    "Submit a concrete implementation plan for this issue. Call this exactly " +
    "once when you're ready to hand off; you do NOT execute the plan in this " +
    "slice. Steps should be the order a Dev would take, not abstract phases.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "steps", "files_to_touch", "open_questions"],
    properties: {
      summary: {
        type: "string",
        description:
          "1-2 sentence overview of the change. Lead with what the user-facing " +
          "or system-facing outcome will be, not the mechanism.",
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string" },
        description:
          "Concrete implementation steps in execution order. Each step should " +
          "name the file(s) and operation (e.g. 'Add foo() to src/x.ts and call " +
          "it from src/y.ts:42'). No 'investigate' / 'understand' steps.",
      },
      files_to_touch: {
        type: "array",
        maxItems: 30,
        items: { type: "string" },
        description:
          "Best-effort guess at the files this change will create or modify. " +
          "Empty array is fine when you genuinely can't tell without reading " +
          "the code (file-reading tools land in the next slice).",
      },
      open_questions: {
        type: "array",
        maxItems: 8,
        items: { type: "string" },
        description:
          "Specific things you'd need to verify or decide before implementing — " +
          "ambiguities in the BA expansion, missing spec context, two reasonable " +
          "approaches, etc. Empty array when the plan is unambiguous.",
      },
    },
  },
};

const BASE_SYSTEM_PROMPT = `
You are agent-forge's Developer (Dev) role. Your job is to take a structured
issue (already expanded by BA, already cost-approved) and turn it into a code
change against the target product repository.

This run is a "planning slice". The tools you'd normally use to read or write
files do not exist in this slice — they land in a follow-up. Read the issue +
BA expansion, read the product spec for context, and submit a concrete
implementation plan via the propose_plan tool. Do NOT speculate about file
contents you cannot see; if a step depends on understanding code you can't
read yet, surface that as an open question instead of guessing.

Style:
- Be concrete. "Add foo() to src/x.ts and call it from src/y.ts" beats
  "implement the feature".
- Cite spec sections or BA acceptance criteria when they constrain a choice.
- If two approaches are reasonable, pick the one most consistent with what's
  already in the spec and mention the alternative as an open question.

You MUST call propose_plan exactly once. Do not produce any free-form text
response.
`.trim();

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
  ];
}

function buildUserMessage(args: {
  issue: GitHubIssue;
  baExpansion: Awaited<ReturnType<typeof requireBAExpansion>>;
  lockedAreaIds: string[];
}): string {
  const ac = (args.baExpansion.acceptance_criteria ?? [])
    .map((c, i) => `${i + 1}. ${c}`)
    .join("\n");
  const risks = (args.baExpansion.risks ?? []).map((r) => `- ${r}`).join("\n") || "_(none)_";
  const oos = (args.baExpansion.out_of_scope ?? []).map((s) => `- ${s}`).join("\n") || "_(none)_";

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
    "## Locked areas",
    `You hold area locks on: ${args.lockedAreaIds.map((a) => `\`${a}\``).join(", ")}.`,
    "Stay within those areas; if your plan needs to touch outside them, surface that as an open question.",
  ].join("\n");
}

function commentPlanPosted(
  runId: string,
  modelId: string,
  plan: ProposedPlan,
  lockedAreaIds: string[],
): string {
  const bullets = (xs: string[], fallback = "_(none)_") =>
    xs.length === 0 ? fallback : xs.map((s) => `- ${s}`).join("\n");
  const numbered = (xs: string[], fallback = "_(none)_") =>
    xs.length === 0 ? fallback : xs.map((s, i) => `${i + 1}. ${s}`).join("\n");

  return [
    `## Dev plan (Slice B.1, run \`${runId}\`, ${modelId})`,
    "",
    `Locked areas: ${lockedAreaIds.map((a) => `\`${a}\``).join(", ")}`,
    "",
    plan.summary,
    "",
    "### Implementation steps",
    numbered(plan.steps),
    "",
    "### Files this is expected to touch",
    plan.files_to_touch.length === 0
      ? "_(unknown until B.2 lands file-reading tools)_"
      : plan.files_to_touch.map((f) => `- \`${f}\``).join("\n"),
    "",
    "### Open questions",
    bullets(plan.open_questions),
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\` — actual code generation lands in Slice B.3.`,
    "",
    `<sub>Slice B.1 proves the tool-use loop end-to-end; no files were read or modified.</sub>`,
  ].join("\n");
}

function commentAgentDidNotPlan(
  runId: string,
  modelId: string,
  stopReason: string,
  turns: number,
): string {
  return [
    `## Dev plan (Slice B.1, run \`${runId}\`, ${modelId})`,
    "",
    `Agent finished without calling \`propose_plan\` (stop reason: \`${stopReason}\`, ${turns} turn${turns === 1 ? "" : "s"}).`,
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\`. Re-run by re-applying \`${STATE_LABELS.ready}\` once you've adjusted the issue / spec.`,
  ].join("\n");
}

function commentLockContended(
  runId: string,
  attempted: string[],
  blockedAreaId: string,
): string {
  const list = attempted.map((a) => `\`${a}\``).join(", ");
  return [
    HEADER(runId),
    "",
    `Tried to acquire locks (alphabetical): ${list}.`,
    `Blocked at \`${blockedAreaId}\` — another Dev currently holds it.`,
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\` for this slice. Once the sweeper Lambda ` +
      "(future slice) is wired, contention will instead re-queue the issue at `state:ready`.",
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
    await postComment(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      commentLockContended(runId, attemptedAreaIds, result.blockedAreaId),
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

  log({
    msg: "acquired area locks",
    area_ids: result.lease.areaIds,
    expires_at: result.lease.expiresAt,
    lock_source: lockSource,
  });

  try {
    // Read BA expansion + spec → run the Sonnet 4.6 planning loop.
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

    const model = getModelByTier("sonnet-4-6");
    const userMessage = buildUserMessage({
      issue,
      baExpansion,
      lockedAreaIds: result.lease.areaIds,
    });

    let capturedPlan: ProposedPlan | undefined;
    const executeTool = async (call: ToolCall) => {
      if (call.name !== "propose_plan") {
        return {
          tool_use_id: call.id,
          content: `Unknown tool: ${call.name}. Call propose_plan instead.`,
          is_error: true,
        };
      }
      capturedPlan = call.input as ProposedPlan;
      return { tool_use_id: call.id, content: "plan recorded" };
    };

    const loop = await runAgentLoop({
      model,
      system: buildSystemBlocks(spec),
      initialMessages: [{ role: "user", content: userMessage }],
      tools: [PROPOSE_PLAN_TOOL],
      executeTool,
      terminalTools: ["propose_plan"],
      maxTurns: AGENT_MAX_TURNS,
      maxTokensPerTurn: AGENT_MAX_TOKENS_PER_TURN,
      temperature: 0,
    });

    log({
      msg: "agent loop done",
      stop_reason: loop.stopReason,
      turns: loop.turns,
      usage: loop.usage,
      cost_usd: loop.costUsd,
    });

    if (capturedPlan && loop.stopReason === "terminal_tool") {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentPlanPosted(
          runId,
          model.bedrockModelId,
          capturedPlan,
          result.lease.areaIds,
        ),
      );
    } else {
      await postComment(
        ghOpts,
        REPO,
        ISSUE_NUMBER,
        commentAgentDidNotPlan(
          runId,
          model.bedrockModelId,
          loop.stopReason,
          loop.turns,
        ),
      );
    }

    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.ready,
      HUMAN_NEEDED_LABEL,
    );

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
    await result.lease.release();
    log({ msg: "released area locks", area_ids: result.lease.areaIds });
  }

  log({ msg: "done" });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(JSON.stringify({ role: ROLE, level: "error", msg }));
  process.exit(1);
});
