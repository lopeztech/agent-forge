variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/sweeper/dist). package.sh must have been run before terraform plan/apply."
}

variable "lock_waiters_table_name" {
  type        = string
  description = "DynamoDB lock_waiters table name."
}

variable "lock_waiters_table_arn" {
  type        = string
  description = "DynamoDB lock_waiters table ARN."
}

variable "dev_state_machine_arn" {
  type        = string
  description = "ARN of the Dev Step Function. The sweeper StartExecution's here when it finds a waiter."
}

variable "event_rule_arn" {
  type        = string
  description = "ARN of the EventBridge rule that invokes this Lambda (the area-lock-released rule)."
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 14
}
