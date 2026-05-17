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

---

## Wiring webhooks to a target repo

One-time setup per target product. Two steps: register the product in the `products` table so the verifier can resolve incoming webhooks, then flip each App's webhook config to point at the agent-forge API Gateway endpoint.

### Step 1 — Seed the `products` row

The webhook verifier resolves `repository.full_name` → `product_id` via a GSI on the `products` table. Until a row exists, every webhook returns "no product for repo" and the event is dropped silently (200 OK so GitHub doesn't retry).

```bash
AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 npm run seed:product -- \
  --product-id lopeztech-agent-forge \
  --repo lopeztech/agent-forge \
  --writer-install <WRITER_INSTALL_ID> \
  --merger-install <MERGER_INSTALL_ID>
```

(Install IDs were printed by `npm run onboard:github-apps`. For an already-installed App, they're also visible on each App's settings page → *Advanced* tab.)

Defaults the script applies: `spec_path=spec/`, `areas_path=.agent-forge/areas.yml`, `functional_runtime_mode=ephemeral`, `cost_approval_threshold_usd=1`, `concurrency_cap=3`. Override any of them with the corresponding flag.

### Step 2 — Point both Apps' webhooks at the API Gateway endpoint

Get the endpoint URL and shared signing secret:

```bash
terraform -chdir=infra/envs/dev output -raw webhook_url
aws secretsmanager get-secret-value --secret-id agent-forge-dev-webhook-signing-secret \
  --query SecretString --output text
```

For **each** App (writer and merger):

1. GitHub → your App → *General* tab.
2. **Webhook → Active:** check.
3. **Webhook URL:** paste the `webhook_url` output.
4. **Webhook secret:** paste the signing secret.
5. **SSL verification:** leave as *Enable SSL verification* (API Gateway has a valid cert).
6. Save changes.
7. Scroll to *Subscribe to events*. For the **writer** App, check: *Issues*, *Issue comment*, *Pull request*, *Pull request review*, *Push*. For the **merger** App: just *Pull request review* (so it sees PO comments without firing on writer activity).
8. *Recent Deliveries* tab → click the most recent delivery (the `ping`) → *Redeliver* if it shows red. You should see `pong` come back.

### Step 3 — Verify end-to-end

Tail the catch-all log group while you label an issue on the target repo:

```bash
aws logs tail --follow --region eu-west-1 \
  "$(terraform -chdir=infra/envs/dev output -json event_log_groups | jq -r .catch_all)"
```

Apply a label (e.g. `state:idea`) to any issue. Within ~2s you should see a JSON event with `source: agent-forge.webhook`, `detail-type: issues`, and `detail.product_id: lopeztech-agent-forge`. That confirms HMAC → product resolution → bus delivery. If nothing shows up, drop down to the verifier Lambda's log group (`event_log_groups.verifier_lambda`) to see why the verifier rejected the call.

---

## Bootstrapping the BA agent on a target repo

Once webhooks deliver, you still need three pieces in place before a `state:idea` label actually causes the BA Fargate task to run: the label vocabulary, a BA image in ECR, and an issue in the target repo to label.

### Step 1 — Seed the label vocabulary

```bash
AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 npm run seed:labels -- \
  --repo lopeztech/agent-forge \
  --install <WRITER_INSTALL_ID>
```

Idempotent — re-runs only touch labels whose color/description drifted.

### Step 2 — Build and push the BA image

The first apply creates an empty ECR repo. Push an image to it before triggering the BA task, otherwise Fargate fails with `CannotPullContainerError`.

```bash
# Manually trigger the agent-images workflow against main:
gh workflow run agent-images.yml --ref main
# or push any commit touching agents/ba/** to fire it automatically.
```

Watch:
```bash
gh run watch $(gh run list --workflow=agent-images.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

Confirm:
```bash
AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 aws ecr list-images \
  --repository-name agent-forge-dev/ba --query 'imageIds[].imageTag' --output text
# should include "latest" and "sha-<git_sha>"
```

### Step 3 — Trigger an end-to-end run

Create a throwaway issue and apply `state:idea`:

```bash
gh issue create --repo lopeztech/agent-forge \
  --title "BA orchestration smoke test" \
  --body "Slice A end-to-end check."
gh issue edit <ISSUE_NUMBER> --repo lopeztech/agent-forge --add-label state:idea
```

Tail the BA task log group while you wait:

```bash
aws logs tail --follow --region eu-west-1 \
  "$(terraform -chdir=infra/envs/dev output -raw ba_task_log_group)"
```

Within ~30s of applying the label you should see:
- The Step Function execution start (visible in the AWS console at `output ba_state_machine_arn`).
- The BA container's structured-JSON logs flow into the task log group.
- A new comment on the issue from the writer App ("BA stub picked up this issue").
- The label transition from `state:idea` to `state:cost-estimating`.
- A row in `budget_ledger` for the run.

If the task fails to start, check the Step Function execution's event view — `CannotPullContainerError` means Step 2 hasn't completed. `AccessDeniedException` on Secrets Manager or DynamoDB means an IAM scoping bug.

---

## Off-boarding the GitHub Apps

Reverse of the above:

1. Uninstall each App from the target repo (App settings → Advanced → Uninstall).
2. Optionally delete the App itself (App settings → Advanced → Delete GitHub App).
3. Optionally `terraform destroy` the secrets module — but note `recovery_window_in_days = 7`, so the secret names will be unavailable for re-use for 7 days unless you force-delete with `aws secretsmanager delete-secret --force-delete-without-recovery`.
