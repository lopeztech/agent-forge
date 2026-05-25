# ------------------------------------------------------------------------------
# Sweeper Lambda (Phase C).
#
# Subscribes to `area-lock-released` events that Dev emits on every successful
# lock release. Looks up the oldest waiter for the released (product, area)
# on lock_waiters, StartExecution's the Dev state machine for it, then
# DeleteItem's the waiter row.
#
# Dev's contention path writes a waiter row + exits cleanly (issue stays at
# state:ready). Without the sweeper, the issue would stay queued indefinitely
# until the next webhook re-fired Dev. The sweeper makes the queue actually
# drain.
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_event_rule" "area_lock_released_to_sweeper" {
  name           = "${var.name_prefix}-area-lock-released-to-sweeper"
  description    = "area-lock-released events → sweeper Lambda."
  event_bus_name = module.eventbridge.bus_name

  event_pattern = jsonencode({
    source      = ["agent-forge.area-locks"]
    detail-type = ["area-lock-released"]
  })
}

module "sweeper" {
  source = "../../modules/sweeper-lambda"

  name_prefix = var.name_prefix
  source_dir  = "${path.module}/../../glue/sweeper/dist"

  lock_waiters_table_name = module.dynamodb.table_names["lock_waiters"]
  lock_waiters_table_arn  = module.dynamodb.table_arns["lock_waiters"]

  dev_state_machine_arn = module.step_functions.dev_state_machine_arn

  event_rule_arn = aws_cloudwatch_event_rule.area_lock_released_to_sweeper.arn
}

resource "aws_cloudwatch_event_target" "area_lock_released_to_sweeper" {
  rule           = aws_cloudwatch_event_rule.area_lock_released_to_sweeper.name
  event_bus_name = module.eventbridge.bus_name
  target_id      = "sweeper-lambda"
  arn            = module.sweeper.function_arn
}
