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

variable "dev_task_definition_arn" {
  type        = string
  description = "Dev task definition ARN (versioned). Step Function calls ecs:RunTask with this."
}

variable "dev_task_role_arn" {
  type        = string
  description = "Dev task role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "dev_execution_role_arn" {
  type        = string
  description = "Dev execution role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "test_task_definition_arn" {
  type        = string
  description = "Test task definition ARN (versioned)."
}

variable "test_task_role_arn" {
  type        = string
  description = "Test task role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "test_execution_role_arn" {
  type        = string
  description = "Test execution role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "functional_task_definition_arn" {
  type        = string
  description = "Functional task definition ARN (versioned)."
}

variable "functional_task_role_arn" {
  type        = string
  description = "Functional task role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "functional_execution_role_arn" {
  type        = string
  description = "Functional execution role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "security_task_definition_arn" {
  type        = string
  description = "Security task definition ARN (versioned)."
}

variable "security_task_role_arn" {
  type        = string
  description = "Security task role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "security_execution_role_arn" {
  type        = string
  description = "Security execution role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "po_task_definition_arn" {
  type        = string
  description = "PO task definition ARN (versioned)."
}

variable "po_task_role_arn" {
  type        = string
  description = "PO task role ARN. Step Function execution role needs iam:PassRole for it."
}

variable "po_execution_role_arn" {
  type        = string
  description = "PO execution role ARN. Step Function execution role needs iam:PassRole for it."
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
