variable "name_prefix" {
  type        = string
  description = "Function-name prefix (e.g. \"agent-forge-dev\")."
}

variable "source_dir" {
  type        = string
  description = "Path to the built JS bundle directory (infra/glue/cost-estimator/dist). package.sh must have been run before terraform plan/apply."
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

variable "issue_state_table_name" {
  type        = string
  description = "DynamoDB issue_state table name."
}

variable "issue_state_table_arn" {
  type        = string
  description = "DynamoDB issue_state table ARN."
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
  description = "DynamoDB rate_limits table name. Passed to the Lambda as AGENT_FORGE_RATE_LIMITS_TABLE so the Bedrock call is throttled by the shared org-wide bucket."
}

variable "rate_limits_table_arn" {
  type        = string
  description = "DynamoDB rate_limits table ARN."
}

variable "bedrock_model_arns" {
  type        = list(string)
  description = "Bedrock foundation-model ARNs the Lambda may invoke. Scoped to Haiku 4.5 in v1."
}

variable "forensic_bucket_name" {
  type        = string
  description = "S3 bucket name for forensic dumps on the Cost Estimator's two unexpected-park paths (Bedrock 5xx / timeout, post-estimate side-effect failure). Passed as AGENT_FORGE_FORENSIC_BUCKET."
  default     = ""
}

variable "forensic_bucket_arn" {
  type        = string
  description = "ARN of the forensic-dump S3 bucket. When set, the Lambda gets s3:PutObject scoped to its own role-prefix in the bucket."
  default     = ""
}

variable "event_rule_arn" {
  type        = string
  description = "ARN of the EventBridge rule that invokes this Lambda. Used to scope the lambda:InvokeFunction permission."
}

variable "hard_per_issue_cap_usd" {
  type        = number
  description = "Hard per-issue cap in USD. Estimates above this park as human-needed (no /approve-cost override)."
  default     = 12
}

variable "default_cost_approval_threshold_usd" {
  type        = number
  description = "Default cost_approval_threshold_usd applied when a products row doesn't override it."
  default     = 1
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the Lambda's own log group."
  default     = 14
}
