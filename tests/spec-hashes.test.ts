import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  diffSpecHashes,
  hasDrift,
  hashSpecFileContent,
  hashSpecTree,
} from "../shared/github/spec-hashes.ts";

describe("hashSpecFileContent", () => {
  it("returns a 64-char hex string", () => {
    const h = hashSpecFileContent("hello world");
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
  });

  it("is content-stable", () => {
    assert.equal(
      hashSpecFileContent("hello"),
      hashSpecFileContent("hello"),
    );
  });

  it("differs on whitespace changes", () => {
    assert.notEqual(
      hashSpecFileContent("hello"),
      hashSpecFileContent("hello "),
    );
  });
});

describe("hashSpecTree", () => {
  it("returns empty map when spec is missing", () => {
    const r = hashSpecTree({
      files: [],
      total_bytes: 0,
      truncated_by: null,
      missing: true,
    });
    assert.deepEqual(r, {});
  });

  it("hashes each spec file by path", () => {
    const r = hashSpecTree({
      files: [
        { path: "spec/a.md", bytes: 5, content: "alpha" },
        { path: "spec/b.md", bytes: 4, content: "beta" },
      ],
      total_bytes: 9,
      truncated_by: null,
      missing: false,
    });
    assert.deepEqual(Object.keys(r).sort(), ["spec/a.md", "spec/b.md"]);
    assert.equal(r["spec/a.md"], hashSpecFileContent("alpha"));
    assert.equal(r["spec/b.md"], hashSpecFileContent("beta"));
  });
});

describe("diffSpecHashes", () => {
  it("flags identical maps as no-drift", () => {
    const map = { "a.md": "hash1", "b.md": "hash2" };
    const d = diffSpecHashes(map, map);
    assert.deepEqual(d, { added: [], removed: [], changed: [] });
    assert.equal(hasDrift(d), false);
  });

  it("flags content changes", () => {
    const baseline = { "a.md": "hash1", "b.md": "hash2" };
    const current = { "a.md": "hash1-CHANGED", "b.md": "hash2" };
    const d = diffSpecHashes(baseline, current);
    assert.deepEqual(d.changed, ["a.md"]);
    assert.deepEqual(d.added, []);
    assert.deepEqual(d.removed, []);
    assert.equal(hasDrift(d), true);
  });

  it("flags added paths", () => {
    const d = diffSpecHashes(
      { "a.md": "h" },
      { "a.md": "h", "b.md": "h" },
    );
    assert.deepEqual(d.added, ["b.md"]);
  });

  it("flags removed paths", () => {
    const d = diffSpecHashes(
      { "a.md": "h", "b.md": "h" },
      { "a.md": "h" },
    );
    assert.deepEqual(d.removed, ["b.md"]);
  });

  it("returns paths alphabetically sorted in each category", () => {
    const d = diffSpecHashes(
      { "z.md": "h", "a.md": "h", "m.md": "h" },
      { "z.md": "h-changed", "a.md": "h-changed", "m.md": "h" },
    );
    assert.deepEqual(d.changed, ["a.md", "z.md"]);
  });
});
