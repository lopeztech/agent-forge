# Runbook

Operational steps a human performs that Terraform / agents cannot. Each
section is independent unless flagged otherwise.

---

## Onboarding the GitHub Apps

One-time setup per AWS environment (`dev`, `prod`). Creates both Apps, installs
them on a target repo, uploads credentials to Secrets Manager, and runs the
smoke test — all driven by `scripts/onboard-github-apps.ts`.

### Prerequisites

- AWS CLI authenticated against the target environment. For dev: `export AWS_PROFILE=agent-forge-dev`. Confirm: `aws sts get-caller-identity` returns the dev account.
- `infra/envs/dev` has been applied — the three Secrets Manager entries exist (placeholders). Confirm: `terraform -chdir=infra/envs/dev output github_app_secret_names`.
- A test target repo you control (the Apps install onto it during onboarding).

### Run it

```bash
AWS_PROFILE=agent-forge-dev npm run onboard:github-apps
```

Optional flags:
- `--owner <org>` — create the Apps under a GitHub org you admin instead of your personal account.
- `--prefix <name>` — defaults to `$AGENT_FORGE_NAME_PREFIX` or `agent-forge-dev`.

The script opens a browser and walks you through ~4 clicks total:

1. **Create writer App** → confirmation page → click *Create GitHub App*. Browser redirects back; credentials upload to Secrets Manager.
2. **Install writer** → pick the target repo → click *Install*. Installation ID captured; smoke test runs.
3. **Create merger App** — same flow.
4. **Install merger** — same flow.

Final screen prints both installation IDs (record them when you onboard a product into the `products` DynamoDB table) and the smoke-test rate-limit results. Expected: `core limit = 5000` for both (App-authenticated). On failure, the terminal log shows the underlying error.

### Webhook signing secret

The webhook-ingress slice (not yet built) needs both Apps' webhook configs to point at the API Gateway endpoint and use the random secret Terraform generated. To preview it:

```bash
aws secretsmanager get-secret-value \
  --secret-id agent-forge-dev-webhook-signing-secret \
  --query SecretString --output text
```

Don't paste it into the Apps yet — the webhook URL doesn't exist. You'll do this when the webhook ingress lands.

---

## Off-boarding the GitHub Apps

Reverse of the above:

1. Uninstall each App from the target repo (App settings → Advanced → Uninstall).
2. Optionally delete the App itself (App settings → Advanced → Delete GitHub App).
3. Optionally `terraform destroy` the secrets module — but note `recovery_window_in_days = 7`, so the secret names will be unavailable for re-use for 7 days unless you force-delete with `aws secretsmanager delete-secret --force-delete-without-recovery`.
