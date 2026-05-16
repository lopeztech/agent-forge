output "function_arn" {
  value       = aws_lambda_function.this.arn
  description = "Lambda function ARN. Used by the API Gateway module for the integration target."
}

output "function_name" {
  value       = aws_lambda_function.this.function_name
  description = "Lambda function name. Used by API Gateway invoke-permission resources."
}

output "log_group_name" {
  value       = aws_cloudwatch_log_group.this.name
  description = "CloudWatch log group for the function's own logs. `aws logs tail` here to debug verifier behavior."
}
