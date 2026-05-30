// Pure, env-free logic for the comment handler. Kept separate from index.ts
// so it is unit-testable without the Lambda's top-level env reads / AWS clients.

export type Command = "approve-cost" | "cancel";

// Only OWNER and MEMBER author_associations can issue commands.
// Locks out outside-collaborator and contractor blast radius.
export const APPROVERS = new Set(["OWNER", "MEMBER"]);

// First non-empty line is the command. Allows users to add explanatory
// text on later lines without the command being lost.
export function parseCommand(body: string): Command | undefined {
  const first = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return undefined;
  if (first === "/approve-cost") return "approve-cost";
  if (first === "/cancel") return "cancel";
  return undefined;
}

export function hasLabel(labels: ReadonlyArray<{ name: string }>, name: string): boolean {
  return labels.some((l) => l.name === name);
}
