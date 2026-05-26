import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeFunctionalReport } from "../agents/functional/src/plan.ts";

describe("normalizeFunctionalReport", () => {
  it("passes through a valid passed report", () => {
    assert.deepEqual(
      normalizeFunctionalReport({
        outcome: "passed",
        summary: "All criteria observed.",
        evidence: "npm test passed.",
      }),
      {
        outcome: "passed",
        summary: "All criteria observed.",
        evidence: "npm test passed.",
      },
    );
  });

  it("defaults malformed outcomes to failed", () => {
    const report = normalizeFunctionalReport({
      outcome: "maybe",
      summary: "",
      evidence: 42,
    });

    assert.equal(report.outcome, "failed");
    assert.equal(report.summary, "(no summary)");
    assert.equal(report.evidence, "");
  });
});
