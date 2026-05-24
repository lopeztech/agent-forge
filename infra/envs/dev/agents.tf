# ------------------------------------------------------------------------------
# Networking — default-VPC public subnets per CLAUDE.md baseline.
# Stateless workers + egress-only SG = no inbound exposure.
# ------------------------------------------------------------------------------

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "agent_tasks" {
  name        = "${var.name_prefix}-agent-tasks"
  description = "Agent Fargate tasks: egress-only (GitHub + AWS service endpoints)."
  vpc_id      = data.aws_vpc.default.id

  egress {
    description = "All outbound - GitHub API plus AWS service endpoints over the AWS backbone"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ------------------------------------------------------------------------------
# ECS + ECR
# ------------------------------------------------------------------------------

module "ecs_cluster" {
  source = "../../modules/ecs-cluster"

  name_prefix = var.name_prefix
}

module "ecr_ba" {
  source = "../../modules/ecr"

  repository_name = "${var.name_prefix}/ba"
}

module "ecr_dev" {
  source = "../../modules/ecr"

  repository_name = "${var.name_prefix}/dev"
}

module "ecr_test" {
  source = "../../modules/ecr"

  repository_name = "${var.name_prefix}/test"
}

# ------------------------------------------------------------------------------
# BA agent role (Slice A stub — no Bedrock yet)
# ------------------------------------------------------------------------------

module "agent_ba" {
  source = "../../modules/agent-role"

  name_prefix     = var.name_prefix
  role            = "ba"
  env             = "dev"
  image_uri       = "${module.ecr_ba.repository_url}:latest"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name
  cluster_arn     = module.ecs_cluster.cluster_arn

  subnets           = data.aws_subnets.default_public.ids
  security_group_id = aws_security_group.agent_tasks.id

  products_table_name = module.dynamodb.table_names["products"]

  extra_environment = {
    AGENT_FORGE_ISSUE_STATE_TABLE   = module.dynamodb.table_names["issue_state"]
    AGENT_FORGE_BUDGET_LEDGER_TABLE = module.dynamodb.table_names["budget_ledger"]
  }

  # BA needs read on products (issue trigger lookup) and write on
  # budget_ledger + issue_state + team_memory + area_locks.
  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    area_locks    = module.dynamodb.table_arns["area_locks"]
  }

  # BA-real (Slice B-followup): expand issues with Sonnet 4.6.
  # Profile + 6 underlying foundation-model ARNs (EU geographic CRIS).
  bedrock_model_arns = local.bedrock_invoke_arns["sonnet-4-6"]
}

# ------------------------------------------------------------------------------
# Dev agent role (Slice A — orchestration + area-lock proof, no Bedrock yet)
# ------------------------------------------------------------------------------

module "agent_dev" {
  source = "../../modules/agent-role"

  name_prefix     = var.name_prefix
  role            = "dev"
  env             = "dev"
  image_uri       = "${module.ecr_dev.repository_url}:latest"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name
  cluster_arn     = module.ecs_cluster.cluster_arn

  subnets           = data.aws_subnets.default_public.ids
  security_group_id = aws_security_group.agent_tasks.id

  products_table_name = module.dynamodb.table_names["products"]

  extra_environment = {
    AGENT_FORGE_ISSUE_STATE_TABLE   = module.dynamodb.table_names["issue_state"]
    AGENT_FORGE_BUDGET_LEDGER_TABLE = module.dynamodb.table_names["budget_ledger"]
    AGENT_FORGE_AREA_LOCKS_TABLE    = module.dynamodb.table_names["area_locks"]
  }

  # Dev needs read on products + the same write surface as BA, plus area_locks
  # (Get/Put/Update for the conditional-write acquire path, Delete via the
  # broader policy below).
  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    area_locks    = module.dynamodb.table_arns["area_locks"]
  }

  # Complexity-driven tier routing (tierForDev): Haiku for trivial issues,
  # Sonnet for small/medium (default), Opus for large + the attempt-3
  # escalation. All three SKUs' profile + per-region foundation ARNs.
  bedrock_model_arns = concat(
    local.bedrock_invoke_arns["haiku-4-5"],
    local.bedrock_invoke_arns["sonnet-4-6"],
    local.bedrock_invoke_arns["opus-4-6"],
  )
}

# Dev releases its own locks via DeleteItem; the agent-role module's base task
# policy only grants Get/Put/Update/Query. Attach a focused inline policy for
# DeleteItem on area_locks so the lock-release path works without widening the
# shared module.
data "aws_iam_policy_document" "agent_dev_area_lock_release" {
  statement {
    sid       = "DeleteOwnAreaLocks"
    actions   = ["dynamodb:DeleteItem"]
    resources = [module.dynamodb.table_arns["area_locks"]]
  }
}

resource "aws_iam_role_policy" "agent_dev_area_lock_release" {
  name   = "${var.name_prefix}-dev-area-lock-release"
  role   = module.agent_dev.task_role_name
  policy = data.aws_iam_policy_document.agent_dev_area_lock_release.json
}

# ------------------------------------------------------------------------------
# Test agent role (Slice C — Sonnet 4.6, no area locks per CLAUDE.md
# concurrency model)
# ------------------------------------------------------------------------------

module "agent_test" {
  source = "../../modules/agent-role"

  name_prefix     = var.name_prefix
  role            = "test"
  env             = "dev"
  image_uri       = "${module.ecr_test.repository_url}:latest"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name
  cluster_arn     = module.ecs_cluster.cluster_arn

  subnets           = data.aws_subnets.default_public.ids
  security_group_id = aws_security_group.agent_tasks.id

  products_table_name = module.dynamodb.table_names["products"]

  extra_environment = {
    AGENT_FORGE_ISSUE_STATE_TABLE   = module.dynamodb.table_names["issue_state"]
    AGENT_FORGE_BUDGET_LEDGER_TABLE = module.dynamodb.table_names["budget_ledger"]
  }

  # Test reads products + issue_state (BA expansion + budget pre-check),
  # writes budget_ledger. No area_locks (doesn't lock per architecture).
  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
  }

  bedrock_model_arns = local.bedrock_invoke_arns["sonnet-4-6"]
}

# ------------------------------------------------------------------------------
# Step Functions: BA + Dev + Test issue-lifecycle state machines
# ------------------------------------------------------------------------------

module "step_functions" {
  source = "../../modules/step-functions"

  name_prefix              = var.name_prefix
  ba_task_definition_arn   = module.agent_ba.task_definition_arn
  ba_task_role_arn         = module.agent_ba.task_role_arn
  ba_execution_role_arn    = module.agent_ba.execution_role_arn
  dev_task_definition_arn  = module.agent_dev.task_definition_arn
  dev_task_role_arn        = module.agent_dev.task_role_arn
  dev_execution_role_arn   = module.agent_dev.execution_role_arn
  test_task_definition_arn = module.agent_test.task_definition_arn
  test_task_role_arn       = module.agent_test.task_role_arn
  test_execution_role_arn  = module.agent_test.execution_role_arn
  cluster_arn              = module.ecs_cluster.cluster_arn
  subnets                  = data.aws_subnets.default_public.ids
  security_group_id        = aws_security_group.agent_tasks.id
}

# ------------------------------------------------------------------------------
# EventBridge rule: webhook event "issues.labeled" + label.name = "state:idea"
# → BA state machine.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "state_idea_to_ba" {
  name           = "${var.name_prefix}-state-idea-to-ba"
  description    = "Issues labeled state:idea → BA state machine."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:idea"]
        }
      }
    }
  })
}

data "aws_iam_policy_document" "eb_to_sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "eb_to_sfn" {
  name               = "${var.name_prefix}-eb-to-sfn"
  assume_role_policy = data.aws_iam_policy_document.eb_to_sfn_assume.json
}

data "aws_iam_policy_document" "eb_to_sfn" {
  statement {
    sid       = "StartBAExecutions"
    actions   = ["states:StartExecution"]
    resources = [module.step_functions.ba_state_machine_arn]
  }

  statement {
    sid       = "StartDevExecutions"
    actions   = ["states:StartExecution"]
    resources = [module.step_functions.dev_state_machine_arn]
  }

  statement {
    sid       = "StartTestExecutions"
    actions   = ["states:StartExecution"]
    resources = [module.step_functions.test_state_machine_arn]
  }
}

resource "aws_iam_role_policy" "eb_to_sfn" {
  name   = "${var.name_prefix}-eb-to-sfn-policy"
  role   = aws_iam_role.eb_to_sfn.id
  policy = data.aws_iam_policy_document.eb_to_sfn.json
}

resource "aws_cloudwatch_event_target" "state_idea_to_ba" {
  rule           = aws_cloudwatch_event_rule.state_idea_to_ba.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "ba-state-machine"
  arn            = module.step_functions.ba_state_machine_arn
  role_arn       = aws_iam_role.eb_to_sfn.arn
}

# ------------------------------------------------------------------------------
# EventBridge rule: webhook event "issues.labeled" + label.name = "state:ready"
# → Dev state machine.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "state_ready_to_dev" {
  name           = "${var.name_prefix}-state-ready-to-dev"
  description    = "Issues labeled state:ready → Dev state machine."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:ready"]
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "state_ready_to_dev" {
  rule           = aws_cloudwatch_event_rule.state_ready_to_dev.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "dev-state-machine"
  arn            = module.step_functions.dev_state_machine_arn
  role_arn       = aws_iam_role.eb_to_sfn.arn
}

# ------------------------------------------------------------------------------
# EventBridge rule: webhook event "issues.labeled" + label.name =
# "state:awaiting-tests" → Test state machine.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "state_awaiting_tests_to_test" {
  name           = "${var.name_prefix}-state-awaiting-tests-to-test"
  description    = "Issues labeled state:awaiting-tests → Test state machine."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:awaiting-tests"]
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "state_awaiting_tests_to_test" {
  rule           = aws_cloudwatch_event_rule.state_awaiting_tests_to_test.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "test-state-machine"
  arn            = module.step_functions.test_state_machine_arn
  role_arn       = aws_iam_role.eb_to_sfn.arn
}
