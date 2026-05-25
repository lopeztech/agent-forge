locals {
  family    = "${var.name_prefix}-${var.role}"
  log_group = "/aws/ecs/${local.family}"
}

# ------------------------------------------------------------------------------
# Log group
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "this" {
  name              = local.log_group
  retention_in_days = var.log_retention_days
}

# ------------------------------------------------------------------------------
# Execution role: what Fargate uses to pull the image + write logs.
# Scoped to this role's ECR repo + log group only.
# ------------------------------------------------------------------------------

data "aws_iam_policy_document" "execution_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${local.family}-execution"
  assume_role_policy = data.aws_iam_policy_document.execution_assume.json
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid = "EcrPullAuth"
    actions = [
      "ecr:GetAuthorizationToken",
    ]
    resources = ["*"]
  }
  statement {
    sid = "EcrPullLayers"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    # Source repo is implicit in image_uri; we don't get its ARN at module
    # boundary cleanly. Acceptable because the ECR pull is read-only and the
    # task ENI runs in egress-only SG. Tighten when we add multi-product
    # repo segregation.
    resources = ["*"]
  }
  statement {
    sid       = "WriteOwnLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "${local.family}-execution-policy"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

# ------------------------------------------------------------------------------
# Task role: what the agent code uses.
# Bedrock model invocation, App credentials fetch, DynamoDB state writes.
# ------------------------------------------------------------------------------

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task" {
  name               = "${local.family}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

data "aws_iam_policy_document" "task" {
  statement {
    sid       = "ReadAppCredentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.app_secret_arn]
  }

  # Bedrock InvokeModel scoped to specific model ARNs. Empty list (e.g.
  # for the BA stub) means no statement is emitted.
  dynamic "statement" {
    for_each = length(var.bedrock_model_arns) > 0 ? [1] : []
    content {
      sid = "InvokeBedrockModels"
      actions = [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
      ]
      resources = var.bedrock_model_arns
    }
  }

  statement {
    sid = "AgentForgeDynamoState"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:Query",
    ]
    resources = values(var.dynamodb_table_arns)
  }

  # PutEvents for future role-to-role signals. No-op today.
  dynamic "statement" {
    for_each = var.event_bus_arn != "" ? [1] : []
    content {
      sid       = "PutEventsOnBus"
      actions   = ["events:PutEvents"]
      resources = [var.event_bus_arn]
    }
  }

  # Forensic-report dump on park. Scoped to the role's own prefix in the
  # bucket so a misbehaving role can't clobber another role's blobs.
  dynamic "statement" {
    for_each = var.forensic_bucket_arn != "" ? [1] : []
    content {
      sid     = "PutForensicArtifacts"
      actions = ["s3:PutObject"]
      resources = [
        "${var.forensic_bucket_arn}/*/*/${var.role}-*.json",
      ]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "${local.family}-task-policy"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

# ------------------------------------------------------------------------------
# Task definition
# ------------------------------------------------------------------------------

resource "aws_ecs_task_definition" "this" {
  family                   = local.family
  cpu                      = var.cpu
  memory                   = var.memory
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  task_role_arn            = aws_iam_role.task.arn
  execution_role_arn       = aws_iam_role.execution.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = var.role
      image     = var.image_uri
      essential = true

      environment = concat(
        [
          { name = "AGENT_FORGE_ENV", value = var.env },
          { name = "AGENT_FORGE_ROLE", value = var.role },
          { name = "AGENT_FORGE_APP_SECRET_NAME", value = var.app_secret_name },
          { name = "AGENT_FORGE_PRODUCTS_TABLE", value = var.products_table_name },
        ],
        [
          for name, value in var.extra_environment : {
            name  = name
            value = value
          }
        ],
      )

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.this.name
          awslogs-region        = data.aws_region.this.name
          awslogs-stream-prefix = var.role
        }
      }
    }
  ])
}

data "aws_region" "this" {}
