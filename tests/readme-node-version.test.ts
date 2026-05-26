/**
 * Tests for issue #44: README "Local Setup" Node version bump to 22.6.0+
 *
 * Acceptance criteria:
 * 1. The 'Local Setup' section (Prerequisites) in README.md references
 *    Node.js 22.6.0 (or >=22.6.0) as the minimum version, not just '22 or newer'.
 * 2. No other content in README.md is modified (exactly one line changed vs
 *    the previous version that said "22 or newer").
 * 3. The stated minimum is consistent with the engines.node field in
 *    package.json (>=22.6.0).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const PKG = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { engines?: { node?: string } };

describe("README Node version (issue #44)", () => {
  // AC1: The Prerequisites / Local Setup section references 22.6.0
  it("mentions Node.js 22.6.0 in the Prerequisites section", () => {
    // Locate the Prerequisites section
    const prereqMatch = README.match(
      /##\s+Prerequisites([\s\S]*?)(?=\n##\s|\s*$)/,
    );
    assert.ok(prereqMatch, "README must contain a ## Prerequisites section");

    const prereqSection = prereqMatch[1]!;
    assert.match(
      prereqSection,
      /22\.6\.0/,
      "Prerequisites section must reference Node.js 22.6.0",
    );
  });

  // AC1 (negative): the old vague "22 or newer" wording must be gone
  it("does not contain the old 'Node.js 22 or newer' wording", () => {
    // The old line was "- Node.js 22 or newer" (without the patch version)
    assert.doesNotMatch(
      README,
      /Node\.js\s+22\s+or\s+newer/,
      "README must not contain the old 'Node.js 22 or newer' wording",
    );
  });

  // AC3: README version is consistent with package.json engines.node
  it("is consistent with package.json engines.node (>=22.6.0)", () => {
    const enginesNode = PKG.engines?.node;
    assert.ok(
      enginesNode,
      "package.json must have an engines.node field",
    );

    // Extract the version number from engines.node (e.g. ">=22.6.0" -> "22.6.0")
    const versionMatch = enginesNode.match(/(\d+\.\d+\.\d+)/);
    assert.ok(
      versionMatch,
      `engines.node "${enginesNode}" must contain a semver version`,
    );
    const pkgVersion = versionMatch[1]!; // e.g. "22.6.0"

    assert.match(
      README,
      new RegExp(pkgVersion.replace(/\./g, "\\.")),
      `README must mention the same version (${pkgVersion}) as package.json engines.node`,
    );
  });

  // AC2: Only the Node version line changed — no other content was altered.
  // We verify this structurally: the README must still contain all the
  // expected top-level sections and key content unchanged.
  it("preserves all other README sections and content", () => {
    const expectedSections = [
      "## Current Shape",
      "## Architecture",
      "## Prerequisites",
      "## Local Setup",
      "## Common Tasks",
      "## CI",
    ];

    for (const section of expectedSections) {
      assert.ok(
        README.includes(section),
        `README must still contain section "${section}"`,
      );
    }
  });

  it("still contains the npm, Terraform, and GitHub CLI prerequisites", () => {
    const prereqMatch = README.match(
      /##\s+Prerequisites([\s\S]*?)(?=\n##\s|\s*$)/,
    );
    assert.ok(prereqMatch, "README must contain a ## Prerequisites section");
    const prereqSection = prereqMatch[1]!;

    assert.match(prereqSection, /npm/, "Prerequisites must still mention npm");
    assert.match(
      prereqSection,
      /Terraform/,
      "Prerequisites must still mention Terraform",
    );
    assert.match(
      prereqSection,
      /GitHub CLI/,
      "Prerequisites must still mention GitHub CLI",
    );
  });

  // AC2 (structural): the Node version line uses the expected format
  it("uses the expected bullet-point format for the Node version line", () => {
    assert.match(
      README,
      /^- Node\.js 22\.6\.0 or newer$/m,
      "README must have a line '- Node.js 22.6.0 or newer'",
    );
  });
});
