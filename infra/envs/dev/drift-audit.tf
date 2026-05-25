# ------------------------------------------------------------------------------
# Drift audit (Phase D2).
#
# Weekly EventBridge Scheduler invocation of the drift-audit Lambda. The
# Lambda walks every product, samples N recently-merged issues with stored
# spec_hashes_at_merge, compares them against the current spec, and files
# state:idea issues for any drift.
#
# Schedule: Mondays at 09:00 UTC. Quiet hours in EU and east-coast US, just
# before the start of the work week — drift findings show up in the backlog
# for BA to start expanding on Monday morning.
# ------------------------------------------------------------------------------

resource "aws_iam_role" "drift_audit_scheduler" {
  name = "${var.name_prefix}-drift-audit-scheduler"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "scheduler.amazonaws.com" }
        Action    = "sts:AssumeRole"
      },
    ]
  })
}

resource "aws_iam_role_policy" "drift_audit_scheduler_invoke" {
  name = "${var.name_prefix}-drift-audit-scheduler-invoke"
  role = aws_iam_role.drift_audit_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.drift_audit.function_arn
      },
    ]
  })
}

resource "aws_scheduler_schedule" "drift_audit_weekly" {
  name       = "${var.name_prefix}-drift-audit-weekly"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  # Mondays at 09:00 UTC. Use cron(...) so daylight savings doesn't shift it.
  schedule_expression          = "cron(0 9 ? * MON *)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = module.drift_audit.function_arn
    role_arn = aws_iam_role.drift_audit_scheduler.arn
    # Lambda gets an empty payload — the handler treats it as ScheduledEvent.
    input = "{}"
  }
}

module "drift_audit" {
  source = "../../modules/drift-audit-lambda"

  name_prefix     = var.name_prefix
  source_dir      = "${path.module}/../../glue/drift-audit/dist"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name

  products_table_name    = module.dynamodb.table_names["products"]
  products_table_arn     = module.dynamodb.table_arns["products"]
  issue_state_table_name = module.dynamodb.table_names["issue_state"]
  issue_state_table_arn  = module.dynamodb.table_arns["issue_state"]

  schedule_arn = aws_scheduler_schedule.drift_audit_weekly.arn
}
