module "dynamodb" {
  source = "../../modules/dynamodb"

  name_prefix = var.name_prefix
}

# Forensic-artifacts bucket. Every agent role PutObjects here when an issue
# parks at human-needed so debugging a stuck issue doesn't require trawling
# CloudWatch. See infra/modules/forensic-artifacts.
module "forensic_artifacts" {
  source = "../../modules/forensic-artifacts"

  # AWS account ID baked in for uniqueness; the bucket name must be globally
  # unique across all of S3.
  bucket_name = "${var.name_prefix}-forensic-076124126225"
}

module "secrets" {
  source = "../../modules/secrets"

  name_prefix = var.name_prefix
}

module "eventbridge" {
  source = "../../modules/eventbridge"

  name_prefix = var.name_prefix
}

module "webhook_verifier" {
  source = "../../modules/webhook-verifier"

  name_prefix              = var.name_prefix
  source_dir               = "${path.module}/../../glue/webhook-verifier/dist"
  webhook_secret_arn       = module.secrets.webhook_secret_arn
  webhook_secret_name      = module.secrets.webhook_secret_name
  products_table_name      = module.dynamodb.table_names["products"]
  products_table_arn       = module.dynamodb.table_arns["products"]
  products_repo_index_name = module.dynamodb.products_repo_index_name
  products_repo_index_arn  = module.dynamodb.products_repo_index_arn
  event_bus_name           = module.eventbridge.bus_name
  event_bus_arn            = module.eventbridge.bus_arn
}

module "api_gateway" {
  source = "../../modules/api-gateway"

  name_prefix            = var.name_prefix
  verifier_function_arn  = module.webhook_verifier.function_arn
  verifier_function_name = module.webhook_verifier.function_name
}
