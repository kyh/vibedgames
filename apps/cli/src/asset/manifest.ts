import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { type LuaValue, parseLua } from "./lua.js";
import { prettyPath, walkFiles } from "./paths.js";

/**
 * Asset-manifest tooling: cross-check a manifest against the PNGs on disk, and
 * export a Lua manifest to portable JSON. Both understand `.lua` and `.json`
 * manifests so a project can migrate one file at a time.
 */

/** Manifest filenames looked for when `--manifest` is omitted. */
export const MANIFEST_CANDIDATES = [
  "assets_index.lua",
  "asset_index.lua",
  "assets/assets_index.lua",
  "assets/asset_index.lua",
];

// Lua entries look like: path = "assets/foo/bar.png". Deliberately loose so
// the check works against manifests this repo has never seen.
const LUA_PATH_RE = /path\s*=\s*"([^"]+\.png)"/g;

function resolveManifestPath(raw: string, manifestDir: string, jsonRoot: string | null): string {
  if (isAbsolute(raw)) return resolve(raw);
  return jsonRoot ? resolve(manifestDir, jsonRoot, raw) : resolve(manifestDir, raw);
}

/** Collect every `.png` value stored under a `path` key, at any depth. */
function collectJsonPaths(payload: unknown): string[] {
  const paths: string[] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key === "path" && typeof value === "string" && value.toLowerCase().endsWith(".png")) {
        paths.push(value);
      } else {
        visit(value);
      }
    }
  };
  visit(payload);
  return paths;
}

/** Absolute paths of every PNG the manifest references. */
export function extractManifestPaths(manifestPath: string): Set<string> {
  const manifestDir = resolve(dirname(manifestPath));

  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    const meta = (payload as Record<string, unknown>).meta;
    const jsonRoot =
      meta !== null &&
      typeof meta === "object" &&
      typeof (meta as Record<string, unknown>).root === "string"
        ? ((meta as Record<string, unknown>).root as string)
        : null;
    return new Set(
      collectJsonPaths(payload).map((p) => resolveManifestPath(p, manifestDir, jsonRoot)),
    );
  }

  const text = readFileSync(manifestPath, "utf8");
  const out = new Set<string>();
  for (const match of text.matchAll(LUA_PATH_RE)) {
    out.add(resolveManifestPath(match[1]!, manifestDir, null));
  }
  return out;
}

export type ManifestCheck = {
  manifest_paths: number;
  actual_pngs: number;
  missing: string[];
  extra: string[];
};

/**
 * Compare the manifest against what is actually on disk.
 *
 * `missing` is art the game ships but never declares (so it never loads);
 * `extra` is art the manifest promises but nobody shipped (so it 404s at
 * runtime). Both are silent failures without this check.
 */
export function checkManifest(manifestPath: string, root: string): ManifestCheck {
  const manifestPaths = extractManifestPaths(manifestPath);
  const actualPaths = new Set(walkFiles(root, ".png").map((p) => resolve(p)));

  const missing = [...actualPaths].filter((p) => !manifestPaths.has(p)).map(prettyPath);
  const extra = [...manifestPaths].filter((p) => !actualPaths.has(p)).map(prettyPath);
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  return {
    manifest_paths: manifestPaths.size,
    actual_pngs: actualPaths.size,
    missing: missing.sort(byName),
    extra: extra.sort(byName),
  };
}

/** Find the first manifest that exists among the conventional names. */
export function autoDetectManifest(): string | null {
  return MANIFEST_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

// Lua manifests use terse keys; JSON consumers get the spelled-out ones.
const KEY_RENAMES: Record<string, string> = {
  w: "width",
  h: "height",
  tileW: "tileWidth",
  tileH: "tileHeight",
  frameW: "frameWidth",
  frameH: "frameHeight",
};

function renameKeys(value: LuaValue): LuaValue {
  if (Array.isArray(value)) return value.map(renameKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, LuaValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    out[KEY_RENAMES[key] ?? key] = renameKeys(nested);
  }
  return out;
}

/** Rewrite every `path` to be relative to the manifest's own folder. */
function rewritePaths(base: string, value: LuaValue): LuaValue {
  if (Array.isArray(value)) return value.map((item) => rewritePaths(base, item));
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, LuaValue> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "path" && typeof nested === "string" && nested.toLowerCase().endsWith(".png")) {
      const absolute = isAbsolute(nested) ? resolve(nested) : resolve(process.cwd(), nested);
      const rel = relative(resolve(base), absolute);
      // Leaving the path alone beats emitting a `../..` escape hatch when the
      // asset lives outside the manifest's folder.
      out[key] = rel && !rel.startsWith("..") ? rel.split(/[/\\]/).join("/") : nested;
    } else {
      out[key] = rewritePaths(base, nested);
    }
  }
  return out;
}

/** Load a manifest and normalise it into the portable JSON shape. */
export function exportManifest(manifestPath: string, packRelative: boolean): LuaValue {
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    return payload as LuaValue;
  }

  const parsed = parseLua(readFileSync(manifestPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Lua manifest must return a table/object.");
  }

  let normalized = renameKeys(parsed) as Record<string, LuaValue>;
  if (packRelative) {
    normalized = rewritePaths(resolve(dirname(manifestPath)), normalized) as Record<
      string,
      LuaValue
    >;
    const meta = normalized.meta;
    if (meta !== null && typeof meta === "object" && !Array.isArray(meta)) {
      (meta as Record<string, LuaValue>).root = ".";
    } else {
      normalized.meta = { root: "." };
    }
  }
  return normalized;
}
