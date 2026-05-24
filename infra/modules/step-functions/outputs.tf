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

output "test_state_machine_arn" {
  value       = aws_sfn_state_machine.test.arn
  description = "Test state machine ARN. Target of the EventBridge rule on state:awaiting-tests labels."
}

output "test_state_machine_name" {
  value       = aws_sfn_state_machine.test.name
  description = "Test state machine name."
}

output "test_log_group_name" {
  value       = aws_cloudwatch_log_group.test.name
  description = "CloudWatch log group for Test state-machine execution events."
}

output "functional_state_machine_arn" {
  value       = aws_sfn_state_machine.functional.arn
  description = "Functional state machine ARN. Target of the EventBridge rule on state:awaiting-functional labels."
}

output "functional_state_machine_name" {
  value       = aws_sfn_state_machine.functional.name
  description = "Functional state machine name."
}

output "functional_log_group_name" {
  value       = aws_cloudwatch_log_group.functional.name
  description = "CloudWatch log group for Functional state-machine execution events."
}

output "security_state_machine_arn" {
  value       = aws_sfn_state_machine.security.arn
  description = "Security state machine ARN. Target of the EventBridge rule on state:awaiting-security labels."
}

output "security_state_machine_name" {
  value       = aws_sfn_state_machine.security.name
  description = "Security state machine name."
}

output "security_log_group_name" {
  value       = aws_cloudwatch_log_group.security.name
  description = "CloudWatch log group for Security state-machine execution events."
}
