# Cost model

Spend model and the budget circuit breaker. Companion to
[`docs/architecture.md`](architecture.md) (which describes the components these
costs come from) and the lean guidance in `CLAUDE.md`/`AGENTS.md`.

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

**With kickbacks at moderate failure rate (p≈0.3, kickback cap=3):** expected **~$3.60 / issue** (see the **Failure handling** section in [`docs/architecture.md`](architecture.md#failure-handling) for the full distribution).

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
