import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isDocsOnlyTestChange } from "../agents/test/src/docs-only.ts";

describe("Test docs-only fast path", () => {
  it("matches Markdown-only PRs", () => {
    assert.equal(
      isDocsOnlyTestChange([
        "README.md",
        "docs/state-lifecycle.md",
        "AGENTS.md",
        "spec/README.mdx",
      ]),
      true,
    );
  });

  it("does not match empty, TypeScript, Terraform, or package changes", () => {
    assert.equal(isDocsOnlyTestChange([]), false);
    assert.equal(isDocsOnlyTestChange(["docs/a.md", "shared/labels.ts"]), false);
    assert.equal(isDocsOnlyTestChange(["docs/a.md", "infra/main.tf"]), false);
    assert.equal(isDocsOnlyTestChange(["package.json"]), false);
  });
});
