// Shared helpers for the issue_state DynamoDB table.
//
// issue_state is the per-issue scratchpad that survives role handoffs. Each
// role should update only its own field(s) so BA expansion, cost estimates,
// kickback counters, and forensic pointers do not overwrite each other.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
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

export type IssueStateKey = {
  productId: string;
  issueNumber: number | string;
};

export type BAExpansionState = {
  acceptance_criteria?: string[];
  risks?: string[];
  out_of_scope?: string[];
  complexity?: string;
  rationale?: string;
  spec_conflict?: {
    detected: boolean;
    reason: string;
  };
  // Areas BA decided this issue touches. Either a subset of areas.yml's
  // area names, ["*"] for wildcard, or [] when BA couldn't categorize (in
  // which case BA parks the issue at human-needed + gap:areas-incomplete
  // before downstream roles see it).
  areas?: string[];
  spec_path?: string;
  spec_files?: string[];
  spec_missing?: boolean;
  spec_truncated_by?: string | null;
  spec?: {
    path: string;
    files: number;
    total_bytes: number;
    truncated_by?: string | null;
    missing: boolean;
  };
  model?: string;
  run_id?: string;
};

export type CostEstimateState = {
  per_role: unknown[];
  rationale: string;
  p50_total_usd: number;
  p90_total_usd: number;
  threshold_usd: number;
  decision: string;
  model: string;
  run_id: string;
  posted_comment_id: number | null;
};

export type ForensicPointer = {
  role: string;
  run_id: string;
  artifact_uri: string;
  reason: string;
  created_at: string;
};

export type IssueState = {
  product_id: string;
  issue_id: string;
  ba_expansion?: BAExpansionState;
  estimate?: CostEstimateState;
  kickback_count?: number;
  last_role?: string;
  last_run_id?: string;
  last_state?: string;
  forensic_reports?: ForensicPointer[];
  updated_at?: string;
};

export type GetIssueStateOpts = IssueStateKey & {
  tableName: string;
};

export async function getIssueState(
  opts: GetIssueStateOpts,
): Promise<IssueState | undefined> {
  const r = await ddb().send(
    new GetCommand({
      TableName: opts.tableName,
      Key: key(opts),
    }),
  );
  return r.Item as IssueState | undefined;
}

export type PutBAExpansionOpts = GetIssueStateOpts & {
  expansion: BAExpansionState;
  updatedAt?: Date;
};

export async function putBAExpansion(
  opts: PutBAExpansionOpts,
): Promise<void> {
  await updateFields(opts.tableName, opts, {
    ba_expansion: opts.expansion,
    updated_at: iso(opts.updatedAt),
  });
}

// Loads the BA expansion for an issue. Downstream roles (Cost Estimator, Dev)
// gate on this — if BA never ran or got short-circuited at human-needed, the
// expansion is absent and the caller can't make a structured decision.
export async function getBAExpansion(
  opts: GetIssueStateOpts,
): Promise<BAExpansionState | undefined> {
  const state = await getIssueState(opts);
  return state?.ba_expansion;
}

export async function requireBAExpansion(
  opts: GetIssueStateOpts,
): Promise<BAExpansionState> {
  const expansion = await getBAExpansion(opts);
  if (!expansion) {
    throw new Error(
      `No BA expansion on issue_state for product=${opts.productId} issue=${opts.issueNumber}; BA must run before this role.`,
    );
  }
  return expansion;
}

export type PutCostEstimateOpts = GetIssueStateOpts & {
  estimate: CostEstimateState;
  updatedAt?: Date;
};

export async function putCostEstimate(
  opts: PutCostEstimateOpts,
): Promise<void> {
  await updateFields(opts.tableName, opts, {
    estimate: opts.estimate,
    updated_at: iso(opts.updatedAt),
  });
}

export type MarkCheckpointOpts = GetIssueStateOpts & {
  role: string;
  runId: string;
  stateLabel?: string;
  updatedAt?: Date;
};

export async function markCheckpoint(
  opts: MarkCheckpointOpts,
): Promise<void> {
  const fields: Record<string, unknown> = {
    last_role: opts.role,
    last_run_id: opts.runId,
    updated_at: iso(opts.updatedAt),
  };
  if (opts.stateLabel !== undefined) {
    fields.last_state = opts.stateLabel;
  }
  await updateFields(opts.tableName, opts, fields);
}

export type IncrementKickbackOpts = GetIssueStateOpts & {
  fromRole: string;
  runId: string;
  stateLabel?: string;
  updatedAt?: Date;
};

export async function incrementKickback(
  opts: IncrementKickbackOpts,
): Promise<number> {
  const names: Record<string, string> = {
    "#kickback_count": "kickback_count",
    "#last_role": "last_role",
    "#last_run_id": "last_run_id",
    "#updated_at": "updated_at",
  };
  const values: Record<string, unknown> = {
    ":zero": 0,
    ":one": 1,
    ":last_role": opts.fromRole,
    ":last_run_id": opts.runId,
    ":updated_at": iso(opts.updatedAt),
  };
  const setParts = [
    "#kickback_count = if_not_exists(#kickback_count, :zero) + :one",
    "#last_role = :last_role",
    "#last_run_id = :last_run_id",
    "#updated_at = :updated_at",
  ];

  if (opts.stateLabel !== undefined) {
    names["#last_state"] = "last_state";
    values[":last_state"] = opts.stateLabel;
    setParts.push("#last_state = :last_state");
  }

  const r = await ddb().send(
    new UpdateCommand({
      TableName: opts.tableName,
      Key: key(opts),
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
      ReturnValues: "UPDATED_NEW",
    }),
  );

  const next = r.Attributes?.kickback_count;
  if (typeof next !== "number") {
    throw new Error("DynamoDB did not return numeric kickback_count");
  }
  return next;
}

export type AppendForensicReportOpts = GetIssueStateOpts & {
  report: ForensicPointer;
  updatedAt?: Date;
};

export async function appendForensicReport(
  opts: AppendForensicReportOpts,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: opts.tableName,
      Key: key(opts),
      UpdateExpression:
        "SET #forensic_reports = list_append(if_not_exists(#forensic_reports, :empty), :report), #updated_at = :updated_at",
      ExpressionAttributeNames: {
        "#forensic_reports": "forensic_reports",
        "#updated_at": "updated_at",
      },
      ExpressionAttributeValues: {
        ":empty": [],
        ":report": [opts.report],
        ":updated_at": iso(opts.updatedAt),
      },
    }),
  );
}

function key(opts: IssueStateKey): { product_id: string; issue_id: string } {
  return {
    product_id: opts.productId,
    issue_id: String(opts.issueNumber),
  };
}

async function updateFields(
  tableName: string,
  target: IssueStateKey,
  fields: Record<string, unknown>,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setParts: string[] = [];

  for (const [field, value] of Object.entries(fields)) {
    const nameKey = `#${field}`;
    const valueKey = `:${field}`;
    names[nameKey] = field;
    values[valueKey] = value;
    setParts.push(`${nameKey} = ${valueKey}`);
  }

  await ddb().send(
    new UpdateCommand({
      TableName: tableName,
      Key: key(target),
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }),
  );
}

function iso(date: Date | undefined): string {
  return (date ?? new Date()).toISOString();
}
