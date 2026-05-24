// Wraps the "Dev is done; ship it" sequence: detect working-tree state,
// commit anything outstanding, push the feature branch, open a PR.
//
// Kept separate from index.ts so it can be unit-tested in isolation and so
// the failure paths (no changes / push failed / PR creation failed) are
// auditable in one place.

import { runBashRaw, type BashRunResult } from "./write-tools.ts";

const API = "https://api.github.com";

export type GitIdentity = {
  name: string;
  email: string;
};

export type SetupWorkdirOpts = {
  workdir: string;
  identity: GitIdentity;
  branchName: string;
};

export type SetupWorkdirResult = {
  defaultBranch: string;
};

// Called right after clone — captures the default branch (the one the agent's
// changes will be PR'd against), pins git identity, and checks out a fresh
// feature branch the agent works on.
export async function setupWorkdir(
  opts: SetupWorkdirOpts,
): Promise<SetupWorkdirResult> {
  const { workdir, identity, branchName } = opts;

  // The default branch is the one git clone checked out (HEAD's current ref).
  const refRun = await runBashRaw(
    "git rev-parse --abbrev-ref HEAD",
    workdir,
    10_000,
  );
  if (refRun.exitCode !== 0) {
    throw new Error(
      `Could not determine default branch: ${refRun.stderr || refRun.stdout}`,
    );
  }
  const defaultBranch = refRun.stdout.trim();

  await runOrThrow(
    `git config user.name ${shellQuote(identity.name)}`,
    workdir,
    "set git user.name",
  );
  await runOrThrow(
    `git config user.email ${shellQuote(identity.email)}`,
    workdir,
    "set git user.email",
  );
  await runOrThrow(
    `git checkout -B ${shellQuote(branchName)}`,
    workdir,
    "create feature branch",
  );

  return { defaultBranch };
}

export type FinalizeOpts = {
  workdir: string;
  branchName: string;
  defaultBranch: string;
  commitMessage: string;
  testCommand?: string;
  token: string; // GitHub installation token
  repo: string; // owner/name
  userAgent: string;
  prTitle: string;
  prBody: string;
};

export type FinalizeResult =
  | { kind: "ok"; prNumber: number; prUrl: string }
  | { kind: "no_changes" }
  | { kind: "tests_failed"; output: string }
  | { kind: "push_failed"; output: string }
  | { kind: "pr_failed"; status: number; body: string };

export async function finalize(opts: FinalizeOpts): Promise<FinalizeResult> {
  // 1. Did the agent make any changes (committed or working-tree)?
  const dirty = await isWorkdirDirty(opts.workdir);
  const ahead = await commitsAhead(opts.workdir, opts.defaultBranch);
  if (!dirty && ahead === 0) {
    return { kind: "no_changes" };
  }

  // 2. Auto-commit anything still uncommitted in the working tree. Uses the
  //    submission summary as the commit message so the PR's first commit is
  //    self-documenting. If the agent already made commits, this becomes a
  //    no-op (nothing left to add) and we fall through to push.
  if (dirty) {
    await runOrThrow("git add -A", opts.workdir, "git add");
    const commitMsg = shellQuote(opts.commitMessage);
    const commitRun = await runBashRaw(
      `git commit -m ${commitMsg}`,
      opts.workdir,
      30_000,
    );
    if (commitRun.exitCode !== 0) {
      throw new Error(
        `git commit failed (exit ${commitRun.exitCode}): ${commitRun.stderr || commitRun.stdout}`,
      );
    }
  }

  // 3. If the product has a test command, run it. Failure returns to the
  //    agent loop (terminate=false on submit_done) so they can investigate.
  if (opts.testCommand) {
    const testRun = await runBashRaw(opts.testCommand, opts.workdir, 10 * 60_000);
    if (testRun.exitCode !== 0) {
      const out = (testRun.stdout + "\n" + testRun.stderr).trim();
      return { kind: "tests_failed", output: out.slice(0, 4000) };
    }
  }

  // 4. Push the feature branch. Force-push so re-attempts on the same issue
  //    overwrite the previous branch state.
  const pushRun = await runBashRaw(
    `git push --force-with-lease origin ${shellQuote(opts.branchName)}`,
    opts.workdir,
    60_000,
  );
  if (pushRun.exitCode !== 0) {
    return {
      kind: "push_failed",
      output: (pushRun.stdout + "\n" + pushRun.stderr).trim().slice(0, 4000),
    };
  }

  // 5. Open the PR. If one already exists for this head→base, GitHub returns
  //    422 with a "pull request already exists" message — treat as success
  //    by finding the existing PR.
  const existing = await openOrFindPR(opts);
  return existing;
}

// ---------------------------------------------------------------------------
// Helpers
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
  defaultBranch: string,
): Promise<number> {
  const r = await runBashRaw(
    `git rev-list --count ${shellQuote(`origin/${defaultBranch}`)}..HEAD`,
    workdir,
    10_000,
  );
  if (r.exitCode !== 0) {
    // origin/<default> may not be set in shallow clones; fall through to 0.
    return 0;
  }
  const n = Number(r.stdout.trim());
  return Number.isFinite(n) ? n : 0;
}

async function runOrThrow(
  cmd: string,
  cwd: string,
  context: string,
): Promise<BashRunResult> {
  const r = await runBashRaw(cmd, cwd, 30_000);
  if (r.exitCode !== 0) {
    throw new Error(
      `${context} failed (exit ${r.exitCode}): ${r.stderr || r.stdout}`,
    );
  }
  return r;
}

// Single-quote escape for shell. Wraps in '...' and replaces ' with '\''.
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// GitHub PR creation
// ---------------------------------------------------------------------------

async function openOrFindPR(opts: FinalizeOpts): Promise<FinalizeResult> {
  const createBody = {
    title: opts.prTitle,
    head: opts.branchName,
    base: opts.defaultBranch,
    body: opts.prBody,
  };
  const r = await fetch(`${API}/repos/${opts.repo}/pulls`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": opts.userAgent,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(createBody),
  });

  if (r.ok) {
    const j = (await r.json()) as { number: number; html_url: string };
    return { kind: "ok", prNumber: j.number, prUrl: j.html_url };
  }

  // 422 with "A pull request already exists" — look it up.
  if (r.status === 422) {
    const existing = await findExistingPR(opts);
    if (existing) return existing;
  }

  return { kind: "pr_failed", status: r.status, body: await r.text() };
}

async function findExistingPR(opts: FinalizeOpts): Promise<FinalizeResult | null> {
  const ownerOrg = opts.repo.split("/")[0]!;
  const url =
    `${API}/repos/${opts.repo}/pulls?state=open&head=` +
    encodeURIComponent(`${ownerOrg}:${opts.branchName}`);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": opts.userAgent,
    },
  });
  if (!r.ok) return null;
  const list = (await r.json()) as Array<{ number: number; html_url: string }>;
  const first = list[0];
  if (!first) return null;
  return { kind: "ok", prNumber: first.number, prUrl: first.html_url };
}
