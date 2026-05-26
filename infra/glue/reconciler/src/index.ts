// Orphan reconciler Lambda — level-triggered backstop for the edge-triggered
// label routing (issue #81).
//
// Trigger: EventBridge Scheduler, every RECONCILE_INTERVAL minutes.
//
// Job, per product:
//   1. List open issues via the writer App token.
//   2. Keep issues sitting at a routable state:* label (idea / ready /
//      awaiting-tests / awaiting-functional / awaiting-security / awaiting-po)
//      that is NOT parked (human-needed) and has been stable for
//      > STALE_MINUTES (so we don't race a legitimate just-happened handoff).
//   3. For each, check the target role's state machine for a recent execution
//      referencing this issue. If none exists, the issue is orphaned — its
//      `labeled` event was never routed — so StartExecution with the synthetic
//      input the state machines expect (mirrors the sweeper Lambda).
//
// Idempotency: bucketed execution names (see logic.reconcilerExecutionName)
// plus the "recent execution exists → skip" check mean a healthy in-flight
// issue is never re-fired and a re-fire isn't repeated every tick.

import type { ScheduledEvent } from "aws-lambda";
import {
  DescribeExecutionCommand,
  ExecutionStatus,
  ListExecutionsCommand,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";

import { getInstallationTokenFromSecret } from "../../../../shared/github/auth.ts";
import { listIssues, type RequestOptions } from "../../../../shared/github/repo.ts";
import {
  listProducts,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../../shared/state/products.ts";
import { requiredEnv } from "../../../../shared/env.ts";
import {
  buildSfInput,
  isStale,
  issueNumberFromExecutionInput,
  reconcilerExecutionName,
  routableStateTarget,
  type RoleTarget,
} from "./logic.ts";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const PRODUCTS_TABLE = requiredEnv("PRODUCTS_TABLE");
const APP_SECRET_NAME = requiredEnv("WRITER_SECRET_NAME");

const STATE_MACHINE_ARNS: Record<RoleTarget, string> = {
  ba: requiredEnv("BA_STATE_MACHINE_ARN"),
  dev: requiredEnv("DEV_STATE_MACHINE_ARN"),
  test: requiredEnv("TEST_STATE_MACHINE_ARN"),
  functional: requiredEnv("FUNCTIONAL_STATE_MACHINE_ARN"),
  security: requiredEnv("SECURITY_STATE_MACHINE_ARN"),
  po: requiredEnv("PO_STATE_MACHINE_ARN"),
};

// Older than this at a routable state ⇒ candidate for re-fire.
const STALE_MINUTES = Number(process.env.STALE_MINUTES ?? "15");
// Re-fire dedupe window (and the "recent execution exists → skip" window).
const BUCKET_MINUTES = Number(process.env.BUCKET_MINUTES ?? "20");

const USER_AGENT = "agent-forge-reconciler";

const sfn = new SFNClient({ region: REGION });

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ role: "reconciler", ...obj }));
}

export async function handler(event: ScheduledEvent): Promise<void> {
  const eventId = (event && event.id) || `local-${Date.now()}`;
  const now = new Date();
  log({ msg: "starting", event_id: eventId, stale_minutes: STALE_MINUTES });

  const products = await listProducts({ tableName: PRODUCTS_TABLE });
  let scanned = 0;
  let refired = 0;

  for (const product of products) {
    try {
      const r = await reconcileProduct(product, now, eventId);
      scanned += r.scanned;
      refired += r.refired;
    } catch (err) {
      log({
        msg: "product reconcile failed; continuing",
        product_id: product.product_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({ msg: "done", event_id: eventId, products: products.length, scanned, refired });
}

async function reconcileProduct(
  product: ProductConfig,
  now: Date,
  eventId: string,
): Promise<{ scanned: number; refired: number }> {
  const productId = product.product_id;
  const writerInstallId = requireWriterInstallId(product);
  const { token } = await getInstallationTokenFromSecret(APP_SECRET_NAME, writerInstallId);
  const ghOpts: RequestOptions = { token, userAgent: USER_AGENT };

  const openIssues = await listIssues(ghOpts, product.repo_full_name, { state: "open" });

  let scanned = 0;
  let refired = 0;

  for (const issue of openIssues) {
    const routable = routableStateTarget(issue.labels);
    if (!routable) continue;
    scanned++;

    if (!isStale(issue.updated_at, now, STALE_MINUTES)) continue;

    const smArn = STATE_MACHINE_ARNS[routable.target];
    if (await hasRecentExecutionForIssue(smArn, issue.number, now)) continue;

    // Orphaned: routable, stale, no recent execution. Re-fire.
    const name = reconcilerExecutionName(
      productId,
      issue.number,
      routable.target,
      now,
      BUCKET_MINUTES,
    );
    const input = buildSfInput({
      productId,
      repoFullName: product.repo_full_name,
      issueNumber: issue.number,
      issueTitle: issue.title,
      stateLabel: routable.state,
      eventId,
    });

    try {
      const exec = await sfn.send(
        new StartExecutionCommand({ stateMachineArn: smArn, name, input }),
      );
      refired++;
      log({
        msg: "re-fired orphaned issue",
        product_id: productId,
        issue_number: issue.number,
        state: routable.state,
        target: routable.target,
        execution_arn: exec.executionArn,
      });
    } catch (err) {
      // ExecutionAlreadyExists ⇒ we already re-fired this issue this bucket;
      // benign. Anything else: log and move on (next tick retries).
      const name2 = err instanceof Error ? err.name : "";
      if (name2 === "ExecutionAlreadyExists") {
        log({
          msg: "already re-fired this bucket; skipping",
          product_id: productId,
          issue_number: issue.number,
        });
      } else {
        log({
          msg: "StartExecution failed",
          product_id: productId,
          issue_number: issue.number,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { scanned, refired };
}

// True iff the state machine has an execution referencing this issue that
// started within the last BUCKET_MINUTES (any status). The execution list is
// newest-first, so we stop as soon as we pass the window.
async function hasRecentExecutionForIssue(
  smArn: string,
  issueNumber: number,
  now: Date,
): Promise<boolean> {
  const windowStart = now.getTime() - BUCKET_MINUTES * 60_000;
  const list = await sfn.send(
    new ListExecutionsCommand({ stateMachineArn: smArn, maxResults: 50 }),
  );
  for (const e of list.executions ?? []) {
    const started = e.startDate ? e.startDate.getTime() : 0;
    if (started < windowStart) break; // older than the window; rest are older too
    if (e.status === ExecutionStatus.ABORTED) continue;
    if (!e.executionArn) continue;
    const desc = await sfn.send(
      new DescribeExecutionCommand({ executionArn: e.executionArn }),
    );
    if (issueNumberFromExecutionInput(desc.input) === issueNumber) return true;
  }
  return false;
}
