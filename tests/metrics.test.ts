import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  costEstimatorMetrics,
  hydrationMetrics,
  metricDataFor,
  roleRunFinishedMetrics,
  type Metric,
} from "../shared/metrics/emit.ts";

function dimensionNames(metric: Metric): string[] {
  return (metric.dimensions ?? []).map((d) => d.name);
}

function dimensionShapes(metrics: Metric[], name: string): string[][] {
  return metrics.filter((m) => m.name === name).map(dimensionNames);
}

describe("metricDataFor", () => {
  it("adds env, emit-level dimensions, metric dimensions, and a stable timestamp", () => {
    const timestamp = new Date("2026-05-31T00:00:00.000Z");

    assert.deepEqual(
      metricDataFor(
        [
          {
            name: "Example",
            value: 2,
            unit: "Count",
            dimensions: [{ name: "status", value: "succeeded" }],
          },
        ],
        "dev",
        { dimensions: [{ name: "role", value: "ba" }] },
        timestamp,
      ),
      [
        {
          MetricName: "Example",
          Value: 2,
          Unit: "Count",
          Dimensions: [
            { Name: "env", Value: "dev" },
            { Name: "role", Value: "ba" },
            { Name: "status", Value: "succeeded" },
          ],
          Timestamp: timestamp,
        },
      ],
    );
  });
});

describe("dashboard metric shapes", () => {
  it("emits role aggregates for the dashboard and detailed dimensions for drilldown", () => {
    const metrics = roleRunFinishedMetrics({
      role: "dev",
      productId: "agent-forge",
      status: "succeeded",
      costUsd: 0.42,
    });

    assert.deepEqual(dimensionShapes(metrics, "RoleRunFinished"), [
      ["status"],
      ["role", "product_id", "status"],
    ]);
    assert.deepEqual(dimensionShapes(metrics, "RoleRunCost"), [
      ["role"],
      ["role", "product_id", "status"],
    ]);
  });

  it("emits cost-estimator aggregates for the dashboard and per-product detail", () => {
    const metrics = costEstimatorMetrics({
      productId: "agent-forge",
      decision: "auto-approved",
      costUsd: 0.02,
      p50TotalUsd: 0.75,
    });

    assert.deepEqual(dimensionShapes(metrics, "CostEstimatorRun"), [
      ["decision"],
      ["product_id", "decision"],
    ]);
    assert.deepEqual(dimensionShapes(metrics, "CostEstimatorCost"), [
      ["decision"],
      ["product_id", "decision"],
    ]);
    assert.deepEqual(dimensionShapes(metrics, "CostEstimateP50"), [
      [],
      ["product_id", "decision"],
    ]);
  });

  it("emits hydration aggregates for the dashboard and per-product detail", () => {
    const metrics = hydrationMetrics({
      productId: "agent-forge",
      gapsFiled: 3,
      costUsd: 0.11,
    });

    assert.deepEqual(dimensionShapes(metrics, "HydrationGapsFiled"), [
      [],
      ["product_id"],
    ]);
    assert.deepEqual(dimensionShapes(metrics, "HydrationCost"), [
      [],
      ["product_id"],
    ]);
  });
});
