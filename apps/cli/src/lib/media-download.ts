import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { isRecord } from "./types.js";

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

const MEDIA_EXTS = new Set([
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

function visit(value: unknown, refs: MediaRef[], seen: Set<string>): void {
  if (Array.isArray(value)) {
    for (const v of value) visit(v, refs, seen);
    return;
  }
  if (!isRecord(value)) return;
  const url = value.url;
  if (typeof url === "string" && url.startsWith("http") && !seen.has(url)) {
    const contentType =
      typeof value.content_type === "string" ? value.content_type.toLowerCase() : null;
    const filenameField = typeof value.file_name === "string" ? value.file_name : null;
    const ext = filenameField ? extname(filenameField).slice(1).toLowerCase() : extFromUrl(url);
    const looksMedia =
      contentType !== null ? /^(image|video|audio)\//.test(contentType) : MEDIA_EXTS.has(ext);
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
  const downloaded: string[] = [];
  const failed: { url: string; error: string }[] = [];
  for (let i = 0; i < opts.refs.length; i++) {
    const ref = opts.refs[i]!;
    const target = renderTemplate(ref, opts.template, i, opts.requestId);
    try {
      const res = await fetch(ref.url);
      if (!res.ok) {
        failed.push({ url: ref.url, error: `${res.status} ${res.statusText}` });
        continue;
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      downloaded.push(target);
    } catch (err) {
      failed.push({
        url: ref.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { downloaded, failed };
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
  const stem = ref.filename.replace(new RegExp(`\\.${ext}$`, "i"), "") || "output";
  if (!template) return resolve(process.cwd(), ref.filename || `output-${index}.${ext}`);
  // Handle a value like ".", "./", "out/" as a directory + default filename.
  const looksLikeDir = template.endsWith("/") || template.endsWith("\\") || !template.includes("{");
  const basename = template.split(/[/\\]/).pop() || "";
  const hasFileExt = basename.includes(".") && basename.lastIndexOf(".") > 0;
  if (looksLikeDir && !hasFileExt) {
    return resolve(template, ref.filename || `output-${index}.${ext}`);
  }
  const rendered = template
    .replaceAll("{index}", String(index))
    .replaceAll("{name}", stem)
    .replaceAll("{ext}", ext)
    .replaceAll("{request_id}", requestId);
  return resolve(rendered);
}
