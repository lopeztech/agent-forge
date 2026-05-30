// Comment handler — parses /approve-cost and /cancel slash commands from
// issue comments and transitions labels accordingly.
//
// Trigger: EventBridge rule on detail-type=issue_comment, detail.action=created.
//
// Authority: only OWNER and MEMBER author_associations can issue commands
// (CLAUDE.md cost-gate decision: "OWNER + MEMBER only" — locks out
// outside-collaborator and contractor blast radius).
//
// Commands:
//   /approve-cost — on state:awaiting-cost-approval → state:ready
//   /cancel       — on any non-terminal state → state:cancelled
//
// Anything else (no slash command, wrong author, wrong issue state) is a
// silent no-op with a structured log line.

import { getInstallationTokenFromSecret } from "../../../../shared/github/auth.ts";
import { postComment, transitionLabel } from "../../../../shared/github/repo.ts";
import {
  STATE_LABELS,
  TERMINAL_STATE_LABELS,
  isStateLabel,
} from "../../../../shared/labels.ts";
import { APPROVERS, type Command, hasLabel, parseCommand } from "./logic.ts";
import {
  requireProduct,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../../shared/state/products.ts";
import { requiredEnv } from "../../../../shared/env.ts";

const PRODUCTS_TABLE = requiredEnv("PRODUCTS_TABLE");
const APP_SECRET_NAME = requiredEnv("APP_SECRET_NAME");
const USER_AGENT = "agent-forge-comment-handler";

// ---------------------------------------------------------------------------
// EventBridge event shape
// ---------------------------------------------------------------------------

type EventBridgeEvent = {
  id: string;
  detail: {
    product_id: string;
    action?: string;
    delivery_id?: string;
    payload: {
      action: "created" | "edited" | "deleted";
      issue: {
        number: number;
        state: string;
        labels: Array<{ name: string }>;
      };
      comment: {
        id: number;
        body: string;
        author_association: string;
        user: { login: string; type?: string };
      };
      repository: { full_name: string };
    };
  };
};

type ProductRow = ProductConfig;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ role: "comment-handler", ...obj }));
}

// Terminal states a /cancel must not touch.
// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

async function fetchProductRow(product_id: string): Promise<ProductRow> {
  return requireProduct({
    tableName: PRODUCTS_TABLE,
    productId: product_id,
  });
}

export async function handler(event: EventBridgeEvent): Promise<void> {
  const { product_id, payload } = event.detail;

  // EventBridge rule already filters action=created, but defend against drift.
  if (payload.action !== "created") {
    log({ msg: "non-created action; skipping", action: payload.action });
    return;
  }

  // Bots include our own writer App's comments — never act on those.
  if (payload.comment.user.type === "Bot") {
    log({ msg: "bot comment; skipping", user: payload.comment.user.login });
    return;
  }

  const command = parseCommand(payload.comment.body);
  if (!command) {
    log({ msg: "no command in comment; skipping" });
    return;
  }

  const repo = payload.repository.full_name;
  const issueNumber = payload.issue.number;
  const association = payload.comment.author_association;
  const user = payload.comment.user.login;
  const labels = payload.issue.labels;

  log({
    msg: "command parsed",
    product_id,
    issue_number: issueNumber,
    command,
    user,
    association,
    labels: labels.map((l) => l.name),
  });

  if (!APPROVERS.has(association)) {
    log({ msg: "non-approver; ignoring", association, user });
    return;
  }

  // Validate state before doing anything externally visible.
  if (command === "approve-cost") {
    if (!hasLabel(labels, STATE_LABELS.awaitingCostApproval)) {
      log({ msg: "/approve-cost on wrong state; ignoring" });
      return;
    }
  } else if (command === "cancel") {
    const hasTerminal = labels.some(
      (l) => isStateLabel(l.name) && TERMINAL_STATE_LABELS.has(l.name),
    );
    if (hasTerminal) {
      log({ msg: "/cancel on terminal state; ignoring" });
      return;
    }
  }

  const product = await fetchProductRow(product_id);
  const writerInstallId = requireWriterInstallId(product);
  const { token } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    writerInstallId,
  );

  const opts = { token, userAgent: USER_AGENT };

  if (command === "approve-cost") {
    await transitionLabel(
      opts,
      repo,
      issueNumber,
      STATE_LABELS.awaitingCostApproval,
      STATE_LABELS.ready,
    );
    await postComment(
      opts,
      repo,
      issueNumber,
      `🤖 \`/approve-cost\` accepted from @${user}. Transitioning to \`state:ready\` — a Dev will pick this up when capacity allows.`,
    );
    log({ msg: "approved", user });
    return;
  }

  // /cancel — strip whichever state:* label is present and add state:cancelled.
  const currentStateLabel = labels.find((l) => isStateLabel(l.name));
  if (currentStateLabel) {
    await transitionLabel(
      opts,
      repo,
      issueNumber,
      currentStateLabel.name,
      STATE_LABELS.cancelled,
    );
  } else {
    // No state: label at all — just add state:cancelled.
    await transitionLabel(
      opts,
      repo,
      issueNumber,
      STATE_LABELS.cancelled, // remove first is a no-op (404 swallowed)
      STATE_LABELS.cancelled,
    );
  }
  await postComment(
    opts,
    repo,
    issueNumber,
    `🤖 \`/cancel\` accepted from @${user}. Transitioned to \`state:cancelled\` — workflow stopped.`,
  );
  log({ msg: "cancelled", user, from: currentStateLabel?.name });
}
