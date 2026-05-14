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
