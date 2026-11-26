import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { isJsonObject, isJsonString, parseJsonText } from "./json.js";
import type { JsonObject, JsonValue } from "./json.js";
import { parseLua } from "./lua.js";
import type { LuaValue } from "./lua.js";
import { compareStrings, prettyPath, walkFiles } from "./paths.js";

/** Manifest filenames looked for when `--manifest` is omitted. */
export const MANIFEST_CANDIDATES = [
  "assets_index.lua",
  "asset_index.lua",
  "assets/assets_index.lua",
  "assets/asset_index.lua",
];

const LUA_PATH_RE = /path\s*=\s*"(?<file>[^"]+\.png)"/gu;

const LUA_META_ROOT_RE = /meta\s*=\s*\{[^}]*\broot\s*=\s*"(?<root>[^"]*)"/u;

const resolveManifestPath = (raw: string, manifestDir: string, root: string | null) => {
  if (path.isAbsolute(raw)) {
    return path.resolve(raw);
  }

  return root !== null && root !== ""
    ? path.resolve(manifestDir, root, raw)
    : path.resolve(manifestDir, raw);
};

const metaRootOf = (payload: JsonValue) => {
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

const collectJsonPaths = (payload: JsonValue) => {
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
export const extractManifestPaths = (manifestPath: string) => {
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
export const checkManifest = (manifestPath: string, root: string) => {
  const manifestPaths = extractManifestPaths(manifestPath);
  const actualPaths = new Set(walkFiles(root, ".png").map((p) => path.resolve(p)));

  const missing = [...actualPaths].flatMap((p) => (manifestPaths.has(p) ? [] : [prettyPath(p)]));
  const extra = [...manifestPaths].flatMap((p) => (actualPaths.has(p) ? [] : [prettyPath(p)]));

  return {
    actual_pngs: actualPaths.size,
    extra: extra.toSorted(compareStrings),
    manifest_paths: manifestPaths.size,
    missing: missing.toSorted(compareStrings),
  };
};

/** Find the first manifest that exists among the conventional names. */
export const autoDetectManifest = () => MANIFEST_CANDIDATES.find((p) => existsSync(p)) ?? null;

const KEY_RENAMES = new Map([
  ["w", "width"],
  ["h", "height"],
  ["tileW", "tileWidth"],
  ["tileH", "tileHeight"],
  ["frameW", "frameWidth"],
  ["frameH", "frameHeight"],
]);

const renameTableKeys = (table: JsonObject) => {
  const out: Record<string, LuaValue> = {};

  for (const [key, nested] of Object.entries(table)) {
    out[KEY_RENAMES.get(key) ?? key] = renameKeys(nested);
  }

  return out;
};

const renameKeys: (value: LuaValue) => LuaValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(renameKeys);
  }

  if (!isJsonObject(value)) {
    return value;
  }

  return renameTableKeys(value);
};

const rewriteTablePaths = (base: string, sourceRoot: string, table: JsonObject) => {
  const out: Record<string, LuaValue> = {};

  for (const [key, nested] of Object.entries(table)) {
    if (key === "path" && isJsonString(nested) && nested.toLowerCase().endsWith(".png")) {
      const absolute = path.isAbsolute(nested)
        ? path.resolve(nested)
        : path.resolve(sourceRoot, nested);

      const rel = path.relative(path.resolve(base), absolute);
      out[key] = rel ? rel.split(/[/\\]/u).join("/") : nested;
    } else {
      out[key] = rewritePaths(base, sourceRoot, nested);
    }
  }

  return out;
};

const rewritePaths: (base: string, sourceRoot: string, value: LuaValue) => LuaValue = (
  base,
  sourceRoot,
  value,
) => {
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
export const exportManifest = (manifestPath: string, packRelative: boolean, outPath?: string) => {
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

    const base =
      outPath !== undefined && outPath !== "" ? path.resolve(path.dirname(outPath)) : manifestDir;

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
