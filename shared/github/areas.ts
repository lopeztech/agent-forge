// Reader + parser for a target product's `.agent-forge/areas.yml`.
//
// Areas are the lock granularity for Dev parallelism. The file declares the
// top-level "areas" of the codebase and the path globs each one owns; this
// helper only cares about the area *names* — path-to-area matching is BA's
// concern when applying `area:<name>` labels.
//
// Schema (mandatory):
//
//   areas:
//     frontend:
//       paths: [src/web/**, src/components/**]
//     api:
//       paths: [src/server/**]
//
// Missing file → `missing: true` (caller decides whether that's a hard error).
// Invalid YAML / wrong shape → throws. Areas with empty `paths` arrays are
// accepted (BA needs paths, Dev doesn't).

import { parse as parseYaml } from "yaml";

const API = "https://api.github.com";

export type AreasFile = {
  areaNames: string[];
  paths: Record<string, string[]>;
};

export type AreasReadResult =
  | { missing: false; areas: AreasFile; path: string }
  | { missing: true; path: string };

export type AreasReadOptions = {
  token: string;
  userAgent: string;
  repo: string;
  path?: string;
  ref?: string;
};

const DEFAULT_PATH = ".agent-forge/areas.yml";

type ContentsFile = {
  type: "file";
  encoding: "base64" | "none";
  content: string;
};

export async function readAreasFile(
  options: AreasReadOptions,
): Promise<AreasReadResult> {
  const path = options.path ?? DEFAULT_PATH;
  const ref = options.ref ? `?ref=${encodeURIComponent(options.ref)}` : "";

  const r = await fetch(
    `${API}/repos/${options.repo}/contents/${encodeURI(path)}${ref}`,
    {
      headers: {
        Authorization: `Bearer ${options.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": options.userAgent,
      },
    },
  );

  if (r.status === 404) {
    return { missing: true, path };
  }
  if (!r.ok) {
    throw new Error(
      `Contents API ${options.repo}:${path} failed: ${r.status} ${r.statusText}\n${await r.text()}`,
    );
  }

  const body = (await r.json()) as ContentsFile;
  if (body.type !== "file") {
    throw new Error(
      `Expected ${path} to be a file; GitHub returned type=${body.type}.`,
    );
  }

  const raw =
    body.encoding === "base64"
      ? Buffer.from(body.content, "base64").toString("utf8")
      : body.content;

  return { missing: false, areas: parseAreasYaml(raw), path };
}

// Exported for unit tests — pure function over a YAML string.
export function parseAreasYaml(source: string): AreasFile {
  const doc = parseYaml(source);
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error("areas.yml must be a YAML mapping at the top level.");
  }

  const areas = (doc as Record<string, unknown>).areas;
  if (areas === null || typeof areas !== "object" || Array.isArray(areas)) {
    throw new Error("areas.yml must define a top-level `areas:` mapping.");
  }

  const entries = Object.entries(areas as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error("areas.yml: `areas:` mapping must declare at least one area.");
  }

  const paths: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (!name || /\s/.test(name)) {
      throw new Error(`areas.yml: invalid area name "${name}".`);
    }
    if (seen.has(name)) {
      throw new Error(`areas.yml: duplicate area "${name}".`);
    }
    seen.add(name);

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`areas.yml: area "${name}" must be a mapping.`);
    }
    const rawPaths = (value as Record<string, unknown>).paths;
    if (rawPaths === undefined) {
      paths[name] = [];
      continue;
    }
    if (!Array.isArray(rawPaths)) {
      throw new Error(`areas.yml: area "${name}".paths must be a list.`);
    }
    paths[name] = rawPaths.map((p, i) => {
      if (typeof p !== "string" || p.length === 0) {
        throw new Error(
          `areas.yml: area "${name}".paths[${i}] must be a non-empty string.`,
        );
      }
      return p;
    });
  }

  return {
    areaNames: Object.keys(paths).sort((a, b) => a.localeCompare(b)),
    paths,
  };
}
