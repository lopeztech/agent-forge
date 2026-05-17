variable "name_prefix" {
  type        = string
  description = "Naming prefix (e.g. \"agent-forge-dev\")."
}

variable "ba_task_definition_arn" {
  type        = string
  description = "BA task definition ARN (versioned). Step Function calls ecs:RunTask with this."
}

variable "ba_task_role_arn" {
  type        = string
  description = "BA task role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "ba_execution_role_arn" {
  type        = string
  description = "BA execution role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "cluster_arn" {
  type        = string
  description = "ECS cluster ARN where tasks are launched."
}

variable "subnets" {
  type        = list(string)
  description = "Subnet IDs for the Fargate task ENI."
}

variable "security_group_id" {
  type        = string
  description = "Security group attached to the task ENI."
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the state-machine log group."
  default     = 30
}
