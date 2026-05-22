# Contributing

agent-forge is early-stage infrastructure software. Keep changes small,
reviewable, and aligned with the architecture in `CLAUDE.md` and the product
spec in `spec/`.

## Setup

Use Node.js 22 or newer and Terraform `1.10.0`.

```bash
npm ci
npm run typecheck
terraform fmt -check -recursive infra
```

AWS-backed tasks also require an authenticated AWS CLI profile for the target
environment. GitHub automation tasks require `gh auth login` with `repo`,
`workflow`, and `read:org` scopes.

## Branching

Use short-lived branches from `main`. Keep each branch focused on one platform
slice, such as a single Terraform module, one glue Lambda, one shared helper, or
one agent role scaffold.

The state-label vocabulary is load-bearing. If a change renames or changes a
`state:*` label, update the EventBridge rules, Step Function definitions, docs,
and label-seeding code in the same pull request.

Do not commit generated Terraform state, local credentials, private keys, or
agent transcripts.

## Tests

Before opening a pull request, run:

```bash
npm run typecheck
terraform fmt -check -recursive infra
```

For infrastructure changes, rely on the Terraform plan workflow before merge.
For GitHub App, webhook, and target-product onboarding changes, update
`docs/runbook.md` when the operator workflow changes.

When adding runtime behavior, prefer focused tests or smoke scripts that can run
without cloud mutation. If cloud access is required, make the command explicit
and document the expected AWS profile, region, and target resource.
