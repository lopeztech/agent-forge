// Single source of truth for model selection across agent-forge.
//
// Provider-agnostic shape (CLAUDE.md "shared/models.ts" decision): role/attempt
// in, ModelHandle out. v1 ships a Bedrock-only adapter; a direct Anthropic API
// adapter can slot in behind the same shape as outage fallback without changing
// role code.
//
// Cost is computed here too because pricing is a model attribute, not a caller
// attribute. Callers pass token counts; the handle's `costUsd` does the math
// (including the 90% prompt-caching discount on cached input tokens).

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";

export type RoleKey =
  | "ba"
  | "cost-estimator"
  | "dev"
  | "test"
  | "functional"
  | "security"
  | "po";

// Opus 4.7 is the aspirational top-tier per CLAUDE.md but is gated behind an
// AWS Sales conversation for new accounts (observed 2026-05-20 on the dev
// account). Until that's resolved, the codebase uses Opus 4.6 — same shape,
// roughly equivalent pricing — as the "best available Opus". Promoting to
// 4.7 is a one-line change here + in infra/envs/dev/bedrock-models.tf.
export type ModelTier = "opus-4-6" | "sonnet-4-6" | "haiku-4-5";

// Bedrock InvokeModel IDs. v1 ships in eu-west-1, where newer Claude SKUs
// are INFERENCE_PROFILE-only — direct `ON_DEMAND` invocation against the
// foundation-model ID returns "model not supported for on-demand throughput".
// We use the EU geographic cross-region inference profile so requests stay
// within EU regions (eu-west-1, eu-west-3, eu-north-1, eu-central-1, eu-south-1,
// eu-south-2). IAM needs grants on both the profile ARN AND every underlying
// foundation-model ARN the profile can fan out to — see infra/envs/dev/bedrock-models.tf.
export const BEDROCK_MODEL_IDS: Record<ModelTier, string> = {
  "opus-4-6": "eu.anthropic.claude-opus-4-6-v1",
  "sonnet-4-6": "eu.anthropic.claude-sonnet-4-6",
  "haiku-4-5": "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
};

// USD per 1M tokens (Bedrock eu-west-1, early 2026 estimates from CLAUDE.md).
// Cached input is 10% of normal input per Anthropic's prompt-caching pricing.
// Opus 4.6 pricing matches Opus 4.7 list pricing — verify against the Bedrock
// pricing page if the budget envelope tightens.
export const PRICING: Record<
  ModelTier,
  { inputPerM: number; outputPerM: number }
> = {
  "opus-4-6": { inputPerM: 15, outputPerM: 75 },
  "sonnet-4-6": { inputPerM: 3, outputPerM: 15 },
  "haiku-4-5": { inputPerM: 1, outputPerM: 5 },
};

const CACHE_DISCOUNT = 0.1;

export function costUsd(
  tier: ModelTier,
  tokens: { input: number; cached: number; output: number },
): number {
  const p = PRICING[tier];
  return (
    (tokens.input * p.inputPerM +
      tokens.cached * p.inputPerM * CACHE_DISCOUNT +
      tokens.output * p.outputPerM) /
    1_000_000
  );
}

// Default per-role model assignment. CLAUDE.md "Roles" section.
// Attempt is 1-indexed (matches `iter:N` labels).
export function defaultTier(role: RoleKey, attempt: number = 1): ModelTier {
  switch (role) {
    case "cost-estimator":
      return "haiku-4-5";
    case "po":
      return "opus-4-6";
    case "dev":
      // Sonnet on attempts 1..(cap-1), Opus on the final attempt.
      // Default kickback cap is 3 → attempt 3 escalates.
      return attempt >= 3 ? "opus-4-6" : "sonnet-4-6";
    case "ba":
    case "test":
    case "functional":
    case "security":
      return "sonnet-4-6";
  }
}

// ----------------------------------------------------------------------------
// Invoke contract
// ----------------------------------------------------------------------------

export type ChatMessage =
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: string | ContentBlock[] };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export type ToolDefinition = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

// System block with optional cache_control. When `cache_control` is set on a
// block, Anthropic creates a cache breakpoint at the end of that block: the
// prefix up to and including that block is cached and reused on subsequent
// calls within the TTL (5 min for `ephemeral`). Minimum cached prefix is 1024
// tokens (Sonnet/Haiku) — blocks below that threshold are silently uncached.
export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export type InvokeOptions = {
  system?: string | SystemBlock[];
  messages: ChatMessage[];
  maxTokens: number;
  tools?: ToolDefinition[];
  // Force the model to call a specific tool (used by the cost estimator to
  // guarantee structured output).
  toolChoice?: { type: "tool"; name: string } | { type: "auto" } | { type: "any" };
  temperature?: number;
};

export type InvokeResult = {
  stopReason: string;
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    cached_tokens: number;
    output_tokens: number;
  };
  costUsd: number;
};

export type ModelHandle = {
  readonly tier: ModelTier;
  readonly bedrockModelId: string;
  invoke(opts: InvokeOptions): Promise<InvokeResult>;
};

// ----------------------------------------------------------------------------
// Bedrock adapter
// ----------------------------------------------------------------------------

const REGION = process.env.AWS_REGION ?? "eu-west-1";
let _bedrock: BedrockRuntimeClient | undefined;
function bedrock(): BedrockRuntimeClient {
  if (!_bedrock) {
    _bedrock = new BedrockRuntimeClient({ region: REGION });
  }
  return _bedrock;
}

type AnthropicBedrockResponse = {
  stop_reason: string;
  content: ContentBlock[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
};

function makeBedrockHandle(tier: ModelTier): ModelHandle {
  const bedrockModelId = BEDROCK_MODEL_IDS[tier];

  return {
    tier,
    bedrockModelId,

    async invoke(opts: InvokeOptions): Promise<InvokeResult> {
      const body: Record<string, unknown> = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: opts.maxTokens,
        messages: opts.messages,
      };
      if (opts.system) body.system = opts.system;
      if (opts.temperature !== undefined) body.temperature = opts.temperature;
      if (opts.tools && opts.tools.length > 0) body.tools = opts.tools;
      if (opts.toolChoice) body.tool_choice = opts.toolChoice;

      const cmd = new InvokeModelCommand({
        modelId: bedrockModelId,
        accept: "application/json",
        contentType: "application/json",
        body: Buffer.from(JSON.stringify(body)),
      });
      const r = await bedrock().send(cmd);

      const parsed = JSON.parse(
        Buffer.from(r.body).toString("utf8"),
      ) as AnthropicBedrockResponse;

      const cached =
        (parsed.usage.cache_read_input_tokens ?? 0) +
        (parsed.usage.cache_creation_input_tokens ?? 0);
      const usage = {
        input_tokens: parsed.usage.input_tokens,
        cached_tokens: cached,
        output_tokens: parsed.usage.output_tokens,
      };

      return {
        stopReason: parsed.stop_reason,
        content: parsed.content,
        usage,
        costUsd: costUsd(tier, {
          input: usage.input_tokens,
          cached: usage.cached_tokens,
          output: usage.output_tokens,
        }),
      };
    },
  };
}

export function getModel(role: RoleKey, attempt: number = 1): ModelHandle {
  return makeBedrockHandle(defaultTier(role, attempt));
}

export function getModelByTier(tier: ModelTier): ModelHandle {
  return makeBedrockHandle(tier);
}
