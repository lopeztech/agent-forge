import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseAreaLabels } from "../shared/labels.ts";

describe("parseAreaLabels", () => {
  it("returns empty when no area:* labels are present", () => {
    assert.deepEqual(
      parseAreaLabels([{ name: "state:ready" }, { name: "iter:1" }]),
      { hasAll: false, areaIds: [] },
    );
  });

  it("extracts concrete area ids and sorts them alphabetically", () => {
    assert.deepEqual(
      parseAreaLabels([
        { name: "area:frontend" },
        { name: "state:ready" },
        { name: "area:api" },
      ]),
      { hasAll: false, areaIds: ["api", "frontend"] },
    );
  });

  it("flags area:* without expanding it (caller resolves against areas.yml)", () => {
    assert.deepEqual(
      parseAreaLabels([{ name: "area:*" }, { name: "state:ready" }]),
      { hasAll: true, areaIds: [] },
    );
  });

  it("preserves concrete areas when area:* is also present", () => {
    assert.deepEqual(
      parseAreaLabels([
        { name: "area:*" },
        { name: "area:frontend" },
        { name: "area:api" },
      ]),
      { hasAll: true, areaIds: ["api", "frontend"] },
    );
  });

  it("deduplicates repeated area ids", () => {
    assert.deepEqual(
      parseAreaLabels([
        { name: "area:api" },
        { name: "area:api" },
        { name: "area:frontend" },
      ]),
      { hasAll: false, areaIds: ["api", "frontend"] },
    );
  });

  it("ignores an empty area suffix (`area:`)", () => {
    assert.deepEqual(
      parseAreaLabels([{ name: "area:" }, { name: "area:api" }]),
      { hasAll: false, areaIds: ["api"] },
    );
  });
});
