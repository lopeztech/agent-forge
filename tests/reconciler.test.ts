import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSfInput,
  isStale,
  issueNumberFromExecutionInput,
  reconcilerExecutionName,
  routableStateTarget,
} from "../infra/glue/reconciler/src/logic.ts";

describe("routableStateTarget", () => {
  it("maps each routable state to its role target", () => {
    const cases: Array<[string, string]> = [
      ["state:idea", "ba"],
      ["state:ready", "dev"],
      ["state:awaiting-tests", "test"],
      ["state:awaiting-functional", "functional"],
      ["state:awaiting-security", "security"],
      ["state:awaiting-po", "po"],
    ];
    for (const [state, target] of cases) {
      assert.deepEqual(routableStateTarget([{ name: state }]), { state, target });
    }
  });

  it("accepts plain-string labels too", () => {
    assert.deepEqual(routableStateTarget(["state:ready"]), {
      state: "state:ready",
      target: "dev",
    });
  });

  it("returns undefined when human-needed is present, even at a routable state", () => {
    assert.equal(
      routableStateTarget([{ name: "state:awaiting-tests" }, { name: "human-needed" }]),
      undefined,
    );
  });

  it("returns undefined for terminal / parked / non-routable states", () => {
    for (const s of [
      "state:done",
      "state:cancelled",
      "state:awaiting-cost-approval",
      "state:cost-estimating",
      "state:in-dev",
    ]) {
      assert.equal(routableStateTarget([{ name: s }]), undefined, `${s} should not route`);
    }
  });

  it("returns undefined when no state label is present", () => {
    assert.equal(routableStateTarget([{ name: "area:docs" }]), undefined);
    assert.equal(routableStateTarget([]), undefined);
  });
});

describe("isStale", () => {
  const now = new Date("2026-05-26T12:00:00Z");
  it("true when updated_at is older than the window", () => {
    assert.equal(isStale("2026-05-26T11:40:00Z", now, 15), true); // 20 min ago
  });
  it("false when updated_at is within the window", () => {
    assert.equal(isStale("2026-05-26T11:50:00Z", now, 15), false); // 10 min ago
  });
  it("true exactly at the boundary", () => {
    assert.equal(isStale("2026-05-26T11:45:00Z", now, 15), true);
  });
  it("false on undefined or unparseable timestamps", () => {
    assert.equal(isStale(undefined, now, 15), false);
    assert.equal(isStale("not-a-date", now, 15), false);
  });
});

describe("reconcilerExecutionName", () => {
  it("is stable within a bucket and changes across buckets", () => {
    const t1 = new Date("2026-05-26T12:00:00Z");
    const t2 = new Date("2026-05-26T12:10:00Z"); // same 20-min bucket
    const t3 = new Date("2026-05-26T12:25:00Z"); // next bucket
    const a = reconcilerExecutionName("prod", 44, "test", t1, 20);
    const b = reconcilerExecutionName("prod", 44, "test", t2, 20);
    const c = reconcilerExecutionName("prod", 44, "test", t3, 20);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("sanitizes product ids unsuitable for execution names", () => {
    const name = reconcilerExecutionName("a/b c:d", 7, "dev", new Date(0), 20);
    assert.match(name, /^reconciler-a-b-c-d-7-dev-\d+$/);
  });
});

describe("buildSfInput", () => {
  it("produces the issues.labeled shape the state machines consume", () => {
    const input = JSON.parse(
      buildSfInput({
        productId: "p1",
        repoFullName: "owner/repo",
        issueNumber: 44,
        issueTitle: "Bump node",
        stateLabel: "state:awaiting-tests",
        eventId: "evt-1",
      }),
    );
    assert.equal(input.detail.product_id, "p1");
    assert.equal(input.detail.delivery_id, "reconciler:evt-1");
    assert.equal(input.detail.payload.issue.number, 44);
    assert.equal(input.detail.payload.repository.full_name, "owner/repo");
    assert.equal(input.detail.payload.label.name, "state:awaiting-tests");
  });
});

describe("issueNumberFromExecutionInput", () => {
  it("extracts the issue number from a webhook-shaped input", () => {
    const input = buildSfInput({
      productId: "p",
      repoFullName: "o/r",
      issueNumber: 123,
      issueTitle: "t",
      stateLabel: "state:ready",
      eventId: "e",
    });
    assert.equal(issueNumberFromExecutionInput(input), 123);
  });

  it("returns undefined on missing / malformed input", () => {
    assert.equal(issueNumberFromExecutionInput(undefined), undefined);
    assert.equal(issueNumberFromExecutionInput("not json"), undefined);
    assert.equal(issueNumberFromExecutionInput("{}"), undefined);
    assert.equal(issueNumberFromExecutionInput('{"detail":{"payload":{}}}'), undefined);
  });
});
