// record_lesson tool — shared across every Fargate role that runs a
// multi-turn agent loop (Dev, Test, Functional, Security, PO). BA's
// single-shot model call doesn't include the tool (BA only reads memory
// into the system prompt; it has no free-roaming loop in which to
// record a lesson).
//
// The agent is encouraged to record a lesson when it notices something
// that would have saved a future run time or cost — e.g. "this project
// uses Result<T, E> not exceptions" or "the test command is `pnpm test
// --reporter=verbose`, not `npm test`". The lesson lands in
// team_memory, scoped to (product, role), with a confidence the agent
// self-reports.
//
// See shared/state/team-memory.ts for the read path (loaded into the
// cached system prefix at run start), the score formula, and the
// eviction policy.

import { recordLesson, type Confidence, type Lesson } from "../state/team-memory.ts";
import type { ToolDefinition } from "../models.ts";

export type RecordLessonTool = ToolDefinition;

export const RECORD_LESSON_TOOL: RecordLessonTool = {
  name: "record_lesson",
  description:
    "Record a lesson learned during this run into the (product, role) " +
    "team memory. Use sparingly: a lesson is something a *future* run of " +
    "your role would benefit from remembering, beyond what's obvious from " +
    "the spec or current code. Examples: project-specific conventions " +
    "(\"this codebase returns Result<T,E>, not exceptions\"), surprising " +
    "test-command quirks, recurring failure modes in this product. NOT " +
    "for: anything in the spec, anything visible in a 30-second skim of " +
    "the repo, or task-specific facts that don't generalize.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["key", "text", "confidence"],
    properties: {
      key: {
        type: "string",
        description:
          "Short slug identifying the lesson (e.g. \"result-types-not-exceptions\"). " +
          "Re-using the same key on a future run overwrites the lesson — pick a " +
          "stable, descriptive slug so refinements accumulate on the same row.",
      },
      text: {
        type: "string",
        description:
          "1-3 sentence lesson body, written for a future agent's eyes. Lead " +
          "with the rule; if non-obvious, follow with 1 sentence of why. " +
          "Concrete is better than abstract.",
      },
      confidence: {
        enum: ["low", "medium", "high"],
        description:
          "How strongly the evidence supports this lesson. high = saw the " +
          "rule applied consistently across multiple files / commits; " +
          "medium = saw it once but it's likely a real convention; low = " +
          "tentative inference worth flagging but easily wrong.",
      },
    },
  },
};

// Format a list of lessons into a system-prompt block for a role.
// Returns an empty string when no lessons exist — caller decides whether
// to include an empty section heading or skip it entirely.
export function buildMemoryBlock(role: string, lessons: Lesson[]): string {
  if (lessons.length === 0) return "";
  const rows = lessons
    .map(
      (l) =>
        `- **${l.key}** (${l.confidence}${l.product_id === "*" ? ", org-global" : ""}): ${l.text}`,
    )
    .join("\n");
  return [
    "=====================",
    `TEAM MEMORY (${role})`,
    "=====================",
    "Lessons accumulated from prior runs in this role. Use them as",
    "soft priors — they're suggestions from your past self, not law.",
    "If a lesson contradicts what you observe in this run, trust your",
    "observation and consider recording a refinement via record_lesson.",
    "",
    rows,
  ].join("\n");
}

// Dispatch helper. Roles call this from their executeTool branch when
// the agent invokes record_lesson. Returns the structured tool-result
// content the loop should hand back to the model.
export type DispatchRecordLessonOpts = {
  tableName: string;
  productId: string;
  role: string;
  runId: string;
  rawInput: unknown;
};

export type DispatchRecordLessonResult = {
  content: string;
  is_error?: boolean;
};

export async function dispatchRecordLesson(
  opts: DispatchRecordLessonOpts,
): Promise<DispatchRecordLessonResult> {
  const input = (opts.rawInput ?? {}) as Partial<{
    key: unknown;
    text: unknown;
    confidence: unknown;
  }>;
  const key = typeof input.key === "string" ? input.key.trim() : "";
  const text = typeof input.text === "string" ? input.text.trim() : "";
  const confRaw = input.confidence;
  const confidence: Confidence | undefined =
    confRaw === "low" || confRaw === "medium" || confRaw === "high"
      ? confRaw
      : undefined;

  if (!key) {
    return { content: "record_lesson rejected: `key` is required and must be non-empty.", is_error: true };
  }
  if (!text) {
    return { content: "record_lesson rejected: `text` is required and must be non-empty.", is_error: true };
  }
  if (!confidence) {
    return {
      content:
        "record_lesson rejected: `confidence` must be one of 'low' | 'medium' | 'high'.",
      is_error: true,
    };
  }

  try {
    const result = await recordLesson({
      tableName: opts.tableName,
      productId: opts.productId,
      role: opts.role,
      key,
      text,
      confidence,
      runId: opts.runId,
    });
    const evictedNote = result.evicted
      ? ` (evicted lowest-scored lesson \`${result.evicted.key}\` to stay under cap)`
      : "";
    return {
      content: `Recorded lesson \`${key}\` (confidence=${confidence})${evictedNote}.`,
    };
  } catch (err) {
    return {
      content: `record_lesson failed: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}
