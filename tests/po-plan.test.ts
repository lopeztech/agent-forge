import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizePOReport } from "../agents/po/src/plan.ts";

describe("normalizePOReport", () => {
  it("passes through an approve verdict", () => {
    assert.deepEqual(
      normalizePOReport({
        verdict: "approve",
        summary: "All acceptance criteria are met.",
        details: "AC1 and AC2 are covered.",
      }),
      {
        verdict: "approve",
        summary: "All acceptance criteria are met.",
        details: "AC1 and AC2 are covered.",
      },
    );
  });

  it("defaults malformed verdicts to spec_ambig", () => {
    const report = normalizePOReport({
      verdict: "ship-it",
      summary: "",
      details: 123,
    });

    assert.equal(report.verdict, "spec_ambig");
    assert.equal(report.summary, "(no summary)");
    assert.equal(report.details, "");
  });
});
