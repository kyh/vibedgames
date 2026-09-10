import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

// Lowercase file extensions we recognize as media when sniffing fal
// response payloads where `content_type` is missing (some endpoints
// omit it).
const MEDIA_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "avif",
  "mp4",
  "mov",
  "webm",
  "mp3",
  "wav",
  "ogg",
  "flac",
  "m4a",
]);

interface MediaRef {
  url: string;
  filename: string;
  contentType: string | null;
}

const TRUSTED_HOST_SUFFIXES = [".fal.media", ".fal.run", ".fal.ai"] as const;
const TRUSTED_HOSTS = new Set(["fal.media", "fal.run", "fal.ai"]);

const isTrustedFalContentHost = (url: string): boolean => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (TRUSTED_HOSTS.has(host)) {
    return true;
  }
  return TRUSTED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
};
const extFromUrl = (url: string): string => {
  try {
    const { pathname } = new URL(url);
    const dot = pathname.lastIndexOf(".");
    return dot === -1 ? "" : pathname.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
};
// Strip any directory components from a fal-provided file_name so a
// malicious response can't traverse out of the download target dir.
// Handle both POSIX and Windows separators regardless of host OS so a
// `..\\..\\evil` payload sent to a Linux client is still flattened.
const sanitizeFilename = (name: string): string | null => {
  const base =
    name
      .replaceAll(/[\\/]+/gu, "/")
      .split("/")
      .pop() ?? "";
  if (!base || base === "." || base === "..") {
    return null;
  }
  return base;
};
const visit = (value: JsonValue, refs: MediaRef[], seen: Set<string>): void => {
  if (Array.isArray(value)) {
    for (const v of value) {
      visit(v, refs, seen);
    }
    return;
  }
  if (!isJsonObject(value)) {
    return;
  }
  const { url } = value;
  if (isJsonString(url) && isTrustedFalContentHost(url) && !seen.has(url)) {
    const contentType = isJsonString(value.content_type) ? value.content_type.toLowerCase() : null;
    const filenameField = isJsonString(value.file_name) ? sanitizeFilename(value.file_name) : null;
    const ext = filenameField
      ? path.extname(filenameField).slice(1).toLowerCase()
      : extFromUrl(url);
    const looksMedia =
      contentType === null ? MEDIA_EXT.has(ext) : /^(?:image|video|audio)\//u.test(contentType);
    if (looksMedia) {
      seen.add(url);
      refs.push({
        contentType,
        filename: filenameField ?? `output${ext ? `.${ext}` : ""}`,
        url,
      });
    }
  }
  for (const child of Object.values(value)) {
    visit(child, refs, seen);
  }
};
/**
 * Walk a fal result payload and pull out anything that looks like a media
 * output. fal endpoints embed outputs in objects shaped like
 * `{ url, content_type, file_name, ... }`; we accept image/video/audio
 * content types and also fall back to URL extension when content_type is
 * absent (some endpoints omit it).
 */
export const extractMediaRefs = (result: JsonValue): MediaRef[] => {
  const seen = new Set<string>();
  const refs: MediaRef[] = [];
  visit(result, refs, seen);
  return refs;
};

// fal stores generated outputs on its own CDN (`X-Fal-Store-IO: 1`) and
// always serves them over HTTPS. Restrict `--download` candidates to
// those hosts and that scheme so a fal response can't trick the CLI
// into fetching arbitrary URLs (e.g. attacker-controlled or
// internal-network targets) on the user's machine, and can't downgrade
// to plain HTTP.

interface DownloadResult {
  downloaded: string[];
  failed: { url: string; error: string }[];
  mislabeled: { path: string; actual: string }[];
}

// The extension each content type genuinely is. Only formats an agent is
// likely to hand to a decoder afterwards need an entry; anything absent is
// left alone rather than guessed at.
const EXT_FOR_CONTENT_TYPE = new Map(
  Object.entries({
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  }),
);

// Extensions that name the same format, so `.jpg` for `image/jpeg` is not a lie.
const EXT_ALIASES = new Map(
  Object.entries({
    htm: "html",
    jpeg: "jpg",
    tif: "tiff",
  }),
);

const canonicalExt = (ext: string) => EXT_ALIASES.get(ext) ?? ext;

/**
 * The extension the caller asked for versus the bytes actually served.
 *
 * `--download board.png` is honoured literally — renaming the path the caller
 * chose would break whatever they wired it into — so when a model returns JPEG
 * the file is a `.png` holding JPEG bytes. Downstream decoders reject it with
 * "bad signature" and nothing points back here, hence the explicit report.
 */
const mislabelOf = (target: string, ref: MediaRef): { path: string; actual: string } | null => {
  const asked = canonicalExt(path.extname(target).slice(1).toLowerCase());
  if (!asked) {
    return null;
  }
  const actual = ref.contentType ? EXT_FOR_CONTENT_TYPE.get(ref.contentType) : undefined;
  if (!actual || canonicalExt(actual) === asked) {
    return null;
  }
  return { actual, path: target };
};

// Exported so the codex provider (lib/codex.ts) reuses identical
// `_1`/`_2` collision-suffix behavior when placing its local outputs.
export const disambiguateTargets = (paths: string[]): string[] => {
  const counts = new Map<string, number>();
  for (const p of paths) {
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return paths.map((p) => {
    if ((counts.get(p) ?? 0) <= 1) {
      return p;
    }
    const n = seen.get(p) ?? 0;
    seen.set(p, n + 1);
    if (n === 0) {
      return p;
    }
    const ext = path.extname(p);
    return `${p.slice(0, p.length - ext.length)}_${n}${ext}`;
  });
};
const renderTemplate = (
  ref: MediaRef,
  template: string | undefined,
  index: number,
  requestId: string,
): string => {
  const ext = (() => {
    const fromName = path.extname(ref.filename).slice(1);
    if (fromName) {
      return fromName;
    }
    return extFromUrl(ref.url) || "bin";
  })();
  // String-based stem extraction: a dynamic RegExp built from `ext`
  // would treat any regex metachars in an unusual fal `file_name`
  // (`.`, `+`, `*`) as patterns, potentially stripping the wrong
  // suffix. Plain endsWith is exact and case-insensitive via toLowerCase.
  const lowerName = ref.filename.toLowerCase();
  const dotExt = `.${ext.toLowerCase()}`;
  const stem = lowerName.endsWith(dotExt)
    ? ref.filename.slice(0, -dotExt.length) || "output"
    : ref.filename || "output";
  // No template or no placeholder → caller meant either a destination
  // directory (omitted, ".", "./", "../out", "out/") or an explicit
  // output filename (`./out.png`, `frame.mp4`). We disambiguate by
  // looking for an extension on the basename — anything with one is
  // treated as the literal output path; otherwise we resolve into the
  // directory using the ref's filename. The previous all-as-dir
  // behavior wrote `./walk.png/output.png` for `--download ./walk.png`.
  if (!template || !template.includes("{")) {
    if (template && path.extname(template)) {
      return path.resolve(template);
    }
    const dir = template ?? process.cwd();
    return path.resolve(dir, ref.filename || `output-${index}.${ext}`);
  }
  const rendered = template
    .replaceAll("{index}", String(index))
    .replaceAll("{name}", stem)
    .replaceAll("{ext}", ext)
    .replaceAll("{request_id}", requestId);
  return path.resolve(rendered);
};
/**
 * Download all extracted media refs to disk, materializing the path from
 * a template. Supported placeholders: {index}, {name}, {ext}, {request_id}.
 * Falls back to the source filename in the cwd when no template is given.
 */
export const downloadMedia = async (opts: {
  refs: MediaRef[];
  template?: string;
  requestId: string;
}): Promise<DownloadResult> => {
  const initial = opts.refs.map((ref, i) => renderTemplate(ref, opts.template, i, opts.requestId));
  // Disambiguate any colliding resolved paths so multi-output runs (e.g.
  // `--num_images 3` where fal returns the same default `file_name` for
  // every output) don't silently overwrite each other on disk. The first
  // occurrence keeps the original name; subsequent collisions get a
  // `_1`, `_2`, … suffix inserted before the extension.
  const targets = disambiguateTargets(initial);
  // Create each unique parent directory once instead of redoing it per ref.
  const dirs = new Set(targets.map((t) => path.dirname(t)));
  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }

  // Fetch all refs in parallel; fal CDN handles the concurrency fine and
  // multi-image runs (`--num_images N`) become N× faster than the old
  // sequential loop. Results stay in ref order via mapped Promise.all.
  type Outcome =
    | { ok: true; target: string; mislabel: { path: string; actual: string } | null }
    | { ok: false; url: string; error: string };

  const outcomes: Outcome[] = await Promise.all(
    opts.refs.map(async (ref, i): Promise<Outcome> => {
      const target = targets[i];
      if (target === undefined) {
        return { error: "no download target", ok: false, url: ref.url };
      }
      try {
        const res = await fetch(ref.url);
        if (!res.ok) {
          return { error: `${res.status} ${res.statusText}`, ok: false, url: ref.url };
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        writeFileSync(target, bytes);
        return { mislabel: mislabelOf(target, ref), ok: true, target };
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          url: ref.url,
        };
      }
    }),
  );

  const downloaded: string[] = [];
  const failed: { url: string; error: string }[] = [];
  const mislabeled: { path: string; actual: string }[] = [];
  for (const o of outcomes) {
    if (!o.ok) {
      failed.push({ error: o.error, url: o.url });
      continue;
    }
    downloaded.push(o.target);
    if (o.mislabel) {
      mislabeled.push(o.mislabel);
    }
  }
  return { downloaded, failed, mislabeled };
};
