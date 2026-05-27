/**
 * Tests for issue #86: Add a 'Project layout' section to README.md
 *
 * Acceptance criteria:
 * 1. A `## Project layout` section exists in README.md.
 * 2. The section lists all seven directories: infra/, agents/, shared/,
 *    scripts/, spec/, docs/, tests/ — each with a one-line description.
 * 3. Descriptions are accurate and consistent with .agent-forge/areas.yml
 *    and the content of spec/README.md / docs/.
 * 4. The section is formatted as a table or list (either acceptable) and
 *    renders correctly in GitHub Markdown.
 * 5. No files other than README.md are modified in the PR.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { describe, it } from "node:test";

const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

// Extract the "## Project layout" section (everything up to the next ## heading)
function extractSection(content: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(
    new RegExp(`${escapedHeading}([\\s\\S]*?)(?=\\n##\\s|\\s*$)`),
  );
  return match ? match[1]! : null;
}

const SEVEN_DIRS = [
  "infra/",
  "agents/",
  "shared/",
  "scripts/",
  "spec/",
  "docs/",
  "tests/",
] as const;

describe("README Project layout section (issue #86)", () => {
  // AC1: The section heading exists
  it("contains a '## Project layout' heading", () => {
    assert.ok(
      README.includes("## Project layout"),
      "README must contain a '## Project layout' heading",
    );
  });

  // AC1: The section has non-trivial content
  it("'## Project layout' section has content after the heading", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    assert.ok(
      section.trim().length > 0,
      "'## Project layout' section must not be empty",
    );
  });

  // AC2: All seven directories are listed
  for (const dir of SEVEN_DIRS) {
    it(`lists '${dir}' in the Project layout section`, () => {
      const section = extractSection(README, "## Project layout");
      assert.ok(section, "README must contain a '## Project layout' section");
      assert.ok(
        section.includes(dir),
        `Project layout section must list '${dir}'`,
      );
    });
  }

  // AC2: Each directory entry has a non-empty description (at least a few words)
  it("each directory entry has a non-empty description", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");

    for (const dir of SEVEN_DIRS) {
      // Find the line(s) containing this directory reference
      const lines = section.split("\n").filter((l) => l.includes(dir));
      assert.ok(
        lines.length > 0,
        `No line found for '${dir}' in Project layout section`,
      );

      // The line should contain more than just the directory name — i.e. a description
      const line = lines[0]!;
      // Strip the directory name and any markdown table/list syntax, then check remaining text
      const stripped = line
        .replace(/`[^`]+`/g, "") // remove backtick-quoted tokens
        .replace(/[|*\-]/g, "") // remove table/list chars
        .trim();
      assert.ok(
        stripped.length > 5,
        `Directory '${dir}' must have a description beyond just its name (got: "${line.trim()}")`,
      );
    }
  });

  // AC3: infra/ description references Terraform (consistent with docs/architecture.md)
  it("infra/ description references Terraform", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    const infraLines = section.split("\n").filter((l) => l.includes("infra/"));
    assert.ok(infraLines.length > 0, "infra/ must appear in the section");
    assert.ok(
      infraLines.some((l) => /terraform/i.test(l)),
      `infra/ description must mention Terraform (got: "${infraLines[0]?.trim()}")`,
    );
  });

  // AC3: agents/ description references agent roles or containers
  it("agents/ description references agent roles or containers", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    const agentLines = section
      .split("\n")
      .filter((l) => l.includes("agents/"));
    assert.ok(agentLines.length > 0, "agents/ must appear in the section");
    assert.ok(
      agentLines.some((l) => /agent|role|container|BA|Dev|Test|PO/i.test(l)),
      `agents/ description must reference agent roles or containers (got: "${agentLines[0]?.trim()}")`,
    );
  });

  // AC3: shared/ description references shared helpers or utilities
  it("shared/ description references shared helpers or utilities", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    const sharedLines = section
      .split("\n")
      .filter((l) => l.includes("shared/"));
    assert.ok(sharedLines.length > 0, "shared/ must appear in the section");
    assert.ok(
      sharedLines.some((l) =>
        /shared|helper|util|TypeScript|library/i.test(l),
      ),
      `shared/ description must reference shared helpers or utilities (got: "${sharedLines[0]?.trim()}")`,
    );
  });

  // AC3: spec/ description references product specification or mission
  it("spec/ description references product specification", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    const specLines = section.split("\n").filter((l) => l.includes("spec/"));
    assert.ok(specLines.length > 0, "spec/ must appear in the section");
    assert.ok(
      specLines.some((l) => /spec|mission|product|role|goal/i.test(l)),
      `spec/ description must reference product specification (got: "${specLines[0]?.trim()}")`,
    );
  });

  // AC3: docs/ description references engineering reference or architecture
  it("docs/ description references engineering reference or architecture", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    const docsLines = section.split("\n").filter((l) => l.includes("docs/"));
    assert.ok(docsLines.length > 0, "docs/ must appear in the section");
    assert.ok(
      docsLines.some((l) =>
        /engineer|architect|reference|runbook|doc|decision/i.test(l),
      ),
      `docs/ description must reference engineering reference or architecture (got: "${docsLines[0]?.trim()}")`,
    );
  });

  // AC3: tests/ description references tests
  it("tests/ description references tests or test coverage", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");
    const testLines = section.split("\n").filter((l) => l.includes("tests/"));
    assert.ok(testLines.length > 0, "tests/ must appear in the section");
    assert.ok(
      testLines.some((l) => /test|unit|integration|coverage/i.test(l)),
      `tests/ description must reference tests (got: "${testLines[0]?.trim()}")`,
    );
  });

  // AC4: The section uses a Markdown table OR a list (either is acceptable)
  it("section is formatted as a Markdown table or list", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");

    const hasTable = /\|.*\|/.test(section);
    const hasList = /^[\s]*[-*+]\s+/m.test(section);

    assert.ok(
      hasTable || hasList,
      "Project layout section must use a Markdown table (|...|) or list (- / * / +)",
    );
  });

  // AC4: If a table is used, it has a header separator row (valid GFM table)
  it("if a table is used, it has a valid GFM header separator row", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");

    const hasTable = /\|.*\|/.test(section);
    if (!hasTable) {
      // List format — skip this check
      return;
    }

    // A valid GFM table requires a separator row like |---|---|
    assert.match(
      section,
      /\|[\s\-:]+\|/,
      "Markdown table must have a header separator row (e.g. |---|---|)",
    );
  });

  // AC4: All seven directories appear in backtick-quoted form (good Markdown practice)
  it("directory names are backtick-quoted in the section", () => {
    const section = extractSection(README, "## Project layout");
    assert.ok(section, "README must contain a '## Project layout' section");

    for (const dir of SEVEN_DIRS) {
      assert.ok(
        section.includes(`\`${dir}\``),
        `Directory '${dir}' should be backtick-quoted in the Project layout section`,
      );
    }
  });

  // AC5: Only README.md was modified in the PR (checked via git diff)
  it("only README.md was modified in the PR", () => {
    let changedFiles: string;
    try {
      // Get files changed in the most recent commit
      changedFiles = execSync("git diff HEAD~1..HEAD --name-only", {
        encoding: "utf8",
        cwd: new URL("..", import.meta.url).pathname,
      }).trim();
    } catch {
      // If git is unavailable or there's no parent commit, skip this check
      return;
    }

    const files = changedFiles.split("\n").filter((f) => f.trim().length > 0);
    assert.deepEqual(
      files,
      ["README.md"],
      `Only README.md should be modified in the PR, but found: ${files.join(", ")}`,
    );
  });

  // Structural: existing README sections are preserved
  it("preserves all pre-existing top-level README sections", () => {
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

  // Structural: Project layout section appears before "Current Shape"
  it("'## Project layout' section appears before '## Current Shape'", () => {
    const layoutIdx = README.indexOf("## Project layout");
    const currentShapeIdx = README.indexOf("## Current Shape");

    assert.ok(layoutIdx !== -1, "README must contain '## Project layout'");
    assert.ok(currentShapeIdx !== -1, "README must contain '## Current Shape'");
    assert.ok(
      layoutIdx < currentShapeIdx,
      "'## Project layout' must appear before '## Current Shape' in README",
    );
  });
});
