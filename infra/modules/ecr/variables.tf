variable "repository_name" {
  type        = string
  description = "Fully-resolved repo name (e.g. \"agent-forge-dev/ba\")."
}

variable "keep_last" {
  type        = number
  description = "Keep the N most-recently-pushed tagged images; older ones are auto-expired."
  default     = 10
}
