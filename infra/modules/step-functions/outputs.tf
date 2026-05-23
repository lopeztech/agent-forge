output "ba_state_machine_arn" {
  value       = aws_sfn_state_machine.ba.arn
  description = "BA state machine ARN. Target of the EventBridge rule on state:idea labels."
}

output "ba_state_machine_name" {
  value       = aws_sfn_state_machine.ba.name
  description = "BA state machine name."
}

output "ba_log_group_name" {
  value       = aws_cloudwatch_log_group.ba.name
  description = "CloudWatch log group for BA state-machine execution events."
}

output "dev_state_machine_arn" {
  value       = aws_sfn_state_machine.dev.arn
  description = "Dev state machine ARN. Target of the EventBridge rule on state:ready labels."
}

output "dev_state_machine_name" {
  value       = aws_sfn_state_machine.dev.name
  description = "Dev state machine name."
}

output "dev_log_group_name" {
  value       = aws_cloudwatch_log_group.dev.name
  description = "CloudWatch log group for Dev state-machine execution events."
}
