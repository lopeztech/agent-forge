# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Mission

agent-forge is an AWS-hosted, serverless-first platform that runs autonomous, long-running software product teams composed entirely of Claude agents. Six role-specialized agents chain together to take a product from spec → backlog → implementation → tested + secured → shipped, with handoffs driven by GitHub issue state, not by a single long-running prompt.

Long-running means **months or years**, not a one-shot build. The team continuously hydrates the backlog from an evolving spec, detects drift in already-shipped work, accumulates per-team memory of conventions, and stays inside a hard budget envelope.

The pain point this solves: Claude Routines and standalone agent runs do not chain hand-offs reliably across roles. agent-forge is the orchestration layer that makes that chaining deterministic, observable, and budgeted.

**Multi-project platform.** agent-forge is designed from day one to operate N target product repos in parallel, each with its own spec, backlog, budget, and accumulated team memory. There is no "single-product" mode.

**Serverless-first.** Every component is serverless (no servers to manage, pay per use). Fargate counts as serverless in the AWS taxonomy and is used in preference to Lambda only where the 15-min execution cap forces it. EC2 / ECS-on-EC2 is explicitly out of scope.

## Current state

The repository is empty (no source yet). This document is the v0 architecture spec; it is the single thing future Claude instances should read first. Implementation is greenfield.

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
- **DynamoDB** — five tables, all keyed by `product_id` first:
  - `products` — per-product config: target repo URL, `writer_install_id`, `merger_install_id`, spec path, areas-file path, budget caps, model overrides, Functional Tester runtime mode (`ephemeral` or `warm`), drift audit config (cadence, sample size, sampling strategy, horizon), kickback cap, concurrency cap.
  - `team_memory` — `(product_id, role, key)` per-role long-term memory. `product_id="*"` is the org-global namespace; agents read `global UNION product` with product winning on conflict.
  - `issue_state` — `(product_id, issue_id)` — per-issue scratchpad, iteration counters, area-lock holdings.
  - `budget_ledger` — every model call's token + USD cost, queried per product per day.
  - `rate_limits` — token-bucket state for the Anthropic API key, shared across all products.
- **S3** — artifacts: full PR diffs, test reports, security scan output, large agent transcripts. Prefixed by `product_id/issue_id/`.
- **Secrets Manager** — `ANTHROPIC_API_KEY`, two GitHub App private keys (`agent-forge-writer`, `agent-forge-merger`), third-party scanner tokens (semgrep, etc. as needed). Each App has one installation per target repo.
- **CloudWatch Logs + X-Ray** — per-task logs tagged with `product_id`, end-to-end tracing across role handoffs.
- **EventBridge Scheduler** — cron triggers for long-running jobs: nightly backlog hydration, weekly drift audit, daily budget rollup. Schedules iterate over the `products` table.

Model access goes **direct to the Anthropic API** in the normal path. Reason: model availability lag on Bedrock for the latest Claude versions; agent-forge wants to use the right model for each role on day one of release. **Bedrock is wired in solely as an outage fallback** — when the Anthropic API returns sustained 5xx (>5 min), in-flight runs cut over to Claude-on-Bedrock for the same model tier and new issue work pauses until the direct API recovers.

VPC: agents do not need inbound traffic. Outbound to the Anthropic API and GitHub is required. Use VPC endpoints for AWS services to avoid a NAT Gateway (~$32/month otherwise).

## Roles

Six teams. Each is a separate container image, system prompt, tool allow-list, IAM role, and GitHub App permissions scope. The model column is the **default**; any role can escalate one tier (e.g. Sonnet → Opus) on retry after a failure.

### 1. Business Analyst (BA)

- **Trigger:** new issue with label `state:idea`, OR scheduled nightly "hydrate" run that scans the spec for un-issued work.
- **Job:** read `spec/`, expand the request into acceptance criteria, split into sub-issues if it spans more than ~1 day of work, attach risks and out-of-scope notes, transition to `state:ready`.
- **Tools:** GitHub Issues read/write, repo file reads, web search.
- **Default model:** **Sonnet 4.6** — strong reasoning over docs, but no code generation; Opus is wasteful for routine refinement.
- **Escalation:** Opus 4.7 for the initial spec-to-backlog hydration of a brand-new spec area (high stakes, infrequent).

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
state:idea                 → BA
state:ready                → Developer
state:in-dev               (working — no trigger; Dev pushes to PR)
state:awaiting-tests       → Test Engineer
state:awaiting-functional  → Functional Tester
state:awaiting-security    → Security Reviewer
state:awaiting-po          → PO
state:done                 (terminal)
human-needed               (parked — only humans clear it)
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

**Lock primitive.** DynamoDB conditional write on `(product_id, area_id)` with TTL = 2× per-issue spend cap (~2h default). Multi-area issues acquire all required locks **in alphabetical order** (deadlock-free by canonical resource ordering). `area:*` acquires every area in alphabetical order — equivalent to single-Dev for that issue.

**Per-product concurrency cap:** default 3 simultaneous Devs, configurable in `products`. Bounds Anthropic rate-limit pressure and daily budget.

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

**Pricing assumptions (Anthropic API, as of early 2026 — verify before relying on these):**

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

**AWS infrastructure (independent of model cost), monthly estimate:**

| Component | Estimate |
|-----------|---------:|
| ECS Fargate (5 issues/day, ~30 min/role × 6 roles) | $80–150 |
| Step Functions (~150 transitions/day) | <$5 |
| DynamoDB on-demand (light use) | $5–20 |
| S3 + transfer | $1–5 |
| EventBridge + API Gateway | <$5 |
| Secrets Manager (3 secrets) | ~$1 |
| CloudWatch Logs (30-day retention) | $10–30 |
| VPC endpoints (avoid NAT Gateway) | ~$15 |
| **Total infra** | **~$120–230** |

**All-in monthly at 5 issues/day:** ~$720–830.

**Budget circuit breaker** is mandatory. Caps live in `products` (per-product) and as global env defaults; `budget_ledger` is the source of truth for spend:

- Per-issue cap: $12 default. Sized to cover the worst-case path through the kickback cap (3 attempts, last on Opus) plus buffer. On hit, label `human-needed` and stop.
- Per-role per-day cap: $30 default.
- Per-product per-day cap: $75 default.
- Global per-day cap (across all products): $250 default.
- Trip behavior: write a `budget:tripped` flag scoped to the tripped scope (product or global). Role triggers check the relevant scope and short-circuit until a human clears it. One product tripping never pauses another.

**Anthropic rate limiting** is also mandatory. The `rate_limits` table holds token-bucket state for the Anthropic API key; every role acquires tokens before calling the model. Without this, a busy product can starve others when they all hit the same Anthropic org rate limit.

**Spot reclamation handling.** All Fargate tasks run on Spot by default. Step Functions catches the `Task.Failed` event from a spot reclamation and retries on on-demand. Agents must checkpoint state to `issue_state` after every meaningful step (file write, label transition, tool call cluster) so a reclaimed task resumes without losing work.

## Repository layout (planned)

```
infra/                    # Terraform (HCL)
  bootstrap/              # one-time — creates the S3 state bucket + DynamoDB lock table
  modules/
    networking/           # VPC + interface endpoints (avoid NAT Gateway)
    eventbridge/          # event bus, webhook rules, scheduled rules
    step-functions/       # state machines + asl/ subdir of ASL JSON
    ecs-role/             # parameterized; instantiated 6× (one per agent role)
    dynamodb/             # products, team_memory, issue_state, budget_ledger, rate_limits
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
  budget/                 # spend tracking + circuit breaker + Anthropic rate limiter
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
- Model selection lives in one place: `shared/models.ts`. Do not hardcode model IDs in role code. Keep the `getModel(role, attempt) → ModelHandle` shape provider-agnostic; do not bake Anthropic-shaped fields into the type so future provider swaps stay a config change.
- Tool definitions live in a normalized format and are serialized per-provider at call time. Even though v1 only targets Anthropic, the normalization keeps the door open without paying refactor cost later.

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

## Open design decisions

All v0 architecture decisions resolved as of 2026-05-01. New questions that emerge during implementation should be added here.
