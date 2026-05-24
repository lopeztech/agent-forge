// FunctionalReport: what submit_functional_done returns. Compared to Dev's
// Submission, this carries an explicit outcome (passed | failed) — the
// wrapper branches on it for the transition target.

export type FunctionalOutcome = "passed" | "failed";

export type FunctionalReport = {
  outcome: FunctionalOutcome;
  // 1-2 sentence summary of what was verified and how.
  summary: string;
  // Markdown body with evidence: commands run, observed behaviour, mapping
  // to acceptance criteria. Posted to the issue as a comment.
  evidence: string;
};

export function normalizeFunctionalReport(raw: unknown): FunctionalReport {
  const r = (raw ?? {}) as Partial<Record<keyof FunctionalReport, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  // Defensive: if outcome isn't one of the two literal strings, treat as
  // failed — better to park than to mistakenly hand off to Security.
  const outcome: FunctionalOutcome = r.outcome === "passed" ? "passed" : "failed";
  return {
    outcome,
    summary: str(r.summary, "(no summary)"),
    evidence: str(r.evidence, ""),
  };
}
