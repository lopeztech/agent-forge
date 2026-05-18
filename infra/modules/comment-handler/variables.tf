variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/comment-handler/dist). package.sh must have been run before terraform plan/apply."
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

variable "event_rule_arn" {
  type        = string
  description = "ARN of the EventBridge rule that invokes this Lambda."
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 14
}
