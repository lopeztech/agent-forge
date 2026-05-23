import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { parseAreasYaml } from "../shared/github/areas.ts";

describe("parseAreasYaml", () => {
  it("returns area names sorted alphabetically and paths verbatim", () => {
    const yaml = `
areas:
  frontend:
    paths: [src/web/**]
  api:
    paths:
      - src/server/**
      - src/handlers/**
`;
    const parsed = parseAreasYaml(yaml);
    assert.deepEqual(parsed.areaNames, ["api", "frontend"]);
    assert.deepEqual(parsed.paths["api"], ["src/server/**", "src/handlers/**"]);
    assert.deepEqual(parsed.paths["frontend"], ["src/web/**"]);
  });

  it("accepts an area with no paths block (Dev only needs the name)", () => {
    const parsed = parseAreasYaml("areas:\n  shared: {}\n");
    assert.deepEqual(parsed.areaNames, ["shared"]);
    assert.deepEqual(parsed.paths["shared"], []);
  });

  it("rejects a top-level scalar / list (must be a mapping)", () => {
    assert.throws(() => parseAreasYaml("- a\n- b\n"), /YAML mapping/);
    assert.throws(() => parseAreasYaml("hello"), /YAML mapping/);
  });

  it("rejects a missing or non-mapping `areas:` block", () => {
    assert.throws(() => parseAreasYaml("other: thing\n"), /top-level `areas:` mapping/);
    assert.throws(() => parseAreasYaml("areas:\n  - a\n"), /top-level `areas:` mapping/);
  });

  it("rejects an empty `areas:` block", () => {
    assert.throws(() => parseAreasYaml("areas: {}\n"), /at least one area/);
  });

  it("rejects an area entry that is not a mapping", () => {
    assert.throws(
      () => parseAreasYaml("areas:\n  frontend: src/web/**\n"),
      /area "frontend" must be a mapping/,
    );
  });

  it("rejects non-list paths", () => {
    assert.throws(
      () => parseAreasYaml("areas:\n  frontend:\n    paths: src/web/**\n"),
      /paths must be a list/,
    );
  });

  it("rejects an empty path string", () => {
    assert.throws(
      () => parseAreasYaml("areas:\n  frontend:\n    paths: [\"\"]\n"),
      /must be a non-empty string/,
    );
  });

  it("rejects whitespace in area names", () => {
    assert.throws(
      () => parseAreasYaml("areas:\n  \"front end\":\n    paths: [src/**]\n"),
      /invalid area name/,
    );
  });

  it("parses agent-forge's own areas.yml", () => {
    const yaml = readFileSync(
      new URL("../.agent-forge/areas.yml", import.meta.url),
      "utf8",
    );
    const parsed = parseAreasYaml(yaml);
    // Whatever the concrete set is, every area must declare at least one path.
    assert.ok(parsed.areaNames.length > 0, "expected at least one area");
    for (const name of parsed.areaNames) {
      assert.ok(
        parsed.paths[name]!.length > 0,
        `area "${name}" should declare at least one path`,
      );
    }
  });
});
