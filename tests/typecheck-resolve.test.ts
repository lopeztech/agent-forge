import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveTypecheckCommand } from "../shared/agent/typecheck.ts";

describe("resolveTypecheckCommand", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "af-typecheck-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the configured command verbatim when set", async () => {
    assert.equal(
      await resolveTypecheckCommand(dir, "make typecheck"),
      "make typecheck",
    );
  });

  it("ignores a blank configured command and falls through to detection", async () => {
    // No package.json yet in a fresh subdir → undefined.
    const empty = await mkdtemp(join(tmpdir(), "af-typecheck-empty-"));
    assert.equal(await resolveTypecheckCommand(empty, "   "), undefined);
    await rm(empty, { recursive: true, force: true });
  });

  it("detects `npm run typecheck` when package.json declares the script", async () => {
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "node --test" } }),
    );
    assert.equal(await resolveTypecheckCommand(dir, undefined), "npm run typecheck");
  });

  it("returns undefined when package.json has no typecheck script", async () => {
    const noScript = await mkdtemp(join(tmpdir(), "af-typecheck-noscript-"));
    await writeFile(
      join(noScript, "package.json"),
      JSON.stringify({ scripts: { test: "node --test" } }),
    );
    assert.equal(await resolveTypecheckCommand(noScript, undefined), undefined);
    await rm(noScript, { recursive: true, force: true });
  });

  it("returns undefined when there is no package.json", async () => {
    const bare = await mkdtemp(join(tmpdir(), "af-typecheck-bare-"));
    assert.equal(await resolveTypecheckCommand(bare, undefined), undefined);
    await rm(bare, { recursive: true, force: true });
  });

  it("does not throw on unparseable package.json", async () => {
    const broken = await mkdtemp(join(tmpdir(), "af-typecheck-broken-"));
    await writeFile(join(broken, "package.json"), "{ not valid json");
    assert.equal(await resolveTypecheckCommand(broken, undefined), undefined);
    await rm(broken, { recursive: true, force: true });
  });
});
