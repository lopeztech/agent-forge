import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parse } from "yaml";

const WORKFLOWS = [
  ".github/workflows/agent-images.yml",
  ".github/workflows/bootstrap.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/terraform-apply.yml",
  ".github/workflows/terraform-plan.yml",
];

describe("GitHub Actions runtime compatibility", () => {
  it("opts every workflow into Node 24 JavaScript actions before GitHub's forced cutover", () => {
    for (const path of WORKFLOWS) {
      const workflow = parse(readFileSync(path, "utf8")) as {
        env?: Record<string, unknown>;
      };

      assert.equal(
        workflow.env?.FORCE_JAVASCRIPT_ACTIONS_TO_NODE24,
        "true",
        `${path} should set FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true`,
      );
    }
  });
});
