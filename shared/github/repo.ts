// Per-repo GitHub helpers shared by every agent role + glue Lambda. Auth
// (installation tokens) lives in ./auth.ts — this file is the layer above:
// REST calls scoped to a single token, with the headers/UA convention every
// caller uses.

const API = "https://api.github.com";

export type RequestOptions = {
  token: string;
  userAgent: string;
};

async function gh(
  opts: RequestOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${opts.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": opts.userAgent,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  return fetch(`${API}${path}`, init);
}

async function ghOrThrow(
  opts: RequestOptions,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const r = await gh(opts, method, path, body);
  if (!r.ok) {
    const text = await r.text();
    throw new Error(
      `GitHub API ${method} ${path} failed: ${r.status} ${r.statusText}\n${text}`,
    );
  }
  return r;
}

export async function postComment(
  opts: RequestOptions,
  repo: string,
  issueNumber: number | string,
  body: string,
): Promise<{ id: number; html_url: string }> {
  const r = await ghOrThrow(
    opts,
    "POST",
    `/repos/${repo}/issues/${issueNumber}/comments`,
    { body },
  );
  return (await r.json()) as { id: number; html_url: string };
}

export async function addLabels(
  opts: RequestOptions,
  repo: string,
  issueNumber: number | string,
  labels: string[],
): Promise<void> {
  await ghOrThrow(
    opts,
    "POST",
    `/repos/${repo}/issues/${issueNumber}/labels`,
    { labels },
  );
}

// Removing a label that's not present returns 404. Treated as a no-op so
// callers don't have to pre-check.
export async function removeLabel(
  opts: RequestOptions,
  repo: string,
  issueNumber: number | string,
  label: string,
): Promise<void> {
  const r = await gh(
    opts,
    "DELETE",
    `/repos/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
  );
  if (!r.ok && r.status !== 404) {
    throw new Error(
      `Removing label "${label}" failed: ${r.status} ${r.statusText}`,
    );
  }
}

export async function transitionLabel(
  opts: RequestOptions,
  repo: string,
  issueNumber: number | string,
  fromLabel: string,
  toLabel: string,
): Promise<void> {
  await removeLabel(opts, repo, issueNumber, fromLabel);
  await addLabels(opts, repo, issueNumber, [toLabel]);
}
