// Sweeper Lambda — Phase C of the engine-completion plan.
//
// Trigger: EventBridge rule on `area-lock-released` events, which Dev's
// release path emits (one event per released area). Detail shape:
//
//   {
//     "source": "agent-forge.area-locks",
//     "detail-type": "area-lock-released",
//     "detail": {
//       "product_id": "<id>",
//       "area_id": "<area>",
//       "released_at": "<iso>"
//     }
//   }
//
// Job:
//   1. Query lock_waiters for the oldest waiter on (product_id, area_id).
//   2. If found:
//      a. StartExecution on the Dev Step Function with the synthetic input
//         shape it expects (mimics an EventBridge `issues.labeled` event
//         for state:ready — the Dev SF's ASL reads $.detail.product_id /
//         payload.issue.number / payload.repository.full_name etc.).
//      b. Delete the waiter row.
//   3. Exit. If no waiter exists, the event is benign (e.g. the holding
//      Dev released and nobody was queued).
//
// Two sweeper firings on the same area Query the same partition; the
// oldest-first ordering + StartExecution being idempotent (Dev SF's task
// definitions don't fail on duplicate fires — Dev's own area-lock acquire
// will either succeed or re-queue) means a race is harmless.

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const LOCK_WAITERS_TABLE = requiredEnv("LOCK_WAITERS_TABLE");
const DEV_STATE_MACHINE_ARN = requiredEnv("DEV_STATE_MACHINE_ARN");

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env: ${name}`);
  return v;
}

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sfn = new SFNClient({ region: REGION });

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ role: "sweeper", ...obj }));
}

type ReleasedEvent = {
  id: string;
  detail: {
    product_id: string;
    area_id: string;
    released_at?: string;
  };
};

export async function handler(event: ReleasedEvent): Promise<void> {
  const { product_id, area_id } = event.detail;
  if (!product_id || !area_id) {
    log({ msg: "missing detail fields; skipping", event_id: event.id });
    return;
  }

  log({ msg: "starting", product_id, area_id });

  const waiter = await findOldestWaiter(product_id, area_id);
  if (!waiter) {
    log({ msg: "no waiters for area; benign release", product_id, area_id });
    return;
  }

  // Build the synthetic SF input mimicking an `issues.labeled` webhook
  // event for state:ready. Matches the shape consumed by
  // infra/modules/step-functions/asl/dev-issue-lifecycle.asl.json.
  const sfInput = {
    detail: {
      product_id,
      delivery_id: `sweeper:${event.id}`,
      payload: {
        issue: { number: waiter.issueNumber, title: "(sweeper re-fire)" },
        repository: { full_name: waiter.repo },
        label: { name: "state:ready" },
      },
    },
  };

  try {
    const exec = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: DEV_STATE_MACHINE_ARN,
        // Distinct execution name per re-fire — Step Functions rejects
        // duplicate names within ~24h.
        name: `sweeper-${event.id}-${waiter.issueNumber}`,
        input: JSON.stringify(sfInput),
      }),
    );
    log({
      msg: "started Dev execution",
      product_id,
      area_id,
      issue_number: waiter.issueNumber,
      execution_arn: exec.executionArn,
    });
  } catch (err) {
    log({
      msg: "StartExecution failed; leaving waiter in place for retry",
      product_id,
      area_id,
      issue_number: waiter.issueNumber,
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't delete the waiter — let a future release re-fire us.
    return;
  }

  // Dequeue the waiter we just fired. Idempotent: a duplicate sweeper
  // firing that races on the same waiter sees the same SK gone and
  // either succeeds-no-op (DeleteItem tolerates missing rows) or starts
  // a duplicate Dev execution that re-queues itself if it can't acquire.
  await ddb.send(
    new DeleteCommand({
      TableName: LOCK_WAITERS_TABLE,
      Key: {
        product_id,
        area_waiter_id: buildAreaWaiterId(
          area_id,
          waiter.createdAtIso,
          waiter.issueNumber,
        ),
      },
    }),
  );
  log({
    msg: "dequeued waiter",
    product_id,
    area_id,
    issue_number: waiter.issueNumber,
  });
}

type Waiter = {
  issueNumber: number;
  createdAtIso: string;
  repo: string;
};

async function findOldestWaiter(
  product_id: string,
  area_id: string,
): Promise<Waiter | undefined> {
  const nowEpoch = Math.floor(Date.now() / 1000);
  const r = await ddb.send(
    new QueryCommand({
      TableName: LOCK_WAITERS_TABLE,
      KeyConditionExpression:
        "product_id = :p AND begins_with(area_waiter_id, :prefix)",
      FilterExpression: "expires_at > :now",
      ExpressionAttributeValues: {
        ":p": product_id,
        ":prefix": `${area_id}#`,
        ":now": nowEpoch,
      },
      ScanIndexForward: true,
      Limit: 1,
    }),
  );
  const item = r.Items?.[0];
  if (!item) return undefined;
  const sk = String(item["area_waiter_id"]);
  const parts = sk.split("#");
  if (parts.length !== 3) return undefined;
  const [, createdAtIso, issueNumStr] = parts;
  const issueNumber = Number(issueNumStr);
  if (!createdAtIso || !Number.isFinite(issueNumber)) return undefined;
  return {
    issueNumber,
    createdAtIso,
    repo: String(item["repo"] ?? ""),
  };
}

function buildAreaWaiterId(
  areaId: string,
  createdAtIso: string,
  issueNumber: number,
): string {
  return `${areaId}#${createdAtIso}#${issueNumber}`;
}
