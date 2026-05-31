import { STATE_LABELS } from "../../../../shared/labels.ts";

export function hasStateDoneLabel(
  labels: ReadonlyArray<{ name: string }> | undefined,
): boolean {
  return (labels ?? []).some((label) => label.name === STATE_LABELS.done);
}
