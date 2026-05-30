# ------------------------------------------------------------------------------
# CloudWatch dashboard — agent-forge platform overview.
#
# Companion to the `agent-forge status` CLI (scripts/status.ts). The CLI
# answers "what's happening right now?"; this dashboard answers "what
# trends look like over time?". All widgets pull from the custom metrics
# emitted by shared/metrics/emit.ts (namespace "agent-forge") via the
# `env` dimension to scope to dev/prod, plus native Step Functions metrics
# for the pipeline traceability row.
#
# Layout (top to bottom):
#   row 1   24h headline (total spend, run count, failure rate)
#   row 2   spend over time, broken down by role
#   row 3   cost estimator decisions
#   row 4   long-running jobs (drift audit + hydration)
#   row 5   pipeline traceability (executions started/failed per role)
# ------------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "agent_forge" {
  dashboard_name = "${var.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      # ----- Row 1: 24h headline numbers --------------------------------------
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 8
        height = 4
        properties = {
          metrics = [
            [
              "agent-forge", "RoleRunCost", "env", "dev", "role", "ba", { stat = "Sum", id = "ba" },
            ],
            ["...", "dev", { stat = "Sum", id = "dev_" }],
            ["...", "test", { stat = "Sum", id = "test_" }],
            ["...", "functional", { stat = "Sum", id = "func" }],
            ["...", "security", { stat = "Sum", id = "sec" }],
            ["...", "po", { stat = "Sum", id = "po" }],
          ]
          region = data.aws_region.current.name
          title  = "Spend by role (24h, $)"
          view   = "singleValue"
          period = 86400
        }
      },
      {
        type   = "metric"
        x      = 8
        y      = 0
        width  = 8
        height = 4
        properties = {
          metrics = [
            [
              "agent-forge", "RoleRunFinished", "env", "dev", "status", "succeeded",
              { stat = "Sum", id = "ok", label = "succeeded" },
            ],
            ["...", "failed", { stat = "Sum", id = "fail", label = "failed" }],
          ]
          region = data.aws_region.current.name
          title  = "Role-runs (24h)"
          view   = "singleValue"
          period = 86400
        }
      },
      {
        type   = "metric"
        x      = 16
        y      = 0
        width  = 8
        height = 4
        properties = {
          metrics = [
            [
              { expression = "100 * fail / (ok + fail)", label = "Failure rate %", id = "rate" },
            ],
            ["agent-forge", "RoleRunFinished", "env", "dev", "status", "succeeded", { stat = "Sum", id = "ok", visible = false }],
            ["...", "failed", { stat = "Sum", id = "fail", visible = false }],
          ]
          region = data.aws_region.current.name
          title  = "Failure rate (24h)"
          view   = "singleValue"
          period = 86400
        }
      },

      # ----- Row 2: spend over time by role -----------------------------------
      {
        type   = "metric"
        x      = 0
        y      = 4
        width  = 24
        height = 6
        properties = {
          metrics = [
            ["agent-forge", "RoleRunCost", "env", "dev", "role", "ba", { stat = "Sum" }],
            ["...", "dev", { stat = "Sum" }],
            ["...", "test", { stat = "Sum" }],
            ["...", "functional", { stat = "Sum" }],
            ["...", "security", { stat = "Sum" }],
            ["...", "po", { stat = "Sum" }],
          ]
          region  = data.aws_region.current.name
          title   = "Spend by role over time"
          view    = "timeSeries"
          stacked = true
          period  = 3600
        }
      },

      # ----- Row 3: cost estimator decisions ----------------------------------
      {
        type   = "metric"
        x      = 0
        y      = 10
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["agent-forge", "CostEstimatorRun", "env", "dev", "decision", "auto-approved", { stat = "Sum" }],
            ["...", "parked", { stat = "Sum" }],
            ["...", "rejected-above-cap", { stat = "Sum" }],
            ["...", "failed", { stat = "Sum" }],
          ]
          region  = data.aws_region.current.name
          title   = "Cost-estimator decisions"
          view    = "timeSeries"
          stacked = true
          period  = 3600
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 10
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["agent-forge", "CostEstimateP50", "env", "dev", { stat = "Average", label = "p50 avg ($)" }],
            ["...", { stat = "Maximum", label = "p50 max ($)" }],
          ]
          region = data.aws_region.current.name
          title  = "Estimated cost per issue"
          view   = "timeSeries"
          period = 3600
        }
      },

      # ----- Row 4: long-running jobs ----------------------------------------
      {
        type   = "metric"
        x      = 0
        y      = 16
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["agent-forge", "DriftAuditChecked", "env", "dev", { stat = "Sum", label = "checked" }],
            ["agent-forge", "DriftAuditDrifted", "env", "dev", { stat = "Sum", label = "drifted" }],
            ["agent-forge", "DriftAuditFiled", "env", "dev", { stat = "Sum", label = "filed" }],
          ]
          region = data.aws_region.current.name
          title  = "Drift audit (weekly runs)"
          view   = "timeSeries"
          period = 86400
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 16
        width  = 12
        height = 6
        properties = {
          metrics = [
            ["agent-forge", "HydrationGapsFiled", "env", "dev", { stat = "Sum", label = "gaps filed" }],
            ["agent-forge", "HydrationCost", "env", "dev", { stat = "Sum", label = "cost ($)" }],
          ]
          region = data.aws_region.current.name
          title  = "Backlog hydration (nightly)"
          view   = "timeSeries"
          period = 86400
        }
      },

      # ----- Row 5: pipeline traceability — executions started per role --------
      {
        type   = "metric"
        x      = 0
        y      = 22
        width  = 24
        height = 6
        properties = {
          metrics = [
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", module.step_functions.ba_state_machine_arn, { stat = "Sum", label = "ba started" }],
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", module.step_functions.dev_state_machine_arn, { stat = "Sum", label = "dev started" }],
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", module.step_functions.test_state_machine_arn, { stat = "Sum", label = "test started" }],
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", module.step_functions.functional_state_machine_arn, { stat = "Sum", label = "functional started" }],
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", module.step_functions.security_state_machine_arn, { stat = "Sum", label = "security started" }],
            ["AWS/States", "ExecutionsStarted", "StateMachineArn", module.step_functions.po_state_machine_arn, { stat = "Sum", label = "po started" }],
          ]
          region  = data.aws_region.current.name
          title   = "Pipeline executions started by role"
          view    = "timeSeries"
          stacked = false
          period  = 3600
        }
      },

      # ----- Row 6: pipeline failures + timeouts per role ---------------------
      {
        type   = "metric"
        x      = 0
        y      = 28
        width  = 24
        height = 6
        properties = {
          metrics = [
            ["AWS/States", "ExecutionsFailed", "StateMachineArn", module.step_functions.ba_state_machine_arn, { stat = "Sum", label = "ba failed" }],
            ["AWS/States", "ExecutionsFailed", "StateMachineArn", module.step_functions.dev_state_machine_arn, { stat = "Sum", label = "dev failed" }],
            ["AWS/States", "ExecutionsFailed", "StateMachineArn", module.step_functions.test_state_machine_arn, { stat = "Sum", label = "test failed" }],
            ["AWS/States", "ExecutionsFailed", "StateMachineArn", module.step_functions.functional_state_machine_arn, { stat = "Sum", label = "functional failed" }],
            ["AWS/States", "ExecutionsFailed", "StateMachineArn", module.step_functions.security_state_machine_arn, { stat = "Sum", label = "security failed" }],
            ["AWS/States", "ExecutionsFailed", "StateMachineArn", module.step_functions.po_state_machine_arn, { stat = "Sum", label = "po failed" }],
            ["AWS/States", "ExecutionsTimedOut", "StateMachineArn", module.step_functions.dev_state_machine_arn, { stat = "Sum", label = "dev timed out" }],
            ["AWS/States", "ExecutionsTimedOut", "StateMachineArn", module.step_functions.test_state_machine_arn, { stat = "Sum", label = "test timed out" }],
          ]
          region  = data.aws_region.current.name
          title   = "Pipeline failures and timeouts by role"
          view    = "timeSeries"
          stacked = false
          period  = 3600
        }
      },
    ]
  })
}
