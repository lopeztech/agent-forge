# Issue State Lifecycle and `state:done` Definition

Engineering reference for the full label-transition sequence that governs an
issue from creation to terminal state. This document is the authoritative
source for:

- The ordered sequence of `state:*` label transitions.
- The exact conditions that must all be satisfied before `state:done` is
  applied.
- The actor responsible for applying `state:done` and the trigger event.
- How each of the five "shipped" conditions from `spec/README.md` maps to a
  specific role or automated check.

For the broader architecture context see [`docs/architecture.md`](architecture.md).
For the label vocabulary and its load-bearing status see `CLAUDE.md` §"Handoff
protocol".

---

## Full label-transition sequence

```
state:idea
  └─▶ BA agent
        └─▶ state:cost-estimating
              └─▶ Cost Estimator Lambda
                    ├─▶ state:awaiting-cost-approval  (parked — /approve-cost or /cancel)
                    │     ├─▶ state:ready             (/approve-cost from maintainer)
                    │     └─▶ state:cancelled         (/cancel from maintainer — TERMINAL)
                    └─▶ state:ready                   (auto-approved, p50 ≤ threshold)

state:ready
  └─▶ Developer agent
        └─▶ state:in-dev                              (working — no trigger; Dev pushes to PR)
              └─▶ state:awaiting-tests

state:awaiting-tests
  └─▶ Test Engineer agent
        └─▶ state:awaiting-functional

state:awaiting-functional
  └─▶ Functional Tester agent
        ├─▶ state:in-dev  (kickback — failure report posted; Dev retries)
        └─▶ state:awaiting-security

state:awaiting-security
  └─▶ Security Reviewer agent
        ├─▶ state:in-dev  (kickback — blocking findings; Dev retries)
        └─▶ state:awaiting-po

state:awaiting-po
  └─▶ PO agent
        ├─▶ state:done    (approve + auto_merge=true — TERMINAL, see below)
        ├─▶ human-needed  (approve + auto_merge=false, or merge failed — human merges)
        ├─▶ state:ready   (kickback — concrete deltas posted; Dev retries)
        └─▶ human-needed  (spec_ambig — spec must change before work resumes)

human-needed
  └─▶ (parked — only a human clears this label)

state:done   (TERMINAL)
state:cancelled  (TERMINAL)
```

Kickback paths increment the `iter:N` counter on the issue. At `iter:3` (the
per-product kickback cap, default 3), any further kickback parks at
`human-needed` instead of looping.

---

## `state:done` — definition and conditions

An issue reaches `state:done` when **all five** of the following conditions
are satisfied. These conditions are the canonical definition from
`spec/README.md` §"What 'shipped' means for a backlog item", mapped here to
the specific role or automated check that satisfies each one:

| # | Condition | Satisfied by |
|---|-----------|--------------|
| 1 | The PR linked to the issue has merged to `main` | Automated: PO agent calls `mergePR` via the `agent-forge-merger` GitHub App (when `products.auto_merge = true`), or a human merges manually (when `auto_merge = false` or the 30-day approval gate is active). |
| 2 | Unit + integration tests covering each acceptance criterion exist and pass | **Test Engineer** agent — adds tests to the PR branch and verifies they pass before transitioning to `state:awaiting-functional`. |
| 3 | Functional Tester has verified end-to-end behaviour against the criteria | **Functional Tester** agent — executes e2e flows, posts a structured pass/fail report, and only transitions to `state:awaiting-security` on pass. |
| 4 | Security Reviewer's SAST + secrets + dependency scans are clean | **Security Reviewer** agent — runs semgrep, gitleaks, and `npm audit` (or equivalent), posts findings, and only transitions to `state:awaiting-po` when no blocking findings remain. |
| 5 | PO has compared the diff to the spec section the issue cites and approved | **PO agent** — reviews the PR against the BA expansion and the cited spec section, then calls `submit_po_verdict(verdict="approve", ...)`. |

All five conditions are gate-enforced by the label-transition sequence: no
label can be skipped because each role only transitions forward on success and
backwards (kickback) on failure. The sequence is therefore the implementation
of the five conditions.

---

## Who applies `state:done` and when

**Actor:** the **PO agent** (`agents/po/src/index.ts`).

**Trigger event:** the PO agent calls `submit_po_verdict` with
`verdict = "approve"` and `products.auto_merge = true` (and the 30-day
approval gate is not active). The agent then:

1. Mints a short-lived installation token for the `agent-forge-merger` GitHub
   App (the writer App cannot merge against branch protection that requires
   the merger App's review).
2. Calls `mergePR` to squash-merge the PR onto `main`.
3. On merge success, calls `transitionLabel` to replace `state:awaiting-po`
   with `state:done` on the issue.
4. Writes `spec_hashes_at_merge` to `issue_state` (DynamoDB) so the weekly
   drift audit can detect future spec drift against this issue.
5. Records the actual spend ratio in `issue_state` for Cost Estimator
   calibration.

**When `auto_merge = false` or the 30-day approval gate is active:**

The PO agent posts a "recommend-merge" comment and parks the issue at
`human-needed`. A human must merge the PR on GitHub and then manually
transition the issue label from `human-needed` to `state:done`. The PO agent
still writes `spec_hashes_at_merge` at verdict time (not at merge time) so
drift detection works regardless of whether the merge was automated or manual.

**When the merge call fails** (branch protection conflict, out-of-date branch,
etc.): the PO agent parks at `human-needed` with the failure reason in the
comment. A human investigates, merges manually, and transitions to
`state:done`.

---

## Immediate predecessor label

The label transition immediately preceding `state:done` is:

```
state:awaiting-po  →  state:done
```

There is no intermediate `state:po-approved` label. The PO agent's approve
verdict and the merge are a single atomic operation: if the merge succeeds,
`state:done` is applied; if it fails, the issue parks at `human-needed`
(never at a hypothetical `state:po-approved`). This keeps the label
vocabulary minimal and avoids a state that would require a second trigger to
advance.

---

## Side-effects on reaching `state:done`

When an issue transitions to `state:done`, the following bookkeeping occurs
(all performed by the PO agent in the same run):

- **`issue_state` (DynamoDB):** `spec_hashes_at_merge` is written — a map of
  cited spec-section path → SHA-256 of the section content at merge time.
  The weekly drift audit compares these hashes against current spec content
  to detect spec-vs-shipped drift.
- **`issue_state` (DynamoDB):** the actual-vs-estimate spend ratio
  `(estimate_p50, actual_usd, ratio)` is recorded for Cost Estimator
  calibration.
- **`budget_ledger` (DynamoDB):** the PO agent's own model spend is appended
  (as with every role run).
- **Area lock:** the Dev-role area lock for this issue is released (TTL
  expires or explicit release), unblocking any queued `state:ready` issues
  for the same area.

---

## Terminal states

There are exactly two terminal states in the lifecycle:

| Label | Set by | Meaning |
|-------|--------|---------|
| `state:done` | PO agent (auto-merge) or human (manual merge) | PR merged; all five conditions satisfied. |
| `state:cancelled` | Glue Lambda on `/cancel` comment | Maintainer explicitly cancelled; no further work. |

`human-needed` is **not** a terminal state — it is a parking state. A human
clears it to resume the workflow.

---

## Relationship to `spec/README.md`

The five conditions in this document are a direct, traceable expansion of the
definition in `spec/README.md` §"What 'shipped' means for a backlog item":

> An issue is `state:done` when:
> - The PR linked to it has merged to `main`
> - Unit + integration tests covering each acceptance criterion exist and pass
> - Functional Tester has verified end-to-end behaviour against the criteria
> - Security Reviewer's SAST + secrets + dependency scans are clean
> - PO has compared the diff to the spec section the issue cites and approved

No condition has been added, removed, or reworded. The table in the
"Conditions" section above maps each bullet to its implementing role or
automated check without altering the meaning.
