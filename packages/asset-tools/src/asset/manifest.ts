import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isJsonObject, isJsonString, parseJsonText } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";
import { parseLua } from "./lua.js";
import type { LuaValue } from "./lua.js";
import { compareStrings, prettyPath, walkFiles } from "./paths.js";

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
const LUA_PATH_RE = /path\s*=\s*"(?<file>[^"]+\.png)"/gu;

// `meta = { version = 1, root = "assets", ... }`. Read with a regex rather than
// the Lua parser for the same reason as LUA_PATH_RE: a manifest this repo has
// never seen must still be checkable, and a parse error here would take the
// whole check down.
const LUA_META_ROOT_RE = /meta\s*=\s*\{[^}]*\broot\s*=\s*"(?<root>[^"]*)"/u;

const resolveManifestPath = (raw: string, manifestDir: string, root: string | null): string => {
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }
  return root ? path.resolve(manifestDir, root, raw) : path.resolve(manifestDir, raw);
};

/** `meta.root` — the folder every relative `path` in the manifest hangs off. */
const metaRootOf = (payload: JsonValue): string | null => {
  if (!isJsonObject(payload)) {
    return null;
  }
  const { meta } = payload;
  if (!isJsonObject(meta)) {
    return null;
  }
  const { root } = meta;
  return isJsonString(root) && root ? root : null;
};

/** Collect every `.png` value stored under a `path` key, at any depth. */
const collectJsonPaths = (payload: JsonValue): string[] => {
  const paths: string[] = [];
  const visit = (node: JsonValue) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }
    if (!isJsonObject(node)) {
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "path" && isJsonString(value) && value.toLowerCase().endsWith(".png")) {
        paths.push(value);
      } else {
        visit(value);
      }
    }
  };
  visit(payload);
  return paths;
};

/** Absolute paths of every PNG the manifest references. */
export const extractManifestPaths = (manifestPath: string): Set<string> => {
  const manifestDir = path.resolve(path.dirname(manifestPath));

  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = parseJsonText(readFileSync(manifestPath, "utf-8"));
    if (!isJsonObject(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    const jsonRoot = metaRootOf(payload);
    return new Set(
      collectJsonPaths(payload).map((p) => resolveManifestPath(p, manifestDir, jsonRoot)),
    );
  }

  const text = readFileSync(manifestPath, "utf-8");
  const luaRoot = LUA_META_ROOT_RE.exec(text)?.groups?.root ?? null;
  const out = new Set<string>();
  for (const match of text.matchAll(LUA_PATH_RE)) {
    out.add(resolveManifestPath(match.groups?.file ?? "", manifestDir, luaRoot));
  }
  return out;
};

export interface ManifestCheck {
  manifest_paths: number;
  actual_pngs: number;
  missing: string[];
  extra: string[];
}

/**
 * Compare the manifest against what is actually on disk.
 *
 * `missing` is art the game ships but never declares (so it never loads);
 * `extra` is art the manifest promises but nobody shipped (so it 404s at
 * runtime). Both are silent failures without this check.
 */
export const checkManifest = (manifestPath: string, root: string): ManifestCheck => {
  const manifestPaths = extractManifestPaths(manifestPath);
  const actualPaths = new Set(walkFiles(root, ".png").map((p) => path.resolve(p)));

  const missing = [...actualPaths].filter((p) => !manifestPaths.has(p)).map(prettyPath);
  const extra = [...manifestPaths].filter((p) => !actualPaths.has(p)).map(prettyPath);

  return {
    actual_pngs: actualPaths.size,
    extra: extra.toSorted(compareStrings),
    manifest_paths: manifestPaths.size,
    missing: missing.toSorted(compareStrings),
  };
};

/** Find the first manifest that exists among the conventional names. */
export const autoDetectManifest = (): string | null =>
  MANIFEST_CANDIDATES.find((p) => existsSync(p)) ?? null;

// Lua manifests use terse keys; JSON consumers get the spelled-out ones.
const KEY_RENAMES = new Map([
  ["w", "width"],
  ["h", "height"],
  ["tileW", "tileWidth"],
  ["tileH", "tileHeight"],
  ["frameW", "frameWidth"],
  ["frameH", "frameHeight"],
]);

const renameTableKeys = (table: JsonObject): JsonObject => {
  const out: Record<string, LuaValue> = {};
  for (const [key, nested] of Object.entries(table)) {
    // oxlint-disable-next-line no-use-before-define -- mutually recursive with renameKeys
    out[KEY_RENAMES.get(key) ?? key] = renameKeys(nested);
  }
  return out;
};

const renameKeys = (value: LuaValue): LuaValue => {
  if (Array.isArray(value)) {
    return value.map(renameKeys);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return renameTableKeys(value);
};

/**
 * Rewrite every `path` so it reads relative to `base`.
 *
 * `sourceRoot` is where the manifest's own relative paths point (its folder
 * joined with `meta.root`) — resolving against the process cwd instead would
 * make the export depend on where the command happened to be run from.
 *
 * A `../` result is emitted rather than suppressed: a path that escapes `base`
 * is still a true path, whereas leaving the original in place next to
 * `meta.root = "."` silently points the manifest at files that aren't there.
 */
const rewriteTablePaths = (base: string, sourceRoot: string, table: JsonObject): JsonObject => {
  const out: Record<string, LuaValue> = {};
  for (const [key, nested] of Object.entries(table)) {
    if (key === "path" && isJsonString(nested) && nested.toLowerCase().endsWith(".png")) {
      const absolute = path.isAbsolute(nested)
        ? path.resolve(nested)
        : path.resolve(sourceRoot, nested);
      const rel = path.relative(path.resolve(base), absolute);
      out[key] = rel ? rel.split(/[/\\]/u).join("/") : nested;
    } else {
      // oxlint-disable-next-line no-use-before-define -- mutually recursive with rewritePaths
      out[key] = rewritePaths(base, sourceRoot, nested);
    }
  }
  return out;
};

const rewritePaths = (base: string, sourceRoot: string, value: LuaValue): LuaValue => {
  if (Array.isArray(value)) {
    return value.map((item) => rewritePaths(base, sourceRoot, item));
  }
  if (!isJsonObject(value)) {
    return value;
  }
  return rewriteTablePaths(base, sourceRoot, value);
};

/**
 * Load a manifest and normalise it into the portable JSON shape.
 *
 * `outPath` is where the JSON will be written; paths are rebased onto its
 * folder so the exported file works from where it lands. Without it they are
 * rebased onto the manifest's own folder.
 */
export const exportManifest = (
  manifestPath: string,
  packRelative: boolean,
  outPath?: string,
): LuaValue => {
  if (manifestPath.toLowerCase().endsWith(".json")) {
    const payload = parseJsonText(readFileSync(manifestPath, "utf-8"));
    if (!isJsonObject(payload)) {
      throw new Error("JSON manifest must be an object at top-level.");
    }
    return payload;
  }

  const parsed = parseLua(readFileSync(manifestPath, "utf-8"));
  if (!isJsonObject(parsed)) {
    throw new Error("Lua manifest must return a table/object.");
  }

  let normalized = renameTableKeys(parsed);
  if (packRelative) {
    const manifestDir = path.resolve(path.dirname(manifestPath));
    const sourceRoot = path.resolve(manifestDir, metaRootOf(normalized) ?? ".");
    const base = outPath ? path.resolve(path.dirname(outPath)) : manifestDir;
    normalized = rewriteTablePaths(base, sourceRoot, normalized);
    const { meta } = normalized;
    if (isJsonObject(meta)) {
      meta.root = ".";
    } else {
      normalized.meta = { root: "." };
    }
  }
  return normalized;
};
