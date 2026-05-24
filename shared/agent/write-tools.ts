// Write tools shared by every agent role that mutates a cloned workdir.
// Path safety mirrors the read tools: everything resolves against the
// workdir; escapes are rejected. bash runs through /bin/bash -c with cwd
// inside the workdir. Q2 resolution is "unrestricted inside /tmp/<run>" —
// the Fargate task is ephemeral and IAM-scoped, so the blast radius is one
// stuck task.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, relative, sep } from "node:path";

import type { ToolDefinition } from "../models.ts";

const MAX_WRITE_FILE_BYTES = 1024 * 1024; // 1 MB
const BASH_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const BASH_OUTPUT_CAP_BYTES = 16 * 1024;

export type DispatchToolResult = {
  content: string;
  is_error?: boolean;
};

export type DevWriteTool = "write_file" | "bash";

export function buildWriteToolDefinitions(): ToolDefinition[] {
  return [WRITE_FILE_TOOL, BASH_TOOL];
}

export async function dispatchWriteTool(
  workdir: string,
  name: string,
  input: unknown,
): Promise<DispatchToolResult | null> {
  switch (name) {
    case "write_file":
      return writeFileTool(workdir, input);
    case "bash":
      return bashTool(workdir, input);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Path safety (duplicated from tools.ts; intentional — both modules need it
// and exporting from tools.ts would couple read/write more tightly than
// necessary)
// ---------------------------------------------------------------------------

function safeJoin(workdir: string, rawPath: unknown): string {
  if (typeof rawPath !== "string" || rawPath.length === 0) {
    throw new Error("path must be a non-empty string");
  }
  const cleaned = rawPath.replace(/^\.?\/+/, "");
  const absolute = resolve(workdir, cleaned);
  const rel = relative(workdir, absolute);
  if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || resolve(absolute) !== absolute) {
    throw new Error(`path "${rawPath}" escapes the workdir`);
  }
  return absolute;
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

const WRITE_FILE_TOOL: ToolDefinition = {
  name: "write_file",
  description:
    "Overwrite (or create) a file in the cloned target repo with the given " +
    "content. Path is repo-root-relative. Parent directories are created if " +
    `needed. Content is capped at ${MAX_WRITE_FILE_BYTES} bytes. Use this for ` +
    "the substantive changes that fulfill the issue's acceptance criteria. " +
    "For small inline edits, you can also run `sed`/`awk` via the bash tool.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description: "Repo-root-relative path to the file. Parent dirs auto-created.",
      },
      content: {
        type: "string",
        description: "Full new contents of the file. Existing content is overwritten.",
      },
    },
  },
};

async function writeFileTool(
  workdir: string,
  input: unknown,
): Promise<DispatchToolResult> {
  const { path, content } = input as { path?: unknown; content?: unknown };
  if (typeof content !== "string") {
    return { content: "content must be a string", is_error: true };
  }
  if (Buffer.byteLength(content, "utf8") > MAX_WRITE_FILE_BYTES) {
    return {
      content: `content exceeds the ${MAX_WRITE_FILE_BYTES}-byte cap`,
      is_error: true,
    };
  }
  let abs: string;
  try {
    abs = safeJoin(workdir, path);
  } catch (err) {
    return { content: String((err as Error).message), is_error: true };
  }

  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return { content: `Wrote ${Buffer.byteLength(content, "utf8")} bytes to ${path}` };
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const BASH_TOOL: ToolDefinition = {
  name: "bash",
  description:
    "Run an arbitrary shell command inside the cloned target repo. " +
    "cwd defaults to the workdir root; you can pass a relative `cwd` to nest " +
    "into a subdirectory. The command runs through /bin/bash -c so pipes, " +
    "redirects, and globs work. " +
    `stdout+stderr are returned (combined cap ${BASH_OUTPUT_CAP_BYTES} bytes), ` +
    `along with the exit code. Default timeout is ${BASH_DEFAULT_TIMEOUT_MS / 1000}s; ` +
    "override via `timeout_seconds`. Useful for: running tests, git status, " +
    "small file edits via sed/awk, multi-file operations.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["cmd"],
    properties: {
      cmd: {
        type: "string",
        description: "Shell command (passed to /bin/bash -c).",
      },
      cwd: {
        type: "string",
        description:
          "Working directory, repo-root-relative. Defaults to repo root.",
      },
      timeout_seconds: {
        type: "number",
        description: `Max wall-clock seconds. Defaults to ${BASH_DEFAULT_TIMEOUT_MS / 1000}.`,
      },
    },
  },
};

async function bashTool(
  workdir: string,
  input: unknown,
): Promise<DispatchToolResult> {
  const { cmd, cwd, timeout_seconds } = input as {
    cmd?: unknown;
    cwd?: unknown;
    timeout_seconds?: unknown;
  };
  if (typeof cmd !== "string" || cmd.length === 0) {
    return { content: "cmd must be a non-empty string", is_error: true };
  }

  let runCwd = workdir;
  if (cwd !== undefined && cwd !== null && cwd !== "" && cwd !== ".") {
    try {
      runCwd = safeJoin(workdir, cwd);
    } catch (err) {
      return { content: String((err as Error).message), is_error: true };
    }
  }

  const timeoutMs =
    typeof timeout_seconds === "number" && timeout_seconds > 0
      ? Math.min(timeout_seconds * 1000, 15 * 60 * 1000)
      : BASH_DEFAULT_TIMEOUT_MS;

  return runBash(cmd, runCwd, timeoutMs);
}

export type BashRunResult = {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export async function runBashRaw(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<BashRunResult> {
  return new Promise((resolveRun) => {
    const child = execFile(
      "/bin/bash",
      ["-c", cmd],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        env: process.env,
      },
      (err, stdout, stderr) => {
        // execFile's callback err is typed as ErrnoException but actually
        // carries `code` (numeric exit code on normal non-zero exit) or
        // `signal` + `killed` (on timeout / SIGTERM). When err is null, the
        // child exited 0.
        const e = err as
          | (Error & { code?: number; signal?: string; killed?: boolean })
          | null;
        const timedOut = e?.killed === true && e?.signal !== undefined;
        const exitCode = e === null
          ? 0
          : typeof e.code === "number"
            ? e.code
            : (child.exitCode ?? null);
        resolveRun({
          exitCode,
          signal: child.signalCode ?? e?.signal ?? null,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut,
        });
      },
    );
  });
}

async function runBash(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<DispatchToolResult> {
  const r = await runBashRaw(cmd, cwd, timeoutMs);
  const exitLine =
    r.exitCode === 0
      ? "(exit 0)"
      : r.timedOut
        ? `(timed out after ${timeoutMs}ms)`
        : `(exit ${r.exitCode ?? "n/a"}${r.signal ? `, signal=${r.signal}` : ""})`;
  const combined = (r.stdout + (r.stderr ? `\n${r.stderr}` : "")).trim();
  const capped =
    combined.length > BASH_OUTPUT_CAP_BYTES
      ? `${combined.slice(0, BASH_OUTPUT_CAP_BYTES)}\n[... output truncated at ${BASH_OUTPUT_CAP_BYTES} bytes ...]`
      : combined;
  const body = capped.length === 0 ? `${exitLine}\n(no output)` : `${exitLine}\n${capped}`;
  const isError = r.exitCode !== 0 || r.timedOut;
  return isError ? { content: body, is_error: true } : { content: body };
}
