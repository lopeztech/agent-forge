import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizePlan } from "../agents/dev/src/plan.ts";

describe("normalizePlan", () => {
  it("passes through a fully-formed plan unchanged", () => {
    const plan = {
      summary: "Add a Testing section",
      steps: ["Read package.json", "Append section to README.md"],
      files_to_touch: ["README.md"],
      open_questions: ["Section heading level?"],
    };
    assert.deepEqual(normalizePlan(plan), plan);
  });

  it("defaults missing summary to a placeholder string", () => {
    const r = normalizePlan({
      steps: ["a"],
      files_to_touch: [],
      open_questions: [],
    });
    assert.equal(r.summary, "(no summary)");
  });

  it("converts missing array fields to empty arrays (the regression that crashed B.2)", () => {
    const r = normalizePlan({ summary: "x" });
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.files_to_touch, []);
    assert.deepEqual(r.open_questions, []);
  });

  it("filters out non-string entries from arrays", () => {
    const r = normalizePlan({
      summary: "x",
      steps: ["good", 42, null, "also good"],
      files_to_touch: [{ obj: true }, "README.md"],
      open_questions: [],
    });
    assert.deepEqual(r.steps, ["good", "also good"]);
    assert.deepEqual(r.files_to_touch, ["README.md"]);
  });

  it("treats a non-array as an empty array (e.g. model returned a single string)", () => {
    const r = normalizePlan({
      summary: "x",
      steps: "1. do thing\n2. do other thing",
      files_to_touch: null,
      open_questions: undefined,
    });
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.files_to_touch, []);
    assert.deepEqual(r.open_questions, []);
  });

  it("handles null / undefined input safely", () => {
    const fromNull = normalizePlan(null);
    const fromUndefined = normalizePlan(undefined);
    for (const r of [fromNull, fromUndefined]) {
      assert.equal(r.summary, "(no summary)");
      assert.deepEqual(r.steps, []);
      assert.deepEqual(r.files_to_touch, []);
      assert.deepEqual(r.open_questions, []);
    }
  });
});
