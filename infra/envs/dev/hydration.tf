# ------------------------------------------------------------------------------
# Backlog hydration (Phase D3).
#
# Nightly Lambda that walks every product, calls Sonnet 4.6 once per product
# with the full spec/ in the cached prefix + open issues as the suffix, and
# files state:idea issues for any gaps the model identifies.
#
# Schedule: 03:00 UTC daily. Quiet hours globally; gap issues land on the
# backlog overnight so BA can pick them up via the standard state:idea →
# state:cost-estimating flow first thing.
# ------------------------------------------------------------------------------

resource "aws_iam_role" "hydration_scheduler" {
  name = "${var.name_prefix}-hydration-scheduler"
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

resource "aws_iam_role_policy" "hydration_scheduler_invoke" {
  name = "${var.name_prefix}-hydration-scheduler-invoke"
  role = aws_iam_role.hydration_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "lambda:InvokeFunction"
        Resource = module.hydration.function_arn
      },
    ]
  })
}

resource "aws_scheduler_schedule" "hydration_nightly" {
  name       = "${var.name_prefix}-hydration-nightly"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = "cron(0 3 * * ? *)"
  schedule_expression_timezone = "UTC"

  target {
    arn      = module.hydration.function_arn
    role_arn = aws_iam_role.hydration_scheduler.arn
    input    = "{}"
  }
}

module "hydration" {
  source = "../../modules/hydration-lambda"

  name_prefix     = var.name_prefix
  source_dir      = "${path.module}/../../glue/hydration/dist"
  env             = "dev"
  app_secret_arn  = module.secrets.writer_secret_arn
  app_secret_name = module.secrets.writer_secret_name

  products_table_name      = module.dynamodb.table_names["products"]
  products_table_arn       = module.dynamodb.table_arns["products"]
  budget_ledger_table_name = module.dynamodb.table_names["budget_ledger"]
  budget_ledger_table_arn  = module.dynamodb.table_arns["budget_ledger"]
  rate_limits_table_name   = module.dynamodb.table_names["rate_limits"]
  rate_limits_table_arn    = module.dynamodb.table_arns["rate_limits"]

  bedrock_model_arns = local.bedrock_invoke_arns["sonnet-4-6"]

  schedule_arn = aws_scheduler_schedule.hydration_nightly.arn
}
