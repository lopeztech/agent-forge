import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeAcquire } from "../shared/rate_limits/bucket.ts";
import {
  DEFAULT_BEDROCK_BUCKETS,
  bucketIdForModel,
} from "../shared/rate_limits/config.ts";

describe("computeAcquire (pure token-bucket math)", () => {
  const cfg = { capacity: 10, refillPerSecond: 1 };

  it("acquires immediately when bucket has enough tokens", () => {
    const r = computeAcquire({
      state: { tokens: 5, lastRefillAtMs: 1_000_000 },
      cfg,
      tokensNeeded: 1,
      nowMs: 1_000_000, // no elapsed time
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.newState.tokens, 4);
      assert.equal(r.newState.lastRefillAtMs, 1_000_000);
    }
  });

  it("refills proportionally to elapsed time", () => {
    // 3 seconds elapsed at 1 RPS adds 3 tokens.
    const r = computeAcquire({
      state: { tokens: 2, lastRefillAtMs: 1_000_000 },
      cfg,
      tokensNeeded: 4,
      nowMs: 1_003_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      // 2 + 3 = 5, minus 4 acquired = 1 remaining.
      assert.equal(r.newState.tokens, 1);
    }
  });

  it("caps refill at capacity", () => {
    // 1000 seconds elapsed would refill 1000 tokens, but capacity is 10.
    const r = computeAcquire({
      state: { tokens: 0, lastRefillAtMs: 1_000_000 },
      cfg,
      tokensNeeded: 10,
      nowMs: 2_000_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.newState.tokens, 0);
  });

  it("reports retryAfterMs when bucket is empty", () => {
    const r = computeAcquire({
      state: { tokens: 0, lastRefillAtMs: 1_000_000 },
      cfg,
      tokensNeeded: 3,
      nowMs: 1_000_000,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      // need 3 tokens, 1 token per second → 3000ms
      assert.equal(r.retryAfterMs, 3000);
    }
  });

  it("retryAfterMs accounts for partial refill since last update", () => {
    // 500ms elapsed → 0.5 tokens added. Need 2 tokens → deficit 1.5 → 1500ms.
    const r = computeAcquire({
      state: { tokens: 0, lastRefillAtMs: 1_000_000 },
      cfg,
      tokensNeeded: 2,
      nowMs: 1_000_500,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.retryAfterMs, 1500);
  });

  it("treats negative elapsed time as zero (clock drift)", () => {
    // nowMs < lastRefillAtMs: should not credit tokens (negative refill).
    const r = computeAcquire({
      state: { tokens: 1, lastRefillAtMs: 2_000_000 },
      cfg,
      tokensNeeded: 1,
      nowMs: 1_000_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.newState.tokens, 0);
      assert.equal(r.newState.lastRefillAtMs, 1_000_000);
    }
  });

  it("supports tokens-needed equal to capacity (single max burst)", () => {
    const r = computeAcquire({
      state: { tokens: 10, lastRefillAtMs: 1_000_000 },
      cfg: { capacity: 10, refillPerSecond: 1 },
      tokensNeeded: 10,
      nowMs: 1_000_000,
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.newState.tokens, 0);
  });
});

describe("DEFAULT_BEDROCK_BUCKETS", () => {
  it("has a config entry for every ModelTier", () => {
    assert.ok(DEFAULT_BEDROCK_BUCKETS["sonnet-4-6"]);
    assert.ok(DEFAULT_BEDROCK_BUCKETS["haiku-4-5"]);
    assert.ok(DEFAULT_BEDROCK_BUCKETS["opus-4-6"]);
  });

  it("uses positive capacity + rate for every tier", () => {
    for (const cfg of Object.values(DEFAULT_BEDROCK_BUCKETS)) {
      assert.ok(cfg.capacity > 0, "capacity > 0");
      assert.ok(cfg.refillPerSecond > 0, "refillPerSecond > 0");
    }
  });
});

describe("bucketIdForModel", () => {
  it("includes region and model id", () => {
    const id = bucketIdForModel("eu.anthropic.claude-sonnet-4-6", "eu-west-1");
    assert.equal(id, "bedrock:eu-west-1:eu.anthropic.claude-sonnet-4-6");
  });

  it("falls back to AWS_REGION env when region arg is absent", () => {
    const prev = process.env.AWS_REGION;
    process.env.AWS_REGION = "eu-central-1";
    try {
      assert.equal(
        bucketIdForModel("eu.anthropic.claude-haiku-4-5-20251001-v1:0"),
        "bedrock:eu-central-1:eu.anthropic.claude-haiku-4-5-20251001-v1:0",
      );
    } finally {
      if (prev === undefined) delete process.env.AWS_REGION;
      else process.env.AWS_REGION = prev;
    }
  });
});
