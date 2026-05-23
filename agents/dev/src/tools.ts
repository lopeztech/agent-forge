// Read tools for the Dev agent loop. All paths are resolved against the
// cloned workdir; anything that escapes (../../etc/passwd etc.) is rejected.
// Implementations stay in pure TS so the runtime container doesn't need to
// shell out for read-only work — that boundary stays at B.3 where the
// `bash` tool lands.

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, relative, sep } from "node:path";

import type { ToolDefinition } from "../../../shared/models.ts";

const MAX_FILE_BYTES = 100 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_LINE_BYTES = 500;
// Skip common heavy directories the agent never needs to traverse.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".terraform",
  "dist",
  ".build",
  "build",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".cache",
  ".venv",
  "venv",
]);

// Public: build the array of tool defs + a single dispatcher fn the agent
// loop's `executeTool` callback wraps.
export type DevReadTool = "read_file" | "list_directory" | "grep";

export type DispatchToolResult = {
  content: string;
  is_error?: boolean;
};

export function buildReadToolDefinitions(): ToolDefinition[] {
  return [READ_FILE_TOOL, LIST_DIRECTORY_TOOL, GREP_TOOL];
}

export async function dispatchReadTool(
  workdir: string,
  name: string,
  input: unknown,
): Promise<DispatchToolResult | null> {
  switch (name) {
    case "read_file":
      return readFileTool(workdir, input);
    case "list_directory":
      return listDirectoryTool(workdir, input);
    case "grep":
      return grepTool(workdir, input);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

// Resolves a tool-supplied path against the workdir and ensures the result
// stays inside it. Throws if the path escapes via `..` or symlink.
function safeJoin(workdir: string, rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  // Normalize: leading "./" or "/" both become workdir-relative.
  const cleaned = rawPath.replace(/^\.?\/+/, "");
  const absolute = resolve(workdir, cleaned);
  const rel = relative(workdir, absolute);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(absolute) !== absolute) {
    throw new Error(`path "${rawPath}" escapes the workdir`);
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

const READ_FILE_TOOL: ToolDefinition = {
  name: "read_file",
  description:
    "Read a single file from the cloned target repo. Path is repo-root-relative " +
    `(e.g. "src/index.ts"). Output is capped at ${MAX_FILE_BYTES} bytes; ` +
    "larger files are truncated with a marker. Binary files (NUL byte in the " +
    "first 8 KB) return an error. Use this after list_directory or grep when " +
    "you need full context for a specific file.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Repo-root-relative path to the file.",
      },
    },
  },
};

async function readFileTool(
  workdir: string,
  input: unknown,
): Promise<DispatchToolResult> {
  const { path } = input as { path?: unknown };
  let abs: string;
  try {
    abs = safeJoin(workdir, path);
  } catch (err) {
    return { content: String((err as Error).message), is_error: true };
  }

  let st;
  try {
    st = await stat(abs);
  } catch {
    return { content: `File not found: ${path}`, is_error: true };
  }
  if (st.isDirectory()) {
    return { content: `Path is a directory; use list_directory: ${path}`, is_error: true };
  }
  if (!st.isFile()) {
    return { content: `Not a regular file: ${path}`, is_error: true };
  }

  const buf = await readFile(abs);
  if (looksBinary(buf)) {
    return { content: `Binary file (skipped): ${path}`, is_error: true };
  }

  const truncated = buf.byteLength > MAX_FILE_BYTES;
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf;
  const text = slice.toString("utf8");
  const marker = truncated
    ? `\n[... truncated; file is ${buf.byteLength} bytes, first ${MAX_FILE_BYTES} shown ...]`
    : "";
  return { content: `${text}${marker}` };
}

function looksBinary(buf: Buffer): boolean {
  const probe = buf.subarray(0, Math.min(buf.byteLength, 8 * 1024));
  for (let i = 0; i < probe.length; i++) {
    if (probe[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// list_directory
// ---------------------------------------------------------------------------

const LIST_DIRECTORY_TOOL: ToolDefinition = {
  name: "list_directory",
  description:
    "List the immediate children of a directory in the cloned target repo. " +
    "Path is repo-root-relative (use \".\" or empty string for the root). " +
    `Returns up to ${MAX_LIST_ENTRIES} entries with type (file/dir). Heavy ` +
    "build/cache directories (node_modules, .git, dist, .terraform, etc.) " +
    "are skipped when listing the root or any nested directory.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description:
          'Repo-root-relative directory path. Use "." or "" for the repo root.',
      },
    },
  },
};

async function listDirectoryTool(
  workdir: string,
  input: unknown,
): Promise<DispatchToolResult> {
  const raw = (input as { path?: unknown }).path;
  const target = typeof raw === "string" && raw.length > 0 && raw !== "." ? raw : ".";
  let abs: string;
  try {
    abs = safeJoin(workdir, target);
  } catch (err) {
    return { content: String((err as Error).message), is_error: true };
  }

  let st;
  try {
    st = await stat(abs);
  } catch {
    return { content: `Directory not found: ${target}`, is_error: true };
  }
  if (!st.isDirectory()) {
    return { content: `Path is not a directory: ${target}`, is_error: true };
  }

  const entries = await readdir(abs, { withFileTypes: true });
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  const lines: string[] = [];
  let shown = 0;
  let skipped = 0;
  for (const e of sorted) {
    if (SKIP_DIRS.has(e.name)) {
      skipped++;
      continue;
    }
    if (shown >= MAX_LIST_ENTRIES) break;
    const kind = e.isDirectory() ? "dir " : e.isFile() ? "file" : "    ";
    lines.push(`${kind}  ${e.name}`);
    shown++;
  }

  const header = `Listing ${target}/ (${shown} shown${skipped ? `, ${skipped} skipped` : ""}${
    shown < sorted.length - skipped ? `, ${sorted.length - skipped - shown} more not shown` : ""
  })`;
  return { content: `${header}\n${lines.join("\n")}` };
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

const GREP_TOOL: ToolDefinition = {
  name: "grep",
  description:
    "Search file contents in the cloned target repo for a regex pattern. " +
    "Path is repo-root-relative; use \".\" for the whole repo. Matches are " +
    `JavaScript regex (no flags supported; case-sensitive). Up to ${MAX_GREP_MATCHES} ` +
    "matches are returned as `path:lineno: content`. Heavy build/cache dirs " +
    "are skipped. Use this to locate symbols, strings, or callers before " +
    "calling read_file.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["pattern", "path"],
    properties: {
      pattern: {
        type: "string",
        description:
          "JavaScript regular expression source (NOT including the /.../). " +
          'Example: "function\\s+foo\\b". Case-sensitive.',
      },
      path: {
        type: "string",
        description:
          'Repo-root-relative directory or file to search. Use "." for the whole repo.',
      },
    },
  },
};

async function grepTool(
  workdir: string,
  input: unknown,
): Promise<DispatchToolResult> {
  const { pattern, path } = input as { pattern?: unknown; path?: unknown };
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { content: "pattern must be a non-empty string", is_error: true };
  }
  const target = typeof path === "string" && path.length > 0 && path !== "." ? path : ".";

  let abs: string;
  try {
    abs = safeJoin(workdir, target);
  } catch (err) {
    return { content: String((err as Error).message), is_error: true };
  }

  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    return { content: `Invalid regex: ${(err as Error).message}`, is_error: true };
  }

  const matches: string[] = [];
  let scanned = 0;
  let truncated = false;

  const visit = async (current: string): Promise<void> => {
    if (matches.length >= MAX_GREP_MATCHES) {
      truncated = true;
      return;
    }
    let st;
    try {
      st = await stat(current);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      const entries = await readdir(current, { withFileTypes: true });
      for (const e of entries) {
        if (matches.length >= MAX_GREP_MATCHES) {
          truncated = true;
          return;
        }
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        await visit(resolve(current, e.name));
      }
      return;
    }
    if (!st.isFile()) return;

    scanned++;
    let buf;
    try {
      buf = await readFile(current);
    } catch {
      return;
    }
    if (looksBinary(buf)) return;
    const rel = relative(workdir, current);
    const text = buf.toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= MAX_GREP_MATCHES) {
        truncated = true;
        return;
      }
      if (re.test(lines[i]!)) {
        const line = lines[i]!;
        const display =
          line.length > MAX_GREP_LINE_BYTES
            ? `${line.slice(0, MAX_GREP_LINE_BYTES)}… [line truncated]`
            : line;
        matches.push(`${rel}:${i + 1}: ${display}`);
      }
    }
  };

  await visit(abs);

  if (matches.length === 0) {
    return { content: `No matches in ${target} for /${pattern}/` };
  }
  const trailer = truncated
    ? `\n[... truncated at ${MAX_GREP_MATCHES} matches; refine the pattern or path ...]`
    : "";
  return {
    content: `${matches.length} match${matches.length === 1 ? "" : "es"} in ${scanned} files:\n${matches.join("\n")}${trailer}`,
  };
}
