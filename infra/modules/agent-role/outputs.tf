output "task_definition_arn" {
  value       = aws_ecs_task_definition.this.arn
  description = "Versioned task-definition ARN. Step Functions RunTask uses this."
}

output "task_definition_family" {
  value       = aws_ecs_task_definition.this.family
  description = "Family name (without revision). Pass to Step Functions if you want it to always grab the latest revision."
}

output "task_role_arn" {
  value       = aws_iam_role.task.arn
  description = "Task role ARN (the role the agent code runs as)."
}

output "execution_role_arn" {
  value       = aws_iam_role.execution.arn
  description = "Execution role ARN (Fargate uses this to pull the image + write logs)."
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.this.name
  description = "CloudWatch log group for the task's container logs."
}
