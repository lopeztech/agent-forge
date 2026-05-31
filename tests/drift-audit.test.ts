import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { hasStateDoneLabel } from "../infra/glue/drift-audit/src/logic.ts";

describe("drift audit candidate filtering", () => {
  it("audits only issues that are currently labeled state:done", () => {
    assert.equal(hasStateDoneLabel([{ name: "state:done" }]), true);
    assert.equal(
      hasStateDoneLabel([{ name: "human-needed" }, { name: "state:awaiting-po" }]),
      false,
    );
    assert.equal(hasStateDoneLabel(undefined), false);
  });
});
