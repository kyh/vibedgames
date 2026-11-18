import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isMediaUrl } from "@repo/contract/generate/media-hosts";

import { isJsonObject, isJsonString } from "./types.js";
import type { JsonValue } from "./types.js";

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

const extFromUrl = (url: string) => {
  try {
    const { pathname } = new URL(url);
    const dot = pathname.lastIndexOf(".");

    return dot === -1 ? "" : pathname.slice(dot + 1).toLowerCase();
  } catch {
    return "";
  }
};

const sanitizeFilename = (name: string) => {
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

const visit = (value: JsonValue, refs: MediaRef[], seen: Set<string>) => {
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

  if (isJsonString(url) && isMediaUrl(url) && !seen.has(url)) {
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
export const extractMediaRefs = (result: JsonValue) => {
  const seen = new Set<string>();
  const refs: MediaRef[] = [];
  visit(result, refs, seen);

  return refs;
};

interface DownloadResult {
  downloaded: string[];
  failed: { url: string; error: string }[];
  mislabeled: { path: string; actual: string }[];
}

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

const EXT_ALIASES = new Map(
  Object.entries({
    htm: "html",
    jpeg: "jpg",
    tif: "tiff",
  }),
);

const canonicalExt = (ext: string) => EXT_ALIASES.get(ext) ?? ext;

const mislabelOf = (target: string, ref: MediaRef) => {
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

export const disambiguateTargets = (paths: string[]) => {
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
) => {
  const ext = (() => {
    const fromName = path.extname(ref.filename).slice(1);

    if (fromName) {
      return fromName;
    }

    return extFromUrl(ref.url) || "bin";
  })();

  const lowerName = ref.filename.toLowerCase();
  const dotExt = `.${ext.toLowerCase()}`;

  const stem = lowerName.endsWith(dotExt)
    ? ref.filename.slice(0, -dotExt.length) || "output"
    : ref.filename || "output";

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
}) => {
  const initial = opts.refs.map((ref, i) => renderTemplate(ref, opts.template, i, opts.requestId));
  const targets = disambiguateTargets(initial);
  const dirs = new Set(targets.map((t) => path.dirname(t)));

  for (const d of dirs) {
    mkdirSync(d, { recursive: true });
  }

  type Outcome =
    | { ok: true; target: string; mislabel: { path: string; actual: string } | null }
    | { ok: false; url: string; error: string };

  const outcomes: Outcome[] = await Promise.all(
    opts.refs.map(async (ref, i) => {
      const target = targets[i];

      if (target === undefined) {
        return { error: "no download target", ok: false, url: ref.url } satisfies Outcome;
      }

      try {
        const res = await fetch(ref.url);

        if (!res.ok) {
          return {
            error: `${res.status} ${res.statusText}`,
            ok: false,
            url: ref.url,
          } satisfies Outcome;
        }

        const bytes = new Uint8Array(await res.arrayBuffer());
        writeFileSync(target, bytes);

        return { mislabel: mislabelOf(target, ref), ok: true, target } satisfies Outcome;
      } catch (error) {
        return {
          error: error instanceof Error ? error.message : String(error),
          ok: false,
          url: ref.url,
        } satisfies Outcome;
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
