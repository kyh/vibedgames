import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

// `--json`/`--help`/`--quiet` are global; `--async` switches the run path
// in citty; `--download` takes an optional template. None of them should
// leak through to fal as model parameters. `--logs` is intentionally NOT
// here: it's a `vg generate status` flag, not a `run` flag, so swallowing it
// would block users from passing a legitimate `logs` parameter to a
// model endpoint.
const RUN_RESERVED_FLAGS = new Set(["--json", "--help", "--quiet", "--async", "--download"]);

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
export function parseRunInput(argv: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("--")) continue;
    // POSIX `--` argument terminator: stop interpreting subsequent
    // tokens as flags. Without this guard, `--` itself parses as
    // `{ "": <next token> }` and pollutes the request body.
    if (arg === "--") break;
    const eqIdx = arg.indexOf("=");
    const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
    const inlineValue = eqIdx === -1 ? undefined : arg.slice(eqIdx + 1);
    if (RUN_RESERVED_FLAGS.has(name)) {
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
      assign(out, key, true);
      continue;
    }
    assign(out, key, parseValue(next));
    i++;
  }
  return out;
}

function assign(out: Record<string, unknown>, key: string, value: unknown): void {
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

export type LocalFile = {
  path: string;
  filename: string;
  contentType: string;
};

/**
 * Probe a path the user explicitly asked us to read (e.g.
 * `vg generate upload <path>`). Skips the path-shape heuristic so a bare
 * filename with a non-media extension — `model.glb`, `scene.fbx`,
 * `data.ply`, even `LICENSE` — still works.
 */
export function readExplicitLocalFile(value: string): LocalFile | null {
  if (value.startsWith("http://") || value.startsWith("https://")) return null;
  if (value.startsWith("data:")) return null;
  if (value.length === 0) return null;
  const expanded = expandHome(value);
  const abs = isAbsolute(expanded) ? expanded : resolve(expanded);
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
  };
}

function expandHome(value: string): string {
  // node:path's resolve() doesn't expand `~` — that's a shell feature.
  // We expand it ourselves so quoted paths like `"~/photo.png"` work.
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

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

export function parseDownloadFlag(argv: string[]): { mode: "off" | "on"; template?: string } {
  let lastIdx = -1;
  let inlineValue: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--") break;
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
  if (candidate === "false") return { mode: "off" };
  if (
    candidate === undefined ||
    candidate === "" ||
    candidate.startsWith("--") ||
    candidate === "true"
  ) {
    return { mode: "on" };
  }
  return { mode: "on", template: candidate };
}
