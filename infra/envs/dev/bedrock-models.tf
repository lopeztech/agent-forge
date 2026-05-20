# Bedrock ARN derivation, shared across roles + glue Lambdas.
#
# All Anthropic Claude SKUs in eu-west-1 are INFERENCE_PROFILE-only — direct
# on-demand invocation of the bare foundation-model ID returns
# "model not supported for on-demand throughput". Roles call via the EU
# geographic cross-region inference profile, which fans out to 6 EU regions.
#
# IAM needs grants on:
#   1. The inference profile ARN itself (where the call lands)
#   2. Every underlying foundation-model ARN the profile may route to
# Missing either set yields an AccessDeniedException with a misleading message.
#
# Profile IDs naming convention: newer Anthropic SKUs (Sonnet 4.6, Opus 4.7)
# drop the datestamp + v-suffix; Haiku 4.5 still carries the old shape.

locals {
  bedrock_eu_regions = [
    "eu-west-1",
    "eu-west-3",
    "eu-north-1",
    "eu-central-1",
    "eu-south-1",
    "eu-south-2",
  ]

  # Keep these in sync with shared/models.ts BEDROCK_MODEL_IDS.
  # opus-4-7 is gated behind an AWS Sales conversation for new accounts
  # (observed 2026-05-20); using opus-4-6 as best-available Opus. Promote
  # to 4-7 here and in shared/models.ts once Sales unlocks it.
  bedrock_profile_ids = {
    "haiku-4-5"  = "eu.anthropic.claude-haiku-4-5-20251001-v1:0"
    "sonnet-4-6" = "eu.anthropic.claude-sonnet-4-6"
    "opus-4-6"   = "eu.anthropic.claude-opus-4-6-v1"
  }

  # The foundation-model IDs are the profile ID with the `eu.` prefix stripped.
  bedrock_foundation_ids = {
    for tier, profile_id in local.bedrock_profile_ids :
    tier => trimprefix(profile_id, "eu.")
  }

  bedrock_arns = {
    for tier, profile_id in local.bedrock_profile_ids :
    tier => {
      profile_arn = "arn:aws:bedrock:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:inference-profile/${profile_id}"
      foundation_arns = [
        for region in local.bedrock_eu_regions :
        "arn:aws:bedrock:${region}::foundation-model/${local.bedrock_foundation_ids[tier]}"
      ]
    }
  }

  # Convenience: full ARN list per tier (profile + every underlying model)
  # for direct use in `bedrock:InvokeModel` resource scoping.
  bedrock_invoke_arns = {
    for tier, arns in local.bedrock_arns :
    tier => concat([arns.profile_arn], arns.foundation_arns)
  }
}
