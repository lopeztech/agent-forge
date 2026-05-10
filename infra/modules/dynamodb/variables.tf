variable "name_prefix" {
  type        = string
  description = "Prefix applied to every table name (e.g. \"agent-forge-dev\")."
}

variable "deletion_protection" {
  type        = bool
  description = "Whether DynamoDB deletion protection is enabled on every table."
  default     = true
}
