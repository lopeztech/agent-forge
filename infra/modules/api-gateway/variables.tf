variable "name_prefix" {
  type        = string
  description = "API and resource-name prefix (e.g. \"agent-forge-dev\")."
}

variable "verifier_function_arn" {
  type        = string
  description = "ARN of the webhook-verifier Lambda the /webhook route invokes."
}

variable "verifier_function_name" {
  type        = string
  description = "Name of the verifier Lambda. Needed for the invoke-permission resource."
}

variable "access_log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the API Gateway access log group."
  default     = 14
}
