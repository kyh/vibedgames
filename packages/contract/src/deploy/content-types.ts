// Extension → MIME type of a deployed game file. `vg deploy` stamps
// `deploymentFile.contentType` from it, and so does `deploy.upload`.
// apps/games/src/content-type.ts derives the served type from the same map
// without a D1 read: keep it in sync.
export const CONTENT_TYPES = new Map(
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

export const contentTypeForPath = (file: string): string => {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES.get(ext) ?? "application/octet-stream";
};
