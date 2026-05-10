provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "agent-forge"
      Env       = "dev"
      ManagedBy = "terraform"
    }
  }
}
