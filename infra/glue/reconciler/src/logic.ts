// Pure, env-free logic for the orphan reconciler. Kept separate from index.ts
// so it is unit-testable without the Lambda's top-level env reads / AWS clients.
//
// Background: pipeline routing is edge-triggered (EventBridge matches the
// one-time `issues.labeled` action). An issue that changes state while its rule
// is absent — mid `terraform apply`, or before a newly-added role was deployed —
// loses its event and is silently orphaned (see issue #81; the incident that
// stranded #44 for two days). The reconciler is the level-triggered backstop.

import { HUMAN_NEEDED_LABEL, STATE_LABELS } from "../../../../shared/labels.ts";

// State labels that route to a role Step Function. Cost-estimating routes to a
// Lambda (not a state machine) and is out of scope for v1; terminal / parked
// states (done, cancelled, awaiting-cost-approval, in-dev, human-needed) are
// never re-fired.
export type RoleTarget = "ba" | "dev" | "test" | "functional" | "security" | "po";

const STATE_TO_TARGET: ReadonlyArray<{ state: string; target: RoleTarget }> = [
  { state: STATE_LABELS.idea, target: "ba" },
  { state: STATE_LABELS.ready, target: "dev" },
  { state: STATE_LABELS.awaitingTests, target: "test" },
  { state: STATE_LABELS.awaitingFunctional, target: "functional" },
  { state: STATE_LABELS.awaitingSecurity, target: "security" },
  { state: STATE_LABELS.awaitingPo, target: "po" },
];

function labelNames(labels: ReadonlyArray<{ name: string } | string>): string[] {
  return labels.map((l) => (typeof l === "string" ? l : l.name));
}

// The routable state + target for an issue, or undefined if the issue is parked
// (human-needed), terminal, or sitting at a non-routable state. A parked issue
// is intentionally left alone — only humans clear human-needed.
export function routableStateTarget(
  labels: ReadonlyArray<{ name: string } | string>,
): { state: string; target: RoleTarget } | undefined {
  const names = labelNames(labels);
  if (names.includes(HUMAN_NEEDED_LABEL)) return undefined;
  for (const entry of STATE_TO_TARGET) {
    if (names.includes(entry.state)) return entry;
  }
  return undefined;
}

// "Has the label been stable long enough to be confident it's stuck, not just
// mid-handoff?" Uses the issue's updated_at as a conservative proxy: a comment
// (e.g. a role's report) resets it, which only ever makes us *less* likely to
// re-fire — safe. Unknown / unparseable freshness → never re-fire.
export function isStale(
  updatedAtIso: string | undefined,
  now: Date,
  staleMinutes: number,
): boolean {
  if (!updatedAtIso) return false;
  const updated = Date.parse(updatedAtIso);
  if (!Number.isFinite(updated)) return false;
  return now.getTime() - updated >= staleMinutes * 60_000;
}

// Bucketed, deterministic execution name. The same issue at the same state
// can't be re-fired more than once per bucket window — Step Functions rejects
// duplicate execution names within ~24h, which is the idempotency guard against
// a permanently-broken issue being re-fired on every scheduler tick.
export function reconcilerExecutionName(
  productId: string,
  issueNumber: number,
  target: RoleTarget,
  now: Date,
  bucketMinutes: number,
): string {
  const bucket = Math.floor(now.getTime() / (bucketMinutes * 60_000));
  const safeProduct = productId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 40);
  return `reconciler-${safeProduct}-${issueNumber}-${target}-${bucket}`;
}

// Synthetic input mirroring an `issues.labeled` webhook event — the shape every
// role state machine consumes via $.detail.payload.* (matches the sweeper).
export function buildSfInput(args: {
  productId: string;
  repoFullName: string;
  issueNumber: number;
  issueTitle: string;
  stateLabel: string;
  eventId: string;
}): string {
  return JSON.stringify({
    detail: {
      product_id: args.productId,
      delivery_id: `reconciler:${args.eventId}`,
      payload: {
        issue: { number: args.issueNumber, title: args.issueTitle },
        repository: { full_name: args.repoFullName },
        label: { name: args.stateLabel },
      },
    },
  });
}

// Pull the issue number out of an existing execution's input JSON, so we can
// tell whether a recent execution already covers this issue. Tolerant of shape.
export function issueNumberFromExecutionInput(
  input: string | undefined,
): number | undefined {
  if (!input) return undefined;
  try {
    const parsed = JSON.parse(input) as {
      detail?: { payload?: { issue?: { number?: unknown } } };
    };
    const n = parsed.detail?.payload?.issue?.number;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
}
