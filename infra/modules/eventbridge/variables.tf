variable "name_prefix" {
  type        = string
  description = "Bus name and resource-name prefix (e.g. \"agent-forge-dev\")."
}

variable "catch_all_log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the catch-all rule. Verifier debugging needs a short window; tune up if useful."
  default     = 14
}
