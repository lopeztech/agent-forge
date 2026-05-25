# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mission

agent-forge is an AWS-hosted, serverless-first platform that runs autonomous, long-running software product teams composed entirely of Claude agents. Six role-specialized agents chain together to take a product from spec → backlog → implementation → tested + secured → shipped, with handoffs driven by GitHub issue state, not by a single long-running prompt.

Long-running means **months or years**, not a one-shot build. The team continuously hydrates the backlog from an evolving spec, detects drift in already-shipped work, accumulates per-team memory of conventions, and stays inside a hard budget envelope.

The pain point this solves: Claude Routines and standalone agent runs do not chain hand-offs reliably across roles. agent-forge is the orchestration layer that makes that chaining deterministic, observable, and budgeted.

**Multi-project platform.** agent-forge is designed from day one to operate N target product repos in parallel, each with its own spec, backlog, budget, and accumulated team memory. There is no "single-product" mode.

**Serverless-first.** Every component is serverless (no servers to manage, pay per use). Fargate counts as serverless in the AWS taxonomy and is used in preference to Lambda only where the 15-min execution cap forces it. EC2 / ECS-on-EC2 is explicitly out of scope.

## Current state

This repository is no longer empty. Treat this document as the architecture
reference and read it alongside `spec/README.md`, `spec/roles.md`,
`README.md`, `CONTRIBUTING.md`, and `docs/runbook.md` before making changes.

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

## Topology

agent-forge is a **single GitHub repo** holding the platform: agent code, system prompts, Terraform, CI workflows, the platform's own spec, runbooks. Humans on the platform team commit only here.

Target products are **N separate GitHub repos**, each owned independently of agent-forge. They contain product code plus a `.agent-forge/areas.yml` and a `spec/` directory at their root. They never contain platform code.

The connection between agent-forge and a target product is **GitHub App installations** on the target repo. The agent-forge AWS deployment holds the App private keys in Secrets Manager and mints short-lived (1h) installation access tokens per API call. PATs and deploy keys are not used.

```
┌──────────────────────────┐        ┌────────────────────────────┐
│ agent-forge GitHub repo  │        │ AWS account (agent-forge)  │
│  (platform code, infra,  │ ──CI──▶│  ECS Fargate, Step Funcs,  │
│   prompts, spec)         │        │  DynamoDB, Secrets Mgr,    │
└──────────────────────────┘        │  EventBridge, ...          │
                                    └─────┬──────────────────┬────┘
                                          │ webhooks (Apps)  │
                                          │                  │
                          ┌───────────────▼──┐  ...  ┌──────▼────────┐
                          │ Product A repo   │       │ Product N repo│
                          │  spec/, areas.yml│       │   ...         │
                          └──────────────────┘       └───────────────┘
```

Why GitHub Apps for the connection:
- Webhook URL is registered once on the App and fires for every repo that installs it — no per-product webhook config.
- Per-repo permissions are enforced by GitHub server-side; leaked tokens are scoped to one repo.
- No GitHub seats consumed (PAT-based machine users would).
- Tokens are short-lived; blast radius is bounded by default.

## Cloud architecture (AWS)

Components, in the order an event flows through them:

- **GitHub** — source of truth for spec, backlog (Issues + Projects), code (PRs). Webhooks fire on issue label changes, PR events, comments.
- **API Gateway** — public HTTPS endpoint receiving GitHub webhooks. Verifies HMAC signature, resolves the source repo to a `product_id` via the `products` table, forwards to EventBridge with `product_id` attached.
- **EventBridge** — event bus. Rules match on `(product_id, label transition)` or `(product_id, PR event)` and invoke the right Step Function with both IDs as input.
- **Step Functions** — one state machine per issue lifecycle, plus per-role sub-workflows. Inputs always include `(product_id, issue_id)`. Tracks "where is issue #42 on product X" centrally.
- **ECS Fargate (Spot by default, on-demand on retry)** — agent containers. One image per role. Spawned per task by Step Functions; not long-lived. Lambda is rejected for all six roles because Dev/Test/Functional runs routinely exceed 15 min, and using two runtimes for the shorter roles doubles operational surface area for trivial savings. Spot is the default because all state is checkpointed at label transitions and Step Functions handles retry; on-demand is the fallback after first reclamation.
- **DynamoDB** — six tables, all keyed by `product_id` first (except `rate_limits`, which is shared org-wide):
  - `products` — per-product config: target repo URL, `writer_install_id`, `merger_install_id`, spec path, areas-file path, budget caps, model overrides, Functional Tester runtime mode (`ephemeral` or `warm`), drift audit config (cadence, sample size, sampling strategy, horizon), kickback cap, concurrency cap, `cost_approval_threshold_usd` (issues estimated above this require human `/approve-cost` before running; default $1).
  - `team_memory` — `(product_id, role_key)` per-role long-term memory. SK is `"<role>#<key>"` so a Query returns either all memory for a product, or one role via `begins_with("dev#")`. `product_id="*"` is the org-global namespace; agents read `global UNION product` with product winning on conflict.
  - `issue_state` — `(product_id, issue_id)` — per-issue scratchpad, iteration counters, forensic pointers, cost estimate (`p50`, `p90`, `model`, `run_id`, posted-comment ID), and the actual-vs-estimate ratio once the issue is `state:done`.
  - `budget_ledger` — `(product_id, ts_run_id)` append-only spend log; SK is `"<iso_ts>#<run_id>"` so daily/weekly rollups Query a SK BETWEEN range.
  - `rate_limits` — `(bucket_id)` token-bucket state for Bedrock per-model invocation quotas (per region per model, AWS-side), shared across all products. TTL on `expires_at`.
  - `area_locks` — `(product_id, area_id)` Dev-role area locks for parallelism. TTL on `expires_at` so stuck locks self-release.
- **S3** — artifacts: full PR diffs, test reports, security scan output, large agent transcripts. Prefixed by `product_id/issue_id/`.
- **Secrets Manager** — two GitHub App private keys (`agent-forge-writer`, `agent-forge-merger`) plus third-party scanner tokens (semgrep, etc. as needed). No Anthropic API key — model access goes through Bedrock with IAM auth from the Fargate task role. Each GitHub App has one installation per target repo.
- **CloudWatch Logs + X-Ray** — per-task logs tagged with `product_id`, end-to-end tracing across role handoffs.
- **EventBridge Scheduler** — cron triggers for long-running jobs: nightly backlog hydration, weekly drift audit, daily budget rollup. Schedules iterate over the `products` table.

Model access goes **through Amazon Bedrock `InvokeModel`** in eu-west-1. Auth is IAM-only (Fargate task role and Cost Estimator Lambda role both grant `bedrock:InvokeModel` on the specific model ARNs they need); no API keys to rotate, leak, or store in Secrets Manager. The `shared/models.ts` abstraction keeps the call shape provider-agnostic so a direct Anthropic API path can be wired in later as outage fallback if Bedrock proves unreliable, but v1 ships Bedrock-only.

Networking: agents and Lambdas have no inbound traffic. Default deployment runs them in **public subnets with no NAT Gateway and no VPC interface endpoints** (Lambda no-VPC; Fargate `assignPublicIp=ENABLED` with empty-inbound security groups). AWS-service calls (Bedrock, DynamoDB, Secrets Manager, STS, Logs, ECR) leave via the IGW but stay on the AWS backbone — zero data-transfer cost intra-region. GitHub egress is the only true internet traffic. Private subnets + interface endpoints are opt-in per product, only when the Functional Tester `warm` mode needs to reach private resources (e.g. an RDS instance). Security posture is equivalent for stateless workers with no listening services.

## Roles

Six teams. Each is a separate container image, system prompt, tool allow-list, IAM role, and GitHub App permissions scope. The model column is the **default**; any role can escalate one tier (e.g. Sonnet → Opus) on retry after a failure.

### 1. Business Analyst (BA)

- **Trigger:** new issue with label `state:idea`, OR scheduled nightly "hydrate" run that scans the spec for un-issued work.
- **Job:** read `spec/`, expand the request into acceptance criteria, split into sub-issues if it spans more than ~1 day of work, attach risks and out-of-scope notes, transition to `state:cost-estimating`.
- **Tools:** GitHub Issues read/write, repo file reads, web search.
- **Default model:** **Sonnet 4.6** — strong reasoning over docs, but no code generation; Opus is wasteful for routine refinement.
- **Escalation:** Opus 4.7 for the initial spec-to-backlog hydration of a brand-new spec area (high stakes, infrequent).

### Cost Estimator (gate, between BA and Dev)

Not a Fargate role — a small Lambda that gates every issue's actual implementation cost.

- **Trigger:** issue at `state:cost-estimating`.
- **Job:** read the issue title, body, BA-extracted acceptance criteria, and the cost of similar past issues from `budget_ledger`. Call Haiku 4.5 once to produce a per-role token + USD estimate with `p50`/`p90` confidence range, write it to `issue_state`, and post a structured comment on the issue. If `p50_total ≤ products.cost_approval_threshold_usd`, transition to `state:ready` (auto-approved, pipeline continues). Otherwise transition to `state:awaiting-cost-approval` and park.
- **Approval mechanism:** maintainer comments `/approve-cost` → transition to `state:ready`. Maintainer comments `/cancel` → transition to `state:cancelled` (terminal). Both handled by a glue Lambda on `issue_comment.created`.
- **Tools:** Bedrock `InvokeModel` (Haiku 4.5), GitHub Issues read/write, DynamoDB read on `budget_ledger`, DynamoDB write on `issue_state`.
- **Default model:** **Haiku 4.5** — cheap classifier, target ~$0.005/issue.
- **Calibration:** when the issue reaches `state:done`, record `(estimate_p50, actual, ratio)` in `issue_state`. A weekly digest surfaces drift (mean ratio, outliers) so the rate-card prompt can be tuned. The estimator's own spend is logged to `budget_ledger` like any other model call.
- **Failure modes:** estimator timeout / Bedrock 5xx → label `human-needed` (don't silently bypass the gate); estimate above the per-issue $12 hard cap → reject without prompting (`/approve-cost` cannot override the budget circuit breaker).

### 2. Developer

- **Trigger:** issue at `state:ready`, no other dev currently working that area.
- **Job:** claim the issue, branch from `main`, implement against acceptance criteria, push commits, open a PR linking the issue, transition issue to `state:awaiting-tests`.
- **Tools:** full git/file edits inside an isolated working copy, run unit tests locally, GitHub PR create.
- **Default model:** **Sonnet 4.6** — best price/perf for code generation across multi-file context.
- **Escalation:** **Opus 4.7** on the final attempt of the per-product kickback cap (default cap=3 → attempt #3), or for issues labelled `complexity:high` (cross-cutting refactors, perf-sensitive code, novel architecture).
- **Guards:** per-issue spend cap, per-issue iteration cap. On hit, label `human-needed` and stop.

### 3. Test Engineer (automated)

- **Trigger:** PR opened with linked issue at `state:awaiting-tests`.
- **Job:** add unit + integration tests covering each acceptance criterion. Push test commits to the PR branch, transition to `state:awaiting-functional`.
- **Tools:** file edits, test runners, coverage tools.
- **Default model:** **Sonnet 4.6** — same code-gen profile as Dev, slightly less context-heavy.
- **Escalation:** Opus 4.7 if coverage gates fail twice.

### 4. Functional Tester

- **Trigger:** `state:awaiting-functional`.
- **Job:** spin the app per the target repo's run instructions, execute end-to-end flows that map to the acceptance criteria, post a structured report as a PR comment. Pass → `state:awaiting-security`. Fail → kick back to `state:in-dev` with the failure report.
- **Tools:** shell, Playwright (or framework-equivalent), GitHub PR comments.
- **Default model:** **Sonnet 4.6** — handles tool-call loops well; Haiku struggles when the failure report needs reasoning over multiple flows.
- **Escalation:** none routinely; functional failures kick back to Dev rather than re-running this agent at a higher tier.
- **Runtime mode (per-product config):** this is the only role where pure serverless can pinch.
  - `ephemeral` (default) — Fargate task spins up per run, runs the target app and any deps it needs (calling out to Aurora Serverless v2, ElastiCache Serverless, etc.). Best for CLIs, libraries, serverless APIs.
  - `warm` — long-lived ECS service holds the target app's heavy dependencies (Postgres, Redis, queues) hot, and the per-run Fargate task connects to it. Opt in per product when ephemeral spin-up cost exceeds ~30s or run cadence is high. Still serverless in the no-server-mgmt sense, but continuously billed.

### 5. Security Reviewer

- **Trigger:** `state:awaiting-security`.
- **Job:** run SAST (semgrep), secret scanning (gitleaks), dependency audit (npm audit / equivalent), and an LLM-driven review of the diff against OWASP Top 10. Post findings. Blocking findings → back to dev. Clean → `state:awaiting-po`.
- **Tools:** shell + scanners, GitHub PR comments.
- **Default model:** **Sonnet 4.6** for routine diffs.
- **Escalation:** **Opus 4.7** for diffs touching auth, crypto, payments, PII handling, or anything tagged `security-sensitive`. Subtle vulnerabilities reward stronger reasoning.

### 6. Product Owner (PO)

- **Trigger:** `state:awaiting-po`, OR scheduled weekly "drift audit" that re-verifies a sample of recently-shipped issues against the current spec.
- **Job:** compare the PR + tests + functional report against the original spec section the issue cites. Three outcomes: merge (`state:done`), kick back with concrete deltas, or `human-needed` if the spec itself is ambiguous.
- **Tools:** GitHub merge, file reads, comments.
- **Default model:** **Opus 4.7** — this is the gate. The cost of a wrong merge is much higher than the cost of running Opus on a few PRs per day. PO runs are infrequent and short.

## Handoff protocol

The chain is **issue label → EventBridge rule → Step Function → role container**. There is exactly one source of truth: the GitHub Issue's `state:*` label.

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

Cross-agent communication goes **only** through the issue and PR. No direct agent-to-agent calls. This keeps the audit trail in GitHub and prevents hidden state.

## Onboarding a new target product

```
1. Human creates the target repo (or picks an existing one).
2. Human installs the agent-forge GitHub App(s) on it via GitHub UI.
3. Human runs `agent-forge onboard <product-id> <repo-url>` (CLI in this repo). The CLI:
   - Records the product in the `products` DynamoDB table:
       (product_id, repo_url, writer_install_id, merger_install_id,
        spec_path, areas_path, budget_caps, model_overrides,
        functional_runtime_mode)
   - Sets branch protection on `main`: PR required, status checks required,
     review required from the merger App.
   - Opens a PR adding `.agent-forge/areas.yml` (template) and `spec/` skeleton.
     Human reviews and merges before the platform starts work.
   - Creates a kickoff issue at `state:idea` once the spec PR is merged.
4. Events from the target repo now flow through agent-forge automatically.
```

Off-boarding is the inverse: uninstall the App(s), `agent-forge offboard <product-id>` removes the `products` row and tombstones budget/memory rows for retention.

## Concurrency model

Multiple Devs per product may run in parallel, locked at the **top-level area** granularity. Other roles run unlocked on their respective PR branches.

**Area declaration.** Each target product publishes `.agent-forge/areas.yml` at its repo root (path overridable in `products` config):

```yaml
areas:
  frontend:
    paths: [src/web/**, src/components/**]
  api:
    paths: [src/server/**, src/handlers/**]
  infra:
    paths: [infra/**]
  shared:
    paths: [src/shared/**, src/types/**]
```

**Issue → area assignment.** BA applies `area:<name>` labels when hydrating. If the spec section maps to paths not covered by any declared area, BA applies `area:*` and flags the gap to a human (`human-needed`-adjacent: a `gap:areas-incomplete` label).

**Lock primitive.** DynamoDB conditional write on the `area_locks` table (PK `product_id`, SK `area_id`) with `expires_at` TTL = 2× per-issue spend cap (~2h default). Multi-area issues acquire all required locks **in alphabetical order** (deadlock-free by canonical resource ordering). `area:*` acquires every area in alphabetical order — equivalent to single-Dev for that issue.

**Per-product concurrency cap:** default 3 simultaneous Devs, configurable in `products`. Bounds Bedrock per-model invocation-quota pressure and daily budget.

**Lock contention.** When Dev's workflow starts and cannot acquire its lock(s), it exits without changing the issue state — issue stays at `state:ready`. On lock release, the holding Dev emits an `area-lock-released` EventBridge event; a sweeper Lambda finds the oldest matching `state:ready` issue and re-fires Dev for it. `state:ready` is the queue; no extra states.

**Other roles do not lock.** Test Engineer, Functional Tester, Security Reviewer, and PO operate on already-existing PR branches that are isolated from each other and from `main`. Lock collisions can only occur at branch-from-main, which is Dev-only.

**Rebase responsibility.** When `main` advances while a PR is in flight, an EventBridge rule on the GitHub `push` event for the default branch re-fires Dev in "rebase-only" mode (no new implementation) for each open PR on that product. Keeps PRs current without spawning extra agents.

**Convention this requires:**
- Trunk-based development; no long-lived feature branches.
- Feature flags for partial rollouts.
- BA breaks down issues so each is < 1 day of Dev work. Long-running PRs make rebase pain compound.

## Failure handling

Three independent counters / caps. Only one ("kickback cap") is the "park the issue" gate.

| Counter | Scope | Default | Purpose |
|---------|-------|--------:|---------|
| Tool-loop cap | per agent run | 50 turns | Bounds runaway tool-call loops inside one role's execution. SDK-level. |
| Kickback cap | per issue | 3 | How many Dev attempts before parking with `human-needed`. Per-product configurable. |
| Wall-clock cap | per issue | 24h | Backstop for stuck workflows that aren't burning budget. |

**Kickback flow.** Each kickback to Dev (from Test, Functional, or Security) increments `issue_state.kickback_count` and updates the issue's `iter:N` label. At cap, the issue parks at `human-needed` regardless of whether it would have continued.

**Escalation policy.** Dev runs Sonnet on attempts 1 to (cap-1), Opus on the final attempt. Last-swing-with-the-better-model maximizes the chance of shipping before parking. Test, Functional, Security stay on Sonnet across kickbacks; Security only escalates for `security-sensitive` diffs (independent of retry count).

**Category-3 (immediate-park) failures.** Don't increment the kickback counter; park immediately with `human-needed`:
- PO can't decide ship/no-ship because the spec is ambiguous.
- BA flags `gap:areas-incomplete` (issue touches paths not in `areas.yml`).
- Security finds a class of issue agents shouldn't auto-fix (e.g. a vulnerable dependency requiring a version-bump decision with breaking-change risk).

**Transient errors** (rate limit, 5xx, network blips) don't increment any counter. Step Functions retry config handles these with exponential backoff inside the same attempt.

**Cost envelope.** With cap=3 at moderate kickback rates (p≈0.3), expected cost per issue is ~$3.60 vs ~$2.65 happy-path baseline. Worst case per issue is ~$9.80 (ships on attempt #3 with Opus) or ~$8.80 (parks). The $12 per-issue budget cap is sized to accommodate this worst case plus buffer; the iteration cap is the primary "park stuck work" gate, with budget as backstop for runaway token spend within a single attempt.

## Long-running concerns

Things that matter when the team operates for months, not days.

- **Backlog hydration.** Nightly EventBridge schedule fires the BA in "scan mode" — read the spec, diff against existing open issues, file new issues for uncovered work.
- **Drift audit.** Weekly schedule fires the PO to sample N recently-merged issues and re-verify them against the **current** spec. If the spec has evolved past what was shipped, the PO files a `state:idea` issue describing the gap.
- **Memory accumulation.** Each role writes durable lessons to `team_memory` in DynamoDB (e.g. "Dev: this codebase uses Result<T, E> for fallible operations, not exceptions"). Lessons are pulled into the system prompt on next run via prompt caching to stay cheap.
- **Tech debt loop.** Dev agent emits `tech-debt:*` issues for TODOs left behind. BA picks them up the next night.
- **Failure forensics.** When `human-needed` is set, the agent dumps a structured forensic report (last N tool calls, last LLM message, why it stopped) to S3 and links it from the issue.
- **Spec evolution.** Spec changes always come from a human PR. On merge, a webhook flags any `state:done` issue whose cited spec section changed; the drift audit picks them up.
- **Onboarding new agents / new repos.** A new target product gets a `bootstrap` Step Function: BA runs over the whole spec to seed the backlog, no Dev runs until backlog is filled.

## Cost model

**Pricing assumptions (Bedrock `InvokeModel` in eu-west-1, as of early 2026 — verify on the AWS Bedrock pricing page before relying on these):**

| Model | $ / M input tokens | $ / M output tokens |
|-------|-------------------:|--------------------:|
| Opus 4.7 | ~$15 | ~$75 |
| Sonnet 4.6 | ~$3 | ~$15 |
| Haiku 4.5 | ~$1 | ~$5 |

Prompt caching reduces input cost by ~90% on cache hits. The system prompt + repo conventions + spec excerpts are stable across runs and **must** be cached — this is the single biggest cost lever. Realistic effective input cost with caching is 25–40% of list price.

**Per-role estimate, per happy-path issue (no kickbacks), with prompt caching:**

| Role | Model | Tokens in | Tokens out | Effective $ / issue |
|------|-------|-----------|------------|---------------------|
| BA | Sonnet 4.6 | ~12K | ~2K | ~$0.05 |
| Developer | Sonnet 4.6 | ~250K | ~50K | ~$1.00 |
| Test Engineer | Sonnet 4.6 | ~80K | ~20K | ~$0.40 |
| Functional Tester | Sonnet 4.6 | ~40K | ~10K | ~$0.20 |
| Security Reviewer | Sonnet 4.6 | ~60K | ~10K | ~$0.25 |
| PO | Opus 4.7 | ~30K | ~5K | ~$0.75 |
| **Total / issue** | | | | **~$2.65** |

**With kickbacks at moderate failure rate (p≈0.3, kickback cap=3):** expected **~$3.60 / issue** (see Failure handling section for the full distribution).

**Daily and monthly volumes (using $3.60/issue realistic average):**

| Throughput | $ / day | $ / month |
|------------|--------:|----------:|
| 3 issues / day | ~$11 | ~$325 |
| 5 issues / day | ~$18 | ~$540 |
| 10 issues / day | ~$36 | ~$1,080 |

**AWS infrastructure (independent of model cost), monthly estimate at 5 issues/day:**

| Component | Estimate |
|-----------|---------:|
| ECS Fargate (Spot by default; ~95 min total task-time per issue across 6 roles incl. ~30% kickback rate) | $5–15 |
| Lambda (Cost Estimator + comment handler + webhook verifier; mostly idle) | <$1 |
| Step Functions (~1,800 transitions/mo, free tier covers 4K/region) | $0 |
| DynamoDB on-demand (light use) | $5–20 |
| S3 (state, artifacts) | $1–5 |
| EventBridge + API Gateway | <$5 |
| Secrets Manager (2 GitHub App private keys) | $1 |
| ECR (~5 GB across 6 role images) | ~$1 |
| CloudWatch Logs (30-day retention) | $10–30 |
| KMS (state-encryption key) | $1 |
| **Total infra** | **~$25–80** |

Idle baseline (no issues running): only the fixed line items charge — KMS, Secrets Manager, ECR storage, plus negligible S3/DDB. **~$3/mo idle.**

**All-in monthly:**

| Throughput | Variable (model + per-issue infra) | Fixed | Total |
|------------|-----------------------------------:|------:|------:|
| Idle (0 issues)        | $0   | $3 | **~$3** |
| 1 issue/day            | ~$80 | $3 | **~$83** |
| 5 issues/day           | ~$400 | $25–80 | **~$425–480** |
| 10 issues/day          | ~$800 | $40–100 | **~$840–900** |
| 25 issues/day          | ~$2,000 | $80–180 | **~$2,080–2,180** |

The cost-first gate brings expected spend further down whenever many issues estimate sub-`cost_approval_threshold_usd` and auto-proceed — only the cumulative cost of approved issues actually runs.

**Budget circuit breaker** is mandatory. Caps live in `products` (per-product) and as global env defaults; `budget_ledger` is the source of truth for spend:

- Per-issue cap: $12 default. Sized to cover the worst-case path through the kickback cap (3 attempts, last on Opus) plus buffer. On hit, label `human-needed` and stop.
- Per-role per-day cap: $30 default.
- Per-product per-day cap: $75 default.
- Global per-day cap (across all products): $250 default.
- Trip behavior: write a `budget:tripped` flag scoped to the tripped scope (product or global). Role triggers check the relevant scope and short-circuit until a human clears it. One product tripping never pauses another.

**Bedrock quota management** is also mandatory. The `rate_limits` table holds token-bucket state for Bedrock per-model invocation quotas (account- and region-scoped); every role acquires tokens before calling `InvokeModel`. Without this, a busy product can starve others when they all hit the same Bedrock account-level quota for a given model.

**Spot reclamation handling.** All Fargate tasks run on Spot by default. Step Functions catches the `Task.Failed` event from a spot reclamation and retries on on-demand. Agents must checkpoint state to `issue_state` after every meaningful step (file write, label transition, tool call cluster) so a reclaimed task resumes without losing work.

## Repository layout (planned)

```
infra/                    # Terraform (HCL)
  bootstrap/              # one-time — creates the S3 state bucket + DynamoDB lock table
  modules/
    networking/           # OPTIONAL: per-product private VPC + endpoints (Functional Tester warm mode only)
    eventbridge/          # event bus, webhook rules, scheduled rules
    step-functions/       # state machines + asl/ subdir of ASL JSON
    ecs-role/             # parameterized; instantiated 6× (one per agent role)
    dynamodb/             # products, team_memory, issue_state, budget_ledger, rate_limits, area_locks
    secrets/              # Secrets Manager entries
    api-gateway/          # webhook ingress
  envs/
    dev/                  # backend.tf, main.tf, terraform.tfvars
    prod/
  glue/                   # source for small Lambdas (webhook verifier, budget checker)
agents/
  ba/                     # Dockerfile + Agent SDK entrypoint + system prompt
  dev/
  test/
  functional/             # heavier image (Playwright + browsers)
  security/               # scanners pre-installed
  po/
shared/
  github/                 # GitHub App auth, label transitions, PR helpers
  state/                  # DynamoDB + S3 helpers
  budget/                 # spend tracking + circuit breaker + Bedrock quota tracker
  prompts/                # shared prompt fragments + cache-key conventions
  models.ts               # single source of truth for per-role model selection
spec/                     # specs for agent-forge itself (BA reads from here)
docs/
  runbook.md              # how to clear human-needed, rotate keys, etc.
.github/workflows/
  terraform-plan.yml      # PR-time plan, posts diff as comment
  terraform-apply.yml     # merge-to-main; auto for dev, manual approval for prod
  agent-images.yml        # builds + pushes ECR images for each role
```

## Infrastructure conventions (Terraform)

- **State backend:** S3 + DynamoDB lock, self-hosted in the same AWS account. Bootstrapped by `infra/bootstrap/` — state migrates into the bucket it creates on first apply (workflow uses `terraform init -backend=false` then `init -migrate-state`); subsequent runs use the S3 backend like every other module. No `.tfstate` ever lands in git.
- **Environment isolation:** directory-per-env (`envs/dev/`, `envs/prod/`), not Terraform workspaces. Shared logic lives in `modules/`.
- **Version pinning:** `.terraform-version` + `required_providers` pinning `hashicorp/aws` to a major version. CI fails if local TF version differs.
- **Step Function definitions:** authored as ASL JSON in `infra/modules/step-functions/asl/`, loaded via `templatefile()`. Variables interpolated from TF locals.
- **Glue Lambdas:** built from `infra/glue/<name>/` via `archive_file` + a per-function `package.sh`. Used for webhook signature verification, budget circuit-breaker checks, and label-event routing — never for agents themselves.
- **Agent container images:** built and pushed by a GitHub Actions workflow (not Terraform). TF references images by tag pulled from a TF variable, kept in sync by the CI pipeline.
- **PR-time plan is mandatory.** Every infra PR posts `terraform plan` output as a comment. Catching "this innocuous change destroys the DynamoDB table" before merge is the entire point.

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
- Per-issue, per-role, per-product, and global daily spend caps are enforced by the budget circuit breaker.
- Production deploys (if the target repo deploys) require an explicit human approval step. Agents do not push to production.
- For the first 30 days of a new target repo, the PO step is a Slack approval gate before merge, not autonomous merge. Lift the gate after observed merge accuracy is acceptable.

## Resolved decisions

- **Scope:** multi-project platform from day one. Per-product config in `products` table; all data keyed by `product_id`. (2026-04-30)
- **Compute model:** serverless-first. Fargate (Spot by default, on-demand on retry) for all agent roles. Small glue Lambdas only. (2026-04-30)
- **Functional Tester runtime:** per-product config — `ephemeral` (default) or `warm` ECS service for products with heavy stateful target-app deps. (2026-04-30)
- **IaC:** Terraform with S3 + DynamoDB state backend, directory-per-env, ASL JSON for Step Functions, GitHub Actions for plan/apply. (2026-04-30)
- **Concurrency:** N Devs per product, locked at top-level area. Areas declared in target repo's `.agent-forge/areas.yml`. Multi-area issues acquire locks alphabetically. Default cap: 3 simultaneous Devs per product. Other roles run unlocked. (2026-05-01)
- **Identity:** Two GitHub Apps — `agent-forge-writer` (BA/Dev/Test/Functional/Security: read, branch, push, comment, request review) and `agent-forge-merger` (PO only: merge). Branch protection on `main` requires review from the merger App. Per-role audit on commits via `author.email`. (2026-05-01)
- **Failure thresholds:** Per-role tool-loop cap = 50 turns (SDK default). Cross-role kickback cap = 3 (configurable per product). Wall-clock cap = 24h per issue. Spec-ambiguity / category-3 failures park immediately. Dev escalates Sonnet → Opus on the final attempt of the cap. Worst-case spend per issue ~$10. Per-issue budget cap raised to $12 to accommodate. (2026-05-01)
- **Drift audit:** Weekly cadence, sample N=5 per product, targeted-first sampling (prioritize issues whose cited spec section has changed since merge), 90-day horizon. All per-product configurable. ~$16/month per product. (2026-05-01)
- **Model strategy:** Claude-only in v1 (Sonnet 4.6 default, Opus 4.7 for PO + escalation, Haiku reserved). No multi-provider for cost — failure-rate risk and loss of prompt caching erase token savings. Architect `shared/models.ts` and tool definitions to be provider-agnostic in shape so future swapping is config not refactor. Anthropic-outage fallback only: 5min sustained 5xx → existing runs fall back to Claude-on-Bedrock for in-flight, new issue work pauses. Re-evaluate at 6 months with telemetry. (2026-05-01)
- **Memory eviction:** Score-based at write time. Cap = 100 lessons per `(product, role)`. Score = `recency_decay × usage_count × confidence` (recency half-life 90d). Lowest-scored evicted on write when cap hit. Pinned lessons never evict. Monthly Sonnet "janitor" agent reports contradictions + zero-usage lessons for human review (flags only, no auto-delete). (2026-05-01)
- **Cross-product memory:** Two-tier with human-gated promotion. `team_memory` supports `(product_id="*", role, key)` org-global rows. Agents read `global UNION product` (product wins on conflict). Agents always write to their own product; promotion to global is via human CLI only (`agent-forge memory promote <role> <key>`). Janitor flags global-tier contradictions for human review. (2026-05-01)
- **Model provider:** Bedrock-only in v1 (supersedes the 2026-05-01 "direct Anthropic API in normal path, Bedrock as fallback" decision). Reasons: IAM-only auth removes the `ANTHROPIC_API_KEY` secret entirely; calls stay on AWS's backbone intra-region with zero data-transfer fees and no third-party egress; single trust surface for both Fargate roles and the Cost Estimator Lambda. Tradeoff accepted: 1–2 weeks of lag on the absolute newest Claude release vs the direct API. The `shared/models.ts` abstraction keeps the door open to add the direct API as outage fallback if Bedrock proves unreliable. Re-evaluate at 6 months. (2026-05-11)
- **Cost-first gate:** Every issue passes through a Cost Estimator Lambda between BA and Dev. Estimator uses Haiku 4.5 (~$0.005/issue) on the BA-structured acceptance criteria + similar past issues from `budget_ledger`, posts a `p50`/`p90` per-role breakdown as an issue comment, and either auto-promotes to `state:ready` (if `p50_total ≤ products.cost_approval_threshold_usd`, default $1) or parks at `state:awaiting-cost-approval` until a maintainer comments `/approve-cost` or `/cancel`. Estimator runs *after* BA so the estimate sees acceptance criteria, not free-form issue text. Estimate-vs-actual logged in `issue_state` for weekly calibration. (2026-05-11)
- **Networking baseline:** Public subnets, no NAT Gateway, no VPC interface endpoints for the default deployment. Stateless workers (agent Fargate tasks, Cost Estimator Lambda, comment handler, webhook verifier) run in the default VPC's public subnets (Fargate `assignPublicIp=ENABLED`, security groups deny all inbound) or with no VPC config (Lambda). AWS-service calls leave via the IGW and stay on the AWS backbone intra-region — zero data-transfer cost, no PrivateLink premium. Saves ~$60–130/mo over the original "private VPC + 6 interface endpoints in 2 AZs" plan. Private subnets + interface endpoints become opt-in per product, only when Functional Tester `warm` mode needs to reach private resources (e.g. an RDS instance). Security posture is equivalent for workers with no listening services. (2026-05-11)
- **Bedrock rate-limit scope:** `rate_limits` table keys buckets by `(model_id, region)` only — org-wide, no per-product bucket. Matches what Bedrock actually limits at the account level. Per-product fairness (a busy product can't drain the org bucket and starve others) is a future enhancement; for v1, the per-day budget caps (per-product, per-role, global) already provide that fairness at a coarser grain. (2026-05-25)
- **Cost Estimator forensic dump:** Only on the two unexpected failure modes — estimator timeout and Bedrock 5xx → `human-needed`. The deterministic `$12 hard-cap reject` path is fully described by the comment alone; no dump there. Matches the Fargate-role policy of "dump on unexpected park, skip on deliberate gating". (2026-05-25)
- **Sweeper Lambda lookup:** New `lock_waiters` side-table keyed by `(product_id, area_id)`. On lock contention, Dev writes a row; on lock release, the sweeper queries by area_id and re-fires the oldest waiter at `state:ready`. O(1) lookup, no full-table scans, clean cleanup-on-acquire via conditional delete. Supersedes today's "park at `human-needed` on contention" behaviour (sweeper not yet implemented as of this commit). (2026-05-25)
- **Production approval gate:** Per-product `approval_gate_until` ISO timestamp in the `products` row. Onboarding writes `now + 30d`; PO reads it and gates auto-merge behaviour on `now < approval_gate_until`. Per-product override possible (set to 0 to disable, set far-future to extend). Beats both "manual flag flip after watching for 30 days" (no timer) and "computed from `products.created_at` + 30d" (no override). (2026-05-25)
- **Team memory: confidence source.** `record_lesson` tool carries a required `confidence` enum (`low` | `medium` | `high`). The agent self-reports based on evidence strength. Score formula uses `confidence ∈ {0.5, 0.75, 1.0}` respectively, multiplied into the existing `recency_decay × usage_count` factors. Cheap to implement; quality of scoring depends on agent calibration, which the monthly janitor agent surfaces for human review. (2026-05-25)
- **Team memory: usage_count trigger.** `usage_count` increments on every read by every role run that loads memory — no agent-side "cite_lesson" tool. Simplest implementation, lowest agent overhead. Inflates count for memories that get loaded but never actually drive decisions, but recency-decay still degrades them and the score formula compensates. The alternative ("agent must call cite_lesson") was rejected as fragile to agent compliance. (2026-05-25)
- **Drift detection:** PO writes `spec_hashes_at_merge` (map of cited-section path → SHA-256) onto `issue_state` when transitioning the issue to `state:done`. The weekly drift-audit run compares those hashes against current spec section contents and flags any mismatch. O(1) per-issue lookup, deterministic, survives spec moves/renames better than path-only diffing. Beats "compute on demand from git log" (more compute per audit) and "GitHub compare API" (flags every spec edit including typos). (2026-05-25)
- **Backlog hydration mode:** Nightly BA "scan mode" is a single Sonnet 4.6 call with the full spec/ in the cached prefix and the list of currently-open issues as the uncached suffix. Returns a structured list of gap-issues to file. Prompt caching keeps the cost flat as spec grows. Beats "per-spec-file walk" (higher token cost, no cache benefit across files) and "diff against last-hydration snapshot" (lowest steady-state cost but can't catch gaps the first scan missed). (2026-05-25)

## Open design decisions

All v0 architecture decisions resolved as of 2026-05-01; cost-gate + Bedrock decisions added 2026-05-11; phase-A/B/C/D/E design decisions resolved 2026-05-25. New questions that emerge during implementation should be added here.
