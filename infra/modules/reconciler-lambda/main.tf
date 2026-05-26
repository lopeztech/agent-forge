locals {
  function_name  = "${var.name_prefix}-reconciler"
  state_machines = values(var.state_machine_arns)
  execution_arns = [for arn in values(var.state_machine_arns) : "${replace(arn, ":stateMachine:", ":execution:")}:*"]
}

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/reconciler.zip"
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

  # Mint installation tokens to list each target repo's open issues.
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

  # Re-fire an orphaned issue, and inspect recent executions to decide whether
  # a re-fire is even needed. StartExecution/ListExecutions act on the state
  # machine ARN; DescribeExecution acts on execution ARNs under it.
  statement {
    sid       = "StartAndListRoleExecutions"
    actions   = ["states:StartExecution", "states:ListExecutions"]
    resources = local.state_machines
  }

  statement {
    sid       = "DescribeRoleExecutions"
    actions   = ["states:DescribeExecution"]
    resources = local.execution_arns
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
      PRODUCTS_TABLE               = var.products_table_name
      WRITER_SECRET_NAME           = var.app_secret_name
      BA_STATE_MACHINE_ARN         = var.state_machine_arns["ba"]
      DEV_STATE_MACHINE_ARN        = var.state_machine_arns["dev"]
      TEST_STATE_MACHINE_ARN       = var.state_machine_arns["test"]
      FUNCTIONAL_STATE_MACHINE_ARN = var.state_machine_arns["functional"]
      SECURITY_STATE_MACHINE_ARN   = var.state_machine_arns["security"]
      PO_STATE_MACHINE_ARN         = var.state_machine_arns["po"]
      STALE_MINUTES                = tostring(var.stale_minutes)
      BUCKET_MINUTES               = tostring(var.bucket_minutes)
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy.this,
  ]
}

resource "aws_lambda_permission" "scheduler_invoke" {
  statement_id  = "AllowEventBridgeSchedulerInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "scheduler.amazonaws.com"
  source_arn    = var.schedule_arn
}
