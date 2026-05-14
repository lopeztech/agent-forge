# Runbook

Operational steps a human performs that Terraform / agents cannot. Each
section is independent unless flagged otherwise.

---

## Onboarding the GitHub Apps

This is a one-time setup per AWS environment (`dev`, `prod`). Two GitHub Apps
plus their installations on each target repo plus their credentials in
Secrets Manager.

### Prerequisites

- AWS CLI authenticated against the target environment. For dev: `export AWS_PROFILE=agent-forge-dev`. Confirm: `aws sts get-caller-identity` returns the dev account.
- `infra/envs/dev` has been applied — the three Secrets Manager entries exist (placeholders). Confirm: `terraform -chdir=infra/envs/dev output github_app_secret_names`.
- A test target repo you control. The Apps will be installed there for the smoke test.
- You can manage Apps under your GitHub account or an org you admin.

### Step 1 — Create `agent-forge-writer`

This App is the identity for BA, Dev, Test Engineer, Functional Tester, and Security Reviewer. Branch protection treats its reviews as non-merging.

1. Go to GitHub → Settings → Developer settings → GitHub Apps → New GitHub App.
2. Fill in:
   - **Name:** `agent-forge-writer` (must be globally unique on github.com; if taken, suffix with your handle, e.g. `agent-forge-writer-<you>`).
   - **Homepage URL:** anything truthful, e.g. `https://github.com/<you>/agent-forge`.
   - **Webhook → Active:** **uncheck**. The API Gateway endpoint does not exist yet; enabling delivery now produces only failed delivery noise. Re-enable in the webhook-ingress slice.
   - **Webhook URL:** leave blank.
   - **Webhook secret:** leave blank for now (will be set in the webhook-ingress slice).
3. **Repository permissions:**
   - Contents: Read & write
   - Issues: Read & write
   - Pull requests: Read & write
   - Metadata: Read-only (auto-selected)
   - Actions: Read-only
4. **Organization permissions:** none.
5. **Account permissions:** none.
6. **Subscribe to events:** none yet (we'll add Issues / Issue comment / Pull request / Pull request review / Push when the webhook endpoint exists).
7. **Where can this GitHub App be installed?** "Only on this account".
8. Click **Create GitHub App**.
9. On the App's settings page:
   - Record the **App ID** (top of page).
   - Scroll to **Private keys** → **Generate a private key**. A `.pem` file downloads. Treat it like an SSH private key.

### Step 2 — Create `agent-forge-merger`

This App is the identity that merges PRs. Branch protection on `main` will require its review.

Repeat Step 1 with these differences:

- **Name:** `agent-forge-merger`.
- **Repository permissions:**
   - Contents: Read & write
   - Issues: Read & write
   - Pull requests: Read & write
   - Metadata: Read-only
   - (no Actions)
- **Webhook → Active:** **uncheck**. The merger is invoked by Step Functions, not by webhooks; it never needs to receive events.
- **Subscribe to events:** none.

Record its App ID and download its private key.

### Step 3 — Install both Apps on the test repo

For each App, from its settings page → **Install App** → choose the account → **Only select repositories** → pick your test target repo → **Install**.

After install, the browser URL is `https://github.com/settings/installations/<INSTALLATION_ID>`. **Record the `INSTALLATION_ID` for each App separately.** They are different numbers.

### Step 4 — Upload credentials to Secrets Manager

For each App, run (substituting `<APP_ID>`, the path to the downloaded `.pem`, and the secret name):

```bash
aws secretsmanager put-secret-value \
  --secret-id agent-forge-dev-writer \
  --secret-string "$(jq -n \
    --arg app_id "<WRITER_APP_ID>" \
    --rawfile private_key ~/Downloads/agent-forge-writer.<date>.private-key.pem \
    '{app_id: $app_id, private_key: $private_key}')"
```

Repeat for the merger:

```bash
aws secretsmanager put-secret-value \
  --secret-id agent-forge-dev-merger \
  --secret-string "$(jq -n \
    --arg app_id "<MERGER_APP_ID>" \
    --rawfile private_key ~/Downloads/agent-forge-merger.<date>.private-key.pem \
    '{app_id: $app_id, private_key: $private_key}')"
```

`jq --rawfile` reads the entire PEM into a string with newlines preserved, which is what `crypto.createPrivateKey()` in the auth helper needs.

After upload, you can shred the local `.pem` files — they are only recoverable from Secrets Manager from now on:

```bash
shred -u ~/Downloads/agent-forge-*.private-key.pem
```

### Step 5 — Smoke test

For each App, with `AWS_PROFILE=agent-forge-dev` set:

```bash
npm run smoke:github-app -- --app writer --install <WRITER_INSTALL_ID>
npm run smoke:github-app -- --app merger --install <MERGER_INSTALL_ID>
```

Expected output: a "token acquired" line followed by the `GET /rate_limit` JSON response (`resources.core.limit` is 5000 for an App installation, vs 60 for unauthenticated).

If you see `still contains the Terraform placeholder` — Step 4 didn't land. Re-run.

If you see `401 Unauthorized` from the token exchange — App ID or PEM mismatch. Recheck which PEM you uploaded into which secret.

If you see `404 Not Found` from the token exchange — the `INSTALLATION_ID` is wrong or the App isn't installed on the test repo.

### Step 6 — Note the webhook signing secret

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
