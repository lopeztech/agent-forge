import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

let _client: SecretsManagerClient | undefined;
const _cache = new Map<string, string>();

function client(): SecretsManagerClient {
  if (!_client) {
    _client = new SecretsManagerClient({});
  }
  return _client;
}

export async function getSecretString(name: string): Promise<string> {
  const hit = _cache.get(name);
  if (hit !== undefined) return hit;

  const response = await client().send(
    new GetSecretValueCommand({ SecretId: name }),
  );

  if (!response.SecretString) {
    throw new Error(
      `Secret "${name}" has no SecretString — only SecretBinary is set, which agent-forge does not use.`,
    );
  }

  _cache.set(name, response.SecretString);
  return response.SecretString;
}

export function _resetSecretCacheForTests(): void {
  _cache.clear();
  _client = undefined;
}
