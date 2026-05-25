# S3 bucket for forensic dumps written by every agent role when an issue
# parks at human-needed. Each role writes a JSON blob with the last few
# turns of conversation + the reason for parking, keyed by
# `<product_id>/<issue_number>/<role>-<run_id>.json`. A pointer to the
# blob lands in `issue_state.forensic_reports[]` so the human-needed
# comment can link to the right one.
#
# Lifecycle: 90 days. Forensic dumps decay fast in usefulness — by the
# time you're going back >3 months, the system has changed enough that
# the blob's context is stale anyway. Versioning is off (overwriting
# the same key from a re-run is fine; we only ever write).

resource "aws_s3_bucket" "this" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "this" {
  bucket = aws_s3_bucket.this.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "this" {
  bucket = aws_s3_bucket.this.id

  rule {
    id     = "expire-old-forensics"
    status = "Enabled"

    filter {}

    expiration {
      days = var.retention_days
    }
  }
}
