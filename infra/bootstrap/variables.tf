variable "aws_region" {
  type        = string
  description = "AWS region for the state backend resources."
  default     = "eu-west-1"
}

variable "aws_account_id" {
  type        = string
  description = "AWS account ID, used to globally-namespace the state bucket name."
  default     = "076124126225"
}

variable "name_prefix" {
  type        = string
  description = "Prefix applied to all resources created by this module."
  default     = "agent-forge"
}
