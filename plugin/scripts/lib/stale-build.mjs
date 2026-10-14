/**
 * Whether the bridge's compiled `dist/` is older than its TypeScript `src/`.
 * A pull rewrites the changed sources with the pull's time, and every runner
 * imports `dist/`, so until someone rebuilds, the pulled fixes do not run.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function tsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(path));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** `{ stale, missing, files }`: `files` names each source newer than its compiled file, or with none. */
export function staleBuild(bridgeDir) {
  const src = join(bridgeDir, "src");
  const dist = join(bridgeDir, "dist");
  if (!existsSync(src)) return { stale: false, missing: false, files: [] };
  if (!existsSync(dist)) return { stale: true, missing: true, files: [] };
  const files = [];
  for (const file of tsFiles(src)) {
    const rel = relative(src, file);
    const built = join(dist, rel.replace(/\.ts$/, ".js"));
    if (!existsSync(built) || statSync(file).mtimeMs > statSync(built).mtimeMs) files.push(rel);
  }
  return { stale: files.length > 0, missing: false, files };
}

export function staleBuildWarning(check) {
  if (!check.stale) return null;
  const what = check.missing ? "is not built (no dist/)" : `is older than its source (${check.files.slice(0, 3).join(", ")}${check.files.length > 3 ? `, +${check.files.length - 3} more` : ""})`;
  return `the model-dispatch bridge ${what}, so the code that runs is not the code on disk. Rebuild with: npm run build`;
}
