# Custom bus that the webhook-verifier Lambda puts events onto. Per-env so
# dev/prod can coexist in the same account if ever needed; today they live
# in separate accounts.
resource "aws_cloudwatch_event_bus" "this" {
  name = var.name_prefix
}

# Catch-all rule + CloudWatch target. Every event landing on the bus is
# mirrored to a log group so we can verify webhook delivery end-to-end
# before any role-specific rules exist. Role rules add themselves to the
# same bus later and run in parallel with this rule.
resource "aws_cloudwatch_log_group" "catch_all" {
  name              = "/aws/events/${var.name_prefix}/catch-all"
  retention_in_days = var.catch_all_log_retention_days
}

resource "aws_cloudwatch_event_rule" "catch_all" {
  name           = "${var.name_prefix}-catch-all"
  description    = "Mirrors every event on the agent-forge bus to CloudWatch Logs for debugging."
  event_bus_name = aws_cloudwatch_event_bus.this.name
  # Match any event with a source attribute. Every PutEvents call sets one,
  # so this is effectively "match everything we send."
  event_pattern = jsonencode({
    source = [{ exists = true }]
  })
}

resource "aws_cloudwatch_event_target" "catch_all_logs" {
  rule           = aws_cloudwatch_event_rule.catch_all.name
  event_bus_name = aws_cloudwatch_event_bus.this.name
  target_id      = "catch-all-cwlogs"
  arn            = aws_cloudwatch_log_group.catch_all.arn
}

# EventBridge writes to CloudWatch Logs via a resource policy on the log
# group, not via an IAM role on the rule.
data "aws_iam_policy_document" "catch_all_log_policy" {
  statement {
    sid    = "AllowEventBridgeToWriteLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.catch_all.arn}:*"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
    # Scope the policy to events originating from our bus.
    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.catch_all.arn]
    }
  }
}

resource "aws_cloudwatch_log_resource_policy" "catch_all" {
  policy_name     = "${var.name_prefix}-catch-all-events"
  policy_document = data.aws_iam_policy_document.catch_all_log_policy.json
}
