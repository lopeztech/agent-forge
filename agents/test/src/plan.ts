// Submission shape for Test's terminal tool. Lighter than Dev's because
// Test doesn't open a PR — Dev's branch + PR already exist.
//
// Two outcome shapes:
//
//   - `passed`: tests were added and pass. Wrapper auto-commits, pushes,
//     transitions to state:awaiting-functional. coverage_notes goes in the
//     issue comment.
//   - `needs_dev_change`: Test agent determined the change can't be
//     meaningfully covered without a Dev-side change (export an internal
//     symbol, fix an actual bug, etc.). Wrapper kicks back to Dev via the
//     shared kickback helper — same flow Functional/Security/PO use on a
//     failed verdict. coverage_notes becomes the kickback reason; any
//     uncommitted test work is discarded (Dev's resume-on-kickback will
//     pick the branch up again; Test re-runs cleanly on the next pass).

export type TestOutcome = "passed" | "needs_dev_change";

export type TestSubmission = {
  outcome: TestOutcome;
  summary: string;
  // For `passed`: what the agent did at a high level (issue-comment body).
  // For `needs_dev_change`: the specific code-side changes Dev must make,
  // mapped to acceptance criteria. Used as the kickback comment body.
  coverage_notes: string;
};

export function normalizeTestSubmission(raw: unknown): TestSubmission {
  const r = (raw ?? {}) as Partial<Record<keyof TestSubmission, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const outcome: TestOutcome =
    r.outcome === "needs_dev_change" ? "needs_dev_change" : "passed";
  return {
    outcome,
    summary: str(r.summary, "(no summary)"),
    coverage_notes: str(r.coverage_notes, ""),
  };
}
