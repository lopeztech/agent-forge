output "webhook_url" {
  value       = "${aws_apigatewayv2_stage.default.invoke_url}/webhook"
  description = "Public HTTPS URL the GitHub App webhook configs should point at."
}

output "api_id" {
  value       = aws_apigatewayv2_api.this.id
  description = "HTTP API ID."
}

output "access_log_group_name" {
  value       = aws_cloudwatch_log_group.access.name
  description = "CloudWatch log group for API Gateway access logs."
}
