locals {
  function_name = "${var.name_prefix}-webhook-verifier"
}

# Zip the pre-built bundle. infra/glue/webhook-verifier/package.sh must have
# run first (CI does this in a step before `terraform plan`/`apply`; locally
# you run it manually).
data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/webhook-verifier.zip"
}

# Pre-create the log group so Terraform owns its retention setting instead
# of letting Lambda create it on first invoke with no retention.
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
    sid       = "ReadWebhookSigningSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.webhook_secret_arn]
  }

  statement {
    sid       = "QueryProductsRepoIndex"
    actions   = ["dynamodb:Query"]
    resources = [var.products_repo_index_arn]
  }

  statement {
    sid       = "PutEventsOnAgentForgeBus"
    actions   = ["events:PutEvents"]
    resources = [var.event_bus_arn]
  }

  statement {
    sid       = "XRayWrite"
    actions   = ["xray:PutTraceSegments", "xray:PutTelemetryRecords", "xray:GetSamplingRules", "xray:GetSamplingTargets"]
    resources = ["*"]
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
  timeout          = 10
  memory_size      = 256
  architectures    = ["arm64"]

  environment {
    variables = {
      WEBHOOK_SECRET_NAME = var.webhook_secret_name
      PRODUCTS_TABLE      = var.products_table_name
      REPO_INDEX_NAME     = var.products_repo_index_name
      EVENT_BUS_NAME      = var.event_bus_name
      EVENT_SOURCE        = "agent-forge.webhook"
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy.this,
  ]
}
