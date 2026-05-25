output "bucket_arn" {
  value       = aws_s3_bucket.this.arn
  description = "Forensic-artifacts bucket ARN. Pass to agent-role modules so each agent can PutObject."
}

output "bucket_name" {
  value       = aws_s3_bucket.this.id
  description = "Forensic-artifacts bucket name. Passed to the agent container as AGENT_FORGE_FORENSIC_BUCKET."
}
