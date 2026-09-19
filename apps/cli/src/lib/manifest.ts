import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

export interface ManifestFile {
  /** forward-slash relative path, e.g. "assets/sprite.png" */
  path: string;
  /** absolute filesystem path */
  absolutePath: string;
  size: number;
  sha256: string;
  contentType: string;
}

const IGNORED_TOP_LEVEL = new Set([
  "node_modules",
  ".git",
  ".turbo",
  ".cache",
  ".DS_Store",
  "vibedgames.json",
]);

const CONTENT_TYPES = new Map(
  Object.entries({
    avif: "image/avif",
    cjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    gif: "image/gif",
    glb: "model/gltf-binary",
    gltf: "model/gltf+json",
    htm: "text/html; charset=utf-8",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    m4a: "audio/mp4",
    map: "application/json; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    otf: "font/otf",
    png: "image/png",
    svg: "image/svg+xml",
    ttf: "font/ttf",
    txt: "text/plain; charset=utf-8",
    wasm: "application/wasm",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xml: "application/xml",
  }),
);

const contentTypeForPath = (file: string): string => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES.get(ext) ?? "application/octet-stream";
};

const shouldIgnore = (relPath: string): boolean => {
  const top = relPath.split(path.sep)[0] ?? "";
  if (IGNORED_TOP_LEVEL.has(top)) {
    return true;
  }
  // skip hidden files anywhere in the tree
  if (relPath.split(path.sep).some((seg) => seg.startsWith("."))) {
    return true;
  }
  return false;
};

export const buildManifest = (rootDir: string): ManifestFile[] => {
  const files: ManifestFile[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(rootDir, abs);
      if (shouldIgnore(rel)) {
        continue;
      }

      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const stat = statSync(abs);
      const buf = readFileSync(abs);
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const posixPath = rel.split(path.sep).join("/");

      files.push({
        absolutePath: abs,
        contentType: contentTypeForPath(posixPath),
        path: posixPath,
        sha256,
        size: stat.size,
      });
    }
  };

  walk(rootDir);
  return files;
};
