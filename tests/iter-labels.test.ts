import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  hasComplexityLargeLabel,
  nextIterAttempt,
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

describe("nextIterAttempt", () => {
  it("bumps 1 → 2", () => {
    assert.equal(nextIterAttempt(1), 2);
  });

  it("bumps 2 → 3", () => {
    assert.equal(nextIterAttempt(2), 3);
  });

  it("returns 'cap' from 3 (no further attempts allowed)", () => {
    assert.equal(nextIterAttempt(3), "cap");
  });

  it("defensive: undefined is treated as 1 → next is 2", () => {
    assert.equal(nextIterAttempt(undefined), 2);
  });
});

describe("hasComplexityLargeLabel", () => {
  it("true when complexity:large is present", () => {
    assert.equal(
      hasComplexityLargeLabel([{ name: "state:ready" }, { name: "complexity:large" }]),
      true,
    );
  });

  it("false when the old complexity:high name is present", () => {
    assert.equal(
      hasComplexityLargeLabel([{ name: "complexity:high" }, { name: "state:ready" }]),
      false,
    );
  });

  it("false when label set is empty", () => {
    assert.equal(hasComplexityLargeLabel([]), false);
  });
});
