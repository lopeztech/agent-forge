# `infra/modules/dynamodb/`

The six DynamoDB tables that hold all per-product state for the agent-forge
platform. All tables use on-demand billing, AWS-managed SSE, and PITR; the
ones with auto-expiring rows have a `expires_at` TTL attribute.

| Table             | Hash key     | Range key   | TTL          | Purpose                                              |
|-------------------|--------------|-------------|--------------|------------------------------------------------------|
| `products`        | `product_id` | —           | —            | Per-product config (repo URL, App install IDs, caps) |
| `team_memory`     | `product_id` | `role_key`  | —            | Per-(product, role) long-term lessons                |
| `issue_state`     | `product_id` | `issue_id`  | —            | Per-issue scratchpad + iteration counters            |
| `budget_ledger`   | `product_id` | `ts_run_id` | —            | Append-only spend log; circuit breaker reads this    |
| `rate_limits`     | `bucket_id`  | —           | `expires_at` | Token-bucket state for Anthropic API key             |
| `area_locks`      | `product_id` | `area_id`   | `expires_at` | Dev-role area locks for parallelism                  |

`team_memory` SK convention is `"<role>#<key>"` so a `Query(product_id)` returns
all memory for the product, and `Query(product_id, begins_with("dev#"))`
returns just the Dev role's memory. Org-global rows live under `product_id="*"`.

`budget_ledger` SK convention is `"<iso_ts>#<run_id>"` so daily/weekly
rollups use a single `Query` with a `BETWEEN` on the SK.

## Inputs

- `name_prefix` (required) — e.g. `agent-forge-dev`
- `deletion_protection` (default `true`) — guard against accidental drop

## Outputs

- `table_names` — `{ products = "agent-forge-dev-products", ... }`
- `table_arns` — same shape, ARNs
