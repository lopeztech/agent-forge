locals {
  tables = {
    # Per-product configuration: repo URL, GitHub App install IDs, budget caps,
    # model overrides, drift-audit config, etc.
    products = {
      hash_key  = "product_id"
      range_key = null
      attributes = [
        { name = "product_id", type = "S" },
      ]
      ttl_attribute = null
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
      ttl_attribute = null
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
      ttl_attribute = null
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
      ttl_attribute = null
    }

    # Token-bucket state for the Anthropic API key, shared across all products.
    # TTL on stale buckets so an outage-era record self-cleans.
    rate_limits = {
      hash_key  = "bucket_id"
      range_key = null
      attributes = [
        { name = "bucket_id", type = "S" },
      ]
      ttl_attribute = "expires_at"
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
      ttl_attribute = "expires_at"
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

  server_side_encryption {
    enabled = true
  }
}
