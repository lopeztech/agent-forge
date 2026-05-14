// Mints an installation access token for one of the agent-forge GitHub Apps
// and exercises it against GET /rate_limit. Proves end-to-end:
//   Secrets Manager fetch → JWT mint → installation token exchange → API call.
//
// Usage:
//   AWS_PROFILE=agent-forge-dev npm run smoke:github-app -- --app writer --install 12345678
//   AWS_PROFILE=agent-forge-dev npm run smoke:github-app -- --app merger --install 87654321
//
// Optional:
//   --prefix <name>   Defaults to $AGENT_FORGE_NAME_PREFIX or "agent-forge-dev".

import { getInstallationToken, type AppName } from "../shared/github/auth.ts";

type Args = {
  app: AppName;
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
      case "--app":
        if (value !== "writer" && value !== "merger") {
          die(`--app must be "writer" or "merger", got "${value}".`);
        }
        out.app = value;
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
  if (!out.app) die("Missing required --app (writer|merger).");
  if (!out.install) die("Missing required --install <installation_id>.");
  out.prefix ??=
    process.env.AGENT_FORGE_NAME_PREFIX ?? "agent-forge-dev";
  return out as Args;
}

function die(msg: string): never {
  console.error(`smoke-github-app: ${msg}`);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Minting installation token for app="${args.app}" install=${args.install} prefix="${args.prefix}"...`,
  );

  const { token, expiresAt } = await getInstallationToken(
    args.prefix,
    args.app,
    args.install,
  );
  console.log(`  → token acquired, expires at ${expiresAt.toISOString()}`);

  console.log(`Calling GET https://api.github.com/rate_limit ...`);
  const response = await fetch("https://api.github.com/rate_limit", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge",
    },
  });
  if (!response.ok) {
    const body = await response.text();
    die(`rate_limit call failed: ${response.status} ${response.statusText}\n${body}`);
  }
  const json = await response.json();
  console.log(JSON.stringify(json, null, 2));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
