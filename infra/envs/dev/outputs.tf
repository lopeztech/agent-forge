output "dynamodb_table_names" {
  value       = module.dynamodb.table_names
  description = "Map of logical table key → resolved DynamoDB table name."
}

output "dynamodb_table_arns" {
  value       = module.dynamodb.table_arns
  description = "Map of logical table key → DynamoDB table ARN."
}

output "github_app_secret_names" {
  value = {
    writer  = module.secrets.writer_secret_name
    merger  = module.secrets.merger_secret_name
    webhook = module.secrets.webhook_secret_name
  }
  description = "Resolved Secrets Manager names for GitHub App credentials and the webhook signing secret. Smoke test and webhook verifier read these by name."
}

output "github_app_secret_arns" {
  value = {
    writer  = module.secrets.writer_secret_arn
    merger  = module.secrets.merger_secret_arn
    webhook = module.secrets.webhook_secret_arn
  }
  description = "ARNs for least-privilege IAM policy attachment on the Fargate task roles and webhook verifier Lambda."
}

output "webhook_url" {
  value       = module.api_gateway.webhook_url
  description = "Public HTTPS URL to paste into both GitHub Apps' webhook config. POSTs from GitHub land here."
}

output "event_bus_name" {
  value       = module.eventbridge.bus_name
  description = "Custom EventBridge bus name. Role-specific rules attach to this bus."
}

output "event_log_groups" {
  value = {
    catch_all       = module.eventbridge.catch_all_log_group_name
    apigw_access    = module.api_gateway.access_log_group_name
    verifier_lambda = module.webhook_verifier.log_group_name
  }
  description = "CloudWatch log groups for debugging webhook ingress end-to-end."
}
