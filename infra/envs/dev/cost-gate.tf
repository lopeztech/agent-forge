# ------------------------------------------------------------------------------
# Cost Estimator gate
#
# Slice B: between BA (state:idea → state:cost-estimating) and the future
# Dev role. Estimates per-issue spend via Haiku 4.5, posts a comment, and
# either auto-promotes to state:ready or parks at state:awaiting-cost-approval
# for /approve-cost.
#
# Composition:
#   - aws_cloudwatch_event_rule: matches issues.labeled with state:cost-estimating
#   - cost_estimator module: Lambda + IAM + log group + EB-invoke permission
#   - aws_cloudwatch_event_target: rule → Lambda
# ------------------------------------------------------------------------------

data "aws_region" "current" {}
data "aws_caller_identity" "current" {}

locals {
  # Haiku 4.5 in eu-west-1 is INFERENCE_PROFILE-only — direct on-demand
  # invocation of the foundation-model ID returns
  # "model not supported for on-demand throughput". We call via the EU
  # geographic cross-region inference profile (keeps inference inside EU
  # regions). Keep this in sync with shared/models.ts BEDROCK_MODEL_IDS.
  haiku_4_5_profile_id = "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
  haiku_4_5_model_id   = "anthropic.claude-haiku-4-5-20251001-v1:0"

  # IAM needs grants on:
  #   1. The inference profile ARN itself
  #   2. Every underlying foundation-model ARN the profile may route to.
  #      AWS surfaces "AccessDeniedException" with a misleading message if
  #      either set is missing.
  haiku_4_5_profile_arn = "arn:aws:bedrock:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:inference-profile/${local.haiku_4_5_profile_id}"

  haiku_4_5_eu_regions = [
    "eu-west-1",
    "eu-west-3",
    "eu-north-1",
    "eu-central-1",
    "eu-south-1",
    "eu-south-2",
  ]

  haiku_4_5_foundation_arns = [
    for r in local.haiku_4_5_eu_regions :
    "arn:aws:bedrock:${r}::foundation-model/${local.haiku_4_5_model_id}"
  ]

  bedrock_haiku_4_5_arns = concat(
    [local.haiku_4_5_profile_arn],
    local.haiku_4_5_foundation_arns,
  )
}

resource "aws_cloudwatch_event_rule" "state_cost_estimating_to_estimator" {
  name           = "${var.name_prefix}-state-cost-estimating-to-estimator"
  description    = "Issues labeled state:cost-estimating → Cost Estimator Lambda."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issues"]
    detail = {
      action = ["labeled"]
      payload = {
        label = {
          name = ["state:cost-estimating"]
        }
      }
    }
  })
}

module "cost_estimator" {
  source = "../../modules/cost-estimator"

  name_prefix     = var.name_prefix
  source_dir      = "${path.module}/../../glue/cost-estimator/dist"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name

  products_table_name      = module.dynamodb.table_names["products"]
  products_table_arn       = module.dynamodb.table_arns["products"]
  issue_state_table_name   = module.dynamodb.table_names["issue_state"]
  issue_state_table_arn    = module.dynamodb.table_arns["issue_state"]
  budget_ledger_table_name = module.dynamodb.table_names["budget_ledger"]
  budget_ledger_table_arn  = module.dynamodb.table_arns["budget_ledger"]

  bedrock_model_arns = local.bedrock_haiku_4_5_arns

  event_rule_arn = aws_cloudwatch_event_rule.state_cost_estimating_to_estimator.arn
}

resource "aws_cloudwatch_event_target" "state_cost_estimating_to_estimator" {
  rule           = aws_cloudwatch_event_rule.state_cost_estimating_to_estimator.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "cost-estimator-lambda"
  arn            = module.cost_estimator.function_arn
}

# ------------------------------------------------------------------------------
# Comment handler — /approve-cost and /cancel
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "issue_comment_to_handler" {
  name           = "${var.name_prefix}-issue-comment-to-handler"
  description    = "issue_comment.created → comment handler Lambda for /approve-cost and /cancel."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.webhook"]
    detail-type = ["issue_comment"]
    detail = {
      action = ["created"]
    }
  })
}

module "comment_handler" {
  source = "../../modules/comment-handler"

  name_prefix     = var.name_prefix
  source_dir      = "${path.module}/../../glue/comment-handler/dist"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name

  products_table_name = module.dynamodb.table_names["products"]
  products_table_arn  = module.dynamodb.table_arns["products"]

  event_rule_arn = aws_cloudwatch_event_rule.issue_comment_to_handler.arn
}

resource "aws_cloudwatch_event_target" "issue_comment_to_handler" {
  rule           = aws_cloudwatch_event_rule.issue_comment_to_handler.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "comment-handler-lambda"
  arn            = module.comment_handler.function_arn
}
