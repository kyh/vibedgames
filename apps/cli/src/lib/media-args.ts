import { existsSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, resolve } from "node:path";

import { MEDIA_EXT } from "./media-types.js";
import { isRecord } from "./types.js";

// Only long flags. parseRunInput already skips anything not starting
// with "--", so single-dash aliases (-h/-q) never need to be listed.
const KNOWN_GLOBAL_FLAGS = new Set(["--json", "--help", "--quiet"]);

// Run-command CLI flags that must NOT be forwarded to fal as model
// inputs. `--async` is a citty-defined boolean on `vg media run` (it
// switches the sync/queue path); we re-parse argv from scratch here,
// so we have to filter it out ourselves. `--download` takes an optional
// path/template that should never end up as a model param.
// Note: `--logs` is intentionally not here. It's a `vg media status`
// flag, not a `run` flag, so swallowing it would block users from
// passing a legitimate `logs` parameter to a fal model endpoint.
const KNOWN_RUN_FLAGS = new Set(["--async", "--download"]);

/**
 * Parse `--<key> value` pairs from argv into a JS object, JSON-decoding
 * values that look like JSON (true/false/null/numbers/objects/arrays) and
 * leaving everything else as a string. Mirrors genmedia's parse-value
 * behavior so skills targeting genmedia produce the same input shapes.
 *
 * Handles both `--key value` and the GNU-style `--key=value`. Without
 * `=` support, `--prompt=hello` would silently send the malformed key
 * `"prompt=hello"` to fal, and `--async=true` would slip past the
 * KNOWN_*_FLAGS guards as a bogus model param.
 */
export function parseRunInput(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    const eqIdx = arg.indexOf("=");
    const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
    if (KNOWN_GLOBAL_FLAGS.has(name) || KNOWN_RUN_FLAGS.has(name)) {
      // --download (without inline value) optionally consumes the next
      // token as its template. With `--download=foo` the value is
      // already attached and we move on without skipping anything.
      if (name === "--download" && inlineValue === undefined) {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) i++;
      }
      continue;
    }
    const key = name.slice(2);
    if (inlineValue !== undefined) {
      assign(out, key, parseValue(inlineValue));
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      // Bare boolean flag
      assign(out, key, true);
      continue;
    }
    assign(out, key, parseValue(next));
    i++;
  }
  return out;
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
  // Repeated flags collect into an array (e.g. --image_url a --image_url b).
  if (key in out) {
    const existing = out[key];
    if (Array.isArray(existing)) existing.push(value);
    else out[key] = [existing, value];
    return;
  }
  out[key] = value;
}

function parseValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (raw.length > 0 && (raw[0] === "{" || raw[0] === "[")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export type FilePathRef = {
  /** Placeholder token written into `rewritten` and later swapped for
   *  the post-upload URL. Kept on the ref itself so the file/URL mapping
   *  has a single source of truth instead of two parallel collections. */
  token: string;
  path: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
};

/**
 * Walk a freshly parsed run input, find values that look like local file
 * paths, and replace them with placeholder tokens. Returns the originals
 * so the caller can upload them and substitute the resulting URLs back in.
 *
 * A value is treated as a local path when it's a string that resolves to
 * an existing file. We deliberately accept any param name (not just *_url)
 * because fal endpoints use a variety of input keys and we want
 * genmedia-style ergonomics for all of them.
 */
export function extractLocalFiles(input: Record<string, unknown>): {
  files: FilePathRef[];
  rewritten: Record<string, unknown>;
} {
  const files: FilePathRef[] = [];
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    rewritten[key] = mapValue(value, files);
  }
  return { files, rewritten };
}

function mapValue(value: unknown, files: FilePathRef[]): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => mapValue(v, files));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapValue(v, files);
    return out;
  }
  if (typeof value !== "string") return value;
  const stat = readLocalFile(value);
  if (!stat) return value;
  const token = `__vg_upload_${files.length}__`;
  files.push({ token, ...stat });
  return token;
}

// Conservative "this string is a media path" heuristic. Without it,
// `--style painterly` would silently get auto-uploaded as soon as a
// file named `painterly` existed in cwd. We require either an explicit
// path-like prefix/separator, or a recognizable media extension.

function looksLikeMediaPath(value: string): boolean {
  if (
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith(".\\") ||
    value.startsWith("..\\") ||
    value.startsWith("~/") ||
    value.startsWith("/") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    return true;
  }
  const dot = value.lastIndexOf(".");
  if (dot === -1 || dot === value.length - 1) return false;
  return MEDIA_EXT.has(value.slice(dot + 1).toLowerCase());
}

function readLocalFile(value: string): Omit<FilePathRef, "token"> | null {
  // Skip values that are clearly not paths.
  if (value.startsWith("http://") || value.startsWith("https://")) return null;
  if (value.startsWith("data:")) return null;
  if (value.length === 0) return null;
  // Avoid the painterly-vs-painterly-file footgun: don't even stat()
  // bare tokens that don't look like paths to a human reader.
  if (!looksLikeMediaPath(value)) return null;
  return statLocalFile(value);
}

/**
 * Probe a path that the user explicitly asked us to read (e.g.
 * `vg media upload <path>`). Skips the looksLikeMediaPath heuristic
 * so a bare filename with a non-media extension — `model.glb`,
 * `scene.fbx`, `data.ply`, even `LICENSE` — still works.
 */
export function readExplicitLocalFile(value: string): Omit<FilePathRef, "token"> | null {
  if (value.startsWith("http://") || value.startsWith("https://")) return null;
  if (value.startsWith("data:")) return null;
  if (value.length === 0) return null;
  return statLocalFile(value);
}

function statLocalFile(value: string): Omit<FilePathRef, "token"> | null {
  const abs = isAbsolute(value) ? value : resolve(value);
  if (!existsSync(abs)) return null;
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return {
    path: abs,
    filename: basename(abs),
    contentType: contentTypeForPath(abs),
    sizeBytes: stat.size,
  };
}

// Local to this module — the deploy path has its own MIME map in
// manifest.ts geared toward static-site assets (HTML/JS/CSS with charset
// directives). Unifying them now would mean inventing a shared file just
// to bridge two unrelated callers; revisit if a third caller appears.
function contentTypeForPath(path: string): string {
  // extname splits on basename, so a dotted directory like
  // "/home/user/my.project/texture" correctly yields "" instead of
  // mistaking "project/texture" for the extension.
  const ext = extname(path).slice(1).toLowerCase();
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    bmp: "image/bmp",
    tif: "image/tiff",
    tiff: "image/tiff",
    avif: "image/avif",
    mp4: "video/mp4",
    mov: "video/quicktime",
    webm: "video/webm",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    flac: "audio/flac",
    m4a: "audio/mp4",
    txt: "text/plain",
    json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * After upload, walk the rewritten input and replace placeholder tokens
 * with the resolved presigned URLs.
 */
export function substituteTokens(
  rewritten: Record<string, unknown>,
  tokenToUrl: Map<string, string>,
): Record<string, unknown> {
  return mapTokens(rewritten, tokenToUrl) as Record<string, unknown>;
}

function mapTokens(value: unknown, tokenToUrl: Map<string, string>): unknown {
  if (typeof value === "string" && tokenToUrl.has(value)) {
    return tokenToUrl.get(value);
  }
  if (Array.isArray(value)) return value.map((v) => mapTokens(v, tokenToUrl));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapTokens(v, tokenToUrl);
    return out;
  }
  return value;
}

export function parseDownloadFlag(argv: string[]): { mode: "off" | "on"; template?: string } {
  // Walk argv to find the *last* --download form; supports both
  // `--download value` and the GNU `--download=value`.
  let lastIdx = -1;
  let inlineValue: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--download") {
      lastIdx = i;
      inlineValue = undefined;
    } else if (arg.startsWith("--download=")) {
      lastIdx = i;
      inlineValue = arg.slice("--download=".length);
    }
  }
  if (lastIdx === -1) return { mode: "off" };
  const candidate = inlineValue ?? argv[lastIdx + 1];
  if (
    candidate === undefined ||
    candidate === "" ||
    candidate.startsWith("--") ||
    // Treat literal "true"/"false" as a no-value boolean flag — users
    // who type `--download true` (thinking the flag is boolean) would
    // otherwise end up creating a directory literally named "true".
    candidate === "true" ||
    candidate === "false"
  ) {
    return { mode: "on" };
  }
  return { mode: "on", template: candidate };
}
