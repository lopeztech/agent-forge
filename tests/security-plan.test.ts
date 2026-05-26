import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  isBlocking,
  normalizeSecurityReport,
} from "../agents/security/src/plan.ts";

describe("normalizeSecurityReport", () => {
  it("defaults malformed blocked reports to high severity", () => {
    const report = normalizeSecurityReport({
      outcome: "unknown",
      worst_severity: "weird",
      summary: "",
    });

    assert.equal(report.outcome, "blocked");
    assert.equal(report.worst_severity, "high");
    assert.equal(report.summary, "(no summary)");
  });

  it("defaults malformed clean severities to info", () => {
    const report = normalizeSecurityReport({
      outcome: "clean",
      worst_severity: "weird",
      summary: "No findings.",
    });

    assert.equal(report.outcome, "clean");
    assert.equal(report.worst_severity, "info");
  });
});

describe("isBlocking", () => {
  it("does not block low and medium findings", () => {
    assert.equal(
      isBlocking({
        outcome: "findings",
        worst_severity: "medium",
        summary: "One medium finding.",
        findings: "- Medium finding.",
      }),
      false,
    );
  });

  it("blocks high findings even when outcome is findings", () => {
    assert.equal(
      isBlocking({
        outcome: "findings",
        worst_severity: "high",
        summary: "One high finding.",
        findings: "- High finding.",
      }),
      true,
    );
  });

  it("blocks explicit blocked outcomes", () => {
    assert.equal(
      isBlocking({
        outcome: "blocked",
        worst_severity: "low",
        summary: "Agent marked this blocked.",
        findings: "- Low finding with blocking context.",
      }),
      true,
    );
  });
});
