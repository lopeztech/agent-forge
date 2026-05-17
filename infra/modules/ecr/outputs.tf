output "repository_url" {
  value       = aws_ecr_repository.this.repository_url
  description = "Repository URL. Combine with a tag to get an image URI (e.g. <repo_url>:latest)."
}

output "repository_arn" {
  value       = aws_ecr_repository.this.arn
  description = "Repository ARN. Used in execution-role IAM policies to scope ecr:Get* permissions."
}

output "repository_name" {
  value       = aws_ecr_repository.this.name
  description = "Repository name (e.g. \"agent-forge-dev/ba\"). Used by the image build workflow."
}
