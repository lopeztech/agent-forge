import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCheck, withBaseRef } from "../shared/agent/checks.ts";

describe("withBaseRef", () => {
  it("exports AGENT_FORGE_BASE_REF before the command when a base ref is given", () => {
    assert.equal(
      withBaseRef("npm test", "origin/main"),
      "export AGENT_FORGE_BASE_REF='origin/main'; npm test",
    );
  });

  it("returns the command unchanged when no base ref is given", () => {
    assert.equal(withBaseRef("npm test", undefined), "npm test");
  });
});

describe("runCheck", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "af-check-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns passed when the command exits 0", async () => {
    const r = await runCheck({
      label: "Tests",
      command: "true",
      workdir: dir,
      timeoutSeconds: 10,
    });
    assert.equal(r.kind, "passed");
  });

  it("returns failed (with output) on a non-zero, non-timeout exit", async () => {
    const r = await runCheck({
      label: "Typecheck",
      command: "echo boom; exit 2",
      workdir: dir,
      timeoutSeconds: 10,
    });
    assert.equal(r.kind, "failed");
    if (r.kind === "failed") {
      assert.match(r.output, /Typecheck failed/);
      assert.match(r.output, /boom/);
    }
  });

  it("returns timed_out (distinct from failed) when the command exceeds the timeout", async () => {
    const r = await runCheck({
      label: "Tests",
      command: "sleep 5",
      workdir: dir,
      timeoutSeconds: 1,
    });
    assert.equal(r.kind, "timed_out");
    if (r.kind === "timed_out") {
      assert.equal(r.timeoutSeconds, 1);
      assert.match(r.output, /timed out after 1s/);
    }
  });

  it("exposes the base ref as $AGENT_FORGE_BASE_REF to the command", async () => {
    const r = await runCheck({
      label: "Tests",
      command: 'test "$AGENT_FORGE_BASE_REF" = "origin/main"',
      workdir: dir,
      timeoutSeconds: 10,
      baseRef: "origin/main",
    });
    assert.equal(r.kind, "passed");
  });
});
