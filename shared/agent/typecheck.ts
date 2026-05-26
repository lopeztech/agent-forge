// Resolve the project's typecheck command for the code-pushing roles (Dev,
// Test). A change that runs its tests green can still fail the repo's
// `tsc --noEmit` gate — agent-forge's own CI does exactly that — so the
// finalize gate runs typecheck *before* tests and kicks back on failure.
//
// Product-agnostic: only engages when the project's package.json declares a
// `typecheck` script (or the product configures an explicit command). Projects
// without one get no typecheck gate, exactly as before.

import { readFile } from "node:fs/promises";

export async function resolveTypecheckCommand(
  workdir: string,
  configured: string | undefined,
): Promise<string | undefined> {
  if (configured && configured.trim().length > 0) return configured;
  try {
    const raw = await readFile(`${workdir}/package.json`, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    if (pkg.scripts && typeof pkg.scripts.typecheck === "string") {
      return "npm run typecheck";
    }
  } catch {
    // No package.json, unreadable, or unparseable → no typecheck gate.
  }
  return undefined;
}
