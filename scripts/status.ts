// agent-forge ops CLI: `npm run status -- <subcommand>`.
//
// Surfaces the cross-product state that GitHub can't aggregate. v1 ships
// `overview` and `budget`; later PRs add `product <id>`, `pipeline <issue>`,
// and `memory <product> <role>` (those need GitHub list calls; this PR is
// DDB-only).
//
// Usage:
//   AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 \
//     npm run status -- overview [--json]
//   AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 \
//     npm run status -- budget [--day=YYYY-MM-DD] [--json]
//
// All subcommands honor:
//   --prefix <name>   Defaults to $AGENT_FORGE_NAME_PREFIX or "agent-forge-dev".
//                     Used to derive the DDB table names.
//   --json            Emit machine-readable JSON instead of text.

import {
  DEFAULT_GLOBAL_DAILY_CAP_USD,
  DEFAULT_PER_PRODUCT_DAILY_CAP_USD,
  DEFAULT_PER_ROLE_DAILY_CAP_USD,
  GLOBAL_PRODUCT_ID,
} from "../shared/budget/caps.ts";
import {
  getSpendTodayUsd,
  listSpendForIssue,
  utcDayFor,
} from "../shared/budget.ts";
import { listHeldAreaLocks } from "../shared/locks/area-locks.ts";
import { listWaitersForProduct } from "../shared/locks/waiters.ts";
import {
  getIssueState,
} from "../shared/state/issue-state.ts";
import {
  getLessons,
  scoreLesson,
} from "../shared/state/team-memory.ts";
import {
  getProduct,
  listProducts,
  requireProduct,
  type ProductConfig,
} from "../shared/state/products.ts";

const ROLE_NAMES = ["ba", "dev", "test", "functional", "security", "po"] as const;
type Role = (typeof ROLE_NAMES)[number];

function die(msg: string): never {
  console.error(`agent-forge status: ${msg}`);
  process.exit(2);
}

type CommonArgs = {
  prefix: string;
  json: boolean;
};

function parseCommonArgs(argv: string[]): { common: CommonArgs; rest: string[] } {
  const rest: string[] = [];
  let prefix =
    process.env.AGENT_FORGE_NAME_PREFIX ?? "agent-forge-dev";
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a === "--prefix") {
      const v = argv[i + 1];
      if (v === undefined) die("--prefix requires a value");
      prefix = v;
      i++;
      continue;
    }
    if (a !== undefined) rest.push(a);
  }
  return { common: { prefix, json }, rest };
}

function tableNames(prefix: string): {
  products: string;
  budget_ledger: string;
  issue_state: string;
  area_locks: string;
  lock_waiters: string;
  team_memory: string;
} {
  return {
    products: `${prefix}-products`,
    budget_ledger: `${prefix}-budget_ledger`,
    issue_state: `${prefix}-issue_state`,
    area_locks: `${prefix}-area_locks`,
    lock_waiters: `${prefix}-lock_waiters`,
    team_memory: `${prefix}-team_memory`,
  };
}

// ---------------------------------------------------------------------------
// overview
// ---------------------------------------------------------------------------

type OverviewRow = {
  product_id: string;
  repo_full_name: string;
  spend_today_usd: number;
  per_product_cap_usd: number;
  budget_tripped_today: boolean;
  approval_gate_active: boolean;
  approval_gate_until: string | null;
  auto_merge: boolean;
  hydration_enabled: boolean;
};

async function overview(common: CommonArgs): Promise<void> {
  const t = tableNames(common.prefix);
  const products = await listProducts({ tableName: t.products });
  const day = utcDayFor();

  const rows: OverviewRow[] = await Promise.all(
    products.map(async (p) => {
      const spend = await getSpendTodayUsd({
        tableName: t.budget_ledger,
        productId: p.product_id,
      });
      const trippedToday =
        Boolean(p.budget_tripped_for_date) &&
        p.budget_tripped_for_date === day.date;
      const gateActive =
        Boolean(p.approval_gate_until) &&
        Date.parse(p.approval_gate_until ?? "") > Date.now();
      return {
        product_id: p.product_id,
        repo_full_name: p.repo_full_name,
        spend_today_usd: spend,
        per_product_cap_usd:
          p.per_product_daily_budget_cap_usd ??
          DEFAULT_PER_PRODUCT_DAILY_CAP_USD,
        budget_tripped_today: trippedToday,
        approval_gate_active: gateActive,
        approval_gate_until: p.approval_gate_until ?? null,
        auto_merge: p.auto_merge === true,
        // Hydration is on by default for v1; products.hydration_enabled is
        // a future field. Surface it now so the column is forward-compatible.
        hydration_enabled: true,
      };
    }),
  );

  // Sort by product_id for stable output.
  rows.sort((a, b) => a.product_id.localeCompare(b.product_id));

  if (common.json) {
    console.log(JSON.stringify({ day: day.date, products: rows }, null, 2));
    return;
  }

  console.log(`agent-forge status — overview (${day.date} UTC)`);
  console.log("");
  if (rows.length === 0) {
    console.log("  No products in `products` table.");
    return;
  }
  console.log(
    pad("product_id", 24),
    pad("repo", 30),
    pad("spend/today", 14),
    pad("cap", 8),
    pad("trip", 6),
    pad("gate", 8),
    pad("auto-merge", 12),
  );
  console.log(
    pad("─".repeat(24), 24),
    pad("─".repeat(30), 30),
    pad("─".repeat(14), 14),
    pad("─".repeat(8), 8),
    pad("─".repeat(6), 6),
    pad("─".repeat(8), 8),
    pad("─".repeat(12), 12),
  );
  for (const r of rows) {
    const spendStr = `$${r.spend_today_usd.toFixed(4)}`;
    const capStr = `$${r.per_product_cap_usd.toFixed(2)}`;
    const tripStr = r.budget_tripped_today ? "YES" : "  -";
    const gateStr = r.approval_gate_active ? "active" : "  -";
    const automergeStr = r.auto_merge ? "true" : "false";
    console.log(
      pad(r.product_id, 24),
      pad(r.repo_full_name, 30),
      pad(spendStr, 14),
      pad(capStr, 8),
      pad(tripStr, 6),
      pad(gateStr, 8),
      pad(automergeStr, 12),
    );
  }

  // Global trip + global cap footer.
  const globalRow = await getProduct({
    tableName: t.products,
    productId: GLOBAL_PRODUCT_ID,
  });
  const globalTripped =
    Boolean(globalRow?.budget_tripped_for_date) &&
    globalRow?.budget_tripped_for_date === day.date;
  const globalCap =
    globalRow?.global_daily_budget_cap_usd ??
    DEFAULT_GLOBAL_DAILY_CAP_USD;
  console.log("");
  console.log(
    `  global cap: $${globalCap.toFixed(2)}/day` +
      (globalTripped ? "  ⚠️  TRIPPED today" : ""),
  );
}

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

type BudgetCell = {
  product_id: string;
  role: Role;
  spend_usd: number;
  cap_usd: number;
  pct: number;
};

async function budget(common: CommonArgs, rest: string[]): Promise<void> {
  const day = parseDayFlag(rest);
  const t = tableNames(common.prefix);
  const products = await listProducts({ tableName: t.products });

  // Per-(product, role) spend for the chosen day. Run the queries in
  // parallel; for v1 product+role counts (≤10×6 = 60) the load is fine.
  const cells: BudgetCell[] = [];
  await Promise.all(
    products.flatMap((p) =>
      ROLE_NAMES.map(async (role) => {
        const spend = await getSpendTodayUsd({
          tableName: t.budget_ledger,
          productId: p.product_id,
          role,
          now: new Date(`${day.date}T12:00:00.000Z`),
        });
        const cap =
          p.per_role_daily_budget_cap_usd ?? DEFAULT_PER_ROLE_DAILY_CAP_USD;
        cells.push({
          product_id: p.product_id,
          role,
          spend_usd: spend,
          cap_usd: cap,
          pct: cap > 0 ? (spend / cap) * 100 : 0,
        });
      }),
    ),
  );

  // Aggregate per-product totals.
  const productTotals = new Map<string, { spend: number; cap: number }>();
  for (const p of products) {
    productTotals.set(p.product_id, {
      spend: 0,
      cap:
        p.per_product_daily_budget_cap_usd ??
        DEFAULT_PER_PRODUCT_DAILY_CAP_USD,
    });
  }
  for (const c of cells) {
    const row = productTotals.get(c.product_id);
    if (row) row.spend += c.spend_usd;
  }

  const globalRow = await getProduct({
    tableName: t.products,
    productId: GLOBAL_PRODUCT_ID,
  });
  const globalCap =
    globalRow?.global_daily_budget_cap_usd ??
    DEFAULT_GLOBAL_DAILY_CAP_USD;
  const globalSpend = [...productTotals.values()].reduce(
    (s, r) => s + r.spend,
    0,
  );

  if (common.json) {
    console.log(
      JSON.stringify(
        {
          day: day.date,
          cells: cells.sort((a, b) =>
            a.product_id === b.product_id
              ? a.role.localeCompare(b.role)
              : a.product_id.localeCompare(b.product_id),
          ),
          per_product: [...productTotals.entries()].map(([product_id, v]) => ({
            product_id,
            ...v,
            pct: v.cap > 0 ? (v.spend / v.cap) * 100 : 0,
          })),
          global: {
            spend_usd: globalSpend,
            cap_usd: globalCap,
            pct: globalCap > 0 ? (globalSpend / globalCap) * 100 : 0,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`agent-forge status — budget (${day.date} UTC)`);
  console.log("");
  console.log(
    pad("product / role", 24),
    pad("spend", 14),
    pad("cap", 10),
    pad("pct", 6),
  );
  console.log(
    pad("─".repeat(24), 24),
    pad("─".repeat(14), 14),
    pad("─".repeat(10), 10),
    pad("─".repeat(6), 6),
  );
  const sortedProducts = [...productTotals.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  for (const [pid, totals] of sortedProducts) {
    const totalPct = totals.cap > 0 ? (totals.spend / totals.cap) * 100 : 0;
    console.log(
      pad(pid, 24),
      pad(`$${totals.spend.toFixed(4)}`, 14),
      pad(`$${totals.cap.toFixed(2)}`, 10),
      pad(`${totalPct.toFixed(1)}%`, 6),
    );
    const productCells = cells
      .filter((c) => c.product_id === pid)
      .sort((a, b) => a.role.localeCompare(b.role));
    for (const c of productCells) {
      console.log(
        pad(`  ${c.role}`, 24),
        pad(`$${c.spend_usd.toFixed(4)}`, 14),
        pad(`$${c.cap_usd.toFixed(2)}`, 10),
        pad(`${c.pct.toFixed(1)}%`, 6),
      );
    }
  }
  console.log("");
  const globalPct = globalCap > 0 ? (globalSpend / globalCap) * 100 : 0;
  console.log(
    `  global: $${globalSpend.toFixed(4)} / $${globalCap.toFixed(2)} (${globalPct.toFixed(1)}%)`,
  );
}

function parseDayFlag(rest: string[]): { date: string } {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a?.startsWith("--day=")) {
      const v = a.slice("--day=".length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) die(`--day must be YYYY-MM-DD, got "${v}"`);
      return { date: v };
    }
    if (a === "--day") {
      const v = rest[i + 1];
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) die(`--day must be YYYY-MM-DD`);
      return { date: v };
    }
  }
  return { date: utcDayFor().date };
}

// ---------------------------------------------------------------------------
// product <id>
// ---------------------------------------------------------------------------

async function product(common: CommonArgs, rest: string[]): Promise<void> {
  const productId = rest[0];
  if (!productId) die("product subcommand requires a product_id argument");
  const t = tableNames(common.prefix);

  const p = await requireProduct({ tableName: t.products, productId });

  // Per-role spend today.
  const todaySpend = await Promise.all(
    ROLE_NAMES.map(async (role) => ({
      role,
      spend_usd: await getSpendTodayUsd({
        tableName: t.budget_ledger,
        productId,
        role,
      }),
    })),
  );
  const totalToday = todaySpend.reduce((s, r) => s + r.spend_usd, 0);

  const heldLocks = await listHeldAreaLocks({
    tableName: t.area_locks,
    productId,
  });
  const waiters = await listWaitersForProduct({
    tableName: t.lock_waiters,
    productId,
  });

  if (common.json) {
    console.log(
      JSON.stringify(
        {
          product: redactedProduct(p),
          spend_today: { per_role: todaySpend, total_usd: totalToday },
          held_area_locks: heldLocks,
          waiters,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`agent-forge status — product ${productId}`);
  console.log("");
  console.log(`  repo                : ${p.repo_full_name}`);
  console.log(`  spec_path           : ${p.spec_path ?? "(default)"}`);
  console.log(`  areas_path          : ${p.areas_path ?? "(default)"}`);
  console.log(`  auto_merge          : ${p.auto_merge === true}`);
  console.log(
    `  approval_gate_until : ${p.approval_gate_until ?? "(unset)"}`,
  );
  console.log(`  concurrency_cap     : ${p.concurrency_cap ?? "(default 3)"}`);
  console.log(`  per_issue_cap       : $${(p.per_issue_budget_cap_usd ?? 12).toFixed(2)}`);
  console.log(
    `  per_role/day cap    : $${(p.per_role_daily_budget_cap_usd ?? DEFAULT_PER_ROLE_DAILY_CAP_USD).toFixed(2)}`,
  );
  console.log(
    `  per_product/day cap : $${(p.per_product_daily_budget_cap_usd ?? DEFAULT_PER_PRODUCT_DAILY_CAP_USD).toFixed(2)}`,
  );
  console.log(
    `  budget_tripped      : ${p.budget_tripped_for_date ? `${p.budget_tripped_for_date} (${p.budget_tripped_reason ?? "no reason recorded"})` : "(none)"}`,
  );
  console.log("");
  console.log(`  Today's spend by role:`);
  for (const row of todaySpend) {
    console.log(`    ${pad(row.role, 12)} $${row.spend_usd.toFixed(4)}`);
  }
  console.log(`    ${pad("(total)", 12)} $${totalToday.toFixed(4)}`);

  console.log("");
  console.log(`  Held area locks (${heldLocks.length}):`);
  if (heldLocks.length === 0) {
    console.log("    (none)");
  } else {
    for (const l of heldLocks) {
      console.log(
        `    ${pad(l.areaId, 16)} owner=${l.ownerId.slice(0, 24)} expires=${new Date(l.expiresAt * 1000).toISOString()}`,
      );
    }
  }

  console.log("");
  console.log(`  Waiters queue (${waiters.length}):`);
  if (waiters.length === 0) {
    console.log("    (none)");
  } else {
    // Group by area for readability.
    const byArea = new Map<string, typeof waiters>();
    for (const w of waiters) {
      const list = byArea.get(w.areaId) ?? [];
      list.push(w);
      byArea.set(w.areaId, list);
    }
    for (const [areaId, list] of [...byArea.entries()].sort()) {
      console.log(`    ${areaId} (${list.length} waiting):`);
      for (const w of list) {
        console.log(
          `      #${w.issueNumber}  queued ${w.createdAtIso}  expires ${new Date(w.expiresAt * 1000).toISOString()}`,
        );
      }
    }
  }
}

function redactedProduct(p: ProductConfig): Record<string, unknown> {
  // Don't dump install IDs / webhook URLs into stdout. Surface presence
  // only, since "is it configured?" is the useful operator question.
  return {
    product_id: p.product_id,
    repo_full_name: p.repo_full_name,
    spec_path: p.spec_path ?? null,
    areas_path: p.areas_path ?? null,
    auto_merge: p.auto_merge === true,
    approval_gate_until: p.approval_gate_until ?? null,
    concurrency_cap: p.concurrency_cap ?? null,
    per_issue_budget_cap_usd: p.per_issue_budget_cap_usd ?? null,
    per_role_daily_budget_cap_usd: p.per_role_daily_budget_cap_usd ?? null,
    per_product_daily_budget_cap_usd: p.per_product_daily_budget_cap_usd ?? null,
    budget_tripped_for_date: p.budget_tripped_for_date ?? null,
    budget_tripped_reason: p.budget_tripped_reason ?? null,
    writer_install_id_present: Boolean(p.writer_install_id),
    merger_install_id_present: Boolean(p.merger_install_id),
    slack_webhook_url_present: Boolean(p.slack_webhook_url),
  };
}

// ---------------------------------------------------------------------------
// pipeline <product> <issue#>
// ---------------------------------------------------------------------------

async function pipeline(common: CommonArgs, rest: string[]): Promise<void> {
  const productId = rest[0];
  const issueStr = rest[1];
  if (!productId || !issueStr) {
    die("pipeline subcommand requires <product_id> <issue_number>");
  }
  const issueNumber = Number(issueStr);
  if (!Number.isFinite(issueNumber)) die(`issue_number must be numeric: ${issueStr}`);

  const t = tableNames(common.prefix);

  const state = await getIssueState({
    tableName: t.issue_state,
    productId,
    issueNumber,
  });
  const spendRows = await listSpendForIssue({
    tableName: t.budget_ledger,
    productId,
    issueNumber,
  });
  const totalSpend = spendRows.reduce((s, r) => s + r.cost_usd, 0);

  if (common.json) {
    console.log(
      JSON.stringify(
        {
          product_id: productId,
          issue_number: issueNumber,
          issue_state: state ?? null,
          spend_rows: spendRows,
          total_spend_usd: totalSpend,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`agent-forge status — pipeline ${productId}#${issueNumber}`);
  console.log("");
  if (!state) {
    console.log(`  (no issue_state row for product=${productId} issue=${issueNumber})`);
  } else {
    console.log(`  last_state          : ${state.last_state ?? "(unset)"}`);
    console.log(`  last_role           : ${state.last_role ?? "(unset)"}`);
    console.log(`  last_run_id         : ${state.last_run_id ?? "(unset)"}`);
    console.log(`  kickback_count      : ${state.kickback_count ?? 0}`);
    console.log(`  updated_at          : ${state.updated_at ?? "(unset)"}`);
    if (state.ba_expansion) {
      const ac = state.ba_expansion.acceptance_criteria ?? [];
      console.log(
        `  BA complexity       : ${state.ba_expansion.complexity ?? "(unset)"}  (${ac.length} ACs)`,
      );
    }
    if (state.estimate) {
      console.log(
        `  cost estimate       : p50=$${state.estimate.p50_total_usd?.toFixed(4) ?? "?"} ` +
          `p90=$${state.estimate.p90_total_usd?.toFixed(4) ?? "?"} ` +
          `→ ${state.estimate.decision ?? "?"}`,
      );
    }
    if (state.spec_hashes_at_merge) {
      const n = Object.keys(state.spec_hashes_at_merge.hashes ?? {}).length;
      console.log(
        `  spec_hashes_at_merge: ${n} files hashed at ${state.spec_hashes_at_merge.hashed_at}`,
      );
    }
    const reports = state.forensic_reports ?? [];
    console.log(`  forensic_reports    : ${reports.length}`);
    for (const r of reports) {
      console.log(`    ${r.created_at}  ${r.role.padEnd(10)} ${r.reason.slice(0, 80)}`);
      console.log(`      ${r.artifact_uri}`);
    }
  }

  console.log("");
  console.log(`  Spend rows (${spendRows.length}):`);
  if (spendRows.length === 0) {
    console.log("    (none)");
  } else {
    for (const r of spendRows) {
      const tokens = r.input_tokens + r.cached_tokens + r.output_tokens;
      console.log(
        `    ${r.ts}  ${pad(r.role, 12)} ${pad(r.model, 28)} ${tokens.toString().padStart(8)} tok  $${r.cost_usd.toFixed(6)}`,
      );
      if (r.note) console.log(`        note: ${r.note}`);
    }
    console.log(`    ${pad("(total)", 12)} $${totalSpend.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------------------
// memory <product> <role>
// ---------------------------------------------------------------------------

async function memory(common: CommonArgs, rest: string[]): Promise<void> {
  const productId = rest[0];
  const role = rest[1];
  if (!productId || !role) {
    die("memory subcommand requires <product_id> <role>");
  }
  const t = tableNames(common.prefix);

  // bumpUsage=false: the ops CLI should be read-only. Inflating usage on
  // every operator inspection would skew the eviction score.
  const lessons = await getLessons({
    tableName: t.team_memory,
    productId,
    role,
    bumpUsage: false,
  });

  const now = Date.now();
  const scored = lessons
    .map((l) => ({ lesson: l, score: scoreLesson(l, now) }))
    .sort((a, b) => b.score - a.score);

  if (common.json) {
    console.log(
      JSON.stringify(
        {
          product_id: productId,
          role,
          count: scored.length,
          lessons: scored.map(({ lesson, score }) => ({
            score,
            key: lesson.key,
            text: lesson.text,
            confidence: lesson.confidence,
            usage_count: lesson.usage_count,
            created_at: lesson.created_at,
            last_read: lesson.last_read ?? null,
            pinned: lesson.pinned ?? false,
            scope: lesson.product_id === GLOBAL_PRODUCT_ID ? "global" : "product",
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`agent-forge status — memory ${productId}/${role}`);
  console.log("");
  console.log(`  ${scored.length} lessons (sorted by score desc):`);
  if (scored.length === 0) {
    console.log("    (none yet — agents will accumulate these via record_lesson)");
    return;
  }
  for (const { lesson, score } of scored) {
    const ageDays = Math.floor(
      (now - new Date(lesson.created_at).getTime()) / (24 * 60 * 60 * 1000),
    );
    const scopeMark =
      lesson.product_id === GLOBAL_PRODUCT_ID ? " [global]" : "";
    const pinnedMark = lesson.pinned ? " [pinned]" : "";
    console.log("");
    console.log(
      `  ${score.toFixed(3)}  ${lesson.key}${scopeMark}${pinnedMark}`,
    );
    console.log(
      `         conf=${lesson.confidence}  usage=${lesson.usage_count}  age=${ageDays}d`,
    );
    console.log(`         ${lesson.text}`);
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n - 1) + "…";
  return s + " ".repeat(n - s.length);
}

function usage(): never {
  console.error(
    [
      "Usage:",
      "  npm run status -- overview                            [--json] [--prefix <name>]",
      "  npm run status -- budget    [--day=YYYY-MM-DD]        [--json] [--prefix <name>]",
      "  npm run status -- product   <product_id>              [--json] [--prefix <name>]",
      "  npm run status -- pipeline  <product_id> <issue#>     [--json] [--prefix <name>]",
      "  npm run status -- memory    <product_id> <role>       [--json] [--prefix <name>]",
      "",
      "Env:",
      "  AWS_PROFILE                  AWS SSO profile (e.g. agent-forge-dev)",
      "  AWS_REGION                   AWS region (defaults to eu-west-1)",
      "  AGENT_FORGE_NAME_PREFIX      DDB-table prefix (defaults to agent-forge-dev)",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) usage();
  const sub = argv[0];
  const { common, rest } = parseCommonArgs(argv.slice(1));
  switch (sub) {
    case "overview":
      await overview(common);
      return;
    case "budget":
      await budget(common, rest);
      return;
    case "product":
      await product(common, rest);
      return;
    case "pipeline":
      await pipeline(common, rest);
      return;
    case "memory":
      await memory(common, rest);
      return;
    case "-h":
    case "--help":
    case "help":
      usage();
    default:
      console.error(`Unknown subcommand: ${sub}\n`);
      usage();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
