// SecurityReport: what submit_security_done returns.
//
// `outcome` is the gate. "clean" hands off to PO; blocking findings kick
// back to Dev through the shared iter:N flow unless the issue is already at
// the cap, where the caller parks at human-needed.
//
// `severity` is a tag for the worst finding. "info" never blocks; "high" or
// "critical" always block (mapped from CLAUDE.md → "Blocking findings →
// back to dev"). "medium" + "low" follow the agent's judgment in `outcome`.

export type SecurityOutcome = "clean" | "findings" | "blocked";

export type SecuritySeverity = "info" | "low" | "medium" | "high" | "critical";

export type SecurityReport = {
  outcome: SecurityOutcome;
  worst_severity: SecuritySeverity;
  // Markdown body with findings. Each finding should name the file +
  // line(s) + a short rule reference (OWASP A0X, CWE-N, or a tool name)
  // + recommended fix.
  findings: string;
  // 1-2 sentence headline for the PR comment ("Clean — no SAST or
  // dependency-audit findings on the diff" / "1 high-severity finding in
  // src/auth.ts; blocks merge").
  summary: string;
};

export function normalizeSecurityReport(raw: unknown): SecurityReport {
  const r = (raw ?? {}) as Partial<Record<keyof SecurityReport, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const outcome: SecurityOutcome =
    r.outcome === "clean" || r.outcome === "findings" || r.outcome === "blocked"
      ? r.outcome
      : "blocked";
  const sev = r.worst_severity;
  const worstSeverity: SecuritySeverity =
    sev === "info" || sev === "low" || sev === "medium" || sev === "high" || sev === "critical"
      ? sev
      : outcome === "clean"
        ? "info"
        : "high";
  return {
    outcome,
    worst_severity: worstSeverity,
    findings: str(r.findings, ""),
    summary: str(r.summary, "(no summary)"),
  };
}

// A report blocks the merge when:
//   - outcome is "blocked", OR
//   - worst_severity is "high" or "critical"
// This matches CLAUDE.md → Security Reviewer ("Blocking findings → back to
// dev. Clean → state:awaiting-po."). Medium / low / info findings ride
// along with the PR comment but don't block.
export function isBlocking(report: SecurityReport): boolean {
  if (report.outcome === "blocked") return true;
  if (report.outcome === "clean") return false;
  return report.worst_severity === "high" || report.worst_severity === "critical";
}
