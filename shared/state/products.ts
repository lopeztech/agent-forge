// Shared helpers for the products DynamoDB table.
//
// products is the source of truth for target-repo configuration: GitHub App
// installation IDs, spec paths, budget thresholds, and runtime knobs.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _ddb: DynamoDBDocumentClient | undefined;

function ddb(): DynamoDBDocumentClient {
  if (!_ddb) {
    _ddb = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
    );
  }
  return _ddb;
}

export type FunctionalRuntimeMode = "ephemeral" | "warm";

export type ProductConfig = {
  product_id: string;
  repo_full_name: string;
  repo_url?: string;
  writer_install_id?: string;
  merger_install_id?: string;
  spec_path?: string;
  areas_path?: string;
  functional_runtime_mode?: FunctionalRuntimeMode;
  cost_approval_threshold_usd?: number;
  concurrency_cap?: number;
  // Per-attempt wall-clock cap for a Dev run. Doubles as the area-lock TTL when
  // Dev acquires (the lock-holder always has at most this long before the lock
  // self-releases via DynamoDB TTL). Defaults to 7200 (2h) at the agent layer.
  // Slice B.1 declares the field; B.3 wires it through to the Fargate task.
  dev_attempt_ttl_seconds?: number;
  // Shell command Dev runs to verify the change before `submit_done`. Falls
  // back to `npm test` when package.json is present, otherwise no-op (the
  // agent is told no tests are configured and may submit without running any).
  // Slice B.1 declares the field; B.3 wires it through to the agent loop.
  test_command?: string;
  updated_at?: string;
};

export type GetProductOpts = {
  tableName: string;
  productId: string;
};

export async function getProduct(
  opts: GetProductOpts,
): Promise<ProductConfig | undefined> {
  const r = await ddb().send(
    new GetCommand({
      TableName: opts.tableName,
      Key: { product_id: opts.productId },
    }),
  );
  return r.Item as ProductConfig | undefined;
}

export async function requireProduct(
  opts: GetProductOpts,
): Promise<ProductConfig> {
  const product = await getProduct(opts);
  if (!product) {
    throw new Error(`No products row for product_id=${opts.productId}`);
  }
  return product;
}

export type ResolveProductByRepoOpts = {
  tableName: string;
  repoIndexName: string;
  repoFullName: string;
};

export async function resolveProductByRepo(
  opts: ResolveProductByRepoOpts,
): Promise<ProductConfig | undefined> {
  const r = await ddb().send(
    new QueryCommand({
      TableName: opts.tableName,
      IndexName: opts.repoIndexName,
      KeyConditionExpression: "repo_full_name = :repo",
      ExpressionAttributeValues: { ":repo": opts.repoFullName },
      Limit: 1,
    }),
  );
  return r.Items?.[0] as ProductConfig | undefined;
}

export function requireWriterInstallId(
  product: ProductConfig,
): string {
  if (!product.writer_install_id) {
    throw new Error(`products[${product.product_id}] has no writer_install_id`);
  }
  return product.writer_install_id;
}

export function requireMergerInstallId(
  product: ProductConfig,
): string {
  if (!product.merger_install_id) {
    throw new Error(`products[${product.product_id}] has no merger_install_id`);
  }
  return product.merger_install_id;
}
