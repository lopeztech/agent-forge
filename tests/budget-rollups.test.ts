import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { utcDayFor } from "../shared/budget.ts";

describe("utcDayFor", () => {
  it("returns midnight-bounded ISO window for a given Date", () => {
    const d = new Date("2026-05-25T13:42:17.500Z");
    const day = utcDayFor(d);
    assert.equal(day.date, "2026-05-25");
    assert.equal(day.startIso, "2026-05-25T00:00:00.000Z");
    assert.equal(day.endIso, "2026-05-26T00:00:00.000Z");
  });

  it("normalises to UTC across timezone shifts", () => {
    // 23:30 in UTC-5 = 04:30 next day UTC. utcDayFor returns the UTC day.
    const d = new Date("2026-05-25T23:30:00.000-05:00");
    const day = utcDayFor(d);
    assert.equal(day.date, "2026-05-26");
    assert.equal(day.startIso, "2026-05-26T00:00:00.000Z");
    assert.equal(day.endIso, "2026-05-27T00:00:00.000Z");
  });

  it("crosses month boundary correctly", () => {
    const d = new Date("2026-04-30T23:59:59.999Z");
    const day = utcDayFor(d);
    assert.equal(day.date, "2026-04-30");
    assert.equal(day.endIso, "2026-05-01T00:00:00.000Z");
  });

  it("crosses year boundary correctly", () => {
    const d = new Date("2026-12-31T23:00:00.000Z");
    const day = utcDayFor(d);
    assert.equal(day.date, "2026-12-31");
    assert.equal(day.endIso, "2027-01-01T00:00:00.000Z");
  });

  it("uses current time when no arg is passed", () => {
    const day = utcDayFor();
    // Just sanity-check the shape — we can't assert the date deterministically.
    assert.match(day.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(day.startIso, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    assert.match(day.endIso, /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });
});
