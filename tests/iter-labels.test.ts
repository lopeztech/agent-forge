import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasComplexityHighLabel,
  parseIterLabel,
} from "../shared/labels.ts";

describe("parseIterLabel", () => {
  it("returns undefined when no iter:* label is present", () => {
    assert.equal(parseIterLabel([{ name: "state:ready" }, { name: "area:docs" }]), undefined);
  });

  it("returns 1 for iter:1", () => {
    assert.equal(parseIterLabel([{ name: "iter:1" }]), 1);
  });

  it("returns 2 for iter:2", () => {
    assert.equal(parseIterLabel([{ name: "iter:2" }]), 2);
  });

  it("returns 3 for iter:3", () => {
    assert.equal(parseIterLabel([{ name: "iter:3" }]), 3);
  });

  it("returns the highest attempt when multiple iter:* labels coexist", () => {
    // Defensive: the kicker should remove the old label before adding the
    // new one, but if both happen to coexist briefly, take the higher.
    assert.equal(
      parseIterLabel([{ name: "iter:1" }, { name: "iter:3" }, { name: "iter:2" }]),
      3,
    );
  });

  it("ignores non-iter labels that share a prefix-ish shape", () => {
    assert.equal(
      parseIterLabel([{ name: "iter:99" }, { name: "iter-1" }, { name: "iteration:1" }]),
      undefined,
    );
  });
});

describe("hasComplexityHighLabel", () => {
  it("true when complexity:high is present", () => {
    assert.equal(
      hasComplexityHighLabel([{ name: "state:ready" }, { name: "complexity:high" }]),
      true,
    );
  });

  it("false when only the other complexity tier labels are present", () => {
    assert.equal(
      hasComplexityHighLabel([{ name: "complexity:low" }, { name: "state:ready" }]),
      false,
    );
  });

  it("false when label set is empty", () => {
    assert.equal(hasComplexityHighLabel([]), false);
  });
});
