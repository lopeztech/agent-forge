# `infra/modules/secrets/`

Secrets Manager entries for the two GitHub Apps and the shared webhook signing
secret. Three resources, one module — kept together because they share lifecycle
(per-env), tagging, and naming.

| Secret name                              | Contents                                              | Populated by                               |
|------------------------------------------|-------------------------------------------------------|--------------------------------------------|
| `<prefix>-writer`                        | JSON `{ app_id, private_key }` for `agent-forge-writer` | Human via `aws secretsmanager put-secret-value` after creating the App on github.com |
| `<prefix>-merger`                        | JSON `{ app_id, private_key }` for `agent-forge-merger` | Same, for the merger App                   |
| `<prefix>-webhook-signing-secret`        | Random 64-char string (alphanumeric)                  | Terraform (`random_password`)              |

## Why the writer/merger secrets are seeded with a placeholder

The App private key (PEM) is downloaded once from github.com and must never
land in Terraform state. The module creates each secret with a placeholder
`secret_string`, then `lifecycle { ignore_changes = [secret_string, version_stages] }`
ensures that subsequent applies don't revert the value an operator has uploaded
via the AWS CLI.

This means **the secrets exist as resources but contain non-functional values
until an operator completes the runbook steps**. The smoke test
(`scripts/smoke-github-app.ts`) will fail loudly if it reads a placeholder.

## Why one shared webhook secret

Both Apps register the same webhook URL (the API Gateway endpoint, not yet
built). Each App's webhook config on github.com gets the same signing secret,
so the verifier Lambda checks one value regardless of which App fired the
event. If we ever need per-App signatures, splitting is a one-resource change.

## Inputs

- `name_prefix` (required) — e.g. `agent-forge-dev`
- `recovery_window_in_days` (default `7`) — grace period before AWS purges a
  deleted secret. `0` = immediate purge.

## Outputs

- `writer_secret_arn`, `writer_secret_name`
- `merger_secret_arn`, `merger_secret_name`
- `webhook_secret_arn`, `webhook_secret_name`

## Runtime access

Local dev: the `agent-forge-dev` SSO profile has `secretsmanager:GetSecretValue`.

Production runtime: Fargate task roles and the webhook verifier Lambda will be
granted least-privilege `GetSecretValue` on the specific ARNs above. Those IAM
policies live in the module that creates each task role.
