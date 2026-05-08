import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";

import { isRecord } from "./types.js";

const KNOWN_GLOBAL_FLAGS = new Set(["--json", "--help", "-h", "--quiet", "-q"]);

const KNOWN_RUN_FLAGS = new Set(["--async", "--logs", "--download"]);

/**
 * Parse `--<key> value` pairs from argv into a JS object, JSON-decoding
 * values that look like JSON (true/false/null/numbers/objects/arrays) and
 * leaving everything else as a string. Mirrors genmedia's parse-value
 * behavior so skills targeting genmedia produce the same input shapes.
 */
export function parseRunInput(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    if (KNOWN_GLOBAL_FLAGS.has(arg) || KNOWN_RUN_FLAGS.has(arg)) {
      // --download takes an optional value; skip it if present and not another flag
      if (arg === "--download") {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) i++;
      }
      continue;
    }
    const key = arg.slice(2);
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
  tokens: Map<string, string>;
  rewritten: Record<string, unknown>;
} {
  const files: FilePathRef[] = [];
  const tokens = new Map<string, string>();
  const rewritten: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    rewritten[key] = mapValue(value, files, tokens);
  }
  return { files, tokens, rewritten };
}

function mapValue(value: unknown, files: FilePathRef[], tokens: Map<string, string>): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => mapValue(v, files, tokens));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapValue(v, files, tokens);
    return out;
  }
  if (typeof value !== "string") return value;
  const ref = readLocalFile(value);
  if (!ref) return value;
  const token = `__vg_upload_${files.length}__`;
  files.push(ref);
  tokens.set(token, ref.path);
  return token;
}

function readLocalFile(value: string): FilePathRef | null {
  // Skip values that are clearly not paths.
  if (value.startsWith("http://") || value.startsWith("https://")) return null;
  if (value.startsWith("data:")) return null;
  if (value.length === 0) return null;
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

export function contentTypeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
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
  const idx = argv.lastIndexOf("--download");
  if (idx === -1) return { mode: "off" };
  const next = argv[idx + 1];
  if (next && !next.startsWith("--")) return { mode: "on", template: next };
  return { mode: "on" };
}
