import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import { getSecretString } from "./secrets.ts";

export type AppName = "writer" | "merger";

export type AppCredentials = {
  app_id: string;
  private_key: string;
};

export type InstallationToken = {
  token: string;
  expiresAt: Date;
};

const PLACEHOLDER = "PLACEHOLDER_OVERWRITE_VIA_PUT_SECRET_VALUE";

export function appSecretName(prefix: string, app: AppName): string {
  return `${prefix}-${app}`;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64url");
}

export async function getAppCredentialsFromSecret(
  secretName: string,
): Promise<AppCredentials> {
  const raw = await getSecretString(secretName);

  let parsed: Partial<AppCredentials>;
  try {
    parsed = JSON.parse(raw) as Partial<AppCredentials>;
  } catch {
    throw new Error(
      `Secret "${secretName}" is not valid JSON. Expected { app_id, private_key }. ` +
        `Run the upload step in docs/runbook.md.`,
    );
  }

  if (!parsed.app_id || !parsed.private_key) {
    throw new Error(
      `Secret "${secretName}" is missing app_id or private_key.`,
    );
  }
  if (parsed.app_id === PLACEHOLDER || parsed.private_key === PLACEHOLDER) {
    throw new Error(
      `Secret "${secretName}" still contains the Terraform placeholder. ` +
        `Upload real credentials via aws secretsmanager put-secret-value first ` +
        `(see docs/runbook.md).`,
    );
  }

  return { app_id: parsed.app_id, private_key: parsed.private_key };
}

export async function getAppCredentials(
  prefix: string,
  app: AppName,
): Promise<AppCredentials> {
  return getAppCredentialsFromSecret(appSecretName(prefix, app));
}

// GitHub caps App JWTs at 10 minutes. We default to 9 minutes and subtract 30s
// off `iat` for clock skew, per GitHub's auth docs.
const JWT_TTL_SECONDS = 540;
const JWT_MAX_TTL_SECONDS = 600;
const JWT_CLOCK_SKEW_SECONDS = 30;

export function mintAppJWT(
  creds: AppCredentials,
  ttlSeconds: number = JWT_TTL_SECONDS,
): string {
  if (ttlSeconds > JWT_MAX_TTL_SECONDS) {
    throw new Error(
      `GitHub rejects App JWTs with exp > ${JWT_MAX_TTL_SECONDS}s; got ${ttlSeconds}.`,
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: now - JWT_CLOCK_SKEW_SECONDS,
    exp: now + ttlSeconds,
    iss: creds.app_id,
  };

  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const key = createPrivateKey(creds.private_key);
  const signature = cryptoSign("RSA-SHA256", Buffer.from(signingInput), key);

  return `${signingInput}.${base64url(signature)}`;
}

export async function getInstallationTokenFromSecret(
  secretName: string,
  installId: string | number,
): Promise<InstallationToken> {
  const creds = await getAppCredentialsFromSecret(secretName);
  return exchangeJWTForInstallationToken(creds, installId);
}

export async function getInstallationToken(
  prefix: string,
  app: AppName,
  installId: string | number,
): Promise<InstallationToken> {
  const creds = await getAppCredentials(prefix, app);
  return exchangeJWTForInstallationToken(creds, installId);
}

async function exchangeJWTForInstallationToken(
  creds: AppCredentials,
  installId: string | number,
): Promise<InstallationToken> {
  const jwt = mintAppJWT(creds);

  const url = `https://api.github.com/app/installations/${installId}/access_tokens`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agent-forge",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub installation token exchange failed for install=${installId}: ` +
        `${response.status} ${response.statusText}\n${body}`,
    );
  }

  const data = (await response.json()) as {
    token: string;
    expires_at: string;
  };

  return { token: data.token, expiresAt: new Date(data.expires_at) };
}
