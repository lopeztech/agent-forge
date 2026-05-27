// "Test is done" sequence: detect what the agent added, optionally commit
// uncommitted changes, run the test command one more time, push to origin
// (the existing PR branch — no new PR), and transition the label.
//
// Mirrors agents/dev/src/finalize.ts in shape but is significantly lighter:
// no branch detection (we cloned directly on the PR branch), no PR open,
// no PR-body composition.

import { runBashRaw } from "../../../shared/agent/write-tools.ts";
import {
  runCheck,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
} from "../../../shared/agent/checks.ts";

export type SetupTestWorkdirOpts = {
  workdir: string;
  identity: { name: string; email: string };
};

export async function setupTestWorkdir(
  opts: SetupTestWorkdirOpts,
): Promise<void> {
  await runOrThrow(
    `git config user.name ${shellQuote(opts.identity.name)}`,
    opts.workdir,
    "set git user.name",
  );
  await runOrThrow(
    `git config user.email ${shellQuote(opts.identity.email)}`,
    opts.workdir,
    "set git user.email",
  );
}

export type FinalizeTestOpts = {
  workdir: string;
  branchName: string;
  commitMessage: string;
  typecheckCommand?: string;
  testCommand?: string;
  // Per-product cap for the typecheck + test commands. Defaults to 600s.
  testTimeoutSeconds?: number;
};

export type FinalizeTestResult =
  | { kind: "ok"; pushedHead: string }
  | { kind: "no_changes" }
  | { kind: "tests_failed"; output: string }
  | { kind: "checks_timed_out"; output: string; timeoutSeconds: number }
  | { kind: "push_failed"; output: string };

export async function finalizeTest(
  opts: FinalizeTestOpts,
): Promise<FinalizeTestResult> {
  // 1. Did Test actually add anything? Working tree dirty OR HEAD ahead of
  //    origin/<branch>.
  const dirty = await isWorkdirDirty(opts.workdir);
  const ahead = await commitsAhead(opts.workdir, opts.branchName);
  if (!dirty && ahead === 0) {
    return { kind: "no_changes" };
  }

  // 2. Auto-commit any uncommitted tree state so the push is self-contained.
  if (dirty) {
    await runOrThrow("git add -A", opts.workdir, "git add");
    const commit = await runBashRaw(
      `git commit -m ${shellQuote(opts.commitMessage)}`,
      opts.workdir,
      30_000,
    );
    if (commit.exitCode !== 0) {
      throw new Error(
        `git commit failed (exit ${commit.exitCode}): ${commit.stderr || commit.stdout}`,
      );
    }
  }

  // 3. Re-run the project's checks one final time as the gate. Agent should
  //    have run them already; this catches the case where the agent skipped or
  //    where the auto-commit included files outside what they tested. Typecheck
  //    first — a test file can pass `node --test` at runtime but fail
  //    `tsc --noEmit` (the repo's CI gate) — then the test command.
  const timeoutSeconds = opts.testTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS;
  for (const [label, command] of [
    ["Typecheck", opts.typecheckCommand],
    ["Tests", opts.testCommand],
  ] as const) {
    if (!command) continue;
    const outcome = await runCheck({
      label,
      command,
      workdir: opts.workdir,
      timeoutSeconds,
      baseRef: "origin/HEAD",
    });
    if (outcome.kind === "timed_out") {
      return {
        kind: "checks_timed_out",
        output: outcome.output,
        timeoutSeconds: outcome.timeoutSeconds,
      };
    }
    if (outcome.kind === "failed") {
      return { kind: "tests_failed", output: outcome.output };
    }
  }

  // 4. Push to the existing PR branch. Force-with-lease so concurrent
  //    pushes (shouldn't happen but defend) fail loudly.
  const push = await runBashRaw(
    `git push --force-with-lease origin ${shellQuote(opts.branchName)}`,
    opts.workdir,
    60_000,
  );
  if (push.exitCode !== 0) {
    return {
      kind: "push_failed",
      output: (push.stdout + "\n" + push.stderr).trim().slice(0, 4000),
    };
  }

  // 5. Return the new HEAD sha for the success comment.
  const head = await runBashRaw("git rev-parse HEAD", opts.workdir, 10_000);
  return {
    kind: "ok",
    pushedHead: head.stdout.trim(),
  };
}

// ---------------------------------------------------------------------------
// Helpers (duplicated from Dev's finalize — small enough to leave parallel)
// ---------------------------------------------------------------------------

async function isWorkdirDirty(workdir: string): Promise<boolean> {
  const r = await runBashRaw("git status --porcelain", workdir, 10_000);
  if (r.exitCode !== 0) {
    throw new Error(`git status failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout.trim().length > 0;
}

async function commitsAhead(
  workdir: string,
  branchName: string,
): Promise<number> {
  const r = await runBashRaw(
    `git rev-list --count ${shellQuote(`origin/${branchName}`)}..HEAD`,
    workdir,
    10_000,
  );
  if (r.exitCode !== 0) return 0;
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

async function runOrThrow(
  cmd: string,
  cwd: string,
  context: string,
): Promise<void> {
  const r = await runBashRaw(cmd, cwd, 30_000);
  if (r.exitCode !== 0) {
    throw new Error(
      `${context} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
    );
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
