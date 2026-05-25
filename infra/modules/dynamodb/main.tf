locals {
  tables = {
    # Per-product configuration: repo URL, GitHub App install IDs, budget caps,
    # model overrides, drift-audit config, etc.
    #
    # repo_full_name-index lets the webhook verifier resolve an incoming
    # "owner/repo" → product_id in O(1) instead of scanning. Projection is
    # KEYS_ONLY because the verifier only needs the product_id; the full row
    # is fetched later by the agent that handles the event.
    products = {
      hash_key  = "product_id"
      range_key = null
      attributes = [
        { name = "product_id", type = "S" },
        { name = "repo_full_name", type = "S" },
      ]
      ttl_attribute = null
      global_secondary_indexes = [
        {
          name            = "repo_full_name-index"
          hash_key        = "repo_full_name"
          projection_type = "KEYS_ONLY"
        },
      ]
    }

    # Per-(product, role) memory. SK encodes "<role>#<key>" so a Query can
    # pull all memory for a product, or just one role's memory via begins_with.
    # Org-global rows live under product_id="*".
    team_memory = {
      hash_key  = "product_id"
      range_key = "role_key"
      attributes = [
        { name = "product_id", type = "S" },
        { name = "role_key", type = "S" },
      ]
      ttl_attribute            = null
      global_secondary_indexes = []
    }

    # Per-issue scratchpad: iteration counters, kickback count, last role,
    # forensic pointers. Survives across role handoffs.
    issue_state = {
      hash_key  = "product_id"
      range_key = "issue_id"
      attributes = [
        { name = "product_id", type = "S" },
        { name = "issue_id", type = "S" },
      ]
      ttl_attribute            = null
      global_secondary_indexes = []
    }

    # Append-only spend log. SK is "<iso_ts>#<run_id>" so daily/weekly
    # rollups can use a BETWEEN range scan.
    budget_ledger = {
      hash_key  = "product_id"
      range_key = "ts_run_id"
      attributes = [
        { name = "product_id", type = "S" },
        { name = "ts_run_id", type = "S" },
      ]
      ttl_attribute            = null
      global_secondary_indexes = []
    }

    # Token-bucket state for Bedrock per-model invocation quotas, shared
    # across all products. TTL on stale buckets so an outage-era record
    # self-cleans.
    rate_limits = {
      hash_key  = "bucket_id"
      range_key = null
      attributes = [
        { name = "bucket_id", type = "S" },
      ]
      ttl_attribute            = "expires_at"
      global_secondary_indexes = []
    }

    # Area-lock records for the Dev role. One row per (product_id, area_id)
    # while the lock is held; TTL auto-releases stuck locks.
    area_locks = {
      hash_key  = "product_id"
      range_key = "area_id"
      attributes = [
        { name = "product_id", type = "S" },
        { name = "area_id", type = "S" },
      ]
      ttl_attribute            = "expires_at"
      global_secondary_indexes = []
    }

    # Phase C — Dev waits for an area lock here when it can't acquire.
    # SK encodes `<area_id>#<created_at_iso>#<issue_number>` so a Query on
    # (product_id, begins_with(area_waiter_id, "<area>#")) returns all
    # waiters for that area in time order (oldest first). The sweeper
    # Lambda picks the head of that list and re-triggers Dev. TTL purges
    # abandoned waiters (matches Dev's wall-clock cap).
    lock_waiters = {
      hash_key  = "product_id"
      range_key = "area_waiter_id"
      attributes = [
        { name = "product_id", type = "S" },
        { name = "area_waiter_id", type = "S" },
      ]
      ttl_attribute            = "expires_at"
      global_secondary_indexes = []
    }
  }
}

resource "aws_dynamodb_table" "this" {
  for_each = local.tables

  name         = "${var.name_prefix}-${each.key}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = each.value.hash_key
  range_key    = each.value.range_key

  deletion_protection_enabled = var.deletion_protection

  dynamic "attribute" {
    for_each = each.value.attributes
    content {
      name = attribute.value.name
      type = attribute.value.type
    }
  }

  point_in_time_recovery {
    enabled = true
  }

  dynamic "ttl" {
    for_each = each.value.ttl_attribute != null ? [each.value.ttl_attribute] : []
    content {
      attribute_name = ttl.value
      enabled        = true
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.value.global_secondary_indexes
    content {
      name            = global_secondary_index.value.name
      hash_key        = global_secondary_index.value.hash_key
      projection_type = global_secondary_index.value.projection_type
    }
  }

  server_side_encryption {
    enabled = true
  }
}
