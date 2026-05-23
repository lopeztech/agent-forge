// Canonical GitHub label vocabulary for the agent-forge workflow.
//
// State labels are load-bearing: EventBridge rules, Step Functions, agents,
// and glue Lambdas all interpret them as workflow state. Keep label renames in
// lockstep with infrastructure and docs.

export const STATE_LABELS = {
  idea: "state:idea",
  costEstimating: "state:cost-estimating",
  awaitingCostApproval: "state:awaiting-cost-approval",
  cancelled: "state:cancelled",
  ready: "state:ready",
  inDev: "state:in-dev",
  awaitingTests: "state:awaiting-tests",
  awaitingFunctional: "state:awaiting-functional",
  awaitingSecurity: "state:awaiting-security",
  awaitingPo: "state:awaiting-po",
  done: "state:done",
} as const;

export type StateLabel = (typeof STATE_LABELS)[keyof typeof STATE_LABELS];

export const HUMAN_NEEDED_LABEL = "human-needed";

export const GAP_LABELS = {
  areasIncomplete: "gap:areas-incomplete",
  specConflict: "gap:spec-conflict",
} as const;

export const FLAG_LABELS = {
  techDebt: "tech-debt",
  securitySensitive: "security-sensitive",
  complexityHigh: "complexity:high",
} as const;

export function iterLabel(attempt: 1 | 2 | 3): `iter:${1 | 2 | 3}` {
  return `iter:${attempt}`;
}

export const AREA_LABEL_PREFIX = "area:";
export const AREA_ALL_LABEL = "area:*";

export const TERMINAL_STATE_LABELS = new Set<StateLabel>([
  STATE_LABELS.done,
  STATE_LABELS.cancelled,
]);

export function isStateLabel(label: string): label is StateLabel {
  return (Object.values(STATE_LABELS) as string[]).includes(label);
}

export type ParsedAreaLabels = {
  hasAll: boolean;
  areaIds: string[];
};

// Extracts `area:<name>` labels from an issue. `area:*` is split out into
// `hasAll` because callers need to expand it against the product's full area
// set (read from `.agent-forge/areas.yml`). Non-area labels are ignored.
export function parseAreaLabels(
  labels: ReadonlyArray<{ name: string }>,
): ParsedAreaLabels {
  let hasAll = false;
  const areaIds = new Set<string>();
  for (const { name } of labels) {
    if (!name.startsWith(AREA_LABEL_PREFIX)) continue;
    const suffix = name.slice(AREA_LABEL_PREFIX.length);
    if (suffix === "") continue;
    if (suffix === "*") {
      hasAll = true;
      continue;
    }
    areaIds.add(suffix);
  }
  return {
    hasAll,
    areaIds: [...areaIds].sort((a, b) => a.localeCompare(b)),
  };
}

export type LabelDefinition = {
  name: string;
  color: string;
  description: string;
};

export const LABEL_VOCABULARY: readonly LabelDefinition[] = [
  // State machine, ordered by lifecycle phase.
  {
    name: STATE_LABELS.idea,
    color: "0e8a16",
    description: "BA hasn't picked this up yet",
  },
  {
    name: STATE_LABELS.costEstimating,
    color: "1d76db",
    description: "Cost Estimator Lambda is sizing this issue",
  },
  {
    name: STATE_LABELS.awaitingCostApproval,
    color: "fbca04",
    description:
      "Estimate above auto-approve threshold; needs /approve-cost from a maintainer",
  },
  {
    name: STATE_LABELS.cancelled,
    color: "cccccc",
    description: "Maintainer ran /cancel; terminal",
  },
  {
    name: STATE_LABELS.ready,
    color: "0052cc",
    description: "Backlog: a Dev will pick this up when capacity allows",
  },
  {
    name: STATE_LABELS.inDev,
    color: "1d76db",
    description: "A Dev is actively working this branch",
  },
  {
    name: STATE_LABELS.awaitingTests,
    color: "5319e7",
    description: "Dev finished; Test Engineer adds tests next",
  },
  {
    name: STATE_LABELS.awaitingFunctional,
    color: "5319e7",
    description: "Tests added; Functional Tester runs e2e flows next",
  },
  {
    name: STATE_LABELS.awaitingSecurity,
    color: "5319e7",
    description: "Functional passed; Security Reviewer scans next",
  },
  {
    name: STATE_LABELS.awaitingPo,
    color: "5319e7",
    description: "Security clean; PO decides ship/no-ship next",
  },
  {
    name: STATE_LABELS.done,
    color: "0e8a16",
    description: "Merged. Terminal.",
  },

  // Iteration counters.
  { name: iterLabel(1), color: "ffaf2b", description: "First Dev attempt" },
  {
    name: iterLabel(2),
    color: "ff6f1a",
    description: "Second Dev attempt (kicked back once)",
  },
  {
    name: iterLabel(3),
    color: "ff4d00",
    description: "Final Dev attempt - runs on Opus",
  },

  // Areas. Concrete area:<name> labels are added dynamically per product.
  {
    name: AREA_ALL_LABEL,
    color: "cccccc",
    description:
      "Spans every declared area; equivalent to single-Dev for that issue",
  },

  // Failure / human-attention.
  {
    name: HUMAN_NEEDED_LABEL,
    color: "b60205",
    description:
      "Parked: a human must clear this before the workflow resumes",
  },
  {
    name: GAP_LABELS.areasIncomplete,
    color: "b60205",
    description:
      "Issue paths aren't covered by .agent-forge/areas.yml; needs human triage",
  },
  {
    name: GAP_LABELS.specConflict,
    color: "b60205",
    description:
      "BA detected a direct conflict with the product spec; needs human resolution",
  },

  // Tech debt and flags.
  {
    name: FLAG_LABELS.techDebt,
    color: "fef2c0",
    description: "Filed by a Dev for follow-up; BA picks up nightly",
  },
  {
    name: FLAG_LABELS.securitySensitive,
    color: "5319e7",
    description:
      "Touches auth, crypto, payments, or PII; Security Reviewer escalates to Opus",
  },
  {
    name: FLAG_LABELS.complexityHigh,
    color: "ff6f1a",
    description:
      "Cross-cutting / perf-sensitive / novel; Dev escalates to Opus on first attempt",
  },
] as const;
