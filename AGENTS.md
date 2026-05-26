# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Mission

agent-forge is an AWS-hosted, serverless-first platform that runs autonomous, long-running software product teams composed entirely of Claude agents. Six role-specialized agents chain together to take a product from spec → backlog → implementation → tested + secured → shipped, with handoffs driven by GitHub issue state, not by a single long-running prompt.

Long-running means **months or years**, not a one-shot build. The team continuously hydrates the backlog from an evolving spec, detects drift in already-shipped work, accumulates per-team memory of conventions, and stays inside a hard budget envelope.

The pain point this solves: Claude Routines and standalone agent runs do not chain hand-offs reliably across roles. agent-forge is the orchestration layer that makes that chaining deterministic, observable, and budgeted.

**Multi-project platform.** agent-forge is designed from day one to operate N target product repos in parallel, each with its own spec, backlog, budget, and accumulated team memory. There is no "single-product" mode.

**Serverless-first.** Every component is serverless (no servers to manage, pay per use). Fargate counts as serverless in the AWS taxonomy and is used in preference to Lambda only where the 15-min execution cap forces it. EC2 / ECS-on-EC2 is explicitly out of scope.

## Current state

This repository is no longer empty. Read this document alongside the reference
docs below, plus `spec/README.md`, `spec/roles.md`, `README.md`,
`CONTRIBUTING.md`, and `docs/runbook.md` before making changes.

Implemented or scaffolded pieces currently include:
- Terraform bootstrap, dev environment, and reusable modules under `infra/`.
- Glue Lambdas for webhook verification, cost estimation, and issue-comment
  handling under `infra/glue/`.
- Shared TypeScript helpers for GitHub App auth, repo/spec access, secrets,
  model selection, and budget conventions under `shared/`.
- BA agent container scaffold under `agents/ba/`.
- Scripts for GitHub App onboarding, product seeding, label seeding, and smoke
  testing under `scripts/`.
- GitHub Actions workflows for bootstrap, Terraform plan/apply, agent image
  builds, and lightweight CI under `.github/workflows/`.

Development is still early-stage. The remaining role agents, shared state
helpers, area-lock implementation, drift audit flow, full lifecycle Step
Functions, and broader test coverage are not complete yet.

## Reference docs

The detailed architecture reference lives under `docs/`. This file is the lean
guidance; reach for these when you need depth:

- [`docs/architecture.md`](docs/architecture.md) — topology, AWS components + DynamoDB tables, the six roles + Cost Estimator gate, concurrency/area-lock model, failure handling, long-running concerns, repository layout, and Terraform conventions.
- [`docs/cost-model.md`](docs/cost-model.md) — pricing assumptions, per-role and per-issue spend estimates, monthly volume projections, and the mandatory budget circuit breaker + Bedrock quota rules.
- [`docs/decisions.md`](docs/decisions.md) — dated architecture decision log (the "Resolved decisions" + open questions). Append new decisions here.
- [`docs/runbook.md`](docs/runbook.md) — operational steps a human performs (onboarding the GitHub Apps, clearing `human-needed`, rotating keys).

## Handoff protocol

The chain is **issue label → EventBridge rule → Step Function → role container**. There is exactly one source of truth: the GitHub Issue's `state:*` label. This vocabulary is load-bearing — renaming a label requires updating EventBridge rules and the Step Function definitions in the same PR.

```
state:idea                    → BA
state:cost-estimating         → Cost Estimator (Lambda)
state:awaiting-cost-approval  (parked — /approve-cost or /cancel from a maintainer)
state:cancelled               (terminal — set by /cancel)
state:ready                   → Developer
state:in-dev                  (working — no trigger; Dev pushes to PR)
state:awaiting-tests          → Test Engineer
state:awaiting-functional     → Functional Tester
state:awaiting-security       → Security Reviewer
state:awaiting-po             → PO
state:done                    (terminal)
human-needed                  (parked — only humans clear it)
```

Each agent's last action sets the next label. A label change emits a webhook → API Gateway → EventBridge → matching rule → Step Function execution → ECS Fargate task with the right image. A per-issue Step Function execution wraps the full lifecycle so the workflow view shows the whole chain in one place.

Cross-agent communication goes **only** through the issue and PR. No direct agent-to-agent calls. This keeps the audit trail in GitHub and prevents hidden state. See [`docs/architecture.md`](docs/architecture.md#roles) for what each role does on its trigger.

## Conventions for working in this repo

- Treat each agent's system prompt as code: changes go through PR review, never edited live in the cloud console.
- The state-label vocabulary is load-bearing. Renaming a label requires updating EventBridge rules and the Step Function definitions in the same PR.
- All cross-agent communication goes through the issue/PR. Never call one agent from another directly.
- Every agent run logs `{issue, role, model, input_tokens, cached_tokens, output_tokens, cost_usd}` to `budget_ledger`. The circuit breaker reads this. No exceptions.
- Prompt caching is mandatory on every role. Stable system prompt + spec excerpts + team memory all go in the cached prefix. Per-issue context goes in the uncached suffix.
- Model selection lives in one place: `shared/models.ts`. Do not hardcode model IDs in role code. Keep the `getModel(role, attempt) → ModelHandle` shape provider-agnostic so a direct-Anthropic-API outage fallback (or any future provider) is a config swap, not a refactor.
- Tool definitions live in a normalized format and are serialized per-provider at call time. v1 only targets Bedrock; the normalization keeps the door open without paying refactor cost later.

## Human gates (deliberate, not exhaustive)

- Spec edits in `spec/` come only from a human PR.
- `human-needed` label parks the workflow until a human clears it.
- Per-issue, per-role, per-product, and global daily spend caps are enforced by the budget circuit breaker (see [`docs/cost-model.md`](docs/cost-model.md)).
- Production deploys (if the target repo deploys) require an explicit human approval step. Agents do not push to production.
- For the first 30 days of a new target repo, the PO step is a Slack approval gate before merge, not autonomous merge. Lift the gate after observed merge accuracy is acceptable.
