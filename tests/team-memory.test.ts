import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONFIDENCE_WEIGHT,
  HALF_LIFE_DAYS,
  mergeLessons,
  parseRoleKey,
  roleKey,
  scoreLesson,
  type Lesson,
} from "../shared/state/team-memory.ts";

function l(partial: Partial<Lesson>): Lesson {
  return {
    product_id: "p",
    role_key: "dev#test",
    role: "dev",
    key: "test",
    text: "",
    confidence: "medium",
    created_at: "2026-05-25T00:00:00.000Z",
    usage_count: 1,
    ...partial,
  };
}

describe("roleKey / parseRoleKey", () => {
  it("round-trips a simple role + key", () => {
    const sk = roleKey("dev", "use-result-types");
    assert.equal(sk, "dev#use-result-types");
    assert.deepEqual(parseRoleKey(sk), {
      role: "dev",
      key: "use-result-types",
    });
  });

  it("handles keys containing '#' literals", () => {
    // The key starts after the first '#'; subsequent '#'s belong to the key.
    const sk = roleKey("po", "ship/no-ship#default");
    assert.deepEqual(parseRoleKey(sk), {
      role: "po",
      key: "ship/no-ship#default",
    });
  });

  it("returns undefined for malformed SKs", () => {
    assert.equal(parseRoleKey(""), undefined);
    assert.equal(parseRoleKey("no-hash"), undefined);
    assert.equal(parseRoleKey("#empty-role"), undefined);
    assert.equal(parseRoleKey("trailing#"), undefined);
  });
});

describe("scoreLesson", () => {
  const FIXED_NOW = new Date("2026-05-25T12:00:00.000Z").getTime();

  it("returns recency_decay × usage × confidence", () => {
    const lesson = l({
      created_at: "2026-05-25T12:00:00.000Z", // age 0
      usage_count: 4,
      confidence: "high",
    });
    // age=0 → decay=1, usage=4, conf=1.0 → score=4
    assert.equal(scoreLesson(lesson, FIXED_NOW), 4);
  });

  it("halves the contribution at one half-life", () => {
    const created = new Date(
      FIXED_NOW - HALF_LIFE_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const lesson = l({
      created_at: created,
      usage_count: 1,
      confidence: "high",
    });
    // age=90d → decay=0.5, usage=1, conf=1.0 → score=0.5
    assert.ok(Math.abs(scoreLesson(lesson, FIXED_NOW) - 0.5) < 1e-9);
  });

  it("floors usage_count at 1 (zero-use lessons still score)", () => {
    const lesson = l({
      created_at: "2026-05-25T12:00:00.000Z",
      usage_count: 0,
      confidence: "low",
    });
    // age=0 → decay=1, usage_floor=1, conf=0.5 → score=0.5
    assert.equal(scoreLesson(lesson, FIXED_NOW), 0.5);
  });

  it("treats future-dated lessons (clock drift) as age 0", () => {
    const future = new Date(FIXED_NOW + 10_000).toISOString();
    const lesson = l({
      created_at: future,
      usage_count: 2,
      confidence: "medium",
    });
    // Negative age clamps to 0 → decay=1 → score = 2 × 0.75 = 1.5
    assert.equal(scoreLesson(lesson, FIXED_NOW), 1.5);
  });

  it("uses the documented confidence weights {0.5, 0.75, 1.0}", () => {
    assert.equal(CONFIDENCE_WEIGHT.low, 0.5);
    assert.equal(CONFIDENCE_WEIGHT.medium, 0.75);
    assert.equal(CONFIDENCE_WEIGHT.high, 1.0);
  });
});

describe("mergeLessons", () => {
  it("returns product as-is when global is empty", () => {
    const product = [l({ product_id: "p", key: "a" })];
    assert.deepEqual(mergeLessons([], product), product);
  });

  it("returns global as-is when product is empty", () => {
    const global = [l({ product_id: "*", key: "a" })];
    assert.deepEqual(mergeLessons(global, []), global);
  });

  it("lets product override global on key conflict", () => {
    const global = [
      l({ product_id: "*", key: "shared", text: "global text" }),
    ];
    const product = [
      l({ product_id: "p", key: "shared", text: "product text" }),
    ];
    const merged = mergeLessons(global, product);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.text, "product text");
    assert.equal(merged[0]?.product_id, "p");
  });

  it("unions non-conflicting keys from both scopes", () => {
    const global = [l({ product_id: "*", key: "only-global" })];
    const product = [l({ product_id: "p", key: "only-product" })];
    const merged = mergeLessons(global, product);
    const keys = merged.map((m) => m.key).sort();
    assert.deepEqual(keys, ["only-global", "only-product"]);
  });
});
