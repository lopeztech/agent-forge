locals {
  ba_state_machine_name         = "${var.name_prefix}-ba-issue-lifecycle"
  dev_state_machine_name        = "${var.name_prefix}-dev-issue-lifecycle"
  test_state_machine_name       = "${var.name_prefix}-test-issue-lifecycle"
  functional_state_machine_name = "${var.name_prefix}-functional-issue-lifecycle"
  security_state_machine_name   = "${var.name_prefix}-security-issue-lifecycle"
  po_state_machine_name         = "${var.name_prefix}-po-issue-lifecycle"
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

# ------------------------------------------------------------------------------
# Dev state machine — mirrors BA's setup with its own task def + log group +
# execution role. Each role gets its own role/policy so a permissions change
# for one doesn't leak across the others.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "dev" {
  name              = "/aws/states/${local.dev_state_machine_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "dev" {
  name               = "${local.dev_state_machine_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "dev" {
  statement {
    sid       = "RunDevTask"
    actions   = ["ecs:RunTask"]
    resources = [replace(var.dev_task_definition_arn, "/:\\d+$/", ":*")]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "WaitForDevTask"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "PassDevTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [var.dev_task_role_arn, var.dev_execution_role_arn]
  }

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
    sid       = "WriteDevStateMachineLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.dev.arn}:*"]
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

resource "aws_iam_role_policy" "dev" {
  name   = "${local.dev_state_machine_name}-policy"
  role   = aws_iam_role.dev.id
  policy = data.aws_iam_policy_document.dev.json
}

resource "aws_sfn_state_machine" "dev" {
  name     = local.dev_state_machine_name
  role_arn = aws_iam_role.dev.arn

  definition = templatefile("${path.module}/asl/dev-issue-lifecycle.asl.json", {
    cluster_arn             = var.cluster_arn
    dev_task_definition_arn = var.dev_task_definition_arn
    subnets                 = var.subnets
    security_group_id       = var.security_group_id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.dev.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
}

# ------------------------------------------------------------------------------
# Test state machine — same shape as Dev: own log group, own IAM role.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "test" {
  name              = "/aws/states/${local.test_state_machine_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "test" {
  name               = "${local.test_state_machine_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "test" {
  statement {
    sid       = "RunTestTask"
    actions   = ["ecs:RunTask"]
    resources = [replace(var.test_task_definition_arn, "/:\\d+$/", ":*")]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "WaitForTestTask"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "PassTestTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [var.test_task_role_arn, var.test_execution_role_arn]
  }

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
    sid       = "WriteTestStateMachineLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.test.arn}:*"]
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

resource "aws_iam_role_policy" "test" {
  name   = "${local.test_state_machine_name}-policy"
  role   = aws_iam_role.test.id
  policy = data.aws_iam_policy_document.test.json
}

resource "aws_sfn_state_machine" "test" {
  name     = local.test_state_machine_name
  role_arn = aws_iam_role.test.arn

  definition = templatefile("${path.module}/asl/test-issue-lifecycle.asl.json", {
    cluster_arn              = var.cluster_arn
    test_task_definition_arn = var.test_task_definition_arn
    subnets                  = var.subnets
    security_group_id        = var.security_group_id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.test.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
}

# ------------------------------------------------------------------------------
# Functional state machine
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "functional" {
  name              = "/aws/states/${local.functional_state_machine_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "functional" {
  name               = "${local.functional_state_machine_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "functional" {
  statement {
    sid       = "RunFunctionalTask"
    actions   = ["ecs:RunTask"]
    resources = [replace(var.functional_task_definition_arn, "/:\\d+$/", ":*")]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "WaitForFunctionalTask"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "PassFunctionalTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [var.functional_task_role_arn, var.functional_execution_role_arn]
  }

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
    sid       = "WriteFunctionalStateMachineLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.functional.arn}:*"]
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

resource "aws_iam_role_policy" "functional" {
  name   = "${local.functional_state_machine_name}-policy"
  role   = aws_iam_role.functional.id
  policy = data.aws_iam_policy_document.functional.json
}

resource "aws_sfn_state_machine" "functional" {
  name     = local.functional_state_machine_name
  role_arn = aws_iam_role.functional.arn

  definition = templatefile("${path.module}/asl/functional-issue-lifecycle.asl.json", {
    cluster_arn                    = var.cluster_arn
    functional_task_definition_arn = var.functional_task_definition_arn
    subnets                        = var.subnets
    security_group_id              = var.security_group_id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.functional.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
}

# ------------------------------------------------------------------------------
# Security state machine
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "security" {
  name              = "/aws/states/${local.security_state_machine_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "security" {
  name               = "${local.security_state_machine_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "security" {
  statement {
    sid       = "RunSecurityTask"
    actions   = ["ecs:RunTask"]
    resources = [replace(var.security_task_definition_arn, "/:\\d+$/", ":*")]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "WaitForSecurityTask"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "PassSecurityTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [var.security_task_role_arn, var.security_execution_role_arn]
  }

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
    sid       = "WriteSecurityStateMachineLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.security.arn}:*"]
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

resource "aws_iam_role_policy" "security" {
  name   = "${local.security_state_machine_name}-policy"
  role   = aws_iam_role.security.id
  policy = data.aws_iam_policy_document.security.json
}

resource "aws_sfn_state_machine" "security" {
  name     = local.security_state_machine_name
  role_arn = aws_iam_role.security.arn

  definition = templatefile("${path.module}/asl/security-issue-lifecycle.asl.json", {
    cluster_arn                  = var.cluster_arn
    security_task_definition_arn = var.security_task_definition_arn
    subnets                      = var.subnets
    security_group_id            = var.security_group_id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.security.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
}

# ------------------------------------------------------------------------------
# PO state machine
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "po" {
  name              = "/aws/states/${local.po_state_machine_name}"
  retention_in_days = var.log_retention_days
}

resource "aws_iam_role" "po" {
  name               = "${local.po_state_machine_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume.json
}

data "aws_iam_policy_document" "po" {
  statement {
    sid       = "RunPoTask"
    actions   = ["ecs:RunTask"]
    resources = [replace(var.po_task_definition_arn, "/:\\d+$/", ":*")]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "WaitForPoTask"
    actions   = ["ecs:DescribeTasks", "ecs:StopTask"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_arn]
    }
  }

  statement {
    sid       = "PassPoTaskRoles"
    actions   = ["iam:PassRole"]
    resources = [var.po_task_role_arn, var.po_execution_role_arn]
  }

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
    sid       = "WritePoStateMachineLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.po.arn}:*"]
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

resource "aws_iam_role_policy" "po" {
  name   = "${local.po_state_machine_name}-policy"
  role   = aws_iam_role.po.id
  policy = data.aws_iam_policy_document.po.json
}

resource "aws_sfn_state_machine" "po" {
  name     = local.po_state_machine_name
  role_arn = aws_iam_role.po.arn

  definition = templatefile("${path.module}/asl/po-issue-lifecycle.asl.json", {
    cluster_arn            = var.cluster_arn
    po_task_definition_arn = var.po_task_definition_arn
    subnets                = var.subnets
    security_group_id      = var.security_group_id
  })

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.po.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }
}
