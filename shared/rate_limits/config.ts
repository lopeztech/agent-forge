// Bedrock per-(model, region) rate-limit configuration.
//
// AWS doesn't expose account quotas programmatically. These defaults are
// conservative for a fresh AWS account in eu-west-1; raise them per-account
// once Bedrock quotas are confirmed or expanded via AWS Sales. The 2026-05-25
// "Bedrock rate-limit scope" decision pins the bucket to (model, region)
// only — no per-product segmentation.
//
// Capacity = burst size (how many calls back-to-back). Refill = steady-state.
// Numbers reflect "requests per minute" expressed as `tokens` where each
// InvokeModel costs 1 token:
//
//   - Sonnet 4.6:  120 RPM burst, 1 RPS steady-state (60 RPM)
//   - Haiku 4.5:   240 RPM burst, 2 RPS steady-state (120 RPM)
//   - Opus 4.6:     60 RPM burst, 0.5 RPS steady-state (30 RPM)
//
// These match the typical default account-level invocation quotas Amazon
// allocates in eu-west-1; if your account has different limits, override
// per-tier here.

import type { ModelTier } from "../models.ts";
import type { BucketConfig } from "./bucket.ts";

export const DEFAULT_BEDROCK_BUCKETS: Record<ModelTier, BucketConfig> = {
  "sonnet-4-6": { capacity: 120, refillPerSecond: 1 },
  "haiku-4-5": { capacity: 240, refillPerSecond: 2 },
  "opus-4-6": { capacity: 60, refillPerSecond: 0.5 },
};

// Region-scoped bucket id. Format: `bedrock:<region>:<inference_profile_id>`.
// Region comes from AWS_REGION (set on every Fargate task / Lambda) and
// defaults to eu-west-1 (the v1 region). The bucket spans all callers in
// that account+region for that model.
export function bucketIdForModel(modelId: string, region?: string): string {
  const r = region ?? process.env.AWS_REGION ?? "eu-west-1";
  return `bedrock:${r}:${modelId}`;
}

// Max wall-clock the integration in shared/models.ts will spend waiting for
// a Bedrock token before falling through to the actual InvokeModel call.
// Past this point, Bedrock's adaptive retry takes over: better to surface
// the throttle as a Bedrock-side error than to block the whole agent run.
export const BEDROCK_TOKEN_WAIT_MS = 60_000;
