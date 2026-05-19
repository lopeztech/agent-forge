// Recursive walker for a directory in a GitHub repo, via the Contents API.
// Used by BA to read the target product's spec/ tree.
//
// Bounded: max files, max total bytes, max depth. If the spec grows beyond
// any cap we truncate (sorted alphabetically for determinism) and surface the
// truncation in the result metadata. Never throws on size — only on transport
// or genuine API errors. A missing path returns an empty result, not an error,
// because a freshly-onboarded product may not have seeded spec/ yet.

const API = "https://api.github.com";

export type SpecFile = {
  path: string;
  bytes: number;
  content: string;
};

export type SpecReadResult = {
  files: SpecFile[];
  total_bytes: number;
  truncated_by: "files" | "bytes" | "depth" | null;
  missing: boolean;
};

export type SpecReadOptions = {
  token: string;
  userAgent: string;
  repo: string; // "owner/name"
  path: string; // e.g. "spec/"
  maxFiles?: number;
  maxTotalBytes?: number;
  maxDepth?: number;
  ref?: string; // branch / sha; default repo's default branch
};

const DEFAULTS = {
  maxFiles: 50,
  maxTotalBytes: 200 * 1024,
  maxDepth: 5,
} as const;

// GitHub Contents API entry. dir = listing; file with content + encoding when
// path resolves to a single file < 1 MB.
type ContentsDirEntry = {
  type: "dir" | "file" | "symlink" | "submodule";
  name: string;
  path: string;
  size: number;
  sha: string;
};

type ContentsFile = {
  type: "file";
  name: string;
  path: string;
  size: number;
  sha: string;
  encoding: "base64" | "none";
  content: string;
};

function shouldSkip(name: string): boolean {
  if (name.startsWith(".")) return true; // dotfiles / dotdirs
  // Common binary extensions BA can't read anyway.
  return /\.(png|jpe?g|gif|svg|pdf|zip|tar|gz|wasm|bin|ico|woff2?|ttf|otf)$/i.test(name);
}

function gh(opts: { token: string; userAgent: string }): Record<string, string> {
  return {
    Authorization: `Bearer ${opts.token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": opts.userAgent,
  };
}

async function listDir(
  opts: SpecReadOptions,
  path: string,
): Promise<ContentsDirEntry[] | null> {
  const ref = opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : "";
  const r = await fetch(
    `${API}/repos/${opts.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${ref}`,
    { headers: gh(opts) },
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(
      `Contents API ${opts.repo}:${path} failed: ${r.status} ${r.statusText}\n${await r.text()}`,
    );
  }
  const body = await r.json();
  // The Contents endpoint returns an array for a directory, an object for a file.
  // We only call this for known-directory paths; if GitHub returns an object
  // (path was actually a file), wrap it.
  return Array.isArray(body)
    ? (body as ContentsDirEntry[])
    : [body as ContentsDirEntry];
}

async function fetchFile(
  opts: SpecReadOptions,
  path: string,
): Promise<ContentsFile | null> {
  const ref = opts.ref ? `?ref=${encodeURIComponent(opts.ref)}` : "";
  const r = await fetch(
    `${API}/repos/${opts.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}${ref}`,
    { headers: gh(opts) },
  );
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(
      `Contents API ${opts.repo}:${path} failed: ${r.status} ${r.statusText}\n${await r.text()}`,
    );
  }
  return (await r.json()) as ContentsFile;
}

function decodeFileContent(file: ContentsFile): string {
  if (file.encoding === "base64") {
    return Buffer.from(file.content, "base64").toString("utf8");
  }
  // encoding "none" means GitHub omitted content (file > 1 MB). We treat those
  // as unreadable here; the caller can fetch via the blobs API if needed.
  return "";
}

export async function readSpecTree(
  options: SpecReadOptions,
): Promise<SpecReadResult> {
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
  const maxBytes = options.maxTotalBytes ?? DEFAULTS.maxTotalBytes;
  const maxDepth = options.maxDepth ?? DEFAULTS.maxDepth;

  // Normalise: strip leading/trailing slashes.
  const rootPath = options.path.replace(/^\/+|\/+$/g, "");

  const root = await listDir(options, rootPath);
  if (root === null) {
    return { files: [], total_bytes: 0, truncated_by: null, missing: true };
  }

  // BFS by depth; sort entries within each directory alphabetically for
  // deterministic truncation order.
  const files: SpecFile[] = [];
  let totalBytes = 0;
  let truncated_by: SpecReadResult["truncated_by"] = null;

  // Each work item: (path, depth, parent-listing-already-fetched-entries)
  type Frame = { entries: ContentsDirEntry[]; depth: number };
  const frames: Frame[] = [
    { entries: [...root].sort((a, b) => a.name.localeCompare(b.name)), depth: 0 },
  ];

  while (frames.length > 0) {
    const frame = frames.shift()!;
    if (frame.depth > maxDepth) {
      truncated_by = "depth";
      continue;
    }

    for (const entry of frame.entries) {
      if (shouldSkip(entry.name)) continue;

      if (entry.type === "dir") {
        const sub = await listDir(options, entry.path);
        if (sub) {
          frames.push({
            entries: [...sub].sort((a, b) => a.name.localeCompare(b.name)),
            depth: frame.depth + 1,
          });
        }
        continue;
      }

      if (entry.type !== "file") continue;

      if (files.length >= maxFiles) {
        truncated_by = truncated_by ?? "files";
        continue;
      }
      if (totalBytes + entry.size > maxBytes) {
        truncated_by = truncated_by ?? "bytes";
        continue;
      }

      const file = await fetchFile(options, entry.path);
      if (!file) continue;
      const content = decodeFileContent(file);
      if (!content) continue;

      files.push({ path: entry.path, bytes: entry.size, content });
      totalBytes += entry.size;
    }
  }

  return { files, total_bytes: totalBytes, truncated_by, missing: false };
}
