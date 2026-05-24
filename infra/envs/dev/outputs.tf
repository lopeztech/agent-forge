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

output "ba_state_machine_arn" {
  value       = module.step_functions.ba_state_machine_arn
  description = "BA state machine ARN. Open in the Step Functions console to inspect executions."
}

output "ba_task_log_group" {
  value       = module.agent_ba.log_group_name
  description = "CloudWatch log group for the BA Fargate task's container output. `aws logs tail` here to see agent runs."
}

output "ba_image_repository_url" {
  value       = module.ecr_ba.repository_url
  description = "ECR repository the BA image is pushed to. The agent-images workflow tags :latest + :sha-<commit>."
}

output "dev_state_machine_arn" {
  value       = module.step_functions.dev_state_machine_arn
  description = "Dev state machine ARN. Open in the Step Functions console to inspect executions."
}

output "dev_task_log_group" {
  value       = module.agent_dev.log_group_name
  description = "CloudWatch log group for the Dev Fargate task's container output. `aws logs tail` here to see agent runs."
}

output "dev_image_repository_url" {
  value       = module.ecr_dev.repository_url
  description = "ECR repository the Dev image is pushed to. The agent-images workflow tags :latest + :sha-<commit>."
}

output "test_state_machine_arn" {
  value       = module.step_functions.test_state_machine_arn
  description = "Test state machine ARN."
}

output "test_task_log_group" {
  value       = module.agent_test.log_group_name
  description = "CloudWatch log group for the Test Fargate task's container output."
}

output "test_image_repository_url" {
  value       = module.ecr_test.repository_url
  description = "ECR repository the Test image is pushed to."
}

output "functional_state_machine_arn" {
  value       = module.step_functions.functional_state_machine_arn
  description = "Functional state machine ARN."
}

output "functional_task_log_group" {
  value       = module.agent_functional.log_group_name
  description = "CloudWatch log group for the Functional Fargate task's container output."
}

output "functional_image_repository_url" {
  value       = module.ecr_functional.repository_url
  description = "ECR repository the Functional image is pushed to."
}

output "security_state_machine_arn" {
  value       = module.step_functions.security_state_machine_arn
  description = "Security state machine ARN."
}

output "security_task_log_group" {
  value       = module.agent_security.log_group_name
  description = "CloudWatch log group for the Security Fargate task's container output."
}

output "security_image_repository_url" {
  value       = module.ecr_security.repository_url
  description = "ECR repository the Security image is pushed to."
}

output "po_state_machine_arn" {
  value       = module.step_functions.po_state_machine_arn
  description = "PO state machine ARN."
}

output "po_task_log_group" {
  value       = module.agent_po.log_group_name
  description = "CloudWatch log group for the PO Fargate task's container output."
}

output "po_image_repository_url" {
  value       = module.ecr_po.repository_url
  description = "ECR repository the PO image is pushed to."
}
