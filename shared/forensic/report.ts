// Forensic-report writer. Per CLAUDE.md → Long-running concerns:
//
//   "When `human-needed` is set, the agent dumps a structured forensic
//    report (last N tool calls, last LLM message, why it stopped) to S3
//    and links it from the issue."
//
// Every Fargate agent (BA, Dev, Test, Functional, Security, PO) calls
// writeForensicReport() on park paths. The blob lands at
//   s3://<bucket>/<product_id>/<issue_number>/<role>-<run_id>.json
// keyed deterministically so a re-run on the same (product, issue, role,
// run) is idempotent.

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import type { ChatMessage } from "../models.ts";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _s3: S3Client | undefined;
function s3(): S3Client {
  if (!_s3) _s3 = new S3Client({ region: REGION });
  return _s3;
}

export type ForensicSnapshot = {
  // Why the agent parked. Free-form; used as the report's headline.
  reason: string;
  // The loop's stop reason if it ran. Optional — some park paths are
  // pre-loop (no model call yet).
  stop_reason?: string;
  turns?: number;
  // Tail of the conversation history. Pass `loop.messages.slice(-N)` for
  // some sensible N. Empty when the park happened before the loop ran.
  conversation_tail?: ChatMessage[];
  // Tool call counts by name, captured during the run.
  tool_call_counts?: Record<string, number>;
  // Total cost for this attempt, if the loop ran.
  cost_usd?: number;
  // Role-specific structured context (e.g. PO verdict, Functional outcome,
  // Security worst_severity). Free-form JSON.
  extra?: Record<string, unknown>;
};

export type WriteForensicReportOpts = {
  bucket: string;
  productId: string;
  issueNumber: number | string;
  role: string;
  runId: string;
  snapshot: ForensicSnapshot;
};

export type WriteForensicReportResult = {
  bucket: string;
  key: string;
  // Plain s3:// URI for the comment. Human downloads via
  // `aws s3 cp <uri> -` if they want to inspect.
  uri: string;
};

export async function writeForensicReport(
  opts: WriteForensicReportOpts,
): Promise<WriteForensicReportResult> {
  const key = `${opts.productId}/${opts.issueNumber}/${opts.role}-${opts.runId}.json`;
  const body = JSON.stringify(
    {
      written_at: new Date().toISOString(),
      role: opts.role,
      product_id: opts.productId,
      issue_number: opts.issueNumber,
      run_id: opts.runId,
      ...opts.snapshot,
    },
    null,
    2,
  );
  await s3().send(
    new PutObjectCommand({
      Bucket: opts.bucket,
      Key: key,
      Body: body,
      ContentType: "application/json",
    }),
  );
  return {
    bucket: opts.bucket,
    key,
    uri: `s3://${opts.bucket}/${key}`,
  };
}
