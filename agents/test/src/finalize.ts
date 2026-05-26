// "Test is done" sequence: detect what the agent added, optionally commit
// uncommitted changes, run the test command one more time, push to origin
// (the existing PR branch — no new PR), and transition the label.
//
// Mirrors agents/dev/src/finalize.ts in shape but is significantly lighter:
// no branch detection (we cloned directly on the PR branch), no PR open,
// no PR-body composition.

import { runBashRaw } from "../../../shared/agent/write-tools.ts";

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
  testCommand?: string;
};

export type FinalizeTestResult =
  | { kind: "ok"; pushedHead: string }
  | { kind: "no_changes" }
  | { kind: "tests_failed"; output: string }
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

  // 3. Re-run tests one final time as the gate. Agent should have run them
  //    already; this catches the case where the agent skipped or where the
  //    auto-commit included files outside what they tested.
  if (opts.testCommand) {
    const r = await runBashRaw(opts.testCommand, opts.workdir, 10 * 60_000);
    if (r.exitCode !== 0) {
      const out = (r.stdout + "\n" + r.stderr).trim();
      return { kind: "tests_failed", output: out.slice(0, 4000) };
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
