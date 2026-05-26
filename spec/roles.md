# Agent roles

Six role-specialized agents form the pipeline. Each has its own system
prompt, IAM scope, GitHub App permissions, and default model. Handoffs go
through GitHub issue label transitions — never direct agent-to-agent calls.

## 1. Business Analyst (BA)

- Reads the product's `spec/` and the incoming issue
- Expands the request into acceptance criteria, risks, out-of-scope notes
- Tags complexity (trivial / small / medium / large)
- Splits large issues into sub-issues (deferred)
- Default model: Sonnet 4.6

## 1.5. Cost Estimator (gate, not a role)

- A small Lambda between BA and Dev
- Reads BA's structured expansion + comparable past issues
- Produces per-role p50/p90 estimates
- Auto-promotes under the threshold; parks for `/approve-cost` above it
- Rejects above the per-issue hard cap
- Default model: Haiku 4.5

## 2. Developer

- Claims the area, branches from `main`, implements against acceptance criteria
- Opens a PR linking the issue
- Escalates Sonnet → Opus on the final retry attempt
- Default model: Sonnet 4.6; Opus 4.7 on attempt 3 or for `complexity:large`

## 3. Test Engineer

- Adds unit + integration tests covering each acceptance criterion
- Pushes test commits to the PR branch
- Default model: Sonnet 4.6

## 4. Functional Tester

- Spins the target app per its run instructions
- Executes end-to-end flows mapping to acceptance criteria
- Posts a structured pass/fail report; fails kick back to Dev
- Default model: Sonnet 4.6

## 5. Security Reviewer

- Runs SAST (semgrep), secret scanning, dependency audit
- LLM-driven review of the diff against OWASP Top 10
- Blocking findings kick back to Dev
- Default model: Sonnet 4.6; Opus 4.7 for diffs tagged `security-sensitive`

## 6. Product Owner (PO)

- Compares the PR + tests + functional report against the cited spec section
- Three outcomes: merge, kick back with concrete deltas, or `human-needed`
- Also runs a weekly drift audit on a sample of recently-merged issues
- Default model: Opus 4.7 (this is the gate; mistakes are expensive)
