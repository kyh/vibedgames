import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { isRecord } from "./types.js";

// Lowercase file extensions we recognize as media when sniffing fal
// response payloads where `content_type` is missing (some endpoints
// omit it).
const MEDIA_EXT = new Set([
  "png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif",
  "mp4", "mov", "webm", "mp3", "wav", "ogg", "flac", "m4a",
]);

export type MediaRef = {
  url: string;
  filename: string;
  contentType: string | null;
};

/**
 * Walk a fal result payload and pull out anything that looks like a media
 * output. fal endpoints embed outputs in objects shaped like
 * `{ url, content_type, file_name, ... }`; we accept image/video/audio
 * content types and also fall back to URL extension when content_type is
 * absent (some endpoints omit it).
 */
export function extractMediaRefs(result: unknown): MediaRef[] {
  const seen = new Set<string>();
  const refs: MediaRef[] = [];
  visit(result, refs, seen);
  return refs;
}

// fal stores generated outputs on its own CDN (`X-Fal-Store-IO: 1`).
// Restrict `--download` candidates to those hosts so a fal response can't
// trick the CLI into fetching arbitrary URLs (e.g. attacker-controlled or
// internal-network targets) on the user's machine.
const TRUSTED_HOST_SUFFIXES = [".fal.media", ".fal.run", ".fal.ai"] as const;
const TRUSTED_HOSTS = new Set(["fal.media", "fal.run", "fal.ai"]);

function isTrustedFalContentHost(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (TRUSTED_HOSTS.has(host)) return true;
  return TRUSTED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function visit(value: unknown, refs: MediaRef[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) visit(v, refs, seen);
    return;
  }
  if (!isRecord(value)) return;
  const url = value.url;
  if (typeof url === "string" && isTrustedFalContentHost(url) && !seen.has(url)) {
    const contentType =
      typeof value.content_type === "string" ? value.content_type.toLowerCase() : null;
    const filenameField = typeof value.file_name === "string" ? value.file_name : null;
    const ext = filenameField ? extname(filenameField).slice(1).toLowerCase() : extFromUrl(url);
    const looksMedia =
      contentType !== null ? /^(image|video|audio)\//.test(contentType) : MEDIA_EXT.has(ext);
    if (looksMedia) {
      seen.add(url);
      refs.push({
        url,
        filename: filenameField ?? `output${ext ? "." + ext : ""}`,
        contentType,
      });
    }
  }
  for (const child of Object.values(value)) visit(child, refs, seen);
}

function extFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const dot = path.lastIndexOf(".");
    return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
}

export type DownloadResult = {
  downloaded: string[];
  failed: { url: string; error: string }[];
};

/**
 * Download all extracted media refs to disk, materializing the path from
 * a template. Supported placeholders: {index}, {name}, {ext}, {request_id}.
 * Falls back to the source filename in the cwd when no template is given.
 */
export async function downloadMedia(opts: {
  refs: MediaRef[];
  template?: string;
  requestId: string;
}): Promise<DownloadResult> {
  const initial = opts.refs.map((ref, i) =>
    renderTemplate(ref, opts.template, i, opts.requestId),
  );
  // Disambiguate any colliding resolved paths so multi-output runs (e.g.
  // `--num_images 3` where fal returns the same default `file_name` for
  // every output) don't silently overwrite each other on disk. The first
  // occurrence keeps the original name; subsequent collisions get a
  // `_1`, `_2`, … suffix inserted before the extension.
  const targets = disambiguateTargets(initial);
  // Create each unique parent directory once instead of redoing it per ref.
  const dirs = new Set(targets.map((t) => dirname(t)));
  for (const d of dirs) mkdirSync(d, { recursive: true });

  // Fetch all refs in parallel; fal CDN handles the concurrency fine and
  // multi-image runs (`--num_images N`) become N× faster than the old
  // sequential loop. Results stay in ref order via mapped Promise.all.
  type Outcome =
    | { ok: true; target: string }
    | { ok: false; url: string; error: string };

  const outcomes: Outcome[] = await Promise.all(
    opts.refs.map(async (ref, i): Promise<Outcome> => {
      const target = targets[i]!;
      try {
        const res = await fetch(ref.url);
        if (!res.ok) {
          return { ok: false, url: ref.url, error: `${res.status} ${res.statusText}` };
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        writeFileSync(target, bytes);
        return { ok: true, target };
      } catch (err) {
        return {
          ok: false,
          url: ref.url,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  const downloaded: string[] = [];
  const failed: { url: string; error: string }[] = [];
  for (const o of outcomes) {
    if (o.ok) downloaded.push(o.target);
    else failed.push({ url: o.url, error: o.error });
  }
  return { downloaded, failed };
}

function disambiguateTargets(paths: string[]): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(p, (counts.get(p) ?? 0) + 1);
  const seen = new Map<string, number>();
  return paths.map((p) => {
    if ((counts.get(p) ?? 0) <= 1) return p;
    const n = seen.get(p) ?? 0;
    seen.set(p, n + 1);
    if (n === 0) return p;
    const ext = extname(p);
    return p.slice(0, p.length - ext.length) + `_${n}` + ext;
  });
}

function renderTemplate(
  ref: MediaRef,
  template: string | undefined,
  index: number,
  requestId: string,
): string {
  const ext = (() => {
    const fromName = extname(ref.filename).slice(1);
    if (fromName) return fromName;
    return extFromUrl(ref.url) || "bin";
  })();
  // String-based stem extraction: a dynamic RegExp built from `ext`
  // would treat any regex metachars in an unusual fal `file_name`
  // (`.`, `+`, `*`) as patterns, potentially stripping the wrong
  // suffix. Plain endsWith is exact and case-insensitive via toLowerCase.
  const lowerName = ref.filename.toLowerCase();
  const dotExt = "." + ext.toLowerCase();
  const stem = lowerName.endsWith(dotExt)
    ? ref.filename.slice(0, -dotExt.length) || "output"
    : ref.filename || "output";
  if (!template) return resolve(process.cwd(), ref.filename || `output-${index}.${ext}`);
  // No placeholder → caller meant a destination directory (e.g. ".",
  // "./", "../out", "out/"). The previous heuristic also rejected any
  // template containing a literal ".", which broke "." and "./" — both
  // common shorthands for "download here".
  if (!template.includes("{")) {
    return resolve(template, ref.filename || `output-${index}.${ext}`);
  }
  const rendered = template
    .replaceAll("{index}", String(index))
    .replaceAll("{name}", stem)
    .replaceAll("{ext}", ext)
    .replaceAll("{request_id}", requestId);
  return resolve(rendered);
}
