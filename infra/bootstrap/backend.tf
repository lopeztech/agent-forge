terraform {
  # Backend is configured via -backend-config in CI.
  # On first apply the bucket does not exist yet; the workflow runs
  # `terraform init -backend=false` and migrates state with
  # `terraform init -migrate-state` after the bucket is created.
  backend "s3" {}
}
