module "dynamodb" {
  source = "../../modules/dynamodb"

  name_prefix = var.name_prefix
}
