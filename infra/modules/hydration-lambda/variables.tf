variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/hydration/dist). package.sh must have been run before terraform plan/apply."
}

variable "env" {
  type        = string
  description = "Deployment environment name used for CloudWatch metric dimensions."
}

variable "app_secret_arn" {
  type        = string
  description = "ARN of the writer App Secrets Manager entry."
}

variable "app_secret_name" {
  type        = string
  description = "Name of the writer App secret, passed to the Lambda via APP_SECRET_NAME."
}

variable "products_table_name" {
  type        = string
  description = "DynamoDB products table name."
}

variable "products_table_arn" {
  type        = string
  description = "DynamoDB products table ARN."
}

variable "budget_ledger_table_name" {
  type        = string
  description = "DynamoDB budget_ledger table name."
}

variable "budget_ledger_table_arn" {
  type        = string
  description = "DynamoDB budget_ledger table ARN."
}

variable "rate_limits_table_name" {
  type        = string
  description = "DynamoDB rate_limits table name. shared/models.ts gates InvokeModel behind this."
}

variable "rate_limits_table_arn" {
  type        = string
  description = "DynamoDB rate_limits table ARN."
}

variable "bedrock_model_arns" {
  type        = list(string)
  description = "Bedrock foundation-model ARNs the Lambda may invoke. Scoped to Sonnet 4.6 (profile + per-region foundation ARNs)."
}

variable "schedule_arn" {
  type        = string
  description = "ARN of the EventBridge Scheduler schedule that invokes this Lambda."
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 30
}

variable "timeout_seconds" {
  type        = number
  description = "Lambda timeout. Hydration does one Sonnet call per product + GitHub list + creates. Sized for ~1-10 products."
  default     = 600
}

variable "memory_size_mb" {
  type        = number
  description = "Lambda memory size."
  default     = 1024
}
