// Per-repo GitHub helpers shared by every agent role + glue Lambda. Auth
// (installation tokens) lives in ./auth.ts — this file is the layer above:
// REST calls scoped to a single token, with the headers/UA convention every
// caller uses.

const API = "https://api.github.com";

export type RequestOptions = {
  token: string;
  userAgent: string;
};

export type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels?: Array<{ name: string }>;
};

// A freshly-minted GitHub installation token can briefly return 401 "Bad
// credentials" from a stale edge cache before propagating — observed in
// production on the Cost Estimator Lambda where postComment(...) succeeded
// and addLabels(...) failed 600ms later on the same token. One short retry
// resolves this. If it's still 401 after that, the token really is bad.
const TRANSIENT_AUTH_RETRY_DELAY_MS = 500;

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
  const url = `${API}${path}`;
  let r = await fetch(url, init);
  if (r.status === 401) {
    console.log(
      JSON.stringify({
        msg: "github-api-401-retry",
        method,
        path,
        delay_ms: TRANSIENT_AUTH_RETRY_DELAY_MS,
      }),
    );
    await new Promise((resolve) =>
      setTimeout(resolve, TRANSIENT_AUTH_RETRY_DELAY_MS),
    );
    r = await fetch(url, init);
  }
  return r;
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

export type IssueListItem = {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  html_url: string;
  labels: Array<{ name: string } | string>;
  // ISO-8601; the GitHub list-issues response always includes it. Used by the
  // reconciler as a "label has been stable for a while" proxy.
  updated_at?: string;
};

// Lists issues for a repo. Default state=open, default per_page=100, paginates
// up to maxPages (default 5 = 500 issues, plenty for v1). PRs are surfaced by
// GitHub through this endpoint too — filter them out with `issue.pull_request`
// if the caller cares.
export async function listIssues(
  opts: RequestOptions,
  repo: string,
  args: { state?: "open" | "closed" | "all"; maxPages?: number } = {},
): Promise<IssueListItem[]> {
  const state = args.state ?? "open";
  const maxPages = args.maxPages ?? 5;
  const all: IssueListItem[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await ghOrThrow(
      opts,
      "GET",
      `/repos/${repo}/issues?state=${state}&per_page=100&page=${page}`,
    );
    const items = (await r.json()) as Array<
      IssueListItem & { pull_request?: unknown }
    >;
    const issuesOnly = items.filter((i) => !("pull_request" in i && i.pull_request));
    all.push(...issuesOnly);
    if (items.length < 100) break;
  }
  return all;
}

export async function createIssue(
  opts: RequestOptions,
  repo: string,
  args: { title: string; body: string; labels?: string[] },
): Promise<{ number: number; html_url: string }> {
  const r = await ghOrThrow(opts, "POST", `/repos/${repo}/issues`, {
    title: args.title,
    body: args.body,
    ...(args.labels && args.labels.length > 0 ? { labels: args.labels } : {}),
  });
  return (await r.json()) as { number: number; html_url: string };
}

export async function getIssue(
  opts: RequestOptions,
  repo: string,
  issueNumber: number | string,
): Promise<GitHubIssue> {
  const r = await ghOrThrow(
    opts,
    "GET",
    `/repos/${repo}/issues/${issueNumber}`,
  );
  return (await r.json()) as GitHubIssue;
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

// Creates a label on the repo if it doesn't exist. Returns true if created.
// Idempotent: a 422 "already_exists" response is treated as a successful no-op.
// Used by BA to materialize per-product `area:<name>` labels on demand —
// these aren't seeded centrally because their names come from each target
// repo's .agent-forge/areas.yml.
export async function ensureLabel(
  opts: RequestOptions,
  repo: string,
  name: string,
  color: string,
  description: string,
): Promise<boolean> {
  const r = await gh(opts, "POST", `/repos/${repo}/labels`, {
    name,
    color,
    description,
  });
  if (r.ok) return true;
  if (r.status === 422) {
    // 422 = label already exists. The GitHub error body has a non-stable
    // shape; we don't bother re-parsing, just treat as a no-op.
    return false;
  }
  const text = await r.text();
  throw new Error(
    `Creating label "${name}" failed: ${r.status} ${r.statusText}\n${text}`,
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

// Look up the single open PR for a given head branch. Returns undefined if no
// open PR exists (e.g. it was already merged or closed). Used by PO to find
// the Dev-opened PR for an issue from the conventional branch name without
// having to thread the PR number through issue_state.
export async function findOpenPRByHead(
  opts: RequestOptions,
  repo: string,
  headBranch: string,
): Promise<{ number: number; html_url: string } | undefined> {
  const owner = repo.split("/")[0]!;
  const r = await ghOrThrow(
    opts,
    "GET",
    `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(
      `${owner}:${headBranch}`,
    )}`,
  );
  const list = (await r.json()) as Array<{ number: number; html_url: string }>;
  return list[0];
}

export async function listPullRequestFiles(
  opts: RequestOptions,
  repo: string,
  prNumber: number,
): Promise<Array<{ filename: string }>> {
  const out: Array<{ filename: string }> = [];
  for (let page = 1; ; page++) {
    const r = await ghOrThrow(
      opts,
      "GET",
      `/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
    );
    const batch = (await r.json()) as Array<{ filename: string }>;
    out.push(...batch);
    if (batch.length < 100) return out;
  }
}

export type MergePROpts = {
  // Squash is the agent-forge default — PRs stack Dev + Test (+ optional
  // Functional fixture) commits and a single squash commit on main keeps
  // history clean. Per-product override lands when we need it.
  mergeMethod?: "merge" | "squash" | "rebase";
  commitTitle?: string;
  commitMessage?: string;
};

export type MergePRResult =
  | {
      ok: true;
      sha: string;
    }
  | {
      ok: false;
      // 405 = branch protection / not mergeable; 409 = head out of sync;
      // 422 = no commits / conflict. Callers branch on the status.
      status: number;
      body: string;
    };

// PUT /repos/{repo}/pulls/{n}/merge. Distinct from creating a comment + label —
// this is the privileged action that the merger App is for. PO is the only
// role expected to call this; F.2.a wires it behind products.auto_merge.
export async function mergePR(
  opts: RequestOptions,
  repo: string,
  prNumber: number,
  mergeOpts: MergePROpts = {},
): Promise<MergePRResult> {
  const body: Record<string, unknown> = {
    merge_method: mergeOpts.mergeMethod ?? "squash",
  };
  if (mergeOpts.commitTitle !== undefined) body.commit_title = mergeOpts.commitTitle;
  if (mergeOpts.commitMessage !== undefined) body.commit_message = mergeOpts.commitMessage;
  const r = await gh(opts, "PUT", `/repos/${repo}/pulls/${prNumber}/merge`, body);
  if (r.ok) {
    const parsed = (await r.json()) as { sha: string; merged: boolean };
    if (!parsed.merged) {
      // 200 OK but merged=false would be unusual; treat as failure.
      return { ok: false, status: 200, body: "GitHub returned merged=false" };
    }
    return { ok: true, sha: parsed.sha };
  }
  return { ok: false, status: r.status, body: await r.text() };
}
