// API Gateway HTTP API v2 → Lambda → EventBridge.
//
// Verifies an incoming GitHub webhook against the shared signing secret,
// resolves the source repo to an agent-forge product_id via the products
// GSI, and PutEvents the payload onto the custom bus. Downstream
// EventBridge rules dispatch to Step Functions / agent containers.
//
// Returns 200 for everything successfully processed (including "no product
// matched this repo" — that's a configuration issue, not a signature
// issue, and GitHub shouldn't retry on it). 401 only when HMAC fails.

import { createHmac, timingSafeEqual } from "node:crypto";

import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

import { envOrDefault, requiredEnv } from "../../../../shared/env.ts";
import { resolveProductByRepo } from "../../../../shared/state/products.ts";

type APIGatewayProxyEventV2 = {
  body?: string;
  isBase64Encoded?: boolean;
  headers: Record<string, string | undefined>;
  requestContext: { requestId: string };
};

type APIGatewayProxyResultV2 = {
  statusCode: number;
  body?: string;
};

const REGION = envOrDefault("AWS_REGION", "eu-west-1");
const WEBHOOK_SECRET_NAME = requiredEnv("WEBHOOK_SECRET_NAME");
const PRODUCTS_TABLE = requiredEnv("PRODUCTS_TABLE");
const REPO_INDEX_NAME = requiredEnv("REPO_INDEX_NAME");
const EVENT_BUS_NAME = requiredEnv("EVENT_BUS_NAME");
const EVENT_SOURCE = envOrDefault("EVENT_SOURCE", "agent-forge.webhook");

const sm = new SecretsManagerClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

// Cache the signing secret across warm invocations. Re-fetched only on
// container init.
let _signingSecret: string | undefined;
async function getSigningSecret(): Promise<string> {
  if (_signingSecret) return _signingSecret;
  const r = await sm.send(
    new GetSecretValueCommand({ SecretId: WEBHOOK_SECRET_NAME }),
  );
  if (!r.SecretString) {
    throw new Error(
      `Secret ${WEBHOOK_SECRET_NAME} has no SecretString (only SecretBinary set).`,
    );
  }
  _signingSecret = r.SecretString;
  return _signingSecret;
}

function header(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  // API Gateway HTTP API v2 lower-cases all incoming header keys.
  return headers[name.toLowerCase()];
}

function decodeBody(event: APIGatewayProxyEventV2): Buffer {
  if (!event.body) return Buffer.alloc(0);
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf8");
}

function verifySignature(body: Buffer, signature: string, secret: string): boolean {
  // GitHub sends X-Hub-Signature-256: sha256=<hex>
  if (!signature.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  let received: Buffer;
  try {
    received = Buffer.from(signature.slice("sha256=".length), "hex");
  } catch {
    return false;
  }
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}

async function resolveProductId(
  repoFullName: string,
): Promise<string | undefined> {
  const product = await resolveProductByRepo({
    tableName: PRODUCTS_TABLE,
    repoIndexName: REPO_INDEX_NAME,
    repoFullName,
  });
  return product?.product_id;
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const requestId = event.requestContext.requestId;
  const ghEvent = header(event.headers, "x-github-event");
  const ghDelivery = header(event.headers, "x-github-delivery");
  const signature = header(event.headers, "x-hub-signature-256");

  if (!ghEvent || !ghDelivery || !signature) {
    console.warn(JSON.stringify({
      requestId,
      msg: "missing required GitHub webhook headers",
      have: {
        event: Boolean(ghEvent),
        delivery: Boolean(ghDelivery),
        signature: Boolean(signature),
      },
    }));
    return { statusCode: 400, body: "missing required headers" };
  }

  const body = decodeBody(event);
  const secret = await getSigningSecret();
  if (!verifySignature(body, signature, secret)) {
    console.warn(JSON.stringify({
      requestId,
      delivery: ghDelivery,
      msg: "signature verification failed",
    }));
    return { statusCode: 401, body: "bad signature" };
  }

  // GitHub also sends `ping` events when a webhook config is first saved.
  // No repository on those — ack and move on.
  if (ghEvent === "ping") {
    console.log(JSON.stringify({
      requestId,
      delivery: ghDelivery,
      msg: "ping received",
    }));
    return { statusCode: 200, body: "pong" };
  }

  let payload: { repository?: { full_name?: string }; action?: string };
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { statusCode: 400, body: "invalid json body" };
  }

  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    console.warn(JSON.stringify({
      requestId,
      delivery: ghDelivery,
      event: ghEvent,
      msg: "no repository.full_name in payload — ignoring",
    }));
    return { statusCode: 200, body: "no repository" };
  }

  const productId = await resolveProductId(repoFullName);
  if (!productId) {
    console.warn(JSON.stringify({
      requestId,
      delivery: ghDelivery,
      event: ghEvent,
      repo: repoFullName,
      msg: "no product matched repo_full_name — ignoring",
    }));
    return { statusCode: 200, body: "no product for repo" };
  }

  await eb.send(
    new PutEventsCommand({
      Entries: [
        {
          Source: EVENT_SOURCE,
          // detailType = the GitHub event name. EventBridge rules match
          // on this (e.g. detail-type = ["issues", "pull_request"]).
          DetailType: ghEvent,
          EventBusName: EVENT_BUS_NAME,
          Detail: JSON.stringify({
            product_id: productId,
            action: payload.action,
            delivery_id: ghDelivery,
            payload,
          }),
        },
      ],
    }),
  );

  console.log(JSON.stringify({
    requestId,
    delivery: ghDelivery,
    event: ghEvent,
    action: payload.action,
    repo: repoFullName,
    product_id: productId,
    msg: "event forwarded",
  }));

  return { statusCode: 202, body: "accepted" };
}
