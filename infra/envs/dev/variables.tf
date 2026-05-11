variable "aws_region" {
  type        = string
  description = "AWS region for all resources in this environment."
  default     = "eu-west-1"
}

variable "name_prefix" {
  type        = string
  description = "Prefix applied to every resource name in this environment."
  default     = "agent-forge-dev"
}
