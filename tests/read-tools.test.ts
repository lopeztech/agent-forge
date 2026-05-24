// Tests for Dev's read tools. Build a small fixture directory under os.tmpdir()
// and exercise each tool through the public dispatcher. No mocks — these run
// against real fs.

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  dispatchReadTool,
  buildReadToolDefinitions,
} from "../shared/agent/read-tools.ts";

let WORKDIR: string;

beforeEach(async () => {
  WORKDIR = join(tmpdir(), `dev-tools-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(WORKDIR, { recursive: true });
  await mkdir(join(WORKDIR, "src"), { recursive: true });
  await mkdir(join(WORKDIR, "src", "nested"), { recursive: true });
  await mkdir(join(WORKDIR, "node_modules"), { recursive: true });
  await mkdir(join(WORKDIR, ".git"), { recursive: true });
  await writeFile(join(WORKDIR, "README.md"), "# Fixture\n\nHello.\n");
  await writeFile(
    join(WORKDIR, "src", "index.ts"),
    "export function hello(): string {\n  return 'hi';\n}\n",
  );
  await writeFile(
    join(WORKDIR, "src", "nested", "deep.ts"),
    "const SECRET = 'banana';\nexport { SECRET };\n",
  );
  await writeFile(join(WORKDIR, "node_modules", "ignored.js"), "// should be skipped\n");
  await writeFile(join(WORKDIR, ".git", "HEAD"), "ref: refs/heads/main\n");
});

afterEach(async () => {
  await rm(WORKDIR, { recursive: true, force: true });
});

describe("buildReadToolDefinitions", () => {
  it("returns the three read tools with required schemas", () => {
    const defs = buildReadToolDefinitions();
    assert.deepEqual(
      defs.map((d) => d.name),
      ["read_file", "list_directory", "grep"],
    );
    for (const d of defs) {
      assert.equal(d.input_schema["type"], "object");
      assert.ok(Array.isArray(d.input_schema["required"]));
    }
  });
});

describe("dispatchReadTool: read_file", () => {
  it("reads a small text file", async () => {
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "README.md" });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.match(r!.content, /^# Fixture\n/);
  });

  it("accepts a leading ./", async () => {
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "./src/index.ts" });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.match(r!.content, /export function hello/);
  });

  it("rejects path escapes via ..", async () => {
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "../etc/passwd" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /escapes the workdir/);
  });

  it("errors when the file is missing", async () => {
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "no-such-file.md" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /not found/i);
  });

  it("errors when the path is a directory", async () => {
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "src" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /directory/);
  });

  it("rejects binary files", async () => {
    await writeFile(join(WORKDIR, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 0xff]));
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "bin.dat" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /[Bb]inary/);
  });

  it("rejects empty path", async () => {
    const r = await dispatchReadTool(WORKDIR, "read_file", { path: "" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
  });
});

describe("dispatchReadTool: list_directory", () => {
  it("lists immediate children of the root with file/dir types", async () => {
    const r = await dispatchReadTool(WORKDIR, "list_directory", { path: "." });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.match(r!.content, /file\s+README\.md/);
    assert.match(r!.content, /dir\s+src/);
  });

  it("skips heavy build/cache directories (node_modules, .git)", async () => {
    const r = await dispatchReadTool(WORKDIR, "list_directory", { path: "." });
    assert.ok(r);
    assert.doesNotMatch(r!.content, /node_modules/);
    assert.doesNotMatch(r!.content, /\.git/);
    assert.match(r!.content, /2 skipped/);
  });

  it("treats empty path as root", async () => {
    const r = await dispatchReadTool(WORKDIR, "list_directory", { path: "" });
    assert.ok(r);
    assert.match(r!.content, /README\.md/);
  });

  it("rejects escapes", async () => {
    const r = await dispatchReadTool(WORKDIR, "list_directory", { path: "../" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
  });

  it("errors when the path doesn't exist", async () => {
    const r = await dispatchReadTool(WORKDIR, "list_directory", { path: "no/such/dir" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
  });
});

describe("dispatchReadTool: grep", () => {
  it("finds matches across nested files with path:line: prefix", async () => {
    const r = await dispatchReadTool(WORKDIR, "grep", { pattern: "SECRET", path: "." });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.match(r!.content, /src\/nested\/deep\.ts:1: const SECRET/);
  });

  it("supports regex metacharacters", async () => {
    const r = await dispatchReadTool(WORKDIR, "grep", {
      pattern: "function\\s+hello",
      path: "src",
    });
    assert.ok(r);
    assert.match(r!.content, /index\.ts:1: export function hello/);
  });

  it("returns a clean 'no matches' when nothing hits", async () => {
    const r = await dispatchReadTool(WORKDIR, "grep", { pattern: "xyz123nope", path: "." });
    assert.ok(r);
    assert.equal(r!.is_error, undefined);
    assert.match(r!.content, /No matches/);
  });

  it("rejects an invalid regex", async () => {
    const r = await dispatchReadTool(WORKDIR, "grep", { pattern: "[unclosed", path: "." });
    assert.ok(r);
    assert.equal(r!.is_error, true);
    assert.match(r!.content, /Invalid regex/);
  });

  it("skips heavy directories during traversal", async () => {
    // Add a match inside node_modules; it should not appear.
    await writeFile(join(WORKDIR, "node_modules", "found.js"), "FINDME\n");
    const r = await dispatchReadTool(WORKDIR, "grep", { pattern: "FINDME", path: "." });
    assert.ok(r);
    assert.match(r!.content, /No matches/);
  });

  it("rejects escapes via path", async () => {
    const r = await dispatchReadTool(WORKDIR, "grep", { pattern: "x", path: "../" });
    assert.ok(r);
    assert.equal(r!.is_error, true);
  });
});

describe("dispatchReadTool: unknown tool", () => {
  it("returns null so the caller can decide what to do", async () => {
    const r = await dispatchReadTool(WORKDIR, "bogus_tool", {});
    assert.equal(r, null);
  });
});
