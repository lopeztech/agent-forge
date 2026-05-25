// Spec-hashing utilities for the Phase D2 drift audit.
//
// PO writes per-file SHA-256s onto issue_state when an approve verdict
// lands (auto-merge or recommend-only). The weekly drift-audit Lambda
// re-reads the spec for sampled recently-merged issues and compares
// these baselines against current content to detect "spec changed
// since this issue shipped".
//
// Hash is content-only (not metadata). Whitespace + ordering matters —
// reformatting the spec WILL look like drift. That's the right call for
// v1: humans can decide whether a typo fix actually constitutes drift
// when triaging the auto-filed gap issue.

import { createHash } from "node:crypto";

import type { SpecReadResult } from "./spec.ts";

// Pure: compute a hex SHA-256 of one file's content.
export function hashSpecFileContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// Pure: turn a SpecReadResult into a path → SHA-256 map. Skips when the
// spec is missing or empty (returns an empty map). Order of map keys is
// insertion order; iterating sorted-by-path is the caller's job if it
// needs deterministic equality.
export function hashSpecTree(spec: SpecReadResult): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec.missing) return out;
  for (const f of spec.files) {
    out[f.path] = hashSpecFileContent(f.content);
  }
  return out;
}

export type SpecHashDiff = {
  // Paths that exist in `current` but not `baseline`.
  added: string[];
  // Paths in `baseline` but not `current`.
  removed: string[];
  // Paths in both whose hash differs.
  changed: string[];
};

// Pure: classify per-path differences between a baseline (stored at
// merge time) and the current spec. Sorted alphabetically for stable
// diffing in audit comments. Empty in every category means "no drift".
export function diffSpecHashes(
  baseline: Record<string, string>,
  current: Record<string, string>,
): SpecHashDiff {
  const baselineKeys = new Set(Object.keys(baseline));
  const currentKeys = new Set(Object.keys(current));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const k of currentKeys) {
    if (!baselineKeys.has(k)) added.push(k);
    else if (baseline[k] !== current[k]) changed.push(k);
  }
  for (const k of baselineKeys) {
    if (!currentKeys.has(k)) removed.push(k);
  }

  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

export function hasDrift(d: SpecHashDiff): boolean {
  return d.added.length > 0 || d.removed.length > 0 || d.changed.length > 0;
}
