// Wraps the "Dev is done; ship it" sequence: detect working-tree state,
// commit anything outstanding, push the feature branch, open a PR.
//
// Kept separate from index.ts so it can be unit-tested in isolation and so
// the failure paths (no changes / push failed / PR creation failed) are
// auditable in one place.

import { runBashRaw, type BashRunResult } from "../../../shared/agent/write-tools.ts";
import {
  runCheck,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
} from "../../../shared/agent/checks.ts";

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
  // True when the feature branch already existed on origin and Dev is
  // continuing from it (kickback resume). False on a fresh attempt where
  // the branch was created from the default branch's HEAD.
  resumed: boolean;
};

// Called right after clone — captures the default branch (the one the agent's
// changes will be PR'd against), pins git identity, and checks out the
// feature branch.
//
// Resume semantics (F.2.b follow-up): if a previous Dev attempt on this issue
// already pushed `branchName` to origin (kickback flow), check out from the
// remote tip so this attempt builds on top of Test's commits + any prior Dev
// work. Otherwise create the branch fresh from the default branch's HEAD.
//
// `git fetch origin <branch>` is the cheapest way to detect whether the
// branch exists on origin: exit 0 if it does, non-zero if it doesn't. The
// shallow clone (depth=20) gives us enough history that pushing a force-with-
// lease later is reliable.
export async function setupWorkdir(
  opts: SetupWorkdirOpts,
): Promise<SetupWorkdirResult> {
  const { workdir, identity, branchName } = opts;

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

  // Probe origin for the feature branch. The clone was --single-branch, so
  // origin/<branchName> isn't tracked yet; an explicit fetch creates the
  // local ref if the branch exists upstream.
  const fetchRun = await runBashRaw(
    `git fetch origin ${shellQuote(branchName)}`,
    workdir,
    30_000,
  );
  const resumed = fetchRun.exitCode === 0;

  if (resumed) {
    // Resume from the remote tip. -B creates the local branch if absent or
    // resets it to origin/<branchName> if present.
    await runOrThrow(
      `git checkout -B ${shellQuote(branchName)} ${shellQuote(`origin/${branchName}`)}`,
      workdir,
      "checkout existing feature branch",
    );
  } else {
    // Fresh attempt — branch off the default branch's HEAD.
    await runOrThrow(
      `git checkout -B ${shellQuote(branchName)}`,
      workdir,
      "create feature branch",
    );
  }

  return { defaultBranch, resumed };
}

export type FinalizeOpts = {
  workdir: string;
  branchName: string;
  defaultBranch: string;
  commitMessage: string;
  typecheckCommand?: string;
  testCommand?: string;
  // Per-product cap for the typecheck + test commands. Defaults to 600s.
  testTimeoutSeconds?: number;
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
  | { kind: "checks_timed_out"; output: string; timeoutSeconds: number }
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

  // 3. Run the project's checks as the pre-PR gate. Typecheck first — a change
  //    can pass `npm test` but fail `tsc --noEmit`, which the repo's CI gates
  //    on — then the test command. Any failure returns to the agent loop
  //    (terminate=false on submit_done) so they can investigate.
  const timeoutSeconds = opts.testTimeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS;
  const baseRef = `origin/${opts.defaultBranch}`;
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
      baseRef,
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
