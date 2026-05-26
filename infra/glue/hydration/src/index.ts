// Backlog hydration Lambda — Phase D3 of the engine-completion plan.
//
// Trigger: EventBridge Scheduler, nightly at 03:00 UTC.
//
// Per CLAUDE.md → Long-running concerns + the 2026-05-25 "Backlog
// hydration" design decision: single Sonnet 4.6 call per product, with
// the full spec/ in the prompt-cached prefix and the current list of
// open issues as the uncached suffix. The model returns a list of
// gap-issues — work the spec calls for that nothing on the backlog
// covers yet. The Lambda files each as a new state:idea issue.
//
// Job, per product:
//   1. Read current spec/ from the target repo.
//   2. List open issues via the GitHub Issues API (excludes PRs).
//   3. Single Sonnet call with submit_gaps tool-forced output.
//   4. File each returned gap-issue as state:idea + hydration label.
//      Idempotent enough: agents BA + the existing dedup heuristic
//      mean files are usually skipped if they look like an existing
//      open issue.
//
// Failure modes:
//   - Per-product failures (Bedrock 5xx, GitHub rate-limit, etc.) are
//     logged and the run continues to the next product.
//   - Per-issue create failures are logged and the run continues to the
//     next gap. The spend row still gets written so the model call's
//     cost is captured even when filing partly failed.

import type { ScheduledEvent } from "aws-lambda";

import { recordSpend } from "../../../../shared/budget.ts";
import { emitHydrationRun } from "../../../../shared/metrics/emit.ts";
import { getInstallationTokenFromSecret } from "../../../../shared/github/auth.ts";
import {
  createIssue,
  listIssues,
  type RequestOptions,
} from "../../../../shared/github/repo.ts";
import { readSpecTree, type SpecReadResult } from "../../../../shared/github/spec.ts";
import {
  costUsd,
  getModelByTier,
  type ContentBlock,
  type SystemBlock,
  type ToolDefinition,
} from "../../../../shared/models.ts";
import {
  listProducts,
  requireWriterInstallId,
  type ProductConfig,
} from "../../../../shared/state/products.ts";
import { requiredEnv } from "../../../../shared/env.ts";

const PRODUCTS_TABLE = requiredEnv("PRODUCTS_TABLE");
const BUDGET_LEDGER_TABLE = requiredEnv("BUDGET_LEDGER_TABLE");
const APP_SECRET_NAME = requiredEnv("APP_SECRET_NAME");

const USER_AGENT = "agent-forge-hydration";
const MODEL_TIER = "sonnet-4-6" as const;
const HYDRATION_LABEL = "hydration";
const STATE_IDEA = "state:idea";

function log(obj: Record<string, unknown>): void {
  console.log(JSON.stringify({ role: "hydration", ...obj }));
}

export async function handler(_event: ScheduledEvent): Promise<void> {
  log({ msg: "starting hydration run" });

  const products = await listProducts({ tableName: PRODUCTS_TABLE });
  log({ msg: "loaded products", count: products.length });

  let totalGapsFiled = 0;

  for (const product of products) {
    try {
      const filed = await hydrateProduct(product);
      totalGapsFiled += filed;
    } catch (err) {
      log({
        msg: "product hydration failed (non-fatal); will retry tomorrow",
        product_id: product.product_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log({
    msg: "done",
    products: products.length,
    gaps_filed: totalGapsFiled,
  });
}

const SUBMIT_GAPS_TOOL: ToolDefinition = {
  name: "submit_gaps",
  description:
    "Submit the list of gap-issues — work the spec calls for that the " +
    "current open-issue backlog doesn't cover yet. If the backlog already " +
    "covers everything in the spec, return an empty `gaps` array. You MUST " +
    "call this tool exactly once.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["gaps", "rationale"],
    properties: {
      gaps: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "body"],
          properties: {
            title: {
              type: "string",
              description:
                "GitHub issue title. Lead with a verb in imperative mood " +
                "(\"Add\", \"Document\", \"Refactor\"). Concrete, scoped, < 70 chars.",
            },
            body: {
              type: "string",
              description:
                "Issue body in Markdown. 1-3 short paragraphs. Quote the " +
                "spec section the gap is filed against; describe what " +
                "should exist that doesn't yet.",
            },
          },
        },
      },
      rationale: {
        type: "string",
        description:
          "1-3 sentences explaining how you decided which gaps to file " +
          "(or, on an empty `gaps`, why the backlog already covers the spec).",
      },
    },
  },
};

type Gap = { title: string; body: string };
type SubmitGapsInput = { gaps: Gap[]; rationale: string };

async function hydrateProduct(product: ProductConfig): Promise<number> {
  const productId = product.product_id;
  log({ msg: "hydrating product", product_id: productId, repo: product.repo_full_name });

  const writerInstallId = requireWriterInstallId(product);
  const { token } = await getInstallationTokenFromSecret(
    APP_SECRET_NAME,
    writerInstallId,
  );
  const ghOpts: RequestOptions = { token, userAgent: USER_AGENT };

  const specPath = product.spec_path ?? "spec/";
  const spec = await readSpecTree({
    token,
    userAgent: USER_AGENT,
    repo: product.repo_full_name,
    path: specPath,
  });
  if (spec.missing) {
    log({ msg: "spec missing; skipping product", product_id: productId, spec_path: specPath });
    return 0;
  }

  const openIssues = await listIssues(ghOpts, product.repo_full_name, {
    state: "open",
  });
  log({
    msg: "loaded open issues",
    product_id: productId,
    count: openIssues.length,
  });

  // Single Sonnet 4.6 call.
  const model = getModelByTier(MODEL_TIER);
  const userMessage = buildUserMessage(openIssues);
  const result = await model.invoke({
    system: buildSystemBlocks(spec),
    messages: [{ role: "user", content: userMessage }],
    maxTokens: 4096,
    tools: [SUBMIT_GAPS_TOOL],
    toolChoice: { type: "tool", name: "submit_gaps" },
    temperature: 0,
  });

  const toolUse = result.content.find(
    (b): b is Extract<ContentBlock, { type: "tool_use" }> =>
      b.type === "tool_use" && b.name === "submit_gaps",
  );
  if (!toolUse) {
    log({
      msg: "model did not call submit_gaps; skipping",
      product_id: productId,
      stop_reason: result.stopReason,
    });
    // Still record the spend — the model call did happen.
    await recordSpend({
      tableName: BUDGET_LEDGER_TABLE,
      runId: `hydration:${productId}:${new Date().toISOString()}`,
      spend: {
        product_id: productId,
        issue_number: 0,
        role: "hydration",
        model: model.bedrockModelId,
        input_tokens: result.usage.input_tokens,
        cached_tokens: result.usage.cached_tokens,
        output_tokens: result.usage.output_tokens,
        cost_usd: result.costUsd,
        note: "submit_gaps not called",
      },
    });
    return 0;
  }

  const parsed = normalizeSubmitGaps(toolUse.input);
  log({
    msg: "parsed gaps",
    product_id: productId,
    gaps: parsed.gaps.length,
    cost_usd: result.costUsd,
    usage: result.usage,
  });

  let filed = 0;
  for (const gap of parsed.gaps) {
    try {
      const created = await createIssue(ghOpts, product.repo_full_name, {
        title: gap.title,
        body: gap.body + "\n\n<sub>Filed automatically by the agent-forge nightly backlog hydration (Phase D3).</sub>",
        labels: [STATE_IDEA, HYDRATION_LABEL],
      });
      filed++;
      log({
        msg: "filed gap issue",
        product_id: productId,
        new_issue: created.number,
        new_issue_url: created.html_url,
      });
    } catch (err) {
      log({
        msg: "filing gap issue failed (non-fatal)",
        product_id: productId,
        title: gap.title.slice(0, 80),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await recordSpend({
    tableName: BUDGET_LEDGER_TABLE,
    runId: `hydration:${productId}:${new Date().toISOString()}`,
    spend: {
      product_id: productId,
      // 0 because hydration isn't scoped to one issue; sentinel for "global".
      issue_number: 0,
      role: "hydration",
      model: model.bedrockModelId,
      input_tokens: result.usage.input_tokens,
      cached_tokens: result.usage.cached_tokens,
      output_tokens: result.usage.output_tokens,
      cost_usd: result.costUsd,
      note: `filed ${filed}/${parsed.gaps.length} gap issues`,
    },
  });

  await emitHydrationRun({
    productId,
    gapsFiled: filed,
    costUsd: result.costUsd,
  });

  // Recompute as a pricing-drift assertion (same pattern as the role
  // agents). Tiny CPU cost; logs if anything's off.
  const recomputed = costUsd(MODEL_TIER, {
    input: result.usage.input_tokens,
    cached: result.usage.cached_tokens,
    output: result.usage.output_tokens,
  });
  if (Math.abs(recomputed - result.costUsd) > 1e-9) {
    log({
      msg: "cost mismatch — pricing table may have drifted",
      recomputed,
      reported: result.costUsd,
    });
  }

  return filed;
}

const BASE_SYSTEM_PROMPT = `
You are agent-forge's backlog-hydration agent. Your job runs once nightly
per product: read the product spec, compare it against the current list
of open issues, and identify gaps — work the spec calls for that nothing
on the backlog covers yet.

You are NOT the developer or BA. Don't expand existing issues, don't
duplicate them, don't file issues for things outside the spec.

Rules:

- File at most 10 gaps per run. If you see more, pick the highest-leverage
  ones (foundational primitives, frequently-blocking gaps, things the
  spec explicitly calls "phase 1" / "minimum"). Tomorrow's run will pick
  up the rest.
- An "open issue" includes any issue with state=open, regardless of its
  state-label. Treat them all as "already on the backlog" — don't refile.
- Don't file gaps for spec text that's clearly future / aspirational
  ("we'd eventually like to...", "consider...", "TBD"). Wait for the
  spec to firm up.
- If the backlog already covers the spec, return an empty gaps array.
  That's a valid + valuable answer — don't pad just to look productive.
- Title format: imperative verb + noun. Keep under 70 chars. Body: 1-3
  short paragraphs quoting the spec section and describing the missing
  work concretely.

You MUST call the submit_gaps tool exactly once. Do not produce any
free-form text response.
`.trim();

function buildSystemBlocks(spec: SpecReadResult): SystemBlock[] {
  const specBlocks = spec.files
    .map((f) => `<file path="${f.path}">\n${f.content.trim()}\n</file>`)
    .join("\n\n");
  const truncationNote = spec.truncated_by
    ? `\n\nNote: spec was truncated by ${spec.truncated_by} cap.`
    : "";
  const specText = [
    "=====================",
    "PRODUCT SPECIFICATION",
    "=====================",
    "The following is the product's spec/ directory. Treat this as the",
    "authoritative source for what the product is supposed to be. Identify",
    "gaps — things the spec calls for that aren't on the open-issue list",
    "below.",
    "",
    specBlocks,
    truncationNote,
  ].join("\n");
  return [
    { type: "text", text: BASE_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: specText, cache_control: { type: "ephemeral" } },
  ];
}

function buildUserMessage(
  openIssues: { number: number; title: string; body: string | null }[],
): string {
  const issuesBlock =
    openIssues.length === 0
      ? "_(no open issues — backlog is empty)_"
      : openIssues
          .map((i) => `- #${i.number}: ${i.title}`)
          .join("\n");
  return [
    "## Current open issues (backlog)",
    "",
    issuesBlock,
    "",
    "Identify gaps in the backlog against the spec. Return at most 10 of " +
      "the highest-leverage missing items via submit_gaps. Empty array is " +
      "fine if the spec is fully covered.",
  ].join("\n");
}

function normalizeSubmitGaps(raw: unknown): SubmitGapsInput {
  const r = (raw ?? {}) as { gaps?: unknown; rationale?: unknown };
  const gapsArr = Array.isArray(r.gaps) ? r.gaps : [];
  const gaps: Gap[] = [];
  for (const g of gapsArr) {
    if (
      typeof g === "object" &&
      g !== null &&
      typeof (g as { title?: unknown }).title === "string" &&
      typeof (g as { body?: unknown }).body === "string"
    ) {
      const title = ((g as { title: string }).title).trim();
      const body = ((g as { body: string }).body).trim();
      if (title.length > 0 && body.length > 0) gaps.push({ title, body });
    }
  }
  const rationale =
    typeof r.rationale === "string" ? r.rationale.trim() : "";
  return { gaps, rationale };
}
