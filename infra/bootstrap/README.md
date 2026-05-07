# `infra/bootstrap/`

Creates the S3 bucket + DynamoDB lock table + KMS key that every other Terraform
module in this repo uses as its remote state backend.

## Resources

- `agent-forge-tfstate-076124126225-eu-west-1` — versioned, KMS-encrypted, TLS-only S3 bucket
- `agent-forge-tflock` — DynamoDB lock table (on-demand billing, PITR enabled)
- `alias/agent-forge-tfstate` — customer-managed KMS key for state encryption

## How to run

This module runs in GitHub Actions only — never locally — via the `Bootstrap`
workflow (`.github/workflows/bootstrap.yml`). The workflow assumes the
`agent-forge-gha-bootstrap` IAM role through OIDC; no AWS credentials are
stored anywhere.

Trigger from a laptop:

```sh
gh workflow run bootstrap.yml -f mode=plan
gh workflow run bootstrap.yml -f mode=apply
```

`plan` is the default — always run it first.

## State flow

The workflow handles the chicken-and-egg problem itself:

1. **First apply** — the bucket does not yet exist. Workflow runs
   `terraform init -backend=false` (local state), `terraform apply`, then
   `terraform init -migrate-state` to copy the local state into the bucket
   the apply just created. State key: `bootstrap/terraform.tfstate`.
2. **Subsequent runs** — the workflow detects the bucket exists, initialises
   straight against the S3 backend, and proceeds normally. No local state
   ever ends up in this repo.

## What other modules use

```hcl
terraform {
  backend "s3" {
    bucket         = "agent-forge-tfstate-076124126225-eu-west-1"
    key            = "envs/dev/<module>.tfstate"
    region         = "eu-west-1"
    dynamodb_table = "agent-forge-tflock"
    encrypt        = true
  }
}
```
