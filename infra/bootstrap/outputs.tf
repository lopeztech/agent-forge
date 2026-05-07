output "state_bucket_name" {
  value       = aws_s3_bucket.tfstate.id
  description = "Name of the S3 bucket holding Terraform state for all agent-forge modules."
}

output "state_bucket_arn" {
  value       = aws_s3_bucket.tfstate.arn
  description = "ARN of the state bucket."
}

output "lock_table_name" {
  value       = aws_dynamodb_table.tflock.name
  description = "DynamoDB table used by Terraform for state locking."
}

output "kms_key_arn" {
  value       = aws_kms_key.tfstate.arn
  description = "KMS key ARN used to encrypt state objects."
}

output "kms_alias" {
  value       = aws_kms_alias.tfstate.name
  description = "Friendly alias for the state-encryption KMS key."
}
