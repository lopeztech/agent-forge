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

module "ecr_functional" {
  source = "../../modules/ecr"

  repository_name = "${var.name_prefix}/functional"
}

module "ecr_security" {
  source = "../../modules/ecr"

  repository_name = "${var.name_prefix}/security"
}

module "ecr_po" {
  source = "../../modules/ecr"

  repository_name = "${var.name_prefix}/po"
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
    AGENT_FORGE_RATE_LIMITS_TABLE   = module.dynamodb.table_names["rate_limits"]
    AGENT_FORGE_FORENSIC_BUCKET     = module.forensic_artifacts.bucket_name
  }

  # BA needs read on products (issue trigger lookup) and write on
  # budget_ledger + issue_state + team_memory + area_locks.
  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    rate_limits   = module.dynamodb.table_arns["rate_limits"]
    area_locks    = module.dynamodb.table_arns["area_locks"]
  }

  forensic_bucket_arn = module.forensic_artifacts.bucket_arn

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
    AGENT_FORGE_RATE_LIMITS_TABLE   = module.dynamodb.table_names["rate_limits"]
    AGENT_FORGE_AREA_LOCKS_TABLE    = module.dynamodb.table_names["area_locks"]
    AGENT_FORGE_LOCK_WAITERS_TABLE  = module.dynamodb.table_names["lock_waiters"]
    AGENT_FORGE_FORENSIC_BUCKET     = module.forensic_artifacts.bucket_name
    # Phase C: shared/locks/area-locks.ts PutEvents `area-lock-released`
    # here on every successful release. The sweeper Lambda subscribes via
    # an EventBridge rule on the same bus.
    AGENT_FORGE_EVENT_BUS_NAME = module.eventbridge.bus_name
  }

  # Dev needs read on products + the same write surface as BA, plus area_locks
  # (Get/Put/Update for the conditional-write acquire path, Delete via the
  # broader policy below). Phase C adds lock_waiters (Put/Query/Delete via
  # the broader policy).
  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    rate_limits   = module.dynamodb.table_arns["rate_limits"]
    area_locks    = module.dynamodb.table_arns["area_locks"]
    lock_waiters  = module.dynamodb.table_arns["lock_waiters"]
  }

  forensic_bucket_arn = module.forensic_artifacts.bucket_arn

  # Phase C: events:PutEvents to the agent-forge bus for `area-lock-released`.
  event_bus_arn = module.eventbridge.bus_arn

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
    AGENT_FORGE_RATE_LIMITS_TABLE   = module.dynamodb.table_names["rate_limits"]
    AGENT_FORGE_FORENSIC_BUCKET     = module.forensic_artifacts.bucket_name
  }

  # Test reads products + issue_state (BA expansion + budget pre-check),
  # writes budget_ledger. No area_locks (doesn't lock per architecture).
  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    rate_limits   = module.dynamodb.table_arns["rate_limits"]
  }

  forensic_bucket_arn = module.forensic_artifacts.bucket_arn

  bedrock_model_arns = local.bedrock_invoke_arns["sonnet-4-6"]
}

# ------------------------------------------------------------------------------
# Functional agent role (Slice D.1 — Sonnet 4.6, no area locks, read-only on
# the PR branch; bash to run smoke/test scripts)
# ------------------------------------------------------------------------------

module "agent_functional" {
  source = "../../modules/agent-role"

  name_prefix     = var.name_prefix
  role            = "functional"
  env             = "dev"
  image_uri       = "${module.ecr_functional.repository_url}:latest"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name
  cluster_arn     = module.ecs_cluster.cluster_arn

  subnets           = data.aws_subnets.default_public.ids
  security_group_id = aws_security_group.agent_tasks.id

  products_table_name = module.dynamodb.table_names["products"]

  extra_environment = {
    AGENT_FORGE_ISSUE_STATE_TABLE   = module.dynamodb.table_names["issue_state"]
    AGENT_FORGE_BUDGET_LEDGER_TABLE = module.dynamodb.table_names["budget_ledger"]
    AGENT_FORGE_RATE_LIMITS_TABLE   = module.dynamodb.table_names["rate_limits"]
    AGENT_FORGE_FORENSIC_BUCKET     = module.forensic_artifacts.bucket_name
  }

  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    rate_limits   = module.dynamodb.table_arns["rate_limits"]
  }

  forensic_bucket_arn = module.forensic_artifacts.bucket_arn

  bedrock_model_arns = local.bedrock_invoke_arns["sonnet-4-6"]
}

# ------------------------------------------------------------------------------
# Security agent role (Slice E.1 — Sonnet 4.6, read-only on PR branch, bash
# for npm audit and ad-hoc inspection)
# ------------------------------------------------------------------------------

module "agent_security" {
  source = "../../modules/agent-role"

  name_prefix     = var.name_prefix
  role            = "security"
  env             = "dev"
  image_uri       = "${module.ecr_security.repository_url}:latest"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name
  cluster_arn     = module.ecs_cluster.cluster_arn

  subnets           = data.aws_subnets.default_public.ids
  security_group_id = aws_security_group.agent_tasks.id

  products_table_name = module.dynamodb.table_names["products"]

  extra_environment = {
    AGENT_FORGE_ISSUE_STATE_TABLE   = module.dynamodb.table_names["issue_state"]
    AGENT_FORGE_BUDGET_LEDGER_TABLE = module.dynamodb.table_names["budget_ledger"]
    AGENT_FORGE_RATE_LIMITS_TABLE   = module.dynamodb.table_names["rate_limits"]
    AGENT_FORGE_FORENSIC_BUCKET     = module.forensic_artifacts.bucket_name
  }

  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    rate_limits   = module.dynamodb.table_arns["rate_limits"]
  }

  forensic_bucket_arn = module.forensic_artifacts.bucket_arn

  bedrock_model_arns = local.bedrock_invoke_arns["sonnet-4-6"]
}

# ------------------------------------------------------------------------------
# PO agent role (Slice F.1 — Opus 4.6 review-only; doesn't merge, just
# posts a recommend-merge / kickback comment + parks at human-needed)
# ------------------------------------------------------------------------------

module "agent_po" {
  source = "../../modules/agent-role"

  name_prefix     = var.name_prefix
  role            = "po"
  env             = "dev"
  image_uri       = "${module.ecr_po.repository_url}:latest"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name
  cluster_arn     = module.ecs_cluster.cluster_arn

  subnets           = data.aws_subnets.default_public.ids
  security_group_id = aws_security_group.agent_tasks.id

  products_table_name = module.dynamodb.table_names["products"]

  # F.2.a: PO needs the merger App's secret NAME exposed so it can mint a
  # merger installation token when products.auto_merge is true. The reads
  # permission for the merger secret is granted via an inline policy
  # below (agent-role only grants reads on the single primary secret).
  extra_environment = {
    AGENT_FORGE_ISSUE_STATE_TABLE   = module.dynamodb.table_names["issue_state"]
    AGENT_FORGE_BUDGET_LEDGER_TABLE = module.dynamodb.table_names["budget_ledger"]
    AGENT_FORGE_RATE_LIMITS_TABLE   = module.dynamodb.table_names["rate_limits"]
    AGENT_FORGE_MERGER_SECRET_NAME  = module.secrets.merger_secret_name
    AGENT_FORGE_FORENSIC_BUCKET     = module.forensic_artifacts.bucket_name
  }

  dynamodb_table_arns = {
    products      = module.dynamodb.table_arns["products"]
    issue_state   = module.dynamodb.table_arns["issue_state"]
    team_memory   = module.dynamodb.table_arns["team_memory"]
    budget_ledger = module.dynamodb.table_arns["budget_ledger"]
    rate_limits   = module.dynamodb.table_arns["rate_limits"]
  }

  forensic_bucket_arn = module.forensic_artifacts.bucket_arn

  # PO runs on Opus 4.6 (best-available Opus; 4.7 gated behind AWS Sales
  # on this account).
  bedrock_model_arns = local.bedrock_invoke_arns["opus-4-6"]
}

# F.2.a: grant PO's task role reads on the merger secret too. The base
# agent-role module grants only the primary (writer) secret; PO is the one
# role that needs both. Inline here rather than widening the module shape
# since PO is the only consumer for the foreseeable future.
data "aws_iam_policy_document" "agent_po_merger_secret" {
  statement {
    sid       = "ReadMergerSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [module.secrets.merger_secret_arn]
  }
}

resource "aws_iam_role_policy" "agent_po_merger_secret" {
  name   = "${var.name_prefix}-po-merger-secret"
  role   = module.agent_po.task_role_name
  policy = data.aws_iam_policy_document.agent_po_merger_secret.json
}

# ------------------------------------------------------------------------------
# Step Functions: BA + Dev + Test + Functional + Security + PO state machines
# ------------------------------------------------------------------------------

module "step_functions" {
  source = "../../modules/step-functions"

  name_prefix                    = var.name_prefix
  ba_task_definition_arn         = module.agent_ba.task_definition_arn
  ba_task_role_arn               = module.agent_ba.task_role_arn
  ba_execution_role_arn          = module.agent_ba.execution_role_arn
  dev_task_definition_arn        = module.agent_dev.task_definition_arn
  dev_task_role_arn              = module.agent_dev.task_role_arn
  dev_execution_role_arn         = module.agent_dev.execution_role_arn
  test_task_definition_arn       = module.agent_test.task_definition_arn
  test_task_role_arn             = module.agent_test.task_role_arn
  test_execution_role_arn        = module.agent_test.execution_role_arn
  functional_task_definition_arn = module.agent_functional.task_definition_arn
  functional_task_role_arn       = module.agent_functional.task_role_arn
  functional_execution_role_arn  = module.agent_functional.execution_role_arn
  security_task_definition_arn   = module.agent_security.task_definition_arn
  security_task_role_arn         = module.agent_security.task_role_arn
  security_execution_role_arn    = module.agent_security.execution_role_arn
  po_task_definition_arn         = module.agent_po.task_definition_arn
  po_task_role_arn               = module.agent_po.task_role_arn
  po_execution_role_arn          = module.agent_po.execution_role_arn
  cluster_arn                    = module.ecs_cluster.cluster_arn
  subnets                        = data.aws_subnets.default_public.ids
  security_group_id              = aws_security_group.agent_tasks.id
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

  statement {
    sid       = "StartFunctionalExecutions"
    actions   = ["states:StartExecution"]
    resources = [module.step_functions.functional_state_machine_arn]
  }

  statement {
    sid       = "StartSecurityExecutions"
    actions   = ["states:StartExecution"]
    resources = [module.step_functions.security_state_machine_arn]
  }

  statement {
    sid       = "StartPoExecutions"
    actions   = ["states:StartExecution"]
    resources = [module.step_functions.po_state_machine_arn]
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

# ------------------------------------------------------------------------------
# EventBridge rule: state:awaiting-functional → Functional state machine.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "state_awaiting_functional_to_functional" {
  name           = "${var.name_prefix}-state-awaiting-functional-to-functional"
  description    = "Issues labeled state:awaiting-functional → Functional state machine."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:awaiting-functional"]
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "state_awaiting_functional_to_functional" {
  rule           = aws_cloudwatch_event_rule.state_awaiting_functional_to_functional.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "functional-state-machine"
  arn            = module.step_functions.functional_state_machine_arn
  role_arn       = aws_iam_role.eb_to_sfn.arn
}

# ------------------------------------------------------------------------------
# EventBridge rule: state:awaiting-security → Security state machine.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "state_awaiting_security_to_security" {
  name           = "${var.name_prefix}-state-awaiting-security-to-security"
  description    = "Issues labeled state:awaiting-security → Security state machine."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:awaiting-security"]
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "state_awaiting_security_to_security" {
  rule           = aws_cloudwatch_event_rule.state_awaiting_security_to_security.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "security-state-machine"
  arn            = module.step_functions.security_state_machine_arn
  role_arn       = aws_iam_role.eb_to_sfn.arn
}

# ------------------------------------------------------------------------------
# EventBridge rule: state:awaiting-po → PO state machine.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "state_awaiting_po_to_po" {
  name           = "${var.name_prefix}-state-awaiting-po-to-po"
  description    = "Issues labeled state:awaiting-po → PO state machine."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:awaiting-po"]
        }
      }
    }
  })
}

resource "aws_cloudwatch_event_target" "state_awaiting_po_to_po" {
  rule           = aws_cloudwatch_event_rule.state_awaiting_po_to_po.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "po-state-machine"
  arn            = module.step_functions.po_state_machine_arn
  role_arn       = aws_iam_role.eb_to_sfn.arn
}
