import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureDependencies,
  npmInstallChain,
} from "../shared/agent/install-deps.ts";

describe("npmInstallChain", () => {
  it("prefers `npm ci` then falls back to --legacy-peer-deps when a lockfile exists", () => {
    assert.deepEqual(npmInstallChain(true), [
      "npm ci",
      "npm ci --legacy-peer-deps",
      "npm install --legacy-peer-deps --no-audit --no-fund",
    ]);
  });

  it("uses `npm install` (no ci) when there is no lockfile", () => {
    assert.deepEqual(npmInstallChain(false), [
      "npm install --no-audit --no-fund",
      "npm install --legacy-peer-deps --no-audit --no-fund",
    ]);
  });
});

describe("ensureDependencies", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "af-install-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("is a no-op for a non-npm repo (no package.json, no configured command)", async () => {
    const bare = await mkdtemp(join(tmpdir(), "af-install-bare-"));
    const r = await ensureDependencies({ workdir: bare });
    assert.equal(r.ran, false);
    assert.equal(r.ok, true);
    assert.deepEqual(r.attempts, []);
    await rm(bare, { recursive: true, force: true });
  });

  it("runs a configured command verbatim and reports success", async () => {
    const r = await ensureDependencies({ workdir: dir, configured: "true" });
    assert.equal(r.ran, true);
    assert.equal(r.ok, true);
    assert.equal(r.commandUsed, "true");
    assert.deepEqual(r.attempts.map((a) => a.command), ["true"]);
  });

  it("reports failure (no throw) when a configured command exits non-zero", async () => {
    const r = await ensureDependencies({ workdir: dir, configured: "exit 7" });
    assert.equal(r.ran, true);
    assert.equal(r.ok, false);
    assert.equal(r.commandUsed, undefined);
    assert.equal(r.attempts[0]?.exitCode, 7);
  });

  it("does not treat an empty configured command as an override", async () => {
    // Blank configured → falls through to npm detection; no package.json here.
    const empty = await mkdtemp(join(tmpdir(), "af-install-empty-"));
    const r = await ensureDependencies({ workdir: empty, configured: "   " });
    assert.equal(r.ran, false);
    await rm(empty, { recursive: true, force: true });
  });
});
