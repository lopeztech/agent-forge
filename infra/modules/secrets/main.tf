locals {
  # JSON shape the auth helper expects in the writer/merger secrets.
  # TF seeds a placeholder so the resource is usable from day one; the human
  # operator overwrites it with the real values via `aws secretsmanager
  # put-secret-value` after creating each App on github.com.
  app_secret_placeholder = jsonencode({
    app_id      = "PLACEHOLDER_OVERWRITE_VIA_PUT_SECRET_VALUE"
    private_key = "PLACEHOLDER_OVERWRITE_VIA_PUT_SECRET_VALUE"
  })
}

# ------------------------------------------------------------------------------
# agent-forge-writer — BA / Dev / Test / Functional / Security
# Permissions: Issues r/w, Pull requests r/w, Contents r/w, Metadata r, Actions r.
# ------------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "writer" {
  name                    = "${var.name_prefix}-writer"
  description             = "GitHub App credentials (app_id + private_key) for agent-forge-writer."
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "writer_placeholder" {
  secret_id     = aws_secretsmanager_secret.writer.id
  secret_string = local.app_secret_placeholder

  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

# ------------------------------------------------------------------------------
# agent-forge-merger — PO only. Holds merge rights protected by branch rules.
# Permissions: Pull requests r/w, Contents r/w, Issues r/w, Metadata r.
# ------------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "merger" {
  name                    = "${var.name_prefix}-merger"
  description             = "GitHub App credentials (app_id + private_key) for agent-forge-merger."
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "merger_placeholder" {
  secret_id     = aws_secretsmanager_secret.merger.id
  secret_string = local.app_secret_placeholder

  lifecycle {
    ignore_changes = [secret_string, version_stages]
  }
}

# ------------------------------------------------------------------------------
# Webhook signing secret. Shared between both Apps' webhook configurations
# on github.com so the API Gateway verifier Lambda has one value to check.
# TF generates the value; the operator copies it into each App's webhook
# config via `aws secretsmanager get-secret-value`.
# ------------------------------------------------------------------------------

resource "random_password" "webhook_signing_secret" {
  length  = 64
  special = false
}

resource "aws_secretsmanager_secret" "webhook_signing_secret" {
  name                    = "${var.name_prefix}-webhook-signing-secret"
  description             = "Shared HMAC signing secret for both GitHub Apps' webhooks."
  recovery_window_in_days = var.recovery_window_in_days
}

resource "aws_secretsmanager_secret_version" "webhook_signing_secret" {
  secret_id     = aws_secretsmanager_secret.webhook_signing_secret.id
  secret_string = random_password.webhook_signing_secret.result
}
