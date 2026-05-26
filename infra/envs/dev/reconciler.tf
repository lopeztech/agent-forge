# ------------------------------------------------------------------------------
# Orphan reconciler (issue #81).
#
# Level-triggered backstop for the edge-triggered label routing. Every 20 min it
# scans each product's open issues and re-fires any that are parked at a routable
# state:* label with no recent execution on the matching role state machine —
# the failure mode that stranded #44 for two days when its `labeled` event fired
# before the Test routing rule existed.
#
# Schedule: every 20 minutes. Cheap (GitHub list + a few SFN calls per product),
# and the bucketed execution names make repeated ticks idempotent.
# ------------------------------------------------------------------------------

resource "aws_iam_role" "reconciler_scheduler" {
  name = "${var.name_prefix}-reconciler-scheduler"
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

resource "aws_iam_role_policy" "reconciler_scheduler_invoke" {
  name = "${var.name_prefix}-reconciler-scheduler-invoke"
  role = aws_iam_role.reconciler_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.reconciler.function_arn
      },
    ]
  })
}

resource "aws_scheduler_schedule" "reconciler_periodic" {
  name       = "${var.name_prefix}-reconciler-periodic"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "rate(20 minutes)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = module.reconciler.function_arn
    role_arn = aws_iam_role.reconciler_scheduler.arn
    input    = "{}"
  }
}

module "reconciler" {
  source = "../../modules/reconciler-lambda"

  name_prefix     = var.name_prefix
  source_dir      = "${path.module}/../../glue/reconciler/dist"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name

  products_table_name = module.dynamodb.table_names["products"]
  products_table_arn  = module.dynamodb.table_arns["products"]

  state_machine_arns = {
    ba         = module.step_functions.ba_state_machine_arn
    dev        = module.step_functions.dev_state_machine_arn
    test       = module.step_functions.test_state_machine_arn
    functional = module.step_functions.functional_state_machine_arn
    security   = module.step_functions.security_state_machine_arn
    po         = module.step_functions.po_state_machine_arn
  }

  schedule_arn = aws_scheduler_schedule.reconciler_periodic.arn
}
