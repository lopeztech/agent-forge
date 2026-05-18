// Append-only spend writer for the budget_ledger table.
//
// Every model call across agent-forge logs here. The circuit breaker (per-issue,
// per-role-per-day, per-product-per-day, global) reads from this table; that
// read path lands in a later slice. This module is only the writer.
//
// SK shape `<iso_ts>#<run_id>` matches what BA's slice-A stub writes
// (agents/ba/src/index.ts:170), so daily/weekly rollups can Query on a SK
// BETWEEN range without an extra GSI.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

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

export type SpendRecord = {
  product_id: string;
  issue_number: number;
  role: string;
  model: string;
  input_tokens: number;
  cached_tokens: number;
  output_tokens: number;
  cost_usd: number;
  note?: string;
};

export type RecordSpendOpts = {
  tableName: string;
  runId: string;
  spend: SpendRecord;
  timestamp?: Date;
};

export async function recordSpend(opts: RecordSpendOpts): Promise<void> {
  const ts = (opts.timestamp ?? new Date()).toISOString();
  await ddb().send(
    new PutCommand({
      TableName: opts.tableName,
      Item: {
        ...opts.spend,
        ts_run_id: `${ts}#${opts.runId}`,
      },
    }),
  );
}
