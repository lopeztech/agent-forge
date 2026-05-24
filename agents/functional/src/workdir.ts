// Clones the PR branch read-only for Functional verification.
// Functional doesn't push anything back, so we don't bother with git config /
// fresh checkout / etc. — just a single-branch clone is enough.

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
  branchName: string;
};

export type ClonedPrWorkdir = {
  path: string;
  branchName: string;
  cleanup: () => Promise<void>;
};

export async function clonePrBranch(
  opts: ClonePrBranchOpts,
): Promise<ClonedPrWorkdir> {
  const path = join(WORKDIR_ROOT, opts.runId);
  try {
    if ((await stat(path)).isDirectory()) {
      await rm(path, { recursive: true, force: true });
    }
  } catch {
    /* not present */
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
