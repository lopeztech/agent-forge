// Thin wrapper around CloudWatch PutMetricData. Used by every Fargate
// role and every Lambda to emit a small per-run metric so the
// `agent-forge` CloudWatch dashboard can plot time series across the
// platform.
//
// Design notes:
//
// - Namespace is fixed: "agent-forge". Single namespace makes per-env
//   filtering rely on the `env` dimension, which keeps the dashboard
//   widget JSON simple.
// - Up to 20 metric values per PutMetricData call; we always emit ≤ 5
//   per run so no batching needed.
// - Errors are swallowed. Metrics are an observability concern, not a
//   correctness one. A CloudWatch outage shouldn't crash an agent.
// - No-op when AGENT_FORGE_ENV is unset (local dev convenience). In
//   AWS the env var is always set by Terraform.

import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";

const REGION = process.env.AWS_REGION ?? "eu-west-1";
const NAMESPACE = "agent-forge";

let _cw: CloudWatchClient | undefined;
function cw(): CloudWatchClient {
  if (!_cw) _cw = new CloudWatchClient({ region: REGION });
  return _cw;
}

export type Dimension = { name: string; value: string };

export type Metric = {
  name: string;
  value: number;
  unit?:
    | "Count"
    | "Seconds"
    | "Milliseconds"
    | "Bytes"
    | "None"
    | "Percent";
  dimensions?: Dimension[];
};

export type EmitOpts = {
  // Per-emit dimensions get merged with the env dimension (and any
  // per-call dims on the Metric itself). env comes from
  // AGENT_FORGE_ENV; absent → emit is a no-op.
  dimensions?: Dimension[];
};

// Best-effort emission. Never throws. Caller is expected to await for
// log ordering but the underlying I/O is fire-and-forget if the env is
// missing.
export async function emitMetrics(
  metrics: Metric[],
  opts: EmitOpts = {},
): Promise<void> {
  if (metrics.length === 0) return;
  const env = process.env.AGENT_FORGE_ENV;
  if (!env) return;

  const baseDims: MetricDatum["Dimensions"] = [
    { Name: "env", Value: env },
    ...(opts.dimensions ?? []).map((d) => ({ Name: d.name, Value: d.value })),
  ];

  const data: MetricDatum[] = metrics.map((m) => ({
    MetricName: m.name,
    Value: m.value,
    Unit: m.unit ?? "None",
    Dimensions: [
      ...baseDims,
      ...(m.dimensions ?? []).map((d) => ({ Name: d.name, Value: d.value })),
    ],
    Timestamp: new Date(),
  }));

  try {
    await cw().send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: data,
      }),
    );
  } catch (err) {
    console.warn(
      JSON.stringify({
        msg: "cloudwatch PutMetricData failed (non-fatal)",
        error: err instanceof Error ? err.message : String(err),
        metric_count: metrics.length,
      }),
    );
  }
}

// Lambda-side convenience emitters. Each picks the right Metric shape +
// dimensions for the dashboard.

export async function emitCostEstimatorRun(args: {
  productId: string;
  decision: "auto-approved" | "parked" | "rejected-above-cap" | "failed";
  costUsd: number;
  p50TotalUsd?: number;
}): Promise<void> {
  const dims: Dimension[] = [
    { name: "product_id", value: args.productId },
    { name: "decision", value: args.decision },
  ];
  const metrics: Metric[] = [
    { name: "CostEstimatorRun", value: 1, unit: "Count", dimensions: dims },
    { name: "CostEstimatorCost", value: args.costUsd, dimensions: dims },
  ];
  if (args.p50TotalUsd !== undefined) {
    metrics.push({
      name: "CostEstimateP50",
      value: args.p50TotalUsd,
      dimensions: dims,
    });
  }
  await emitMetrics(metrics);
}

export async function emitDriftAuditRun(args: {
  checked: number;
  drifted: number;
  filed: number;
}): Promise<void> {
  await emitMetrics([
    { name: "DriftAuditChecked", value: args.checked, unit: "Count" },
    { name: "DriftAuditDrifted", value: args.drifted, unit: "Count" },
    { name: "DriftAuditFiled", value: args.filed, unit: "Count" },
  ]);
}

export async function emitHydrationRun(args: {
  productId: string;
  gapsFiled: number;
  costUsd: number;
}): Promise<void> {
  const dims: Dimension[] = [{ name: "product_id", value: args.productId }];
  await emitMetrics([
    { name: "HydrationGapsFiled", value: args.gapsFiled, unit: "Count", dimensions: dims },
    { name: "HydrationCost", value: args.costUsd, dimensions: dims },
  ]);
}

// Convenience: emit the "role finished a run" pair every Fargate agent
// posts at the end of main(). Two metric series:
//
//   RoleRunFinished  count 1  dims: role, product_id, status
//   RoleRunCost      USD      dims: role, product_id, status
//
// status: "succeeded" when the role completed its intended terminal
// action (Dev shipped a PR, Test pushed, Functional passed, etc.) or
// "failed" otherwise (loop runaway, finalize failed, kickback at cap,
// parked-by-design). Keep the cardinality low — granular outcomes
// belong in CloudWatch Logs, not metrics.
export async function emitRoleRunFinished(args: {
  role: string;
  productId: string;
  status: "succeeded" | "failed";
  costUsd: number;
}): Promise<void> {
  const dims: Dimension[] = [
    { name: "role", value: args.role },
    { name: "product_id", value: args.productId },
    { name: "status", value: args.status },
  ];
  await emitMetrics([
    { name: "RoleRunFinished", value: 1, unit: "Count", dimensions: dims },
    { name: "RoleRunCost", value: args.costUsd, unit: "None", dimensions: dims },
  ]);
}
