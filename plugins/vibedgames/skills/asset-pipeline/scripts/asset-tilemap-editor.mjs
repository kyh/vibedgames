#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  createTilemapEditor,
  exportMapRender,
  exportTilesetGrid,
  fail,
  getAll,
  getFlag,
  getInt,
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

const isPlainObject = (v) => Object.prototype.toString.call(v) === "[object Object]";
const isString = (v) => String(v) === v;

const resolveManifest = (explicit = "") => {
  if (explicit === "") {
    return (
      MANIFEST_JSON_CANDIDATES.find((c) => existsSync(c)) ??
      fail(
        `Manifest not found. Pass --manifest or create one of: ${MANIFEST_JSON_CANDIDATES.join(", ")}`,
      )
    );
  }

  if (existsSync(explicit) && statSync(explicit).isDirectory()) {
    return (
      ["assets_index.json", "asset_index.json"]
        .map((n) => path.join(explicit, n))
        .find((c) => existsSync(c)) ??
      fail(
        `--manifest points at a directory (${explicit}), but no assets_index.json was found inside.`,
      )
    );
  }

  if (!existsSync(explicit)) {
    fail(`Manifest not found: ${explicit}`);
  }

  return explicit;
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["edit", "label-ids", "trim"],
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
  });

  const manifestPath = resolveManifest(getString(args, "manifest"));
  const manifest = loadManifestJson(manifestPath);
  const tilesets = sanitizeTilesets(manifest);
  const name = getString(args, "tileset") ?? Object.keys(tilesets).toSorted()[0];
  let meta = tilesetMetaFromManifest(manifestPath, manifest, name);

  const scale = getInt(args, "scale", 4);
  const trim = getFlag(args, "trim");
  const gridOut = getString(args, "export-tileset-grid") ?? "";
  const renderOut = getString(args, "export-map-render") ?? "";
  const selftestOut = getString(args, "make-selftest-map") ?? "";

  const startEditor = () => {
    const here = import.meta.dirname;
    const html = readFileSync(path.join(here, "tilemap-editor.html"), "utf-8");
    const host = getString(args, "host") ?? "127.0.0.1";
    const port = getInt(args, "port", 0);

    const editor = createTilemapEditor({
      html,
      manifestPath,
      mapPath: getString(args, "map") ?? null,
      tileset: name,
      writeRoot: getString(args, "write-root") ?? process.cwd(),
    });

    editor.server.on("error", (error) => {
      fail(
        "code" in error && error.code === "EADDRINUSE"
          ? `Port ${port} is already in use — pass a different --port, or omit it to get a free one.`
          : error.message,
      );
    });

    editor.server.listen(port, host, () => {
      const address = editor.server.address();
      const actual = address !== null && address instanceof Object ? address.port : port;
      console.log(`Tilemap editor: ${editor.url(actual, host)}`);
      console.log("Open that URL (the token is part of it). Ctrl-C to stop.");
    });

    process.on("SIGINT", () => {
      editor.server.close();
      process.exit(0);
    });
  };

  if (getFlag(args, "edit")) {
    startEditor();

    return;
  }

  if (gridOut === "" && renderOut === "" && selftestOut === "") {
    fail(
      "Nothing to do. Pass --edit, --export-tileset-grid, --export-map-render or --make-selftest-map.",
    );
  }

  if (gridOut !== "") {
    exportTilesetGrid(meta, gridOut, { labelIds: getFlag(args, "label-ids"), scale, trim });
    console.log(`Wrote ${gridOut}`);
  }

  if (renderOut !== "") {
    const mapPath = getString(args, "map") ?? "";

    if (mapPath === "") {
      fail("--export-map-render requires --map PATH");
    }

    const mapPayload = JSON.parse(readFileSync(mapPath, "utf-8"));

    if (!isPlainObject(mapPayload)) {
      fail("Map JSON must be an object at top-level.");
    }

    const mapMeta = mapPayload.meta;

    if (isPlainObject(mapMeta) && isString(mapMeta.tileset) && mapMeta.tileset in tilesets) {
      meta = tilesetMetaFromManifest(manifestPath, manifest, mapMeta.tileset);
    }

    const fills = getAll(args, "fill-rect").map((spec) => {
      const parts = spec.split(",").map((p) => p.trim());

      if (parts.length !== 5) {
        fail("--fill-rect must be x,y,w,h,#RRGGBB[AA]");
      }

      return {
        color: parseColor(parts[4] ?? ""),
        h: Number(parts[3]),
        w: Number(parts[2]),
        x: Number(parts[0]),
        y: Number(parts[1]),
      };
    });

    const bg = getString(args, "bg") ?? "";
    exportMapRender(meta, renderOut, {
      background: bg === "" ? null : parseColor(bg),
      fills,
      mapPayload,
      scale,
      trim,
    });
    console.log(`Wrote ${renderOut}`);
  }

  if (selftestOut !== "") {
    writeJsonFile(selftestOut, makeSelftestMap(meta));
    console.log(`Wrote ${selftestOut}`);
  }
});
