// Idempotently create the agent-forge label vocabulary on a target repo via
// the writer App. Safe to re-run — existing labels are updated to the
// canonical color/description; missing labels are created; extra labels
// (anything not in the vocabulary) are left alone.
//
// Usage:
//   AWS_PROFILE=agent-forge-dev AWS_REGION=eu-west-1 npm run seed:labels -- \
//     --repo lopeztech/agent-forge \
//     --install <WRITER_INSTALL_ID>
//
// Optional:
//   --prefix <name>  Defaults to $AGENT_FORGE_NAME_PREFIX or "agent-forge-dev".
//                    Used to build the writer secret name.

import {
  appSecretName,
  getInstallationTokenFromSecret,
} from "../shared/github/auth.ts";
import {
  LABEL_VOCABULARY,
  type LabelDefinition,
} from "../shared/labels.ts";

// Color scheme:
//   state:*           — blue family (cycle through shades by life-cycle phase)
//   iter:*            — orange (kickback count, attention-grabbing)
//   area:*            — grey (informational)
//   human-needed      — red (action required)
//   gap:areas-incomplete — red (action required)
//   tech-debt:*       — yellow
//   security-sensitive — purple
//   complexity:high   — orange
type Args = {
  repo: string;
  install: string;
  prefix: string;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--")) continue;
    if (value === undefined) die(`Flag ${flag} requires a value.`);
    switch (flag) {
      case "--repo":
        if (!/^[^/\s]+\/[^/\s]+$/.test(value)) {
          die(`--repo must be "owner/name", got "${value}".`);
        }
        out.repo = value;
        break;
      case "--install":
        out.install = value;
        break;
      case "--prefix":
        out.prefix = value;
        break;
      default:
        die(`Unknown flag: ${flag}`);
    }
    i++;
  }
  if (!out.repo) die("Missing required --repo");
  if (!out.install) die("Missing required --install");
  return {
    repo: out.repo,
    install: out.install,
    prefix: out.prefix ?? process.env.AGENT_FORGE_NAME_PREFIX ?? "agent-forge-dev",
  };
}

function die(msg: string): never {
  console.error(`seed-labels: ${msg}`);
  process.exit(2);
}

async function gh(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge-seed-labels",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetch(`https://api.github.com${path}`, init);
}

async function listExistingLabels(
  token: string,
  repo: string,
): Promise<Map<string, { color: string; description: string | null }>> {
  const out = new Map<string, { color: string; description: string | null }>();
  let page = 1;
  while (true) {
    const r = await gh(token, "GET", `/repos/${repo}/labels?per_page=100&page=${page}`);
    if (!r.ok) {
      throw new Error(`Listing labels failed: ${r.status} ${r.statusText}\n${await r.text()}`);
    }
    const items = (await r.json()) as Array<{
      name: string;
      color: string;
      description: string | null;
    }>;
    if (items.length === 0) break;
    for (const it of items) {
      out.set(it.name, { color: it.color, description: it.description });
    }
    if (items.length < 100) break;
    page++;
  }
  return out;
}

async function ensureLabel(
  token: string,
  repo: string,
  label: LabelDefinition,
  existing: { color: string; description: string | null } | undefined,
): Promise<"created" | "updated" | "unchanged"> {
  if (!existing) {
    const r = await gh(token, "POST", `/repos/${repo}/labels`, label);
    if (!r.ok) {
      throw new Error(`Create ${label.name} failed: ${r.status}\n${await r.text()}`);
    }
    return "created";
  }
  if (existing.color === label.color && (existing.description ?? "") === label.description) {
    return "unchanged";
  }
  const r = await gh(
    token,
    "PATCH",
    `/repos/${repo}/labels/${encodeURIComponent(label.name)}`,
    { new_name: label.name, color: label.color, description: label.description },
  );
  if (!r.ok) {
    throw new Error(`Update ${label.name} failed: ${r.status}\n${await r.text()}`);
  }
  return "updated";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const secret = appSecretName(args.prefix, "writer");

  console.log(`Seeding labels on ${args.repo}`);
  console.log(`  writer secret : ${secret}`);
  console.log(`  install id    : ${args.install}`);
  console.log();

  const { token } = await getInstallationTokenFromSecret(secret, args.install);
  const existing = await listExistingLabels(token, args.repo);

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  for (const label of LABEL_VOCABULARY) {
    const result = await ensureLabel(token, args.repo, label, existing.get(label.name));
    const tag = result.padEnd(9);
    console.log(`  [${tag}] ${label.name}`);
    if (result === "created") created++;
    else if (result === "updated") updated++;
    else unchanged++;
  }

  console.log();
  console.log(`Done. created=${created} updated=${updated} unchanged=${unchanged}`);
  console.log("Labels not in the agent-forge vocabulary were left alone.");
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
