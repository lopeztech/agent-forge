// Clones the target repo and checks out Dev's PR branch for the Test agent.
// Convention: Dev branches as `agent-forge/dev/issue-<N>` (see
// agents/dev/src/index.ts), so Test re-derives the same name from issue
// number. No need to store it elsewhere.

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WORKDIR_ROOT = process.env.AGENT_FORGE_WORKDIR_ROOT ?? "/tmp/agent-forge";

export type ClonePrBranchOpts = {
  token: string;
  repo: string; // "owner/name"
  runId: string;
  branchName: string; // e.g. "agent-forge/dev/issue-41"
};

export type ClonedPrWorkdir = {
  path: string;
  branchName: string;
  cleanup: () => Promise<void>;
};

// Single-branch clone directly checked out to the PR branch. Avoids
// pulling the default branch's history. If the branch doesn't exist on
// origin (e.g. Dev never pushed), git clone exits non-zero and the caller
// surfaces that as an error.
export async function clonePrBranch(
  opts: ClonePrBranchOpts,
): Promise<ClonedPrWorkdir> {
  const path = join(WORKDIR_ROOT, opts.runId);
  try {
    if ((await stat(path)).isDirectory()) {
      await rm(path, { recursive: true, force: true });
    }
  } catch {
    /* not present, fine */
  }
  await mkdir(WORKDIR_ROOT, { recursive: true });

  const url = `https://x-access-token:${opts.token}@github.com/${opts.repo}.git`;
  await execFileAsync("git", [
    "clone",
    "--branch",
    opts.branchName,
    "--single-branch",
    "--depth=20",
    url,
    path,
  ]);

  return {
    path,
    branchName: opts.branchName,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}
