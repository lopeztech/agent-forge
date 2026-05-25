// Kickback orchestrator shared by downstream roles (Test, Functional,
// Security, PO).
//
// When a role decides the PR is wrong/incomplete and needs another Dev
// attempt, it calls kickbackToDev() to:
//
//   1. Increment iter:N on the issue (1 → 2, 2 → 3). If already at 3,
//      returns { kind: "capped" } and the caller parks at human-needed
//      instead — CLAUDE.md → Failure handling caps Dev attempts at 3.
//   2. Remove the current state label (state:awaiting-tests / -functional /
//      -security / -po) and the OLD iter:N label.
//   3. Apply the new iter:N+1 label + state:ready, which re-fires Dev's
//      EventBridge rule.
//   4. Increment issue_state.kickback_count for audit (in addition to the
//      label-visible iter:N).
//
// Fresh-start semantics: Dev's setupWorkdir creates the feature branch
// with `git checkout -B`, which resets the branch from main. Test's
// commits + any prior Dev commits on the branch are discarded. A future
// slice could fetch + resume the existing branch instead.

import {
  addLabels,
  removeLabel,
  type RequestOptions,
} from "../github/repo.ts";
import {
  STATE_LABELS,
  iterLabel,
  nextIterAttempt,
  type IterAttempt,
} from "../labels.ts";
import { incrementKickback } from "../state/issue-state.ts";

export type KickbackOpts = {
  ghOpts: RequestOptions;
  repo: string;
  issueNumber: number;
  // The state label the kicker is leaving — e.g. state:awaiting-functional.
  currentState: string;
  // Current iter:N value parsed from the issue's labels (or undefined when
  // no iter:* label is present, which only happens on a bug or for
  // pre-#23 stale issues).
  currentAttempt: IterAttempt | undefined;
  // For audit row + the kickback_count increment.
  issueStateTable: string;
  productId: string;
  fromRole: string;
  runId: string;
};

export type KickbackResult =
  | {
      kind: "kickback";
      newAttempt: IterAttempt;
      kickbackCount: number;
    }
  | { kind: "capped" };

export async function kickbackToDev(opts: KickbackOpts): Promise<KickbackResult> {
  const next = nextIterAttempt(opts.currentAttempt);
  if (next === "cap") return { kind: "capped" };

  // Remove the current state + (if present) the old iter:N label. The
  // helper tolerates 404 on remove, so doing this before the bump is safe.
  await removeLabel(opts.ghOpts, opts.repo, opts.issueNumber, opts.currentState);
  if (opts.currentAttempt !== undefined) {
    await removeLabel(
      opts.ghOpts,
      opts.repo,
      opts.issueNumber,
      iterLabel(opts.currentAttempt),
    );
  }

  // Add the new iter label + state:ready in one call. addLabels is
  // idempotent on already-present names, so even if iter:N+1 was somehow
  // already there this is a no-op.
  await addLabels(opts.ghOpts, opts.repo, opts.issueNumber, [
    iterLabel(next),
    STATE_LABELS.ready,
  ]);

  // Audit: bump issue_state.kickback_count. Doesn't drive any agent
  // behaviour today; useful for weekly digests + per-product accuracy
  // metrics in the long-term roadmap.
  const newCount = await incrementKickback({
    tableName: opts.issueStateTable,
    productId: opts.productId,
    issueNumber: opts.issueNumber,
    fromRole: opts.fromRole,
    runId: opts.runId,
  });

  return { kind: "kickback", newAttempt: next, kickbackCount: newCount };
}
