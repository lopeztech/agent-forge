# TEMPORARY — delete after the apply that adopts the existing resources
# into Terraform state succeeds. The first bootstrap apply on 2026-05-07
# created these resources but the migrate-state step failed, leaving the
# AWS resources orphaned from any TF state file. This file uses TF 1.5+
# `import {}` blocks to adopt them into the (now S3-backed) state on the
# next apply.

import {
  to = aws_kms_key.tfstate
  id = "987d7c05-a653-48e7-bd52-612989f3ae48"
}

import {
  to = aws_kms_alias.tfstate
  id = "alias/agent-forge-tfstate"
}

import {
  to = aws_s3_bucket.tfstate
  id = "agent-forge-tfstate-076124126225-eu-west-1"
}

import {
  to = aws_s3_bucket_versioning.tfstate
  id = "agent-forge-tfstate-076124126225-eu-west-1"
}

import {
  to = aws_s3_bucket_server_side_encryption_configuration.tfstate
  id = "agent-forge-tfstate-076124126225-eu-west-1"
}

import {
  to = aws_s3_bucket_public_access_block.tfstate
  id = "agent-forge-tfstate-076124126225-eu-west-1"
}

import {
  to = aws_s3_bucket_policy.tfstate_tls_only
  id = "agent-forge-tfstate-076124126225-eu-west-1"
}

import {
  to = aws_dynamodb_table.tflock
  id = "agent-forge-tflock"
}
