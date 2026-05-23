// Decides what `area:*` labels to apply to an issue based on what the BA
// model returned. Kept separate from the agent main flow so the validation
// rules (defend against bad model output, normalize wildcards, dedupe) are
// unit-testable without a Bedrock fake.

export type AreaDecision =
  // The issue genuinely spans every declared area. Apply `area:*` only.
  | { kind: "wildcard"; areaIds: string[] }
  // Apply `area:<name>` for each entry. Always non-empty, sorted, deduped.
  | { kind: "concrete"; areaIds: string[] }
  // BA couldn't categorize the issue. Wrapper applies gap:areas-incomplete
  // and parks at human-needed instead of progressing to cost-estimating.
  | { kind: "park"; reason: string };

export function chooseAreaLabels(
  modelAreas: ReadonlyArray<string> | undefined,
  declared: ReadonlyArray<string>,
): AreaDecision {
  if (!modelAreas || modelAreas.length === 0) {
    return {
      kind: "park",
      reason:
        "BA returned no areas — issue scope doesn't map cleanly to any declared area",
    };
  }
  if (declared.length === 0) {
    // Caller should have caught the areas.yml-missing branch upstream; defend
    // here so we never tell DynamoDB the issue covers "every" of zero areas.
    return {
      kind: "park",
      reason: "No areas declared in the target repo's .agent-forge/areas.yml",
    };
  }

  const declaredSet = new Set(declared);
  const invalid: string[] = [];
  const valid = new Set<string>();
  let wildcard = false;

  for (const a of modelAreas) {
    if (a === "*") {
      wildcard = true;
      continue;
    }
    if (declaredSet.has(a)) {
      valid.add(a);
      continue;
    }
    invalid.push(a);
  }

  if (wildcard) {
    // Wildcard subsumes any concrete area BA may have also returned.
    return {
      kind: "wildcard",
      areaIds: [...declared].sort((a, b) => a.localeCompare(b)),
    };
  }

  if (valid.size === 0) {
    return {
      kind: "park",
      reason:
        invalid.length > 0
          ? `BA returned only unknown areas: ${invalid.join(", ")}`
          : "BA returned no valid areas",
    };
  }

  return {
    kind: "concrete",
    areaIds: [...valid].sort((a, b) => a.localeCompare(b)),
  };
}

// Hex color for `area:<name>` labels created on-the-fly. Matches the muted
// blue convention used when the labels are added during BA expansion.
export const AREA_LABEL_COLOR = "bfd4f2";

export function areaLabelDescription(areaId: string, paths: string[]): string {
  const summary = paths.length > 0 ? ` (${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ", …" : ""})` : "";
  return `Issue touches the "${areaId}" area${summary}`;
}
