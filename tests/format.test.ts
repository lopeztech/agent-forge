import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { formatUsd } from "../shared/format.ts";

describe("formatUsd", () => {
  it("formats simple decimal values with two decimal places", () => {
    assert.equal(formatUsd(1.3), "$1.30");
    assert.equal(formatUsd(0), "$0.00");
  });

  it("formats values with thousands separators", () => {
    assert.equal(formatUsd(1234.5), "$1,234.50");
    assert.equal(formatUsd(1000), "$1,000.00");
    assert.equal(formatUsd(1000000), "$1,000,000.00");
  });

  it("formats negative values with minus sign before currency symbol", () => {
    assert.equal(formatUsd(-4.5), "-$4.50");
    assert.equal(formatUsd(-1), "-$1.00");
    assert.equal(formatUsd(-1234.5), "-$1,234.50");
  });

  it("rounds to two decimal places correctly", () => {
    // Test banker's rounding / half-up rounding behavior
    assert.equal(formatUsd(1.005), "$1.01");
    assert.equal(formatUsd(1.004), "$1.00");
    assert.equal(formatUsd(1.006), "$1.01");
    assert.equal(formatUsd(0.005), "$0.01");
    assert.equal(formatUsd(0.004), "$0.00");
  });

  it("handles zero and near-zero values", () => {
    assert.equal(formatUsd(0), "$0.00");
    assert.equal(formatUsd(0.001), "$0.00");
    assert.equal(formatUsd(0.005), "$0.01");
    assert.equal(formatUsd(-0.001), "-$0.00");
  });

  it("handles large values", () => {
    assert.equal(formatUsd(999999.99), "$999,999.99");
    assert.equal(formatUsd(1234567.89), "$1,234,567.89");
  });

  it("handles values with many decimal places", () => {
    assert.equal(formatUsd(1.234567), "$1.23");
    assert.equal(formatUsd(99.999), "$100.00");
  });

  it("handles negative zero", () => {
    // JavaScript's -0 should format the same as 0
    assert.equal(formatUsd(-0), "$0.00");
  });
});
