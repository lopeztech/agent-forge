variable "name_prefix" {
  type        = string
  description = "Naming prefix (e.g. \"agent-forge-dev\")."
}

variable "role" {
  type        = string
  description = "Role key: one of ba, dev, test, functional, security, po."
  validation {
    condition     = contains(["ba", "dev", "test", "functional", "security", "po"], var.role)
    error_message = "role must be one of: ba, dev, test, functional, security, po."
  }
}

variable "image_uri" {
  type        = string
  description = "Full container image URI (e.g. <ecr_url>:latest or <ecr_url>@sha256:...)."
}

variable "app_secret_arn" {
  type        = string
  description = "ARN of the GitHub App credentials secret this role uses (writer for BA/Dev/Test/Functional/Security; merger for PO)."
}

variable "app_secret_name" {
  type        = string
  description = "Name of the App secret (passed to the container as AGENT_FORGE_APP_SECRET_NAME)."
}

variable "bedrock_model_arns" {
  type        = list(string)
  description = "List of Bedrock model ARNs this role is allowed to InvokeModel against. Empty list = no Bedrock perms (BA stub doesn't need them yet)."
  default     = []
}

variable "dynamodb_table_arns" {
  type        = map(string)
  description = "Map of logical table key → table ARN. Role gets Get/Put/Update/Query on these."
}

variable "event_bus_arn" {
  type        = string
  description = "Custom EventBridge bus ARN. Role can PutEvents (for future role-to-role events; today nothing puts)."
  default     = ""
}

variable "cluster_arn" {
  type        = string
  description = "ECS cluster ARN where the task runs. Used by the execution-role IAM scoping."
}

variable "subnets" {
  type        = list(string)
  description = "Subnet IDs the Fargate task ENI attaches to. Default-VPC public subnets for now (per CLAUDE.md networking baseline)."
}

variable "security_group_id" {
  type        = string
  description = "Security group attached to the task ENI. Egress-only by default."
}

variable "cpu" {
  type        = number
  description = "Task CPU units (1024 = 1 vCPU). 512 default for the BA stub."
  default     = 512
}

variable "memory" {
  type        = number
  description = "Task memory in MiB."
  default     = 1024
}

variable "log_retention_days" {
  type        = number
  description = "CloudWatch Logs retention for the task's log group."
  default     = 14
}

variable "env" {
  type        = string
  description = "Environment name (e.g. \"dev\") — passed to the container as AGENT_FORGE_ENV."
}

variable "products_table_name" {
  type        = string
  description = "Name of the products DynamoDB table — passed to the container as AGENT_FORGE_PRODUCTS_TABLE."
}

variable "extra_environment" {
  type        = map(string)
  description = "Additional static environment variables to inject into the agent container."
  default     = {}
}

variable "forensic_bucket_arn" {
  type        = string
  description = "Optional. When set, the task role gets s3:PutObject on <bucket>/<role>/* for dumping forensic reports on park. Empty string disables the grant."
  default     = ""
}
