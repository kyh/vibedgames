/**
 * The tilemap editor's server half.
 *
 * The editor used to be a Tkinter window, which meant a working local Python
 * with Tk — the single heaviest thing any of these skills asked a user to
 * install, and unavailable to an agent besides. The drawing surface is a
 * browser now: this serves one page and a small JSON API over loopback, and
 * the page does the painting on a canvas.
 *
 * What lives here is everything that touches the machine — reading the
 * manifest, serving tileset images, and writing map files — so it can be typed
 * and tested. The page itself is passed in as a string, so it stays an ordinary
 * HTML file in the skill directory.
 *
 * Two things guard the write endpoint, because a local HTTP server is
 * reachable by anything else on the machine: a random per-run token that must
 * arrive in a header (a cross-origin page cannot set one without a preflight,
 * and none is answered), and a root directory that every resolved path must
 * sit inside.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, isAbsolute, relative, resolve } from "node:path";

import { isJsonObject, isJsonString, type JsonValue, parseJsonText } from "./json.js";
import {
  loadManifestJson,
  newMap,
  parseTilemap,
  sanitizeTilesets,
  tilemapPayload,
  type TilesetMeta,
  tilesetMetaFromManifest,
} from "./tilemap.js";

export const DEFAULT_MAP_WIDTH = 64;
export const DEFAULT_MAP_HEIGHT = 36;

const CONTENT_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/**
 * True when `candidate` is `root` or sits inside it.
 *
 * `relative` gives a path starting with `..` for anything outside, which is
 * the check — string prefixing would accept a sibling like `/srv/project-old`
 * for a root of `/srv/project`.
 */
export function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export type EditorOptions = {
  manifestPath: string;
  /** Map to open at startup and quick-save to. */
  mapPath?: string | null;
  /** Tileset to select first; defaults to the manifest's first by name. */
  tileset?: string | null;
  /** The editor page, served at `/`. */
  html: string;
  /** Saves and loads are refused outside this directory. */
  writeRoot: string;
};

export type EditorHandle = {
  server: Server;
  token: string;
  /** The URL to open, token included. */
  url: (port: number, host?: string) => string;
};

function sendJson(res: ServerResponse, status: number, body: JsonValue): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // Nothing here should ever be cached: the point is to reflect files on disk.
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readBody(req: IncomingMessage, limitBytes = 8 * 1024 * 1024): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limitBytes) {
        rejectBody(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

/** Everything the page needs about one tileset, including where to fetch it. */
function tilesetSummary(meta: TilesetMeta) {
  return {
    name: meta.name,
    tileWidth: meta.tileW,
    tileHeight: meta.tileH,
    columns: meta.columns,
    rows: meta.rows,
    margin: meta.margin,
    spacing: meta.spacing,
    imageWidth: meta.imageW,
    imageHeight: meta.imageH,
    path: meta.path,
  };
}

export function createTilemapEditor(options: EditorOptions): EditorHandle {
  const token = randomUUID();
  const manifestPath = resolve(options.manifestPath);
  const writeRoot = resolve(options.writeRoot);

  // Re-read the manifest per request rather than caching it: an agent editing
  // the manifest in another window should see the change on reload, which is
  // exactly when a grid-metadata mistake gets fixed.
  const readTilesets = () => {
    const manifest = loadManifestJson(manifestPath);
    return { manifest, tilesets: sanitizeTilesets(manifest) };
  };

  const metaFor = (name: string): TilesetMeta => {
    const { manifest, tilesets } = readTilesets();
    if (!(name in tilesets)) throw new Error(`No such tileset: ${name}`);
    return tilesetMetaFromManifest(manifestPath, manifest, name);
  };

  const resolveWritable = (raw: string): string => {
    const target = resolve(writeRoot, raw);
    if (!isInside(writeRoot, target)) {
      throw new Error(`Refusing to touch a path outside ${writeRoot}: ${raw}`);
    }
    return target;
  };

  const handlers = new Map<string, (url: URL, req: IncomingMessage) => Promise<JsonValue>>([
    [
      "/api/state",
      async () => {
        const { tilesets } = readTilesets();
        const names = Object.keys(tilesets).sort();
        const selected =
          options.tileset && names.includes(options.tileset) ? options.tileset : names[0]!;

        const map =
          options.mapPath && existsSync(options.mapPath)
            ? parseTilemap(parseJsonText(readFileSync(options.mapPath, "utf8")), {
                width: DEFAULT_MAP_WIDTH,
                height: DEFAULT_MAP_HEIGHT,
              })
            : {
                width: DEFAULT_MAP_WIDTH,
                height: DEFAULT_MAP_HEIGHT,
                data: newMap(DEFAULT_MAP_WIDTH, DEFAULT_MAP_HEIGHT),
                tileset: null,
              };

        const initial = map.tileset && names.includes(map.tileset) ? map.tileset : selected;
        return {
          manifestPath,
          mapPath: options.mapPath ?? null,
          writeRoot,
          tilesetNames: names,
          tileset: tilesetSummary(metaFor(initial)),
          map,
        };
      },
    ],

    [
      "/api/tileset",
      async (url) => {
        const name = url.searchParams.get("name");
        if (!name) throw new Error("name is required");
        return tilesetSummary(metaFor(name));
      },
    ],

    [
      "/api/load",
      async (url) => {
        const path = url.searchParams.get("path");
        if (!path) throw new Error("path is required");
        const target = resolveWritable(path);
        if (!existsSync(target)) throw new Error(`Map not found: ${path}`);
        return {
          path: target,
          ...parseTilemap(parseJsonText(readFileSync(target, "utf8")), {
            width: DEFAULT_MAP_WIDTH,
            height: DEFAULT_MAP_HEIGHT,
          }),
        };
      },
    ],

    [
      "/api/save",
      async (url, req) => {
        const body = parseJsonText(await readBody(req));
        if (!isJsonObject(body)) throw new Error("Body must be an object.");
        const raw = isJsonString(body.path) && body.path ? body.path : options.mapPath;
        if (!raw) throw new Error("No path given and no --map to fall back on.");
        const target = resolveWritable(raw);

        if (!isJsonString(body.tileset)) throw new Error("tileset is required");
        const meta = metaFor(body.tileset);
        // Round-trip through the same reader the load path uses, so a bad
        // payload from the page is clamped and squared off exactly like a bad
        // file on disk rather than written through verbatim.
        const parsed = parseTilemap(
          {
            meta: { width: body.width ?? null, height: body.height ?? null },
            data: body.data ?? null,
          },
          { width: DEFAULT_MAP_WIDTH, height: DEFAULT_MAP_HEIGHT },
        );

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          `${JSON.stringify(tilemapPayload(meta, parsed.width, parsed.height, parsed.data), null, 2)}\n`,
        );
        return { path: target, width: parsed.width, height: parsed.height };
      },
    ],
  ]);

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const authorized =
        req.headers["x-editor-token"] === token || url.searchParams.get("t") === token;

      if (!authorized) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("Forbidden — open the URL the editor printed, token included.\n");
        return;
      }

      if (url.pathname === "/") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(options.html);
        return;
      }

      if (url.pathname === "/api/sheet") {
        try {
          const name = url.searchParams.get("name");
          if (!name) throw new Error("name is required");
          const meta = metaFor(name);
          const bytes = readFileSync(meta.path);
          res.writeHead(200, {
            "content-type": CONTENT_TYPES.get(extname(meta.path).toLowerCase()) ?? "image/png",
            "content-length": bytes.length,
            "cache-control": "no-store",
          });
          res.end(bytes);
        } catch (error) {
          sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }

      const handler = handlers.get(url.pathname);
      if (!handler) {
        sendJson(res, 404, { error: `No such endpoint: ${url.pathname}` });
        return;
      }
      try {
        sendJson(res, 200, await handler(url, req));
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  return {
    server,
    token,
    url: (port, host = "127.0.0.1") => `http://${host}:${port}/?t=${token}`,
  };
}
