variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "webhook_secret_arn" {
  type        = string
  description = "ARN of the Secrets Manager entry holding the shared webhook signing secret."
}

variable "webhook_secret_name" {
  type        = string
  description = "Name of the webhook signing secret, passed to the Lambda via WEBHOOK_SECRET_NAME."
}

variable "products_table_name" {
  type        = string
  description = "DynamoDB products table name."
}

variable "products_table_arn" {
  type        = string
  description = "DynamoDB products table ARN (for the IAM policy)."
}

variable "products_repo_index_name" {
  type        = string
  description = "Name of the products GSI mapping repo_full_name → product_id."
}

variable "products_repo_index_arn" {
  type        = string
  description = "ARN of the products GSI (for the IAM policy)."
}

variable "event_bus_name" {
  type        = string
  description = "Custom EventBridge bus the Lambda PutEvents to."
}

variable "event_bus_arn" {
  type        = string
  description = "Custom EventBridge bus ARN (for the IAM policy)."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/webhook-verifier/dist). package.sh must have been run before terraform plan/apply."
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 14
}
