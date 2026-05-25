// Park-time forensic dumper. Used by every role's index.ts at "park"
// sites (transitions to human-needed) where there's loop / model context
// worth preserving for a human to inspect later.
//
// Per CLAUDE.md → Long-running concerns:
//
//   "When `human-needed` is set, the agent dumps a structured forensic
//    report (last N tool calls, last LLM message, why it stopped) to S3
//    and links it from the issue."
//
// makeParkDumper() returns a function bound to the role/issue identity.
// Each call writes one S3 object and appends a pointer to
// issue_state.forensic_reports[]. Both writes are best-effort: any failure
// logs and swallows so the park itself still happens. The returned URI is
// what the caller embeds in the issue comment ("aws s3 cp <uri> - to
// inspect").
//
// When AGENT_FORGE_FORENSIC_BUCKET is unset, the dumper is a no-op that
// returns undefined — useful for the local-dev path where there's no
// bucket. Production tasks always have it set (see
// infra/envs/<env>/agents.tf).

import { appendForensicReport } from "../state/issue-state.ts";
import type { ChatMessage } from "../models.ts";
import { writeForensicReport, type ForensicSnapshot } from "./report.ts";

export type ParkDumperConfig = {
  // From AGENT_FORGE_FORENSIC_BUCKET — optional. When unset the dumper
  // no-ops; the comment just won't carry a forensic-dump footer.
  bucket: string | undefined;
  issueStateTable: string;
  productId: string;
  issueNumber: number;
  role: string;
  // Caller's structured logger. Defaults to console.log of JSON.
  log?: (obj: Record<string, unknown>) => void;
};

export type ParkDumpArgs = {
  // Human-readable headline for why we parked. Stored in the S3 blob and
  // copied to the issue_state.forensic_reports[].reason field.
  reason: string;
  // Per-task run identifier. Used in the S3 key so a re-run on the same
  // (product, issue, role, run) is idempotent.
  runId: string;
  // Loop-shaped fields. All optional — pre-loop parks pass nothing here.
  stopReason?: string;
  turns?: number;
  toolCallCounts?: Record<string, number>;
  loopMessages?: ReadonlyArray<ChatMessage>;
  costUsd?: number;
  // Role-specific structured context (e.g. PO verdict, Functional outcome,
  // Security worst_severity). Free-form.
  extra?: Record<string, unknown>;
};

// Last 6 messages: ~3 user/assistant turns of context. Plenty for a
// human to see what the agent was doing right before parking without
// blowing the S3 object size up.
const CONVERSATION_TAIL_LENGTH = 6;

export type ParkDumper = (args: ParkDumpArgs) => Promise<string | undefined>;

export function makeParkDumper(cfg: ParkDumperConfig): ParkDumper {
  const log = cfg.log ?? ((obj) => console.log(JSON.stringify(obj)));
  return async function dumpForensicForPark(args) {
    if (!cfg.bucket) {
      log({ msg: "forensic bucket not configured; skipping dump" });
      return undefined;
    }
    try {
      const snapshot: ForensicSnapshot = { reason: args.reason };
      if (args.stopReason !== undefined) snapshot.stop_reason = args.stopReason;
      if (args.turns !== undefined) snapshot.turns = args.turns;
      if (args.toolCallCounts !== undefined) {
        snapshot.tool_call_counts = args.toolCallCounts;
      }
      if (args.loopMessages !== undefined) {
        snapshot.conversation_tail = args.loopMessages.slice(
          -CONVERSATION_TAIL_LENGTH,
        );
      }
      if (args.costUsd !== undefined) snapshot.cost_usd = args.costUsd;
      if (args.extra !== undefined) snapshot.extra = args.extra;
      const written = await writeForensicReport({
        bucket: cfg.bucket,
        productId: cfg.productId,
        issueNumber: cfg.issueNumber,
        role: cfg.role,
        runId: args.runId,
        snapshot,
      });
      await appendForensicReport({
        tableName: cfg.issueStateTable,
        productId: cfg.productId,
        issueNumber: cfg.issueNumber,
        report: {
          role: cfg.role,
          run_id: args.runId,
          artifact_uri: written.uri,
          reason: args.reason,
          created_at: new Date().toISOString(),
        },
      });
      log({ msg: "wrote forensic report", uri: written.uri });
      return written.uri;
    } catch (err) {
      log({
        msg: "forensic dump failed (non-fatal)",
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  };
}

// Standard "<sub>...</sub>" footer to append to a park comment. Roles can
// use it verbatim or build their own — the contract is just "include the
// URI so a human can `aws s3 cp` it".
export function forensicFooter(uri: string): string {
  return `<sub>Forensic dump: \`${uri}\` (last ${CONVERSATION_TAIL_LENGTH} conversation turns + tool counts). \`aws s3 cp <uri> -\` to inspect.</sub>`;
}
