// Submission shape for Test's terminal tool. Lighter than Dev's because
// Test doesn't open a PR — Dev's branch + PR already exist. Test just
// pushes commits and transitions the label, so it only needs a summary
// that the wrapper uses for the auto-commit message + a "Test added"
// comment on the issue.

export type TestSubmission = {
  summary: string;
  // What the agent did at a high level. Goes into the body of the
  // "Tests added" issue comment so a human can skim.
  coverage_notes: string;
};

export function normalizeTestSubmission(raw: unknown): TestSubmission {
  const r = (raw ?? {}) as Partial<Record<keyof TestSubmission, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  return {
    summary: str(r.summary, "(no summary)"),
    coverage_notes: str(r.coverage_notes, ""),
  };
}
