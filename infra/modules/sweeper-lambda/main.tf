locals {
  function_name = "${var.name_prefix}-sweeper"
}

data "archive_file" "bundle" {
  type        = "zip"
  source_dir  = var.source_dir
  output_path = "${path.module}/.build/sweeper.zip"
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

  # Query the waiter list (oldest-for-area), then DeleteItem the chosen
  # waiter after StartExecution succeeds.
  statement {
    sid = "QueryAndDeleteLockWaiters"
    actions = [
      "dynamodb:Query",
      "dynamodb:DeleteItem",
    ]
    resources = [var.lock_waiters_table_arn]
  }

  # Re-fire Dev for the dequeued waiter.
  statement {
    sid       = "StartDevExecution"
    actions   = ["states:StartExecution"]
    resources = [var.dev_state_machine_arn]
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
  # Sweeper does at most one Query + one StartExecution + one Delete per
  # invocation. Headroom for occasional DDB throttling.
  timeout       = 30
  memory_size   = 256
  architectures = ["arm64"]

  environment {
    variables = {
      LOCK_WAITERS_TABLE    = var.lock_waiters_table_name
      DEV_STATE_MACHINE_ARN = var.dev_state_machine_arn
    }
  }

  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy.this,
  ]
}

resource "aws_lambda_permission" "events_invoke" {
  statement_id  = "AllowEventBridgeInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.this.function_name
  principal     = "events.amazonaws.com"
  source_arn    = var.event_rule_arn
}
