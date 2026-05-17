locals {
  ba_state_machine_name = "${var.name_prefix}-ba-issue-lifecycle"
}

# ------------------------------------------------------------------------------
# Logs for the state machine itself (separate from the task's logs).
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "ba" {
  name              = "/aws/states/${local.ba_state_machine_name}"
  retention_in_days = var.log_retention_days
}

# ------------------------------------------------------------------------------
# Execution role for Step Functions: needs ecs:RunTask, iam:PassRole on the
# task + execution roles, ec2:Describe* for ENI cleanup, and logs:* for its
# own log group.
# ------------------------------------------------------------------------------

data "aws_iam_policy_document" "assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ba" {
  name               = "${local.ba_state_machine_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "ba" {
  statement {
    sid       = "RunBATask"
    actions   = ["ecs:RunTask"]
    resources = [replace(var.ba_task_definition_arn, "/:\\d+$/", ":*")]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid     = "WaitForBATask"
    actions = ["ecs:DescribeTasks", "ecs:StopTask"]
    # ECS tasks are arn-by-id at run time; we can only scope by cluster
    # via the resource condition.
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "PassTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [var.ba_task_role_arn, var.ba_execution_role_arn]
  }

  # Step Functions sets up an EventBridge managed rule so it can be notified
  # when the ECS task completes (required by .sync integration).
  statement {
    sid = "ManageEventBridgeRuleForRunTaskSync"
    actions = [
      "events:PutTargets",
      "events:PutRule",
      "events:DescribeRule",
    ]
    resources = [
      "arn:aws:events:*:*:rule/StepFunctionsGetEventsForECSTaskRule",
    ]
  }

  statement {
    sid       = "WriteStateMachineLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.ba.arn}:*"]
  }

  statement {
    sid = "CreateLogDelivery"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ba" {
  name   = "${local.ba_state_machine_name}-policy"
  role   = aws_iam_role.ba.id
  policy = data.aws_iam_policy_document.ba.json
}

# ------------------------------------------------------------------------------
# State machine
# ------------------------------------------------------------------------------

resource "aws_sfn_state_machine" "ba" {
  name     = local.ba_state_machine_name
  role_arn = aws_iam_role.ba.arn

  definition = templatefile("${path.module}/asl/ba-issue-lifecycle.asl.json", {
    cluster_arn            = var.cluster_arn
    ba_task_definition_arn = var.ba_task_definition_arn
    subnets                = var.subnets
    security_group_id      = var.security_group_id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.ba.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
}
