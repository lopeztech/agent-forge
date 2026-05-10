terraform {
  # Backend configured at init time via -backend-config flags in CI:
  #   bucket         = agent-forge-tfstate-076124126225-eu-west-1
  #   key            = envs/dev/terraform.tfstate
  #   region         = eu-west-1
  #   dynamodb_table = agent-forge-tflock
  #   encrypt        = true
  backend "s3" {}
}
