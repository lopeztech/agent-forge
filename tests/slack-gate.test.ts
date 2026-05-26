import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isGateActive } from "../shared/slack/notify.ts";

describe("isGateActive", () => {
  const fixedNow = new Date("2026-05-26T12:00:00.000Z");

  it("returns false when approval_gate_until is undefined", () => {
    assert.equal(isGateActive(undefined, fixedNow), false);
  });

  it("returns false when approval_gate_until is malformed", () => {
    assert.equal(isGateActive("not-an-iso", fixedNow), false);
    assert.equal(isGateActive("", fixedNow), false);
  });

  it("returns true when now < approval_gate_until", () => {
    // 1 hour in the future
    const future = new Date(fixedNow.getTime() + 3600_000).toISOString();
    assert.equal(isGateActive(future, fixedNow), true);
  });

  it("returns false when now >= approval_gate_until", () => {
    // 1 hour in the past
    const past = new Date(fixedNow.getTime() - 3600_000).toISOString();
    assert.equal(isGateActive(past, fixedNow), false);
  });

  it("returns false exactly at the deadline (boundary is inclusive of expiry)", () => {
    const exact = fixedNow.toISOString();
    assert.equal(isGateActive(exact, fixedNow), false);
  });
});
