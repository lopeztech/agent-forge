// Seed (or upsert) a row in the `products` DynamoDB table for an agent-forge
// target product. The verifier Lambda resolves incoming webhooks against
// repo_full_name → product_id via the GSI on this table.
//
// Usage:
//   AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 \
//     npm run seed:product -- \
//       --product-id <id> \
//       --repo <owner/repo> \
//       --writer-install <id> \
//       --merger-install <id>
//
// Optional flags:
//   --prefix <name>                 Defaults to $AGENT_FORGE_NAME_PREFIX or "agent-forge-dev".
//   --spec-path <path>              Defaults to "spec/".
//   --areas-path <path>             Defaults to ".agent-forge/areas.yml".
//   --functional-runtime <mode>     "ephemeral" (default) or "warm".
//   --cost-approval-threshold <usd> Default 1. Issues with p50 ≤ this auto-promote.
//   --concurrency-cap <n>           Max simultaneous Dev tasks. Default 3.

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

type Args = {
  productId: string;
  repo: string;
  writerInstall: string;
  mergerInstall: string;
  prefix: string;
  specPath: string;
  areasPath: string;
  functionalRuntime: "ephemeral" | "warm";
  costApprovalThresholdUsd: number;
  concurrencyCap: number;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--")) continue;
    if (value === undefined) die(`Flag ${flag} requires a value.`);
    switch (flag) {
      case "--product-id":
        out.productId = value;
        break;
      case "--repo":
        if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
          die(`--repo must be "owner/name", got "${value}".`);
        }
        out.repo = value;
        break;
      case "--writer-install":
        out.writerInstall = value;
        break;
      case "--merger-install":
        out.mergerInstall = value;
        break;
      case "--prefix":
        out.prefix = value;
        break;
      case "--spec-path":
        out.specPath = value;
        break;
      case "--areas-path":
        out.areasPath = value;
        break;
      case "--functional-runtime":
        if (value !== "ephemeral" && value !== "warm") {
          die(`--functional-runtime must be "ephemeral" or "warm", got "${value}".`);
        }
        out.functionalRuntime = value;
        break;
      case "--cost-approval-threshold":
        out.costApprovalThresholdUsd = Number(value);
        if (!Number.isFinite(out.costApprovalThresholdUsd)) {
          die(`--cost-approval-threshold must be a number, got "${value}".`);
        }
        break;
      case "--concurrency-cap":
        out.concurrencyCap = Number(value);
        if (!Number.isInteger(out.concurrencyCap) || out.concurrencyCap <= 0) {
          die(`--concurrency-cap must be a positive integer, got "${value}".`);
        }
        break;
      default:
        die(`Unknown flag: ${flag}`);
    }
    i++;
  }

  for (const required of [
    "productId",
    "repo",
    "writerInstall",
    "mergerInstall",
  ] as const) {
    if (!out[required]) die(`Missing required --${kebab(required)}`);
  }

  return {
    productId: out.productId!,
    repo: out.repo!,
    writerInstall: out.writerInstall!,
    mergerInstall: out.mergerInstall!,
    prefix: out.prefix ?? process.env.AGENT_FORGE_NAME_PREFIX ?? "agent-forge-dev",
    specPath: out.specPath ?? "spec/",
    areasPath: out.areasPath ?? ".agent-forge/areas.yml",
    functionalRuntime: out.functionalRuntime ?? "ephemeral",
    costApprovalThresholdUsd: out.costApprovalThresholdUsd ?? 1,
    concurrencyCap: out.concurrencyCap ?? 3,
  };
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function die(msg: string): never {
  console.error(`seed-product: ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const tableName = `${args.prefix}-products`;
  const region = process.env.AWS_REGION ?? "eu-west-1";

  // Phase E: set the 30-day approval gate at onboarding per the 2026-05-25
  // decision. PO suppresses auto-merge while now < approval_gate_until.
  // After 30 days, products.auto_merge takes effect as configured.
  const approvalGateUntil = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();

  console.log(`Seeding product into ${tableName} (${region}):`);
  console.log(`  product_id          : ${args.productId}`);
  console.log(`  repo_full_name      : ${args.repo}`);
  console.log(`  writer_install_id   : ${args.writerInstall}`);
  console.log(`  merger_install_id   : ${args.mergerInstall}`);
  console.log(`  functional_runtime  : ${args.functionalRuntime}`);
  console.log(`  cost_approval_$_p50 : ${args.costApprovalThresholdUsd}`);
  console.log(`  concurrency_cap     : ${args.concurrencyCap}`);
  console.log(`  approval_gate_until : ${approvalGateUntil}`);
  console.log();

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
  await ddb.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        product_id: args.productId,
        repo_full_name: args.repo,
        repo_url: `https://github.com/${args.repo}`,
        writer_install_id: args.writerInstall,
        merger_install_id: args.mergerInstall,
        spec_path: args.specPath,
        areas_path: args.areasPath,
        functional_runtime_mode: args.functionalRuntime,
        cost_approval_threshold_usd: args.costApprovalThresholdUsd,
        concurrency_cap: args.concurrencyCap,
        approval_gate_until: approvalGateUntil,
        updated_at: new Date().toISOString(),
      },
    }),
  );

  console.log("Done. The webhook verifier will now resolve this repo → product_id.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
