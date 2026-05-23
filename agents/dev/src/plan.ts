// ProposedPlan type + defensive normalizer for the propose_plan tool's input.
// Lives in its own file so unit tests can import without triggering the
// top-level main() in agents/dev/src/index.ts.

export type ProposedPlan = {
  summary: string;
  steps: string[];
  files_to_touch: string[];
  open_questions: string[];
};

// Bedrock enforces the JSON schema for tool inputs, but the model has been
// observed (issue #38, B.2 first run) to occasionally omit fields or return
// non-string entries — which crashed the comment formatter with
// `TypeError: a.map is not a function`. Filter to string-only entries and
// default missing fields to safe values.
export function normalizePlan(raw: unknown): ProposedPlan {
  const r = (raw ?? {}) as Partial<Record<keyof ProposedPlan, unknown>>;
  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    summary: typeof r.summary === "string" ? r.summary : "(no summary)",
    steps: stringArray(r.steps),
    files_to_touch: stringArray(r.files_to_touch),
    open_questions: stringArray(r.open_questions),
  };
}
