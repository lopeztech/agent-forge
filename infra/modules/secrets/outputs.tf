output "writer_secret_arn" {
  value       = aws_secretsmanager_secret.writer.arn
  description = "ARN of the agent-forge-writer App credentials secret. Used in IAM policies for BA/Dev/Test/Functional/Security task roles."
}

output "writer_secret_name" {
  value       = aws_secretsmanager_secret.writer.name
  description = "Name of the writer secret. Passed to runtime code that calls GetSecretValue."
}

output "merger_secret_arn" {
  value       = aws_secretsmanager_secret.merger.arn
  description = "ARN of the agent-forge-merger App credentials secret. Used in the PO task role policy."
}

output "merger_secret_name" {
  value       = aws_secretsmanager_secret.merger.name
  description = "Name of the merger secret. Passed to runtime code that calls GetSecretValue."
}

output "webhook_secret_arn" {
  value       = aws_secretsmanager_secret.webhook_signing_secret.arn
  description = "ARN of the shared webhook signing secret. Used in the webhook verifier Lambda's IAM policy."
}

output "webhook_secret_name" {
  value       = aws_secretsmanager_secret.webhook_signing_secret.name
  description = "Name of the webhook signing secret."
}
