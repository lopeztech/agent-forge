# agent-forge — product spec

This is the **product** spec for the agent-forge platform. It describes what
the platform exists to do, who it's for, and what success looks like. It is
read by the BA agent (and any humans triaging backlog) to ground backlog work
in the product's purpose.

Architecture details — components, infrastructure, conventions — live in
`docs/architecture.md` (with `CLAUDE.md`/`AGENTS.md` as the lean agent
guidance that links to it). Treat those as the engineering reference;
this directory is the product reference.

## Mission

agent-forge runs autonomous, long-running software product teams composed
entirely of Claude agents. Six role-specialized agents chain together —
BA → Cost Estimator → Developer → Test Engineer → Functional Tester →
Security Reviewer → Product Owner — to take a product from spec to shipped
code, with handoffs driven by GitHub issue state.

**Long-running means months or years**, not a one-shot build. The team
continuously hydrates the backlog from an evolving spec, detects drift in
already-shipped work, accumulates per-team memory of conventions, and stays
inside a hard budget envelope.

## Who it's for

- Solo engineers and small teams who want autonomous agents to operate a
  product backlog while they focus on architecture and direction.
- Multi-product operators: one agent-forge deployment runs N target product
  repos in parallel, each with its own spec, backlog, budget, and team memory.

## Product principles

1. **Determinism over cleverness.** Handoffs are driven by GitHub label
   transitions, not by a single long-running prompt. Every state change is
   inspectable in the issue history.
2. **Cost is a first-class constraint.** Every issue passes through a Cost
   Estimator gate. Per-issue, per-role, per-product, and global caps trip a
   circuit breaker. No surprise spend.
3. **Humans are not in the inner loop.** The default path is autonomous
   merge after PO approval. Humans are needed only for ambiguous specs,
   over-budget estimates, parked issues, and merging spec changes.
4. **Serverless-first.** Fargate for agents, Lambda for glue, DynamoDB for
   state. No servers to manage.
5. **Bounded blast radius.** Per-repo GitHub Apps with short-lived (1h)
   installation tokens. IAM-scoped Bedrock model access. Branch protection
   on `main` requires the merger App's review.

## What "shipped" means for a backlog item

An issue is `state:done` when:
- The PR linked to it has merged to `main`
- Unit + integration tests covering each acceptance criterion exist and pass
- Functional Tester has verified end-to-end behaviour against the criteria
- Security Reviewer's SAST + secrets + dependency scans are clean
- PO has compared the diff to the spec section the issue cites and approved

## Success metrics

- **Time-to-merge** for a typical issue: minutes-to-hours, not days
- **Kickback rate** (issues that bounce back from Test/Functional/Security):
  trending down as team memory accumulates
- **Cost per issue**: bounded by per-issue cap (default $12); typical happy
  path ~$2.65, expected with kickbacks ~$3.60
- **Drift rate**: PO weekly drift audit catches shipped-vs-spec gaps within
  a configurable horizon (default 90 days)

## Non-goals

See `non-goals.md` for an explicit list of things agent-forge will not do.

## Roles

See `roles.md` for what each of the six agent roles is responsible for.
