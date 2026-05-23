import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeAreaIds } from "../shared/locks/area-locks.ts";

describe("normalizeAreaIds", () => {
  it("deduplicates and sorts area ids alphabetically", () => {
    assert.deepEqual(
      normalizeAreaIds(["frontend", "api", "frontend", "infra"]),
      ["api", "frontend", "infra"],
    );
  });

  it("expands area:* to the complete area set", () => {
    assert.deepEqual(
      normalizeAreaIds(["*"], ["shared", "frontend", "api"]),
      ["api", "frontend", "shared"],
    );
  });

  it("lets area:* dominate any explicitly supplied area ids", () => {
    assert.deepEqual(
      normalizeAreaIds(["frontend", "*"], ["infra", "api"]),
      ["api", "infra"],
    );
  });

  it("requires allAreaIds when acquiring area:*", () => {
    assert.throws(
      () => normalizeAreaIds(["*"]),
      /area:\* lock acquisition requires allAreaIds/,
    );
  });

  it("requires at least one concrete area id", () => {
    assert.throws(
      () => normalizeAreaIds([]),
      /at least one area id is required/,
    );
  });
});
