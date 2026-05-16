output "table_names" {
  value       = { for k, t in aws_dynamodb_table.this : k => t.name }
  description = "Map of logical key → resolved DynamoDB table name."
}

output "table_arns" {
  value       = { for k, t in aws_dynamodb_table.this : k => t.arn }
  description = "Map of logical key → DynamoDB table ARN."
}

output "products_repo_index_name" {
  value       = "repo_full_name-index"
  description = "Name of the GSI on the products table that maps repo_full_name → product_id. Used by the webhook verifier."
}

output "products_repo_index_arn" {
  value       = "${aws_dynamodb_table.this["products"].arn}/index/repo_full_name-index"
  description = "ARN of the products repo_full_name-index GSI. Used to scope dynamodb:Query in the verifier Lambda's IAM policy."
}
