export function isDocsOnlyTestChange(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(isDocsPath);
}

function isDocsPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".mdx");
}
