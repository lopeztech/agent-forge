variable "name_prefix" {
  type        = string
  description = "Prefix applied to every secret name (e.g. \"agent-forge-dev\")."
}

variable "recovery_window_in_days" {
  type        = number
  description = "Days a deleted secret is recoverable before AWS purges it. 0 = immediate, 7-30 = grace period."
  default     = 7
}
