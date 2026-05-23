// Tool input shapes + defensive normalizers for Dev's terminal tool.
//
// Bedrock enforces the JSON schema for tool inputs but the model has been
// observed (issue #38) to occasionally omit required array fields or return
// non-string entries. Normalization here is the wrapper's safety net so a
// successful agent run doesn't crash on the comment formatter.

// `submit_done` is Dev's terminal tool (B.3). Agent calls it when changes
// are written + tested locally. Wrapper validates (commits exist, tests
// pass), commits any uncommitted tree changes, pushes, opens the PR, and
// transitions state:ready → state:awaiting-tests.
export type Submission = {
  summary: string;
  pr_title: string;
  pr_body: string;
};

export function normalizeSubmission(raw: unknown): Submission {
  const r = (raw ?? {}) as Partial<Record<keyof Submission, unknown>>;
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  return {
    summary: str(r.summary, "(no summary)"),
    pr_title: str(r.pr_title, "(no title)"),
    pr_body: str(r.pr_body, ""),
  };
}
