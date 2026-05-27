# agent-forge

agent-forge is an AWS-hosted, serverless-first orchestration platform for
long-running software product teams made of role-specialized agents. It turns
GitHub issue state transitions into deterministic handoffs across a product
lifecycle: backlog refinement, cost estimation, implementation, testing,
functional verification, security review, and product-owner approval.

The platform lives in this repository. Target products live in separate GitHub
repositories and connect through GitHub App installations.

## Project layout

| Directory | Purpose |
|-----------|---------|
| `infra/` | Terraform modules, environment configs, bootstrap state, and glue Lambdas for AWS infrastructure. |
| `agents/` | Role-specialized agent containers (BA, Dev, Test, Functional, Security, PO). |
| `shared/` | Shared TypeScript helpers — GitHub App auth, model selection, budget, labels, and state utilities. |
| `scripts/` | Operational scripts for GitHub App onboarding, product seeding, label seeding, and smoke testing. |
| `spec/` | Product specification: mission, roles, non-goals, and success metrics. |
| `docs/` | Engineering reference: architecture, cost model, decision log, and operational runbook. |
| `tests/` | Unit and integration tests for shared helpers, agent plans, and platform behaviour. |

## Current Shape

This repo currently contains:

- Terraform for the dev environment, reusable AWS modules, and bootstrap state.
- Glue Lambdas for webhook verification, cost estimation, and comment handling.
- Shared TypeScript helpers for GitHub App auth, model selection, specs, and
  budget conventions.
- Six role containers for BA, Dev, Test, Functional, Security, and PO,
  with the full label-driven pipeline wired in dev. Long-running
  behaviours — nightly backlog hydration, weekly drift audit, and
  per-(product, role) team-memory accumulation — are running on schedule.
  A 30-day post-onboarding approval gate suppresses auto-merge while a
  target repo's PR-accuracy is being observed.
- Scripts for GitHub App onboarding, product seeding, label seeding, and smoke
  testing.
- Operational docs in `docs/runbook.md`.

## Architecture

The core handoff loop is:

```text
GitHub label change
  -> API Gateway webhook
  -> webhook verifier Lambda
  -> EventBridge
  -> Step Functions
  -> Lambda or ECS Fargate role runner
  -> GitHub issue / PR state update
```

GitHub is the durable product workflow surface. DynamoDB stores product config,
issue scratch state, budget ledger entries, team memory, model rate buckets, and
area locks. S3 stores larger artifacts such as diffs, reports, and transcripts.
Model calls go through Amazon Bedrock in `eu-west-1`.

For the product and role-level spec, see:

- `spec/README.md`
- `spec/roles.md`

For the engineering reference, see:

- `CLAUDE.md` / `AGENTS.md` — lean agent guidance (mission, handoff protocol, conventions)
- `docs/architecture.md` — topology, AWS components, roles, concurrency, failure handling
- `docs/cost-model.md` — spend model and budget circuit breaker
- `docs/decisions.md` — architecture decision log

## Prerequisites

- Node.js 22.6.0 or newer
- npm
- Terraform `1.10.0`
- GitHub CLI authenticated with `repo`, `workflow`, and `read:org` scopes
- AWS CLI authenticated to the target AWS account when running infra or
  onboarding tasks

## Local Setup

Install dependencies:

```bash
npm ci
```

Run the TypeScript check:

```bash
npm run typecheck
```

Check Terraform formatting:

```bash
terraform fmt -check -recursive infra
```

## Common Tasks

Seed the label vocabulary on a target repo:

```bash
AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 npm run seed:labels -- \
  --repo owner/repo \
  --install <WRITER_INSTALL_ID>
```

Register a target product in DynamoDB:

```bash
AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 npm run seed:product -- \
  --product-id owner-repo \
  --repo owner/repo \
  --writer-install <WRITER_INSTALL_ID> \
  --merger-install <MERGER_INSTALL_ID>
```

Run the GitHub App smoke test:

```bash
AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 npm run smoke:github-app -- \
  --repo owner/repo \
  --install <WRITER_INSTALL_ID>
```

For full operational steps, including GitHub App onboarding and webhook wiring,
see `docs/runbook.md`.

## CI

Pull requests run lightweight checks that do not require AWS credentials:

- `npm ci`
- `npm run typecheck`
- `terraform fmt -check -recursive infra`

Infrastructure pull requests also run Terraform plan through
`.github/workflows/terraform-plan.yml`, which requires the configured GitHub OIDC
role in AWS.
