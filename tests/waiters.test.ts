import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAreaWaiterId,
  parseAreaWaiterId,
} from "../shared/locks/waiters.ts";

describe("buildAreaWaiterId / parseAreaWaiterId", () => {
  it("round-trips a typical (area, iso, issue) triple", () => {
    const sk = buildAreaWaiterId("frontend", "2026-05-25T13:42:17.500Z", 42);
    assert.equal(sk, "frontend#2026-05-25T13:42:17.500Z#42");
    const parsed = parseAreaWaiterId(sk);
    assert.deepEqual(parsed, {
      areaId: "frontend",
      createdAtIso: "2026-05-25T13:42:17.500Z",
      issueNumber: 42,
    });
  });

  it("sorts lexicographically by time within an area", () => {
    const early = buildAreaWaiterId("api", "2026-05-25T08:00:00.000Z", 100);
    const late = buildAreaWaiterId("api", "2026-05-25T20:00:00.000Z", 1);
    // Issue 100 was earlier; sort says it comes first regardless of issue
    // number (we sort on time, not issue).
    assert.ok(early < late, "earlier time should sort before later");
  });

  it("returns undefined for invalid SK shapes", () => {
    assert.equal(parseAreaWaiterId("not-an-sk"), undefined);
    assert.equal(parseAreaWaiterId("only#two"), undefined);
    assert.equal(parseAreaWaiterId("a#b#c#d"), undefined);
    assert.equal(parseAreaWaiterId(""), undefined);
  });

  it("returns undefined when issue_number isn't numeric", () => {
    assert.equal(
      parseAreaWaiterId("frontend#2026-05-25T13:42:17.500Z#abc"),
      undefined,
    );
  });

  it("preserves area_id case sensitivity", () => {
    const sk = buildAreaWaiterId("Frontend", "2026-01-01T00:00:00.000Z", 1);
    const parsed = parseAreaWaiterId(sk);
    assert.equal(parsed?.areaId, "Frontend");
  });
});
