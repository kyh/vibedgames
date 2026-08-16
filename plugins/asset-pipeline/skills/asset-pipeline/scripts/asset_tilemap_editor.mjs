#!/usr/bin/env node
/**
 * Tileset/tilemap exports for debugging tileset grid assumptions.
 *
 * Manifest-driven: it only assumes an assets_index.json with a `tilesets`
 * section. The grid overlay shows where the tool believes tile boundaries are,
 * the self-test map places every non-empty tile at its own coordinate, and the
 * map render composites a tilemap — so a wrong `tileWidth`, `margin` or
 * `spacing` is visible at a glance instead of showing up as garbled tiles
 * in-game.
 *
 * `--edit` opens a painting editor in the browser instead: same map format,
 * same keys as the old desktop window, but nothing to install — it serves one
 * page over loopback and the canvas does the drawing.
 *
 * Examples:
 *   node asset_tilemap_editor.mjs --manifest path/to/assets_index.json \
 *       --export-tileset-grid tmp/grid.png --scale 3 --label-ids
 *   node asset_tilemap_editor.mjs --manifest path/to/assets_index.json \
 *       --make-selftest-map tmp/selftest.json
 *   node asset_tilemap_editor.mjs --manifest path/to/assets_index.json \
 *       --map maps/level1.json --export-map-render tmp/level1.png --scale 2
 *   node asset_tilemap_editor.mjs --manifest path/to/assets_index.json \
 *       --map maps/level1.json --edit
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createTilemapEditor,
  exportMapRender,
  exportTilesetGrid,
  fail,
  getAll,
  getFlag,
  getNumber,
  getString,
  loadManifestJson,
  main,
  makeSelftestMap,
  MANIFEST_JSON_CANDIDATES,
  parseArgs,
  parseColor,
  sanitizeTilesets,
  tilesetMetaFromManifest,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

/** An explicit path, a folder holding a manifest, or a conventional name. */
function resolveManifest(explicit) {
  if (!explicit) {
    const found = MANIFEST_JSON_CANDIDATES.find((c) => existsSync(c));
    if (!found) {
      fail(
        `Manifest not found. Pass --manifest or create one of: ${MANIFEST_JSON_CANDIDATES.join(", ")}`,
      );
    }
    return found;
  }
  if (existsSync(explicit) && statSync(explicit).isDirectory()) {
    const inside = ["assets_index.json", "asset_index.json"]
      .map((n) => join(explicit, n))
      .find((c) => existsSync(c));
    if (!inside) {
      fail(
        `--manifest points at a directory (${explicit}), but no assets_index.json was found inside.`,
      );
    }
    return inside;
  }
  if (!existsSync(explicit)) fail(`Manifest not found: ${explicit}`);
  return explicit;
}

/**
 * Serve the editor page and block until interrupted.
 *
 * Loopback only, and the URL carries a per-run token that every API call must
 * repeat — a local port is reachable by anything else on the machine, and this
 * one can write files.
 */
function startEditor(args, manifestPath, tileset) {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "tilemap-editor.html"), "utf8");
  const host = getString(args, "host") ?? "127.0.0.1";
  const port = getNumber(args, "port", 0);

  const editor = createTilemapEditor({
    manifestPath,
    mapPath: getString(args, "map") ?? null,
    tileset,
    html,
    writeRoot: getString(args, "write-root") ?? process.cwd(),
  });

  editor.server.on("error", (error) => {
    fail(
      error.code === "EADDRINUSE"
        ? `Port ${port} is already in use — pass a different --port, or omit it to get a free one.`
        : error.message,
    );
  });

  editor.server.listen(port, host, () => {
    const actual = editor.server.address().port;
    console.log(`Tilemap editor: ${editor.url(actual, host)}`);
    console.log("Open that URL (the token is part of it). Ctrl-C to stop.");
  });

  // Nothing else to do on this thread; the server keeps the process alive.
  process.on("SIGINT", () => {
    editor.server.close();
    process.exit(0);
  });
}

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: [
      "bg",
      "export-map-render",
      "export-tileset-grid",
      "fill-rect",
      "host",
      "make-selftest-map",
      "manifest",
      "map",
      "port",
      "scale",
      "tileset",
      "write-root",
    ],
    booleans: ["edit", "label-ids", "trim"],
  });
  const manifestPath = resolveManifest(getString(args, "manifest"));
  const manifest = loadManifestJson(manifestPath);
  const tilesets = sanitizeTilesets(manifest);
  const name = getString(args, "tileset") ?? Object.keys(tilesets).sort()[0];
  let meta = tilesetMetaFromManifest(manifestPath, manifest, name);

  const scale = getNumber(args, "scale", 4);
  const trim = getFlag(args, "trim");
  const gridOut = getString(args, "export-tileset-grid");
  const renderOut = getString(args, "export-map-render");
  const selftestOut = getString(args, "make-selftest-map");

  if (getFlag(args, "edit")) {
    startEditor(args, manifestPath, name);
    return;
  }

  if (!gridOut && !renderOut && !selftestOut) {
    fail(
      "Nothing to do. Pass --edit, --export-tileset-grid, --export-map-render or --make-selftest-map.",
    );
  }

  if (gridOut) {
    exportTilesetGrid(meta, gridOut, { scale, labelIds: getFlag(args, "label-ids"), trim });
    console.log(`Wrote ${gridOut}`);
  }

  if (renderOut) {
    const mapPath = getString(args, "map");
    if (!mapPath) fail("--export-map-render requires --map PATH");
    const mapPayload = JSON.parse(readFileSync(mapPath, "utf8"));
    if (mapPayload === null || typeof mapPayload !== "object" || Array.isArray(mapPayload)) {
      fail("Map JSON must be an object at top-level.");
    }

    // A map may name its own tileset, which wins over the CLI default.
    const mapMeta = mapPayload.meta;
    if (mapMeta && typeof mapMeta === "object" && typeof mapMeta.tileset === "string") {
      if (mapMeta.tileset in tilesets) {
        meta = tilesetMetaFromManifest(manifestPath, manifest, mapMeta.tileset);
      }
    }

    const fills = getAll(args, "fill-rect").map((spec) => {
      const parts = spec.split(",").map((p) => p.trim());
      if (parts.length !== 5) fail("--fill-rect must be x,y,w,h,#RRGGBB[AA]");
      return {
        x: Number(parts[0]),
        y: Number(parts[1]),
        w: Number(parts[2]),
        h: Number(parts[3]),
        color: parseColor(parts[4]),
      };
    });

    const bg = getString(args, "bg");
    exportMapRender(meta, renderOut, {
      mapPayload,
      scale,
      background: bg ? parseColor(bg) : null,
      fills,
      trim,
    });
    console.log(`Wrote ${renderOut}`);
  }

  if (selftestOut) {
    writeJsonFile(selftestOut, makeSelftestMap(meta));
    console.log(`Wrote ${selftestOut}`);
  }
});
