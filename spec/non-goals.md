# Non-goals

What agent-forge will explicitly NOT do, to keep scope tight and prevent
scope creep when BA expands incoming issues.

## Not in scope

- **A web UI or dashboard.** All state is visible in GitHub Issues, PRs,
  and CloudWatch. No bespoke front-end.
- **Multi-provider model routing.** v1 is Bedrock-only on Anthropic Claude.
  Adding OpenAI / Gemini / etc. is rejected — failure-rate risk plus loss of
  prompt caching wipes any token savings. Anthropic-outage fallback is the
  only multi-provider scenario considered.
- **EC2 or ECS-on-EC2.** Serverless-first. Fargate counts; long-lived
  ECS services for stateful target-app deps are opt-in per product
  (`functional_runtime_mode: warm`) but agent runtime itself is never on EC2.
- **Production deploys by agents.** Agents merge PRs; humans (or external
  CD systems) handle deploys. Agents never push to prod.
- **PII / payments / financial-grade workflows out of the box.** Such
  domains require additional review gates not in v1.
- **Custom git hosts.** GitHub only. Bitbucket / GitLab / Forgejo are not
  on the roadmap.
- **Cross-repo PRs.** A Dev works in one target repo at a time.
- **Monorepo work units that span undeclared areas.** BA flags
  `gap:areas-incomplete` and parks; humans extend `.agent-forge/areas.yml`.

## Out of scope for this slice (BA-real, current)

- Sub-issue splitting on `complexity: large` (separate follow-up)
- `team_memory` accumulation read/write
- Opus 4.7 escalation for brand-new spec hydration
- Web-search tool
- Prompt caching on the BA system prompt + spec block
