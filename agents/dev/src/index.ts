// Dev (Developer) — Slice A: orchestration + area-lock proof.
//
// Trigger: issue gets label `state:ready`. EventBridge → Step Function → this
// Fargate task. Env vars come from RunTask container overrides
// (see infra/modules/step-functions/asl/dev-issue-lifecycle.asl.json).
//
// This slice does NOT implement any code. It verifies the orchestration wiring
// end-to-end and exercises the area-lock primitive (acquire → release) against
// the live DynamoDB table. Every path parks the issue at `human-needed` because
// the slice that actually writes code lands next.
//
// Branch behaviours:
//   1. Issue has no `area:*` labels at all          → park with gap:areas-incomplete.
//   2. Issue has `area:*` (the wildcard)            → fetch areas.yml; lock the
//                                                     full area set alphabetically.
//                                                     Missing areas.yml → park
//                                                     with gap:areas-incomplete.
//   3. Issue has concrete `area:<name>` labels      → acquire all alphabetically, release, park.
//
// Out of scope this slice (deliberate):
//   - Bedrock model invocation (no code generation yet)
//   - Branching from main, opening a PR
//   - Iteration counter / kickback flow
//   - Spend logging (no model call ⇒ no spend; budget_ledger entries land
//     once Sonnet 4.6 is wired in Slice B).

import { getInstallationTokenFromSecret } from "../../../shared/github/auth.ts";
import {
  addLabels,
  getIssue,
  postComment,
  transitionLabel,
  type GitHubIssue,
} from "../../../shared/github/repo.ts";
import { acquireAreaLocks } from "../../../shared/locks/area-locks.ts";
import {
  AREA_ALL_LABEL,
  GAP_LABELS,
  HUMAN_NEEDED_LABEL,
  STATE_LABELS,
  parseAreaLabels,
} from "../../../shared/labels.ts";
import { readAreasFile } from "../../../shared/github/areas.ts";
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
const AREA_LOCKS_TABLE = requiredEnv("AGENT_FORGE_AREA_LOCKS_TABLE");
const ROLE = requiredEnv("AGENT_FORGE_ROLE");
const ENV = requiredEnv("AGENT_FORGE_ENV");
const DELIVERY_ID = process.env.AGENT_FORGE_DELIVERY_ID ?? "unknown";
const LABEL = process.env.AGENT_FORGE_LABEL ?? "unknown";

const USER_AGENT = `agent-forge-${ROLE}`;

// Lock TTL = 2× the per-issue spend cap. Slice A holds locks for milliseconds,
// but the architecture requires this ceiling so a stuck Dev task self-releases.
const LOCK_TTL_SECONDS = 2 * 60 * 60;

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

const HEADER = (runId: string) =>
  `## Dev orchestration (Slice A, run \`${runId}\`)`;

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
    "",
    "<sub>Slice A does not implement code; it only verifies orchestration + area-lock plumbing.</sub>",
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
    "",
    "<sub>Slice A does not implement code; it only verifies orchestration + area-lock plumbing.</sub>",
  ].join("\n");
}

function commentLockProofOk(
  runId: string,
  areaIds: string[],
  source: "concrete" | "wildcard",
  areasPath?: string,
): string {
  const list = areaIds.map((a) => `\`${a}\``).join(", ");
  const sourceLine =
    source === "wildcard"
      ? `Expanded \`${AREA_ALL_LABEL}\` against \`${areasPath}\` → locked every declared area.`
      : "Locked from concrete `area:<name>` labels on the issue.";
  return [
    HEADER(runId),
    "",
    `Acquired area locks (alphabetical): ${list}.`,
    sourceLine,
    "Lock plumbing verified end-to-end; releasing locks now.",
    "",
    `Parking at \`${HUMAN_NEEDED_LABEL}\` — the slice that actually writes code lands next.`,
    "",
    "<sub>Slice A does not implement code; it only verifies orchestration + area-lock plumbing.</sub>",
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
    "",
    "<sub>Slice A does not implement code; it only verifies orchestration + area-lock plumbing.</sub>",
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
    await postComment(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      commentLockProofOk(runId, result.lease.areaIds, lockSource, areasPath),
    );
    await transitionLabel(
      ghOpts,
      REPO,
      ISSUE_NUMBER,
      STATE_LABELS.ready,
      HUMAN_NEEDED_LABEL,
    );
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
