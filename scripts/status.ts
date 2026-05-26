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
  utcDayFor,
} from "../shared/budget.ts";
import {
  getProduct,
  listProducts,
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
} {
  return {
    products: `${prefix}-products`,
    budget_ledger: `${prefix}-budget_ledger`,
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
      "  npm run status -- overview [--json] [--prefix <name>]",
      "  npm run status -- budget   [--day=YYYY-MM-DD] [--json] [--prefix <name>]",
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
