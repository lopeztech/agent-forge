// Clones the target repo into /tmp/<runId> for the Dev agent to read from.
// The installation token is embedded in the remote URL so git's HTTPS transport
// auths automatically; we don't write it to disk. The agent code never sees
// the URL — only the local workdir path.

import { execFile } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Default Fargate ephemeral storage is 20 GB; /tmp is writable by every user.
const WORKDIR_ROOT = process.env.AGENT_FORGE_WORKDIR_ROOT ?? "/tmp/agent-forge";

export type CloneRepoOpts = {
  token: string;
  repo: string; // "owner/name"
  runId: string;
};

export type ClonedWorkdir = {
  path: string;
  cleanup: () => Promise<void>;
};

// Shallow single-branch clone of the default branch. Enough for B.2 (read-only
// investigation) and B.3 (branch + commit + push will be a `--no-shallow`
// promotion when we add write tools, or stay shallow if push-from-shallow works
// for the new-branch case — to be confirmed in B.3).
export async function cloneTargetRepo(
  opts: CloneRepoOpts,
): Promise<ClonedWorkdir> {
  const path = join(WORKDIR_ROOT, opts.runId);
  // Clean any leftover from a previous task that crashed mid-run on this host
  // (Fargate normally gives each task a fresh ephemeral disk, but defend
  // anyway).
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
    "--depth=1",
    "--single-branch",
    url,
    path,
  ]);

  return {
    path,
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}
