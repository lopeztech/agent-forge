output "table_names" {
  value       = { for k, t in aws_dynamodb_table.this : k => t.name }
  description = "Map of logical key → resolved DynamoDB table name."
}

output "table_arns" {
  value       = { for k, t in aws_dynamodb_table.this : k => t.arn }
  description = "Map of logical key → DynamoDB table ARN."
}
