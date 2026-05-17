// BA role — stub entrypoint.
//
// Slice A scope: prove the orchestration path works end-to-end (label →
// EventBridge → Step Function → Fargate → GitHub API → label transition)
// without depending on Bedrock. The real BA agent (spec reading,
// acceptance-criteria extraction, sub-issue splitting, Bedrock InvokeModel
// with prompt caching) lands in Slice B.
//
// Behaviour:
//   1. Read env vars set by the Step Function's RunTask container override.
//   2. Look up writer_install_id from the products row.
//   3. Mint an installation token for the writer App.
//   4. Post a comment on the issue identifying this run.
//   5. Transition the label state:idea → state:cost-estimating.
//   6. Write a budget_ledger row with zero spend (no LLM call yet).
//
// Failure modes:
//   - Any uncaught error: process exits non-zero → ECS task fails →
//     Step Function transitions to its TaskFailed state. The issue keeps
//     its state:idea label (no transition happens), so the next time the
//     issue is touched the label change re-fires the rule. This is correct
//     for transient errors. For permanent errors we'll add explicit
//     human-needed labeling in Slice B.

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import { getInstallationTokenFromSecret } from "../../../shared/github/auth.ts";

type ProductRow = {
  product_id: string;
  repo_full_name: string;
  writer_install_id?: string;
  merger_install_id?: string;
};

const REGION = process.env.AWS_REGION ?? "eu-west-1";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const PRODUCT_ID = required("AGENT_FORGE_PRODUCT_ID");
const ISSUE_NUMBER = required("AGENT_FORGE_ISSUE_NUMBER");
const REPO = required("AGENT_FORGE_REPO");
const APP_SECRET_NAME = required("AGENT_FORGE_APP_SECRET_NAME");
const PRODUCTS_TABLE = required("AGENT_FORGE_PRODUCTS_TABLE");
const ROLE = required("AGENT_FORGE_ROLE");
const ENV = required("AGENT_FORGE_ENV");
const DELIVERY_ID = process.env.AGENT_FORGE_DELIVERY_ID ?? "unknown";
const LABEL = process.env.AGENT_FORGE_LABEL ?? "unknown";

// budget_ledger lives at ${name_prefix}-budget_ledger. We could pass the
// full name as an env var; for now derive it from ENV which encodes the
// prefix suffix. Keeps the env contract minimal.
const BUDGET_LEDGER_TABLE = `agent-forge-${ENV}-budget_ledger`;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

function log(obj: Record<string, unknown>): void {
  // ECS awslogs driver works best with one JSON object per line.
  console.log(JSON.stringify({
    role: ROLE,
    env: ENV,
    product_id: PRODUCT_ID,
    issue: Number(ISSUE_NUMBER),
    delivery_id: DELIVERY_ID,
    ...obj,
  }));
}

async function fetchProductRow(): Promise<ProductRow> {
  const r = await ddb.send(
    new GetCommand({
      TableName: PRODUCTS_TABLE,
      Key: { product_id: PRODUCT_ID },
    }),
  );
  if (!r.Item) {
    throw new Error(`No products row for product_id=${PRODUCT_ID}`);
  }
  return r.Item as ProductRow;
}

async function githubRequest(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": `agent-forge-${ROLE}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`https://api.github.com${path}`, init);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `GitHub API ${method} ${path} failed: ${r.status} ${r.statusText}\n${text}`,
    );
  }
  return r;
}

async function postComment(token: string, body: string): Promise<void> {
  await githubRequest(token, "POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/comments`, {
    body,
  });
}

async function transitionLabel(
  token: string,
  fromLabel: string,
  toLabel: string,
): Promise<void> {
  // Remove the source label. If it's already gone (e.g. a manual reset),
  // GitHub returns 404; treat that as fine.
  const removeResp = await fetch(
    `https://api.github.com/repos/${REPO}/issues/${ISSUE_NUMBER}/labels/${encodeURIComponent(fromLabel)}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": `agent-forge-${ROLE}`,
      },
    },
  );
  if (!removeResp.ok && removeResp.status !== 404) {
    throw new Error(
      `Removing ${fromLabel} failed: ${removeResp.status} ${removeResp.statusText}`,
    );
  }

  await githubRequest(token, "POST", `/repos/${REPO}/issues/${ISSUE_NUMBER}/labels`, {
    labels: [toLabel],
  });
}

async function recordRun(): Promise<void> {
  const ts = new Date().toISOString();
  // budget_ledger SK shape: <iso_ts>#<run_id>. Run ID is the ECS task ARN
  // when present; otherwise a short random fallback.
  const runId = (process.env.ECS_TASK_ARN ?? process.env.AGENT_FORGE_DELIVERY_ID ?? `local-${Date.now()}`)
    .split("/")
    .slice(-1)[0]!;
  await ddb.send(
    new PutCommand({
      TableName: BUDGET_LEDGER_TABLE,
      Item: {
        product_id: PRODUCT_ID,
        ts_run_id: `${ts}#${runId}`,
        role: ROLE,
        issue_number: Number(ISSUE_NUMBER),
        model: "none",
        input_tokens: 0,
        cached_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
        note: "slice-A stub: no LLM call",
      },
    }),
  );
}

async function main(): Promise<void> {
  log({ msg: "starting", repo: REPO, label: LABEL });

  if (LABEL && LABEL !== "state:idea") {
    log({ msg: "non-state:idea label fired this run; nothing to do", label: LABEL });
    return;
  }

  const product = await fetchProductRow();
  if (!product.writer_install_id) {
    throw new Error(`products[${PRODUCT_ID}] has no writer_install_id`);
  }
  log({ msg: "fetched product", writer_install_id: product.writer_install_id });

  const { token, expiresAt } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    product.writer_install_id,
  );
  log({ msg: "minted installation token", expires_at: expiresAt.toISOString() });

  await postComment(
    token,
    `🤖 **BA stub** picked up this issue (slice A: orchestration validation, no LLM yet).\n\n` +
      `Transitioning label \`state:idea\` → \`state:cost-estimating\`. The Cost Estimator Lambda will take over once it's wired in (next slice).\n\n` +
      `<sub>delivery_id: \`${DELIVERY_ID}\`</sub>`,
  );
  log({ msg: "posted comment" });

  await transitionLabel(token, "state:idea", "state:cost-estimating");
  log({ msg: "label transitioned", from: "state:idea", to: "state:cost-estimating" });

  await recordRun();
  log({ msg: "recorded run in budget_ledger" });

  log({ msg: "done" });
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  console.error(JSON.stringify({ role: ROLE, level: "error", msg }));
  process.exit(1);
});
