output "bus_name" {
  value       = aws_cloudwatch_event_bus.this.name
  description = "Custom EventBridge bus name. The verifier Lambda passes this as EventBusName on PutEvents."
}

output "bus_arn" {
  value       = aws_cloudwatch_event_bus.this.arn
  description = "Custom EventBridge bus ARN. Used to scope events:PutEvents in the verifier Lambda's IAM policy."
}

output "catch_all_log_group_name" {
  value       = aws_cloudwatch_log_group.catch_all.name
  description = "CloudWatch log group that mirrors every event on the bus. `aws logs tail` here to debug webhook delivery."
}
