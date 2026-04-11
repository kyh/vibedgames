import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export type ManifestFile = {
  /** forward-slash relative path, e.g. "assets/sprite.png" */
  path: string;
  /** absolute filesystem path */
  absolutePath: string;
  size: number;
  sha256: string;
  contentType: string;
};

const IGNORED_TOP_LEVEL = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".cache",
  ".DS_Store",
  "vibedgames.json",
]);

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  js: "application/javascript; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  cjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  wasm: "application/wasm",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain; charset=utf-8",
  xml: "application/xml",
};

function contentTypeForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

function shouldIgnore(relPath: string): boolean {
  const top = relPath.split(sep)[0] ?? "";
  if (IGNORED_TOP_LEVEL.has(top)) return true;
  // skip hidden files anywhere in the tree
  if (relPath.split(sep).some((seg) => seg.startsWith("."))) return true;
  return false;
}

export function buildManifest(rootDir: string): ManifestFile[] {
  const files: ManifestFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(rootDir, abs);
      if (shouldIgnore(rel)) continue;

      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const stat = statSync(abs);
      const buf = readFileSync(abs);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const posixPath = rel.split(sep).join("/");

      files.push({
        path: posixPath,
        absolutePath: abs,
        size: stat.size,
        sha256,
        contentType: contentTypeForPath(posixPath),
      });
    }
  };

  walk(rootDir);
  return files;
}
