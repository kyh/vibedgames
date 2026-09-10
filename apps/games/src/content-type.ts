// Extension → MIME map for served game files.
//
// This mirrors CONTENT_TYPES in apps/cli/src/lib/manifest.ts — the CLI stamps
// deploymentFile.contentType from that map at upload time, so deriving the
// type from the path here reproduces the stored value without a D1 lookup
// (which used to run once per asset request — ~180 queries for a cold load of
// an asset-heavy game). Keep the two maps in sync.
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

export const contentTypeForPath = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES.get(ext) ?? "application/octet-stream";
};
