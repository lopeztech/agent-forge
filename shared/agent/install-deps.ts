// Deterministic dependency install for the code-pushing roles (Dev, Test)
// after they clone a target repo, run *before* the model loop and the finalize
// gate. Without this, dependency resolution was left to the model improvising
// `npm` commands via the bash tool — fragile for real-world repos whose strict
// `npm ci` fails (e.g. ERESOLVE peer conflicts from mismatched Storybook/React
// peer ranges). A broken/incomplete node_modules then fails the *entire* test
// suite in the finalize gate, so Dev loops to the turn cap and parks even
// though its change was fine. Confirmed onboarding lopeztech/home-plant-tracker
// (issue #458): `npm ci` ERESOLVEd, the suite reported 116/116 failures, yet a
// clean `npm install --legacy-peer-deps` makes those same tests pass 116/116.
//
// Product-agnostic: only engages for npm projects (package.json present), or
// when the product configures an explicit install command. Non-npm repos get
// no install step, exactly as before.

import { stat } from "node:fs/promises";

import { runBashRaw } from "./write-tools.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export type InstallAttempt = { command: string; exitCode: number | null };

export type InstallResult = {
  // false → nothing to install (no package.json, no configured command).
  ran: boolean;
  // true → a command succeeded, or there was nothing to do.
  ok: boolean;
  // The command that succeeded, if any.
  commandUsed?: string;
  attempts: InstallAttempt[];
  // Combined output of the last failing attempt, for diagnostics.
  output?: string;
};

// Ordered fallback chain for npm projects. `npm ci` is preferred (lockfile-
// exact, reproducible); the `--legacy-peer-deps` fallbacks recover from
// ERESOLVE peer conflicts that would otherwise leave the clone with no usable
// node_modules. Each is tried until one exits 0.
export function npmInstallChain(hasLock: boolean): string[] {
  return hasLock
    ? [
        "npm ci",
        "npm ci --legacy-peer-deps",
        "npm install --legacy-peer-deps --no-audit --no-fund",
      ]
    : [
        "npm install --no-audit --no-fund",
        "npm install --legacy-peer-deps --no-audit --no-fund",
      ];
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export type EnsureDependenciesOpts = {
  workdir: string;
  // Per-product override (ProductConfig.install_command). Runs verbatim with no
  // fallback — the product owns its install contract.
  configured?: string;
  timeoutMs?: number;
};

export async function ensureDependencies(
  opts: EnsureDependenciesOpts,
): Promise<InstallResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Explicit override wins — run exactly what the product configured.
  if (opts.configured && opts.configured.trim().length > 0) {
    const r = await runBashRaw(opts.configured, opts.workdir, timeoutMs);
    const attempts = [{ command: opts.configured, exitCode: r.exitCode }];
    if (r.exitCode === 0) {
      await restoreManifests(opts.workdir, timeoutMs);
      return { ran: true, ok: true, commandUsed: opts.configured, attempts };
    }
    return {
      ran: true,
      ok: false,
      attempts,
      output: `${r.stdout}\n${r.stderr}`.trim().slice(0, 4000),
    };
  }

  // npm detection. No package.json → nothing to do (non-npm project).
  if (!(await exists(`${opts.workdir}/package.json`))) {
    return { ran: false, ok: true, attempts: [] };
  }
  const hasLock = await exists(`${opts.workdir}/package-lock.json`);

  const attempts: InstallAttempt[] = [];
  let lastOutput = "";
  for (const command of npmInstallChain(hasLock)) {
    const r = await runBashRaw(command, opts.workdir, timeoutMs);
    attempts.push({ command, exitCode: r.exitCode });
    if (r.exitCode === 0) {
      // A `--legacy-peer-deps`/`install` fallback can rewrite package-lock.json
      // (and occasionally package.json). Restore them so the install is a pure
      // node_modules operation and doesn't pollute the agent's eventual diff.
      // Safe here: this runs before the model makes any change, so it only
      // undoes the installer's own churn.
      await restoreManifests(opts.workdir, timeoutMs);
      return { ran: true, ok: true, commandUsed: command, attempts };
    }
    lastOutput = `${r.stdout}\n${r.stderr}`.trim();
  }
  return { ran: true, ok: false, attempts, output: lastOutput.slice(0, 4000) };
}

async function restoreManifests(workdir: string, timeoutMs: number): Promise<void> {
  // Best-effort: only restores tracked files; a no-op when nothing changed.
  await runBashRaw(
    "git checkout -- package-lock.json package.json 2>/dev/null || true",
    workdir,
    Math.min(timeoutMs, 30_000),
  );
}
