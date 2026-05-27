import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeAreaIds,
  releaseAreaLocks,
} from "../shared/locks/area-locks.ts";

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

describe("releaseAreaLocks", () => {
  it("is a no-op for an empty area list (first-area contention path)", async () => {
    // Regression: on contention acquireAreaLocks calls releaseAreaLocks with
    // the locks it already took; when the FIRST requested area is contended
    // that set is empty. Before the fix, normalizeAreaIds([]) threw "at least
    // one area id is required", escaping acquireAreaLocks and crashing the Dev
    // run (exit 1) instead of returning { acquired: false } so a waiter could
    // be queued. An empty release must resolve without touching DynamoDB.
    await assert.doesNotReject(
      releaseAreaLocks({
        tableName: "unused",
        productId: "p",
        areaIds: [],
        ownerId: "o",
      }),
    );
  });
});
