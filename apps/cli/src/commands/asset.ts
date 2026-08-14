import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import {
  autoDetectManifest,
  checkManifest,
  exportManifest,
  MANIFEST_CANDIDATES,
} from "../asset/manifest.js";
import {
  defaultRoot,
  parseFrame,
  resolveTargets,
  writeJsonFile,
  writeTextFile,
} from "../asset/paths.js";
import { analyzeBaseline, probeSheet } from "../asset/sheet.js";
import {
  exportMapRender,
  exportTilesetGrid,
  loadManifestJson,
  makeSelftestMap,
  MANIFEST_JSON_CANDIDATES,
  sanitizeTilesets,
  tilesetMetaFromManifest,
} from "../asset/tilemap.js";
import { collectSizes, sizesToCsv } from "../asset/sizes.js";
import { parseColor } from "../image/color.js";
import { outputArgs, writeStructured } from "../lib/output.js";

/**
 * `vg asset` — the sprite-sheet and manifest tooling that used to live in
 * `plugins/asset-pipeline/skills/asset-pipeline/scripts/*.py`. Same flags,
 * same reports, no Python.
 */

/**
 * Locate the JSON manifest for tilemap exports: an explicit path, a folder
 * containing one, or the conventional names in the working directory.
 */
function resolveTilemapManifest(explicit: string | undefined): string {
  if (!explicit) {
    const found = MANIFEST_JSON_CANDIDATES.find((c) => existsSync(c));
    if (!found) {
      consola.error(
        `Manifest not found. Pass --manifest or create one of: ${MANIFEST_JSON_CANDIDATES.join(", ")}`,
      );
      process.exit(1);
    }
    return found;
  }
  if (existsSync(explicit) && statSync(explicit).isDirectory()) {
    const inside = ["assets_index.json", "asset_index.json"]
      .map((n) => join(explicit, n))
      .find((c) => existsSync(c));
    if (!inside) {
      consola.error(
        `--manifest points at a directory (${explicit}), but no assets_index.json was found inside.`,
      );
      process.exit(1);
    }
    return inside;
  }
  if (!existsSync(explicit)) {
    consola.error(`Manifest not found: ${explicit}`);
    process.exit(1);
  }
  return explicit;
}

/** Citty types positionals as optional; fail loudly rather than reading `undefined`. */
function requirePath(value: string | undefined): string {
  if (!value) {
    consola.error("A PNG file or folder path is required.");
    process.exit(1);
  }
  return value;
}

const sizes = defineCommand({
  meta: {
    name: "sizes",
    description: "List the dimensions of every PNG under a folder.",
  },
  args: {
    root: {
      type: "string",
      description: "Root folder to scan (default: ./assets if it exists, else .).",
    },
    csv: { type: "string", description: "Also write a CSV report to this path." },
    out: { type: "string", description: "Also write a JSON report to this path." },
    ...outputArgs,
  },
  run: ({ args }) => {
    const root = defaultRoot(args.root);
    if (!existsSync(root)) {
      consola.error(`Root not found: ${root}`);
      process.exit(1);
    }

    const rows = collectSizes(root);
    if (args.csv) writeTextFile(args.csv, sizesToCsv(rows));
    if (args.out) writeJsonFile(args.out, rows);
    if (writeStructured(rows, args)) return;

    for (const row of rows) consola.log(`${row.width}x${row.height}\t${row.path}`);
  },
});

const sheetProbe = defineCommand({
  meta: {
    name: "sheet-probe",
    description: "Analyse sprite-sheet grids and list which frames contain art.",
  },
  args: {
    path: { type: "positional", description: "PNG file or folder." },
    frame: { type: "string", required: true, description: "Frame size WxH, e.g. 32x32." },
    list: { type: "boolean", description: "List non-empty frame coordinates." },
    "show-empty": { type: "boolean", description: "Also list empty frame coordinates." },
    out: { type: "string", description: "Write the JSON report to this path." },
    ...outputArgs,
  },
  run: ({ args }) => {
    const path = requirePath(args.path);
    const frame = parseFrame(args.frame);
    const results = resolveTargets(path).map((target) =>
      probeSheet(target, frame, Boolean(args["show-empty"])),
    );

    if (args.out) writeJsonFile(args.out, results);
    if (writeStructured(results, args)) return;

    for (const result of results) {
      const nonEmpty = result.non_empty.length;
      consola.log(
        `${result.path}  grid=${result.grid.columns}x${result.grid.rows}  non_empty=${nonEmpty}  empty=${result.empty_count}`,
      );
      const format = (pairs: [number, number][]) =>
        `[${pairs.map(([c, r]) => `(${c}, ${r})`).join(", ")}]`;
      if (args.list) consola.log(`  non_empty=${format(result.non_empty)}`);
      if (args["show-empty"]) consola.log(`  empty=${format(result.empty ?? [])}`);
    }
  },
});

const spriteBaseline = defineCommand({
  meta: {
    name: "sprite-baseline",
    description: "Audit, and optionally normalise, where sprites sit inside their frames.",
  },
  args: {
    path: { type: "positional", description: "PNG file or folder." },
    frame: { type: "string", required: true, description: "Frame size WxH, e.g. 256x256." },
    "target-bottom": {
      type: "string",
      description: "Target visible bottom pixel, inclusive. Defaults to frame height - 1.",
    },
    "target-center-x": {
      type: "string",
      description: "Optional target visible centre x. Omit to only normalise vertically.",
    },
    "out-image": { type: "string", description: "Corrected PNG path (single-file input only)." },
    "out-dir": { type: "string", description: "Corrected output folder." },
    out: { type: "string", description: "Write the JSON report to this path." },
    ...outputArgs,
  },
  run: ({ args }) => {
    const frame = parseFrame(args.frame);
    const targetBottom =
      args["target-bottom"] === undefined ? frame.height - 1 : Number(args["target-bottom"]);
    const targetCenterX =
      args["target-center-x"] === undefined ? null : Number(args["target-center-x"]);
    if (Number.isNaN(targetBottom) || (targetCenterX !== null && Number.isNaN(targetCenterX))) {
      consola.error("--target-bottom and --target-center-x must be integers.");
      process.exit(1);
    }

    const path = requirePath(args.path);
    const targets = resolveTargets(path);
    if (targets.length === 0) {
      consola.error(`No PNG files found in ${path}`);
      process.exit(1);
    }
    if (args["out-image"] && args["out-dir"]) {
      consola.error("Use either --out-image or --out-dir, not both.");
      process.exit(1);
    }
    if (args["out-image"] && targets.length !== 1) {
      consola.error("--out-image only works with a single PNG input; use --out-dir for folders.");
      process.exit(1);
    }

    const inputIsFile = statSync(path).isFile();
    const reports = targets.map((target) => {
      let outPath: string | null = null;
      if (args["out-image"]) outPath = args["out-image"];
      else if (args["out-dir"]) {
        const rel = inputIsFile ? basename(target) : relative(path, target);
        outPath = join(args["out-dir"], rel);
      }
      return analyzeBaseline(target, frame, targetBottom, targetCenterX, outPath);
    });

    if (args.out) writeJsonFile(args.out, reports);
    if (writeStructured(reports, args)) return;

    const range = (value: [number, number] | null) => (value ? `[${value.join(", ")}]` : "None");
    for (const report of reports) {
      consola.log(
        `${report.path} frame=${frame.width}x${frame.height} bottom_range=${range(report.visibleBottomYRange)} shift_y_range=${range(report.shiftYRange)}`,
      );
    }
  },
});

const manifestCheck = defineCommand({
  meta: {
    name: "manifest-check",
    description: "Verify every PNG is declared in the asset manifest, and vice versa.",
  },
  args: {
    manifest: {
      type: "string",
      description: "Path to the manifest (default: auto-detect common names).",
    },
    root: {
      type: "string",
      description: "Root folder to scan (default: ./assets if it exists, else .).",
    },
    out: { type: "string", description: "Write the JSON report to this path." },
    ...outputArgs,
  },
  run: ({ args }) => {
    const root = defaultRoot(args.root);
    if (!existsSync(root)) {
      consola.error(`Root not found: ${root}`);
      process.exit(1);
    }

    const manifest = args.manifest ?? autoDetectManifest();
    if (!manifest || !existsSync(manifest)) {
      consola.error(
        `Manifest not found. Pass --manifest or create one of: ${MANIFEST_CANDIDATES.join(", ")}`,
      );
      process.exit(1);
    }

    const report = checkManifest(manifest, root);
    if (args.out) writeJsonFile(args.out, report);
    if (writeStructured(report, args)) return;

    consola.log(`manifest paths: ${report.manifest_paths}`);
    consola.log(`actual pngs:    ${report.actual_pngs}`);
    consola.log(`missing:        ${report.missing.length}`);
    for (const path of report.missing) consola.log(`  MISSING ${path}`);
    consola.log(`extra:          ${report.extra.length}`);
    for (const path of report.extra) consola.log(`  EXTRA ${path}`);
  },
});

const manifestExport = defineCommand({
  meta: {
    name: "manifest-export",
    description: "Export a Lua asset manifest to portable JSON.",
  },
  args: {
    manifest: {
      type: "string",
      required: true,
      description: "Path to assets_index.lua (or .json).",
    },
    out: { type: "string", required: true, description: "Output JSON path." },
    "keep-paths": {
      type: "boolean",
      description: "Leave paths as written instead of rebasing them onto the manifest folder.",
    },
  },
  run: ({ args }) => {
    if (!existsSync(args.manifest)) {
      consola.error(`Manifest not found: ${args.manifest}`);
      process.exit(1);
    }
    const payload = exportManifest(args.manifest, !args["keep-paths"]);
    writeJsonFile(args.out, payload);
    consola.log(`Wrote ${args.out}`);
  },
});

const tilemap = defineCommand({
  meta: {
    name: "tilemap",
    description: "Export tileset grid overlays, self-test maps, and tilemap renders.",
  },
  args: {
    manifest: {
      type: "string",
      description: "Path to assets_index.json, or a folder containing one (default: auto-detect).",
    },
    map: { type: "string", description: "Tilemap JSON to render." },
    tileset: {
      type: "string",
      description: "Tileset name to use (default: first in the manifest, alphabetically).",
    },
    "export-tileset-grid": {
      type: "string",
      description: "Write a grid-overlay PNG for the tileset to this path.",
    },
    "export-map-render": {
      type: "string",
      description: "Render --map to a PNG at this path.",
    },
    "make-selftest-map": {
      type: "string",
      description: "Write a tilemap JSON placing every non-empty tile at its own coordinate.",
    },
    scale: { type: "string", description: "Scale factor for PNG exports (default: 4)." },
    "label-ids": { type: "boolean", description: "Label tile IDs on the exported grid." },
    bg: { type: "string", description: "Background colour for --export-map-render." },
    "fill-rect": {
      type: "string",
      description: "Fill a tile-rect behind tiles: x,y,w,h,#RRGGBB[AA] in tile units. Repeatable.",
    },
    trim: { type: "boolean", description: "Trim transparent borders on PNG exports." },
  },
  run: ({ args }) => {
    const manifestPath = resolveTilemapManifest(args.manifest);
    const manifest = loadManifestJson(manifestPath);
    const tilesets = sanitizeTilesets(manifest);
    const name = args.tileset ?? Object.keys(tilesets).sort()[0]!;
    let meta = tilesetMetaFromManifest(manifestPath, manifest, name);
    const scale = args.scale === undefined ? 4 : Number(args.scale);
    if (!Number.isFinite(scale)) {
      consola.error("--scale must be a number.");
      process.exit(1);
    }

    if (!args["export-tileset-grid"] && !args["export-map-render"] && !args["make-selftest-map"]) {
      consola.error(
        "Nothing to do. Pass --export-tileset-grid, --export-map-render or --make-selftest-map.",
      );
      process.exit(1);
    }

    if (args["export-tileset-grid"]) {
      exportTilesetGrid(meta, args["export-tileset-grid"], {
        scale,
        labelIds: Boolean(args["label-ids"]),
        trim: Boolean(args.trim),
      });
      consola.log(`Wrote ${args["export-tileset-grid"]}`);
    }

    if (args["export-map-render"]) {
      if (!args.map) {
        consola.error("--export-map-render requires --map PATH");
        process.exit(1);
      }
      const mapPayload: unknown = JSON.parse(readFileSync(args.map, "utf8"));
      if (mapPayload === null || typeof mapPayload !== "object" || Array.isArray(mapPayload)) {
        consola.error("Map JSON must be an object at top-level.");
        process.exit(1);
      }
      // A map may name its own tileset, which wins over the CLI default.
      const mapMeta = (mapPayload as Record<string, unknown>).meta;
      if (mapMeta !== null && typeof mapMeta === "object" && !Array.isArray(mapMeta)) {
        const named = (mapMeta as Record<string, unknown>).tileset;
        if (typeof named === "string" && named in tilesets) {
          meta = tilesetMetaFromManifest(manifestPath, manifest, named);
        }
      }

      const rawFills = args["fill-rect"];
      const fillSpecs =
        rawFills === undefined ? [] : Array.isArray(rawFills) ? rawFills : [rawFills];
      const fills = fillSpecs.map((spec) => {
        const parts = String(spec)
          .split(",")
          .map((p) => p.trim());
        if (parts.length !== 5) throw new Error("--fill-rect must be x,y,w,h,#RRGGBB[AA]");
        return {
          x: Number(parts[0]),
          y: Number(parts[1]),
          w: Number(parts[2]),
          h: Number(parts[3]),
          color: parseColor(parts[4]!),
        };
      });

      exportMapRender(meta, args["export-map-render"], {
        mapPayload: mapPayload as Record<string, unknown>,
        scale,
        background: args.bg ? parseColor(args.bg) : null,
        fills,
        trim: Boolean(args.trim),
      });
      consola.log(`Wrote ${args["export-map-render"]}`);
    }

    if (args["make-selftest-map"]) {
      writeJsonFile(args["make-selftest-map"], makeSelftestMap(meta));
      consola.log(`Wrote ${args["make-selftest-map"]}`);
    }
  },
});

export const assetCommand = defineCommand({
  meta: {
    name: "asset",
    description: "Inspect and fix game art: sheet grids, sprite baselines, asset manifests.",
  },
  subCommands: {
    sizes,
    "sheet-probe": sheetProbe,
    "sprite-baseline": spriteBaseline,
    "manifest-check": manifestCheck,
    "manifest-export": manifestExport,
    tilemap,
  },
});
