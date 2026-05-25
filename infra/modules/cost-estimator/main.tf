locals {
  function_name = "${var.name_prefix}-cost-estimator"
}

# Bundled by infra/glue/cost-estimator/package.sh before terraform plan/apply.
data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/cost-estimator.zip"
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = var.log_retention_days
}

# ------------------------------------------------------------------------------
# IAM
# ------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${local.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "this" {
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  statement {
    sid       = "ReadWriterAppSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.app_secret_arn]
  }

  statement {
    sid       = "ReadProductsRow"
    actions   = ["dynamodb:GetItem"]
    resources = [var.products_table_arn]
  }

  statement {
    sid = "ReadWriteIssueState"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [var.issue_state_table_arn]
  }

  statement {
    sid       = "WriteBudgetLedger"
    actions   = ["dynamodb:PutItem"]
    resources = [var.budget_ledger_table_arn]
  }

  # Token-bucket gate in front of Bedrock InvokeModel. Lazy seed (PutItem
  # with attribute_not_exists) + optimistic refill-and-deduct (UpdateItem
  # with last_refill_at_ms condition).
  statement {
    sid = "RateLimitsBucket"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    ]
    resources = [var.rate_limits_table_arn]
  }

  statement {
    sid       = "InvokeBedrockHaiku"
    actions   = ["bedrock:InvokeModel"]
    resources = var.bedrock_model_arns
  }

  # Forensic-report dump on the two unexpected-park paths. Scoped to the
  # cost-estimator's own key prefix so a misbehaving Lambda can't clobber
  # other roles' blobs. Matches the per-Fargate-role grant in
  # infra/modules/agent-role/main.tf.
  dynamic "statement" {
    for_each = var.forensic_bucket_arn != "" ? [1] : []
    content {
      sid     = "PutForensicArtifacts"
      actions = ["s3:PutObject"]
      resources = [
        "${var.forensic_bucket_arn}/*/*/cost-estimator-*.json",
      ]
    }
  }
}

resource "aws_iam_role_policy" "this" {
  name   = "${local.function_name}-policy"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.this.json
}

# ------------------------------------------------------------------------------
# Lambda function
# ------------------------------------------------------------------------------

resource "aws_lambda_function" "this" {
  function_name    = local.function_name
  role             = aws_iam_role.this.arn
  filename         = data.archive_file.bundle.output_path
  source_code_hash = data.archive_file.bundle.output_base64sha256
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  # Bedrock InvokeModel for the cost estimator typically lands in 2-5s, but
  # cold-start + token streaming + GitHub round-trips warrant headroom.
  timeout       = 60
  memory_size   = 512
  architectures = ["arm64"]

  environment {
    variables = {
      PRODUCTS_TABLE                      = var.products_table_name
      ISSUE_STATE_TABLE                   = var.issue_state_table_name
      BUDGET_LEDGER_TABLE                 = var.budget_ledger_table_name
      APP_SECRET_NAME                     = var.app_secret_name
      HARD_PER_ISSUE_CAP_USD              = tostring(var.hard_per_issue_cap_usd)
      DEFAULT_COST_APPROVAL_THRESHOLD_USD = tostring(var.default_cost_approval_threshold_usd)
      # shared/models.ts reads this; lazy no-op when unset.
      AGENT_FORGE_RATE_LIMITS_TABLE = var.rate_limits_table_name
      AGENT_FORGE_FORENSIC_BUCKET   = var.forensic_bucket_name
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy.this,
  ]
}

# EventBridge invokes the Lambda directly (no role chaining — Lambda's resource
# policy grants events.amazonaws.com permission scoped to the specific rule).
resource "aws_lambda_permission" "events_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_rule_arn
}
