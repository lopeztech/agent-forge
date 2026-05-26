// POVerdict — the terminal output of the PO agent.
//
// Three outcomes per CLAUDE.md → Roles → Product Owner:
//   - approve:      PR matches the issue's acceptance criteria + cited spec.
//                   The caller auto-merges through the merger App when
//                   products.auto_merge=true; otherwise it posts a
//                   "recommend-merge" comment and parks at human-needed for
//                   a human to merge (the "first 30 days" approval gate).
//   - kickback:     PR is missing something or got something wrong. Slice
//                   callers route this back to Dev by incrementing iter:N
//                   and applying state:ready, unless already at iter:3 cap.
//   - spec_ambig:   the spec itself is unclear about what "correct" means
//                   here. Parks at human-needed regardless of slice
//                   (architecture treats this as a category-3 immediate
//                   park — humans must clarify the spec, not Dev).

export type POVerdict = "approve" | "kickback" | "spec_ambig";

export type POReport = {
  verdict: POVerdict;
  // 1-2 sentence headline ("Approve — all four ACs are observably met
  // by the PR and the spec is unambiguous").
  summary: string;
  // For verdict=approve: brief justification covering each AC.
  // For verdict=kickback: concrete deltas — what's missing or wrong,
  // mapped to specific files / lines / commits where possible.
  // For verdict=spec_ambig: the specific section of spec/ that's
  // unclear and why.
  details: string;
};

export function normalizePOReport(raw: unknown): POReport {
  const r = (raw ?? {}) as Partial<Record<keyof POReport, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const verdict: POVerdict =
    r.verdict === "approve" || r.verdict === "kickback" || r.verdict === "spec_ambig"
      ? r.verdict
      : "spec_ambig"; // safest default — defers to human
  return {
    verdict,
    summary: str(r.summary, "(no summary)"),
    details: str(r.details, ""),
  };
}
