// End-to-end onboarding for both agent-forge GitHub Apps via the App Manifest
// flow. Spins up a localhost server, opens the browser, captures App
// credentials + install IDs, uploads creds to Secrets Manager, and runs the
// smoke test. Replaces the manual ~6-step runbook with ~4 browser clicks
// total (2 per App: "Create" + "Install").
//
// Usage:
//   AWS_PROFILE=agent-forge-dev npm run onboard:github-apps
//
// Optional flags:
//   --prefix <name>   Defaults to $AGENT_FORGE_NAME_PREFIX or "agent-forge-dev".
//   --owner <org>     If set, creates the Apps under a GitHub org you admin
//                     instead of your personal account.
//   --port <number>   Localhost port for the callback server. Default 8765.

import { exec } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

import {
  appSecretName,
  getInstallationToken,
  type AppName,
} from "../shared/github/auth.ts";

type Args = {
  prefix: string;
  owner: string | undefined;
  port: number;
};

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!flag?.startsWith("--")) continue;
    if (value === undefined) die(`Flag ${flag} requires a value.`);
    switch (flag) {
      case "--prefix":
        out.prefix = value;
        break;
      case "--owner":
        out.owner = value;
        break;
      case "--port":
        out.port = Number(value);
        if (!Number.isInteger(out.port) || out.port <= 0) {
          die(`--port must be a positive integer, got "${value}".`);
        }
        break;
      default:
        die(`Unknown flag: ${flag}`);
    }
    i++;
  }
  return {
    prefix: out.prefix ?? process.env.AGENT_FORGE_NAME_PREFIX ?? "agent-forge-dev",
    owner: out.owner,
    port: out.port ?? 8765,
  };
}

function die(msg: string): never {
  console.error(`onboard-github-apps: ${msg}`);
  process.exit(2);
}

function manifestPostUrl(owner: string | undefined): string {
  return owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : `https://github.com/settings/apps/new`;
}

// GitHub App names are globally unique on github.com. A short random suffix
// avoids collisions when running this script repeatedly or alongside other
// agent-forge installs. The operator can rename on GitHub's confirmation page.
function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

type Manifest = {
  name: string;
  url: string;
  description: string;
  public: boolean;
  redirect_url: string;
  setup_url: string;
  setup_on_update: boolean;
  hook_attributes: { url: string; active: boolean };
  default_events: string[];
  default_permissions: Record<string, "read" | "write">;
};

function appManifest(app: AppName, host: string): Manifest {
  const common = {
    url: "https://github.com/lopeztech/agent-forge",
    public: false,
    redirect_url: `${host}/${app}/created`,
    setup_url: `${host}/${app}/installed`,
    setup_on_update: false,
    // Webhooks are wired in the upcoming webhook-ingress slice. Disable here so
    // GitHub doesn't try delivering to a placeholder URL.
    hook_attributes: { url: "https://placeholder.invalid/webhook", active: false },
    default_events: [],
  };
  if (app === "writer") {
    return {
      ...common,
      name: `agent-forge-writer-${randomSuffix()}`,
      description: "agent-forge writer: BA, Dev, Test, Functional, Security identity.",
      default_permissions: {
        contents: "write",
        issues: "write",
        pull_requests: "write",
        metadata: "read",
        actions: "read",
      },
    };
  }
  return {
    ...common,
    name: `agent-forge-merger-${randomSuffix()}`,
    description: "agent-forge merger: PO identity; branch-protection-required reviewer.",
    default_permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    },
  };
}

type AppRecord = {
  app_id?: number;
  slug?: string;
  installation_id?: number;
};

type ManifestConversion = {
  id: number;
  slug: string;
  pem: string;
  webhook_secret: string | null;
  client_id: string;
  client_secret: string;
};

async function exchangeCode(code: string): Promise<ManifestConversion> {
  const r = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "agent-forge",
      },
    },
  );
  if (!r.ok) {
    throw new Error(
      `Manifest conversion failed: ${r.status} ${r.statusText}\n${await r.text()}`,
    );
  }
  return (await r.json()) as ManifestConversion;
}

const sm = new SecretsManagerClient({});
async function putAppSecret(
  prefix: string,
  app: AppName,
  appId: number,
  pem: string,
): Promise<void> {
  await sm.send(
    new PutSecretValueCommand({
      SecretId: appSecretName(prefix, app),
      SecretString: JSON.stringify({
        app_id: String(appId),
        private_key: pem,
      }),
    }),
  );
}

async function smokeOne(
  prefix: string,
  app: AppName,
  installId: number,
): Promise<string> {
  const { token } = await getInstallationToken(prefix, app, installId);
  const r = await fetch("https://api.github.com/rate_limit", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge",
    },
  });
  if (!r.ok) {
    throw new Error(
      `rate_limit call failed: ${r.status} ${r.statusText}\n${await r.text()}`,
    );
  }
  const data = (await r.json()) as { resources: { core: { limit: number } } };
  return `core limit = ${data.resources.core.limit} (5000 = authenticated App)`;
}

function openBrowser(url: string): void {
  // darwin only — matches the platform this script is invoked from.
  exec(`open "${url}"`, (err) => {
    if (err) {
      console.warn(
        `Could not auto-open browser (${err.message}). Open this URL manually: ${url}`,
      );
    }
  });
}

// -----------------------------------------------------------------------------
// HTML
// -----------------------------------------------------------------------------

const STYLE = `body{font-family:system-ui,-apple-system,sans-serif;max-width:680px;margin:48px auto;padding:0 24px;color:#1f2328;line-height:1.5}
button,a.btn{display:inline-block;background:#1f883d;color:white;border:0;padding:10px 18px;border-radius:6px;font-size:15px;font-weight:500;text-decoration:none;cursor:pointer}
button:hover,a.btn:hover{background:#1a7f37}
code{background:#f6f8fa;padding:2px 6px;border-radius:3px;font-size:13px}
h1{font-size:22px;margin-bottom:8px}
.muted{color:#656d76;font-size:14px}
.step{color:#656d76;font-size:13px;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px}
pre{background:#f6f8fa;padding:12px;border-radius:6px;overflow-x:auto;font-size:13px}`;

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

// Escape for use inside a single-quoted HTML attribute value.
function attrEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/'/g, "&#39;");
}

function landingPage(app: AppName, args: Args, host: string): string {
  const manifest = appManifest(app, host);
  const action = manifestPostUrl(args.owner);
  const stepNum = app === "writer" ? "1 of 2" : "2 of 2";
  return htmlPage(
    `Create ${app} App`,
    `<div class="step">Step ${stepNum}</div>
     <h1>Create <code>agent-forge-${app}</code></h1>
     <p>Click below. GitHub opens a pre-filled App config page — click <strong>Create GitHub App</strong> at the bottom. You'll be redirected back here.</p>
     <form action="${action}" method="post">
       <input type="hidden" name="manifest" value='${attrEscape(JSON.stringify(manifest))}' />
       <button type="submit">Create ${app} App on GitHub</button>
     </form>
     <p class="muted">Account: ${args.owner ? `org <code>${args.owner}</code>` : "your personal account"}. To change, abort and re-run with <code>--owner &lt;org&gt;</code>.</p>`,
  );
}

function installPage(app: AppName, slug: string, args: Args): string {
  const next =
    app === "writer"
      ? "Once installed, you'll come back here to start step 2 (merger)."
      : "Once installed, you'll come back here for the smoke test and you're done.";
  return htmlPage(
    `Install ${app}`,
    `<div class="step">Step ${app === "writer" ? "1 of 2" : "2 of 2"} — install</div>
     <h1>Install <code>agent-forge-${app}</code></h1>
     <p>Credentials saved to Secrets Manager (<code>${appSecretName(args.prefix, app)}</code>).</p>
     <p>Pick a target repo and click Install. ${next}</p>
     <p><a class="btn" href="https://github.com/apps/${encodeURIComponent(slug)}/installations/new">Install ${app}</a></p>`,
  );
}

function donePage(
  args: Args,
  records: Record<AppName, AppRecord>,
  smoke: Record<AppName, string>,
): string {
  return htmlPage(
    "Done",
    `<h1>Done.</h1>
     <p>Both Apps created, installed on your target repo, and smoke-tested. You can close this tab and return to the terminal.</p>
     <h3>Installation IDs</h3>
     <p>Record these when onboarding a target product (<code>products</code> DynamoDB row, <code>writer_install_id</code> / <code>merger_install_id</code>):</p>
     <pre>writer: ${records.writer.installation_id}
merger: ${records.merger.installation_id}</pre>
     <h3>Smoke test</h3>
     <pre>writer: ${smoke.writer}
merger: ${smoke.merger}</pre>
     <p class="muted">Secrets stored as <code>${appSecretName(args.prefix, "writer")}</code> and <code>${appSecretName(args.prefix, "merger")}</code>.</p>`,
  );
}

function errorPage(message: string): string {
  return htmlPage(
    "Error",
    `<h1>Onboarding failed</h1>
     <p>Check the terminal for details. Error:</p>
     <pre>${message.replace(/</g, "&lt;")}</pre>`,
  );
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const host = `http://localhost:${args.port}`;

  console.log(`agent-forge onboard-github-apps`);
  console.log(`  name prefix : ${args.prefix}`);
  console.log(`  AWS_PROFILE : ${process.env.AWS_PROFILE ?? "(not set — using default chain)"}`);
  console.log(`  AWS_REGION  : ${process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "(default chain)"}`);
  console.log(`  owner       : ${args.owner ?? "(personal account)"}`);
  console.log(`  callback    : ${host}`);
  console.log();

  const records: Record<AppName, AppRecord> = { writer: {}, merger: {} };
  const smoke: Partial<Record<AppName, string>> = {};
  let completed = false;

  const server = createServer((req, res) => {
    handleRequest(req, res, args, host, records, smoke).then(
      (finished) => {
        if (finished) {
          completed = true;
          setTimeout(() => server.close(), 500);
        }
      },
      (err: unknown) => {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
        console.error(msg);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorPage(err instanceof Error ? err.message : String(err)));
        }
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, () => {
      console.log(`Listening on ${host}. Opening browser...\n`);
      openBrowser(host);
      resolve();
    });
  });

  await new Promise<void>((resolve) => server.on("close", resolve));

  if (!completed) {
    console.error("\nServer closed before onboarding completed.");
    process.exit(1);
  }

  console.log();
  console.log("Onboarding complete.");
  console.log(`  writer install id: ${records.writer.installation_id}`);
  console.log(`  merger install id: ${records.merger.installation_id}`);
  console.log(`  writer secret    : ${appSecretName(args.prefix, "writer")}`);
  console.log(`  merger secret    : ${appSecretName(args.prefix, "merger")}`);
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  args: Args,
  host: string,
  records: Record<AppName, AppRecord>,
  smoke: Partial<Record<AppName, string>>,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", host);
  const pathname = url.pathname;

  if (pathname === "/") {
    sendHtml(res, 200, landingPage("writer", args, host));
    return false;
  }

  const createdMatch = pathname.match(/^\/(writer|merger)\/created$/);
  if (createdMatch) {
    const app = createdMatch[1] as AppName;
    const code = url.searchParams.get("code");
    if (!code) throw new Error(`Missing ?code on ${pathname}`);
    console.log(`[${app}] exchanging manifest code...`);
    const conv = await exchangeCode(code);
    console.log(`[${app}] App created: id=${conv.id} slug=${conv.slug}`);
    records[app].app_id = conv.id;
    records[app].slug = conv.slug;
    await putAppSecret(args.prefix, app, conv.id, conv.pem);
    console.log(`[${app}] credentials uploaded to ${appSecretName(args.prefix, app)}`);
    sendHtml(res, 200, installPage(app, conv.slug, args));
    return false;
  }

  const installedMatch = pathname.match(/^\/(writer|merger)\/installed$/);
  if (installedMatch) {
    const app = installedMatch[1] as AppName;
    const installationIdStr = url.searchParams.get("installation_id");
    if (!installationIdStr) throw new Error(`Missing ?installation_id on ${pathname}`);
    const installationId = Number(installationIdStr);
    if (!Number.isInteger(installationId)) {
      throw new Error(`Bad installation_id: ${installationIdStr}`);
    }
    records[app].installation_id = installationId;
    console.log(`[${app}] installed: installation_id=${installationId}`);
    console.log(`[${app}] running smoke test...`);
    smoke[app] = await smokeOne(args.prefix, app, installationId);
    console.log(`[${app}] smoke OK: ${smoke[app]}`);

    if (app === "writer") {
      sendHtml(res, 200, landingPage("merger", args, host));
      return false;
    }
    sendHtml(
      res,
      200,
      donePage(args, records, smoke as Record<AppName, string>),
    );
    return true;
  }

  if (pathname === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return false;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
  return false;
}

function sendHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
