variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/drift-audit/dist). package.sh must have been run before terraform plan/apply."
}

variable "env" {
  type        = string
  description = "Deployment environment name used for CloudWatch metric dimensions."
}

variable "app_secret_arn" {
  type        = string
  description = "ARN of the writer App Secrets Manager entry. Drift audit re-uses writer credentials to read spec/ and file new state:idea issues."
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

variable "issue_state_table_name" {
  type        = string
  description = "DynamoDB issue_state table name."
}

variable "issue_state_table_arn" {
  type        = string
  description = "DynamoDB issue_state table ARN."
}

variable "schedule_arn" {
  type        = string
  description = "ARN of the EventBridge Scheduler schedule that invokes this Lambda. Used to scope lambda:InvokeFunction."
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 30
}

variable "timeout_seconds" {
  type        = number
  description = "Lambda timeout. Drift audit walks all products + their done issues + the spec read; 5 min default is generous for v1 (~1-10 products)."
  default     = 300
}

variable "memory_size_mb" {
  type        = number
  description = "Lambda memory size."
  default     = 512
}
