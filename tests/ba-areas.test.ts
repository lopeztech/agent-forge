import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chooseAreaLabels } from "../agents/ba/src/areas.ts";

const DECLARED = ["agents", "ci", "docs", "infra", "shared"];

describe("chooseAreaLabels", () => {
  it("returns concrete areas sorted alphabetically", () => {
    const r = chooseAreaLabels(["shared", "agents"], DECLARED);
    assert.deepEqual(r, { kind: "concrete", areaIds: ["agents", "shared"] });
  });

  it("dedupes repeated areas", () => {
    const r = chooseAreaLabels(["agents", "agents", "ci"], DECLARED);
    assert.deepEqual(r, { kind: "concrete", areaIds: ["agents", "ci"] });
  });

  it("treats `*` as wildcard and expands to all declared areas alphabetically", () => {
    const r = chooseAreaLabels(["*"], DECLARED);
    assert.deepEqual(r, {
      kind: "wildcard",
      areaIds: ["agents", "ci", "docs", "infra", "shared"],
    });
  });

  it("ignores concrete areas when `*` is also returned", () => {
    const r = chooseAreaLabels(["agents", "*"], DECLARED);
    assert.deepEqual(r, {
      kind: "wildcard",
      areaIds: ["agents", "ci", "docs", "infra", "shared"],
    });
  });

  it("parks when the model returns an empty array", () => {
    const r = chooseAreaLabels([], DECLARED);
    assert.equal(r.kind, "park");
  });

  it("parks when the model returns undefined", () => {
    const r = chooseAreaLabels(undefined, DECLARED);
    assert.equal(r.kind, "park");
  });

  it("drops invalid areas and keeps valid ones", () => {
    const r = chooseAreaLabels(["agents", "bogus", "docs"], DECLARED);
    assert.deepEqual(r, { kind: "concrete", areaIds: ["agents", "docs"] });
  });

  it("parks when every returned area is unknown (surfaces the invalid names)", () => {
    const r = chooseAreaLabels(["bogus", "alsobogus"], DECLARED);
    assert.equal(r.kind, "park");
    if (r.kind === "park") {
      assert.match(r.reason, /bogus/);
      assert.match(r.reason, /alsobogus/);
    }
  });

  it("parks when declared areas list is empty (defensive — caller should catch areas.yml missing upstream)", () => {
    const r = chooseAreaLabels(["agents"], []);
    assert.equal(r.kind, "park");
  });
});
