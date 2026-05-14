module "dynamodb" {
  source = "../../modules/dynamodb"

  name_prefix = var.name_prefix
}

module "secrets" {
  source = "../../modules/secrets"

  name_prefix = var.name_prefix
}
