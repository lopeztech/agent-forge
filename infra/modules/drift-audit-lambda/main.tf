locals {
  function_name = "${var.name_prefix}-drift-audit"
}

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/drift-audit.zip"
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

  # Scan products to iterate every target repo.
  statement {
    sid       = "ScanProducts"
    actions   = ["dynamodb:Scan", "dynamodb:GetItem"]
    resources = [var.products_table_arn]
  }

  # Query the per-product issue_state partition for done-with-hashes
  # candidates. Read-only — drift audit never writes issue_state.
  statement {
    sid       = "QueryIssueState"
    actions   = ["dynamodb:Query"]
    resources = [var.issue_state_table_arn]
  }

  statement {
    sid       = "PublishCloudWatchMetrics"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
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
  timeout          = var.timeout_seconds
  memory_size      = var.memory_size_mb
  architectures    = ["arm64"]

  environment {
    variables = {
      AGENT_FORGE_ENV   = var.env
      PRODUCTS_TABLE    = var.products_table_name
      ISSUE_STATE_TABLE = var.issue_state_table_name
      APP_SECRET_NAME   = var.app_secret_name
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

# EventBridge Scheduler invokes the Lambda; scope the lambda:InvokeFunction
# permission to the specific schedule ARN.
resource "aws_lambda_permission" "scheduler_invoke" {
  statement_id  = "AllowEventBridgeSchedulerInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = var.schedule_arn
}
