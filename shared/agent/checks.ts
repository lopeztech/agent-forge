// Runs a project "check" (typecheck or test command) as the finalize gate for
// the code-pushing roles (Dev, Test), with three behaviours the raw runBashRaw
// call lacked:
//
//   (a) Timeout is a distinct, terminal outcome. A check that times out (a
//       slow or hanging suite) is NOT a failure the agent can fix by re-running
//       — looping just burns the 2h wall-clock. `timed_out` is surfaced so the
//       caller parks immediately with a clear message instead of kicking back.
//   (b) Change-scoped testing without framework-guessing. The base ref is
//       exported as `AGENT_FORGE_BASE_REF` so a product can opt into a
//       framework-native scoped command (e.g. `vitest run --changed
//       "$AGENT_FORGE_BASE_REF"`, `jest --changedSince="$AGENT_FORGE_BASE_REF"`)
//       that the test runner computes safely. Commands that don't reference it
//       run the full suite, exactly as before.
//   (c) Per-product timeout. The caller passes the timeout (from
//       ProductConfig.test_timeout_seconds) rather than a hardcoded 10 minutes.
//
// Confirmed need onboarding lopeztech/home-plant-tracker (#458): a one-line
// README change couldn't ship because the full `vitest run` finalize gate hung
// past the wall-clock cap.

import { runBashRaw } from "./write-tools.ts";

export const DEFAULT_CHECK_TIMEOUT_SECONDS = 600;

export type CheckOutcome =
  | { kind: "passed" }
  | { kind: "failed"; output: string }
  | { kind: "timed_out"; output: string; timeoutSeconds: number };

function shellQuoteSingle(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// Export AGENT_FORGE_BASE_REF before running the command, so the command can
// reference it both as an env var (process.env) and via shell expansion on its
// own line (e.g. `vitest run --changed "$AGENT_FORGE_BASE_REF"`). An inline
// `VAR=x cmd` prefix would NOT expand on the same line — the assignment applies
// after word expansion — so we use a separate `export ...;` statement. Commands
// that don't reference it are unaffected.
export function withBaseRef(command: string, baseRef: string | undefined): string {
  if (!baseRef) return command;
  return `export AGENT_FORGE_BASE_REF=${shellQuoteSingle(baseRef)}; ${command}`;
}

export type RunCheckOpts = {
  // Human label for messages: "Typecheck" | "Tests".
  label: string;
  command: string;
  workdir: string;
  timeoutSeconds: number;
  // Git ref the change is based on, exposed as $AGENT_FORGE_BASE_REF for
  // opt-in change-scoped commands. Undefined → not exported.
  baseRef?: string;
};

export async function runCheck(opts: RunCheckOpts): Promise<CheckOutcome> {
  const cmd = withBaseRef(opts.command, opts.baseRef);
  const r = await runBashRaw(cmd, opts.workdir, opts.timeoutSeconds * 1000);
  if (r.exitCode === 0) return { kind: "passed" };

  const tail = `${r.stdout}\n${r.stderr}`.trim();
  if (r.timedOut) {
    return {
      kind: "timed_out",
      timeoutSeconds: opts.timeoutSeconds,
      output: (
        `${opts.label} command \`${opts.command}\` timed out after ` +
        `${opts.timeoutSeconds}s. This usually means the suite is too slow or ` +
        `hangs in the agent environment — re-running won't fix it. Consider a ` +
        `change-scoped test_command (using $AGENT_FORGE_BASE_REF) or a longer ` +
        `test_timeout_seconds for this product.\n${tail}`
      ).slice(0, 4000),
    };
  }
  return {
    kind: "failed",
    output: `${opts.label} failed (\`${opts.command}\`):\n${tail}`.slice(0, 4000),
  };
}
