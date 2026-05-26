variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/reconciler/dist). package.sh must have been run before terraform plan/apply."
}

variable "app_secret_arn" {
  type        = string
  description = "ARN of the writer App Secrets Manager entry."
}

variable "app_secret_name" {
  type        = string
  description = "Name of the writer App secret, passed to the Lambda via WRITER_SECRET_NAME."
}

variable "products_table_name" {
  type        = string
  description = "DynamoDB products table name."
}

variable "products_table_arn" {
  type        = string
  description = "DynamoDB products table ARN."
}

variable "state_machine_arns" {
  type        = map(string)
  description = "Map of role key (ba/dev/test/functional/security/po) → role Step Function ARN. The reconciler re-fires orphaned issues onto these."
}

variable "schedule_arn" {
  type        = string
  description = "ARN of the EventBridge Scheduler schedule that invokes this Lambda."
}

variable "stale_minutes" {
  type        = number
  description = "An issue must sit at a routable state:* for at least this long before the reconciler will re-fire it (avoids racing a legitimate just-happened handoff)."
  default     = 15
}

variable "bucket_minutes" {
  type        = number
  description = "Re-fire dedupe window: the same issue won't be re-fired more than once per bucket, and a re-fire is skipped if any execution referenced the issue within this window."
  default     = 20
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 30
}

variable "timeout_seconds" {
  type        = number
  description = "Lambda timeout. Does GitHub list + a few StartExecution/Describe calls per product; sized for ~1-10 products."
  default     = 120
}

variable "memory_size_mb" {
  type        = number
  description = "Lambda memory size."
  default     = 256
}
