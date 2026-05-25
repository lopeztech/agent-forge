variable "bucket_name" {
  type        = string
  description = "S3 bucket name. Must be globally unique."
}

variable "retention_days" {
  type        = number
  description = "Days before forensic dumps expire. Default 90 — forensics decay fast in usefulness."
  default     = 90
}
