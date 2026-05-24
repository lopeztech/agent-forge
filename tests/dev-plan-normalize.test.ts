import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeSubmission } from "../agents/dev/src/plan.ts";

describe("normalizeSubmission", () => {
  it("passes through a fully-formed submission unchanged", () => {
    const sub = {
      summary: "Add Testing section to README.md",
      pr_title: "Add Testing section to README.md",
      pr_body: "Closes #38\n\nLists all six npm scripts.",
    };
    assert.deepEqual(normalizeSubmission(sub), sub);
  });

  it("defaults missing summary to a placeholder string", () => {
    const r = normalizeSubmission({ pr_title: "x", pr_body: "y" });
    assert.equal(r.summary, "(no summary)");
  });

  it("defaults missing pr_title to a placeholder string", () => {
    const r = normalizeSubmission({ summary: "x", pr_body: "y" });
    assert.equal(r.pr_title, "(no title)");
  });

  it("defaults missing pr_body to an empty string", () => {
    const r = normalizeSubmission({ summary: "x", pr_title: "y" });
    assert.equal(r.pr_body, "");
  });

  it("rejects empty-string values (uses fallback instead)", () => {
    const r = normalizeSubmission({ summary: "", pr_title: "", pr_body: "" });
    assert.equal(r.summary, "(no summary)");
    assert.equal(r.pr_title, "(no title)");
    assert.equal(r.pr_body, "");
  });

  it("handles non-string types by falling back", () => {
    const r = normalizeSubmission({
      summary: 42,
      pr_title: null,
      pr_body: { obj: "weird" },
    });
    assert.equal(r.summary, "(no summary)");
    assert.equal(r.pr_title, "(no title)");
    assert.equal(r.pr_body, "");
  });

  it("handles null / undefined input safely", () => {
    for (const v of [null, undefined]) {
      const r = normalizeSubmission(v);
      assert.equal(r.summary, "(no summary)");
      assert.equal(r.pr_title, "(no title)");
      assert.equal(r.pr_body, "");
    }
  });
});
