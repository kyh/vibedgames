import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { JsonObject, JsonValue } from "./types.js";

// `--json`/`--help`/`--quiet` are global; `--async` switches the run path
// in citty; `--download` takes an optional template. None of them should
// leak through to fal as model parameters. `--logs` is intentionally NOT
// here: it's a `vg generate status` flag, not a `run` flag, so swallowing it
// would block users from passing a legitimate `logs` parameter to a
// model endpoint.
const RUN_RESERVED_FLAGS = new Set([
  "--json",
  "--help",
  "--quiet",
  "--async",
  "--download",
  "--provider",
]);

const assign = (out: JsonObject, key: string, value: JsonValue): void => {
  const existing = out[key];
  if (existing !== undefined) {
    if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[key] = [existing, value];
    }
    return;
  }
  out[key] = value;
};
const parseValue = (raw: string): JsonValue => {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  if (raw === "null") {
    return null;
  }
  if (raw.length > 0 && (raw[0] === "{" || raw[0] === "[")) {
    try {
      // SAFETY: JSON.parse output is structurally JsonValue.
      return JSON.parse(raw) as JsonValue;
    } catch {
      return raw;
    }
  }
  if (/^-?\d+(?:\.\d+)?$/u.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return raw;
};
/**
 * Parse `--<key> value` pairs from argv into a JS object, JSON-decoding
 * values that look like JSON (true/false/null/numbers/objects/arrays) and
 * leaving everything else as a string. The parse-value behavior is stable
 * so skills targeting this surface produce the same input shapes.
 *
 * Handles both `--key value` and the GNU-style `--key=value`. Without
 * `=` support, `--prompt=hello` would silently send the malformed key
 * `"prompt=hello"` upstream, and `--async=true` would slip past the
 * RUN_RESERVED_FLAGS guard as a bogus model param.
 */
export const parseRunInput = (argv: string[]) => {
  const out: JsonObject = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) {
      continue;
    }
    // POSIX `--` argument terminator: stop interpreting subsequent
    // tokens as flags. Without this guard, `--` itself parses as
    // `{ "": <next token> }` and pollutes the request body.
    if (arg === "--") {
      break;
    }
    const eqIdx = arg.indexOf("=");
    const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
    if (RUN_RESERVED_FLAGS.has(name)) {
      // --download (without inline value) optionally consumes the next
      // token as its template. With `--download=foo` the value is
      // already attached and we move on without skipping anything.
      if (name === "--download" && inlineValue === undefined) {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          i += 1;
        }
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
      assign(out, key, true);
      continue;
    }
    assign(out, key, parseValue(next));
    i += 1;
  }
  return out;
};

export interface LocalFile {
  path: string;
  filename: string;
  contentType: string;
}

const expandHome = (value: string): string => {
  // node:path's resolve() doesn't expand `~` — that's a shell feature.
  // We expand it ourselves so quoted paths like `"~/photo.png"` work.
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(homedir(), value.slice(2));
  }
  return value;
};
const contentTypeForPath = (file: string): string => {
  // extname splits on basename, so a dotted directory like
  // "/home/user/my.project/texture" correctly yields "" instead of
  // mistaking "project/texture" for the extension.
  const ext = path.extname(file).slice(1).toLowerCase();
  const map = new Map(
    Object.entries({
      avif: "image/avif",
      bmp: "image/bmp",
      flac: "audio/flac",
      gif: "image/gif",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      json: "application/json",
      m4a: "audio/mp4",
      mov: "video/quicktime",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      ogg: "audio/ogg",
      png: "image/png",
      tif: "image/tiff",
      tiff: "image/tiff",
      txt: "text/plain",
      wav: "audio/wav",
      webm: "video/webm",
      webp: "image/webp",
    }),
  );
  return map.get(ext) ?? "application/octet-stream";
};
/**
 * Probe a path the user explicitly asked us to read (e.g.
 * `vg generate upload <path>`). Skips the path-shape heuristic so a bare
 * filename with a non-media extension — `model.glb`, `scene.fbx`,
 * `data.ply`, even `LICENSE` — still works.
 */
export const readExplicitLocalFile = (value: string): LocalFile | null => {
  if (value.startsWith("http://") || value.startsWith("https://")) {
    return null;
  }
  if (value.startsWith("data:")) {
    return null;
  }
  if (value.length === 0) {
    return null;
  }
  const expanded = expandHome(value);
  const abs = path.isAbsolute(expanded) ? expanded : path.resolve(expanded);
  let stat;
  try {
    stat = statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile()) {
    return null;
  }
  return {
    contentType: contentTypeForPath(abs),
    filename: path.basename(abs),
    path: abs,
  };
};

export interface DownloadFlag {
  mode: "off" | "on";
  template?: string;
}

export const parseDownloadFlag = (argv: string[]): DownloadFlag => {
  let lastIdx = -1;
  let inlineValue: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) {
      continue;
    }
    if (arg === "--") {
      break;
    }
    if (arg === "--download") {
      lastIdx = i;
      inlineValue = undefined;
    } else if (arg.startsWith("--download=")) {
      lastIdx = i;
      inlineValue = arg.slice("--download=".length);
    }
  }
  if (lastIdx === -1) {
    return { mode: "off" };
  }
  const candidate = inlineValue ?? argv[lastIdx + 1];
  if (candidate === "false") {
    return { mode: "off" };
  }
  if (
    candidate === undefined ||
    candidate === "" ||
    candidate.startsWith("--") ||
    candidate === "true"
  ) {
    return { mode: "on" };
  }
  return { mode: "on", template: candidate };
};
