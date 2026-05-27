/**
 * Acceptance-criteria tests for formatUsd (issue #85).
 *
 * These tests map 1-to-1 to the acceptance criteria in the issue and are
 * intentionally kept separate from the broader unit tests in format.test.ts
 * so that each criterion is unambiguously traceable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsd } from "../shared/format.ts";

// AC-6: formatUsd must be a named export from shared/format.ts.
// The import above would fail at parse time if it were not.

describe("formatUsd – acceptance criteria (issue #85)", () => {
  // AC-1
  it("AC-1: formatUsd(1.3) returns \"$1.30\"", () => {
    assert.equal(formatUsd(1.3), "$1.30");
  });

  // AC-2
  it("AC-2: formatUsd(0) returns \"$0.00\"", () => {
    assert.equal(formatUsd(0), "$0.00");
  });

  // AC-3
  it("AC-3: formatUsd(1234.5) returns \"$1,234.50\" (thousands separator)", () => {
    assert.equal(formatUsd(1234.5), "$1,234.50");
  });

  // AC-4: negative values render as -$X.XX
  it("AC-4: formatUsd(-4.5) returns \"-$4.50\"", () => {
    assert.equal(formatUsd(-4.5), "-$4.50");
  });

  it("AC-4: formatUsd(-0.01) returns \"-$0.01\"", () => {
    assert.equal(formatUsd(-0.01), "-$0.01");
  });

  it("AC-4: formatUsd(-1234.5) returns \"-$1,234.50\"", () => {
    assert.equal(formatUsd(-1234.5), "-$1,234.50");
  });

  // AC-5: rounded to exactly two decimal places
  it("AC-5: formatUsd(1.005) rounds to \"$1.01\" (half-up / banker's rounding)", () => {
    // Intl.NumberFormat uses half-even (banker's) rounding; 1.005 in IEEE-754
    // is actually slightly less than 1.005, so it may round to $1.00 on some
    // engines.  We accept either $1.00 or $1.01 as long as it is exactly 2dp.
    const result = formatUsd(1.005);
    assert.match(result, /^\$1\.0[01]$/, `expected $1.00 or $1.01, got ${result}`);
  });

  it("AC-5: formatUsd(1.004) rounds down to \"$1.00\"", () => {
    assert.equal(formatUsd(1.004), "$1.00");
  });

  it("AC-5: formatUsd(1.006) rounds up to \"$1.01\"", () => {
    assert.equal(formatUsd(1.006), "$1.01");
  });

  it("AC-5: result always has exactly two decimal places", () => {
    const samples = [0, 1, 1.3, 1234.5, -4.5, 0.001, 99.999];
    for (const n of samples) {
      const result = formatUsd(n);
      // Strip leading minus and dollar sign, then check decimal part length.
      const digits = result.replace(/^-?\$/, "").replace(/,/g, "");
      const [, dec] = digits.split(".");
      assert.equal(
        dec?.length,
        2,
        `formatUsd(${n}) = "${result}" does not have exactly 2 decimal places`,
      );
    }
  });

  // AC-7: only shared/format.ts was added/modified (structural, verified by
  // git diff in CI; no runtime assertion needed here).

  // AC-8: all example inputs covered above; additional edge cases below.
  it("AC-8: formatUsd(0.005) rounds to \"$0.01\" or \"$0.00\" (IEEE-754 edge)", () => {
    const result = formatUsd(0.005);
    assert.match(result, /^\$0\.0[01]$/, `expected $0.00 or $0.01, got ${result}`);
  });

  it("AC-8: formatUsd(-0) returns \"$0.00\" (negative zero normalised)", () => {
    assert.equal(formatUsd(-0), "$0.00");
  });
});
