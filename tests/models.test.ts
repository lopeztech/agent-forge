import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { tierForDev } from "../shared/models.ts";

describe("tierForDev", () => {
  describe("attempt 1 (complexity-driven)", () => {
    it("trivial → haiku-4-5", () => {
      assert.equal(tierForDev({ complexity: "trivial", attempt: 1 }), "haiku-4-5");
    });
    it("small → sonnet-4-6", () => {
      assert.equal(tierForDev({ complexity: "small", attempt: 1 }), "sonnet-4-6");
    });
    it("medium → sonnet-4-6", () => {
      assert.equal(tierForDev({ complexity: "medium", attempt: 1 }), "sonnet-4-6");
    });
    it("large → opus-4-6", () => {
      assert.equal(tierForDev({ complexity: "large", attempt: 1 }), "opus-4-6");
    });
    it("undefined complexity → sonnet-4-6", () => {
      assert.equal(tierForDev({ attempt: 1 }), "sonnet-4-6");
    });
    it("unknown complexity string → sonnet-4-6", () => {
      assert.equal(tierForDev({ complexity: "epic", attempt: 1 }), "sonnet-4-6");
    });
  });

  describe("attempt 2 (floors at Sonnet)", () => {
    it("trivial bumps up to sonnet-4-6", () => {
      assert.equal(tierForDev({ complexity: "trivial", attempt: 2 }), "sonnet-4-6");
    });
    it("small stays at sonnet-4-6", () => {
      assert.equal(tierForDev({ complexity: "small", attempt: 2 }), "sonnet-4-6");
    });
    it("large stays at opus-4-6 (max wins)", () => {
      assert.equal(tierForDev({ complexity: "large", attempt: 2 }), "opus-4-6");
    });
  });

  describe("attempt 3 (always Opus)", () => {
    it("trivial → opus-4-6", () => {
      assert.equal(tierForDev({ complexity: "trivial", attempt: 3 }), "opus-4-6");
    });
    it("small → opus-4-6", () => {
      assert.equal(tierForDev({ complexity: "small", attempt: 3 }), "opus-4-6");
    });
    it("undefined complexity → opus-4-6", () => {
      assert.equal(tierForDev({ attempt: 3 }), "opus-4-6");
    });
  });

  describe("defaults", () => {
    it("no args at all → sonnet-4-6 (attempt 1, no complexity)", () => {
      assert.equal(tierForDev(), "sonnet-4-6");
    });
    it("explicit attempt=undefined treated as 1", () => {
      assert.equal(
        tierForDev({ complexity: "trivial", attempt: undefined }),
        "haiku-4-5",
      );
    });
  });
});
