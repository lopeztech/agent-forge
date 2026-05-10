output "dynamodb_table_names" {
  value       = module.dynamodb.table_names
  description = "Map of logical table key → resolved DynamoDB table name."
}

output "dynamodb_table_arns" {
  value       = module.dynamodb.table_arns
  description = "Map of logical table key → DynamoDB table ARN."
}
