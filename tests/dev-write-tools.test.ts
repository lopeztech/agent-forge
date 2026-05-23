// Tests for the write_file + bash tools. Real fs + child_process; runs
// against a fixture directory under os.tmpdir().

import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildWriteToolDefinitions,
  dispatchWriteTool,
  runBashRaw,
} from "../agents/dev/src/write-tools.ts";

let WORKDIR: string;

beforeEach(async () => {
  WORKDIR = join(tmpdir(), `dev-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(WORKDIR, { recursive: true });
  await writeFile(join(WORKDIR, "existing.txt"), "old\n");
});

afterEach(async () => {
  await rm(WORKDIR, { recursive: true, force: true });
});

describe("buildWriteToolDefinitions", () => {
  it("returns write_file and bash with required schemas", () => {
    const defs = buildWriteToolDefinitions();
    assert.deepEqual(
      defs.map((d) => d.name),
      ["write_file", "bash"],
    );
  });
});

describe("dispatchWriteTool: write_file", () => {
  it("creates a new file", async () => {
    const r = await dispatchWriteTool(WORKDIR, "write_file", {
      path: "new.md",
      content: "# Hello\n",
    });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    const written = await readFile(join(WORKDIR, "new.md"), "utf8");
    assert.equal(written, "# Hello\n");
  });

  it("overwrites an existing file", async () => {
    const r = await dispatchWriteTool(WORKDIR, "write_file", {
      path: "existing.txt",
      content: "new content\n",
    });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.equal(await readFile(join(WORKDIR, "existing.txt"), "utf8"), "new content\n");
  });

  it("creates parent directories as needed", async () => {
    const r = await dispatchWriteTool(WORKDIR, "write_file", {
      path: "deep/nested/file.txt",
      content: "x",
    });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.equal(await readFile(join(WORKDIR, "deep/nested/file.txt"), "utf8"), "x");
  });

  it("rejects path escapes via ..", async () => {
    const r = await dispatchWriteTool(WORKDIR, "write_file", {
      path: "../outside.txt",
      content: "evil",
    });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /escapes the workdir/);
  });

  it("rejects non-string content", async () => {
    const r = await dispatchWriteTool(WORKDIR, "write_file", {
      path: "x.txt",
      content: 42,
    });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /content must be a string/);
  });

  it("rejects content above the cap", async () => {
    const big = "x".repeat(1024 * 1024 + 1);
    const r = await dispatchWriteTool(WORKDIR, "write_file", {
      path: "big.txt",
      content: big,
    });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /cap/);
  });
});

describe("dispatchWriteTool: bash", () => {
  it("runs a successful command and returns stdout", async () => {
    const r = await dispatchWriteTool(WORKDIR, "bash", { cmd: "echo hello" });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.match(r!.content, /\(exit 0\)/);
    assert.match(r!.content, /hello/);
  });

  it("inherits the workdir as cwd by default", async () => {
    await writeFile(join(WORKDIR, "marker"), "");
    const r = await dispatchWriteTool(WORKDIR, "bash", { cmd: "ls" });
    assert.ok(r);
    assert.match(r!.content, /existing\.txt/);
    assert.match(r!.content, /marker/);
  });

  it("accepts a relative cwd inside the workdir", async () => {
    await mkdir(join(WORKDIR, "sub"), { recursive: true });
    await writeFile(join(WORKDIR, "sub", "inside.txt"), "yes\n");
    const r = await dispatchWriteTool(WORKDIR, "bash", {
      cmd: "ls",
      cwd: "sub",
    });
    assert.ok(r);
    assert.match(r!.content, /inside\.txt/);
  });

  it("rejects a cwd that escapes the workdir", async () => {
    const r = await dispatchWriteTool(WORKDIR, "bash", {
      cmd: "ls",
      cwd: "../",
    });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /escapes the workdir/);
  });

  it("returns the actual exit code on failure", async () => {
    const r = await dispatchWriteTool(WORKDIR, "bash", { cmd: "exit 7" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /\(exit 7\)/);
  });

  it("rejects an empty cmd", async () => {
    const r = await dispatchWriteTool(WORKDIR, "bash", { cmd: "" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
  });
});

describe("runBashRaw", () => {
  it("captures stdout and stderr separately", async () => {
    const r = await runBashRaw(
      'echo out; echo err >&2',
      WORKDIR,
      10_000,
    );
    assert.equal(r.exitCode, 0);
    assert.match(r.stdout, /out/);
    assert.match(r.stderr, /err/);
  });
});

describe("dispatchWriteTool: unknown tool", () => {
  it("returns null for an unrecognised name", async () => {
    const r = await dispatchWriteTool(WORKDIR, "nope", {});
    assert.equal(r, null);
  });
});
