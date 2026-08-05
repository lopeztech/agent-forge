/**
 * Tests for issue #41: "Add 'Type-checking locally' note to README.md"
 *
 * Acceptance criteria:
 *  1. A `### Type-checking` (or equivalent) subsection exists in README.md.
 *  2. The subsection references the exact npm script name from package.json
 *     using backtick formatting (inline or fenced code block).
 *  3. The subsection includes at least one sentence explaining when a developer
 *     should run the command.
 *  4. The new subsection is placed near other developer-facing notes (e.g.
 *     adjacent to build/test/lint instructions).
 *  5. The subsection is concise — no padding or filler prose. The type-checking
 *     specific content (prose + code block) must be ≤ 2 content blocks.
 *  6. README.md renders without Markdown formatting errors (headings, backticks
 *     balanced).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const readmeText = readFileSync(
  new URL("../README.md", import.meta.url),
  "utf8",
);

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };

const readmeLines = readmeText.split("\n");

/**
 * Return the 0-based index of the first line that matches `predicate`,
 * or -1 if not found.
 */
function findLineIndex(predicate: (line: string) => boolean): number {
  return readmeLines.findIndex(predicate);
}

/**
 * Return the lines that belong to the section starting at `startIdx` up to
 * (but not including) the next heading of the same or higher level, or EOF.
 */
function sectionLines(startIdx: number): string[] {
  const headingMatch = readmeLines[startIdx].match(/^(#{1,6})\s/);
  if (!headingMatch) return [];
  const level = headingMatch[1].length;
  const result: string[] = [readmeLines[startIdx]];
  for (let i = startIdx + 1; i < readmeLines.length; i++) {
    const m = readmeLines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) break;
    result.push(readmeLines[i]);
  }
  return result;
}

/**
 * Count distinct "content blocks" in a list of lines:
 *   - A fenced code block (``` ... ```) counts as ONE block regardless of
 *     how many lines it spans.
 *   - A run of consecutive non-empty, non-fence prose lines counts as ONE block.
 * Blank lines between blocks are ignored.
 */
function countContentBlocks(lines: string[]): number {
  let blocks = 0;
  let inFence = false;
  let inProse = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      if (!inFence) {
        blocks++;
        inFence = true;
        inProse = false;
      } else {
        inFence = false;
      }
      continue;
    }

    if (inFence) continue;

    if (trimmed.length === 0) {
      inProse = false;
      continue;
    }

    if (!inProse) {
      blocks++;
      inProse = true;
    }
  }

  return blocks;
}

/**
 * Extract the lines of the type-checking specific content from the section:
 * everything from the heading up to (but not including) the first line that
 * starts a new unrelated prose block after the typecheck code block closes.
 *
 * Concretely: heading + prose sentence(s) + the fenced code block containing
 * the typecheck command.
 */
function typecheckSpecificLines(
  section: string[],
  typecheckCommand: string,
): string[] {
  // Find the code block that contains the typecheck command
  let inFence = false;
  let fenceEnd = -1;
  for (let i = 1; i < section.length; i++) {
    const trimmed = section[i].trim();
    if (trimmed.startsWith("```")) {
      if (!inFence) {
        inFence = true;
      } else {
        inFence = false;
        // Check if this fence contained the typecheck command
        const fenceContent = section.slice(0, i + 1).join("\n");
        if (fenceContent.includes(typecheckCommand)) {
          fenceEnd = i;
          break;
        }
      }
    }
  }

  if (fenceEnd === -1) return section; // fallback: return whole section

  return section.slice(0, fenceEnd + 1);
}

// ---------------------------------------------------------------------------
// Locate the type-checking subsection
// ---------------------------------------------------------------------------

const typecheckHeadingIdx = findLineIndex((line) =>
  /^#{2,4}\s+type.?check/i.test(line),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("README.md — Type-checking subsection (issue #41)", () => {
  // AC 1 ─────────────────────────────────────────────────────────────────────
  it("AC1: a Type-checking subsection heading exists", () => {
    assert.ok(
      typecheckHeadingIdx !== -1,
      "Expected a heading matching /type.?check/i (e.g. '### Type-checking') in README.md",
    );
  });

  // AC 2 ─────────────────────────────────────────────────────────────────────
  it("AC2: subsection references the exact npm script name from package.json", () => {
    const scripts = packageJson.scripts ?? {};
    const typecheckScript = Object.keys(scripts).find((k) =>
      /typecheck/i.test(k),
    );
    assert.ok(
      typecheckScript,
      "package.json must define a script whose name contains 'typecheck'",
    );

    const section = sectionLines(typecheckHeadingIdx).join("\n");

    // The script name must appear either as an inline backtick span
    // (e.g. `npm run typecheck`) OR inside a fenced code block command.
    const inlineBacktick = `\`npm run ${typecheckScript}\``;
    const bareCommand = `npm run ${typecheckScript}`;

    const referenced =
      section.includes(inlineBacktick) || section.includes(bareCommand);

    assert.ok(
      referenced,
      `Expected the subsection to reference "${bareCommand}" (inline backtick or code block) but got:\n${section}`,
    );
  });

  // AC 3 ─────────────────────────────────────────────────────────────────────
  it("AC3: subsection contains at least one explanatory sentence (when to run)", () => {
    const section = sectionLines(typecheckHeadingIdx);
    // A sentence is any non-empty, non-heading, non-code-fence line that
    // contains multiple words (i.e. prose, not a bare command).
    const proseLine = section.slice(1).find((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("#") &&
        !trimmed.startsWith("```") &&
        trimmed.includes(" ")
      );
    });
    assert.ok(
      proseLine !== undefined,
      "Expected at least one prose sentence in the Type-checking subsection explaining when to run the command",
    );
  });

  // AC 4 ─────────────────────────────────────────────────────────────────────
  it("AC4: subsection is placed near other developer-facing notes (under Local Setup or similar)", () => {
    // Walk backwards from the typecheck heading to find the nearest parent
    // section (## level heading).
    let parentHeadingLine = "";
    for (let i = typecheckHeadingIdx - 1; i >= 0; i--) {
      if (/^##\s/.test(readmeLines[i])) {
        parentHeadingLine = readmeLines[i];
        break;
      }
    }
    // The parent section should be developer-facing.
    const devSectionPattern =
      /local\s*setup|setup|development|getting\s*started|contributing|ci|build|test/i;
    assert.ok(
      devSectionPattern.test(parentHeadingLine),
      `Expected the Type-checking subsection to live under a developer-facing ## section, ` +
        `but its nearest parent heading is: "${parentHeadingLine}"`,
    );
  });

  // AC 5 ─────────────────────────────────────────────────────────────────────
  it("AC5: type-checking specific content is concise (1 prose block + 1 code block)", () => {
    const scripts = packageJson.scripts ?? {};
    const typecheckScript =
      Object.keys(scripts).find((k) => /typecheck/i.test(k)) ?? "typecheck";
    const typecheckCommand = `npm run ${typecheckScript}`;

    const section = sectionLines(typecheckHeadingIdx);
    // Extract only the content up to and including the typecheck code block.
    const tcLines = typecheckSpecificLines(section, typecheckCommand);
    const bodyLines = tcLines.slice(1); // exclude heading
    const blocks = countContentBlocks(bodyLines);

    assert.ok(
      blocks <= 2,
      `Expected at most 2 content blocks (one prose paragraph + one code block) ` +
        `for the type-checking specific content, but found ${blocks} blocks.\n` +
        `Content:\n${bodyLines.join("\n")}`,
    );
  });

  // AC 6 ─────────────────────────────────────────────────────────────────────
  it("AC6: README.md has no unbalanced backticks or malformed headings", () => {
    // Check that every heading line starts with 1–6 # followed by a space.
    const badHeadings = readmeLines.filter(
      (line) => /^#+/.test(line) && !/^#{1,6}\s/.test(line),
    );
    assert.deepEqual(
      badHeadings,
      [],
      `Found malformed heading lines:\n${badHeadings.join("\n")}`,
    );

    // Check that inline backtick runs are balanced (even count of lone backticks
    // outside fenced code blocks).
    let inFence = false;
    const unbalancedLines: string[] = [];
    for (const line of readmeLines) {
      if (/^```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      // Count single backticks (not part of ```) on this line.
      const singleBackticks = (line.match(/(?<!`)`(?!`)/g) ?? []).length;
      if (singleBackticks % 2 !== 0) {
        unbalancedLines.push(line);
      }
    }
    assert.deepEqual(
      unbalancedLines,
      [],
      `Found lines with unbalanced inline backticks:\n${unbalancedLines.join("\n")}`,
    );

    // Fenced code blocks must be closed.
    assert.equal(
      inFence,
      false,
      "README.md has an unclosed fenced code block (``` not closed)",
    );
  });
});
