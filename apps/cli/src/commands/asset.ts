import { existsSync, statSync } from "node:fs";
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
import { collectSizes, sizesToCsv } from "../asset/sizes.js";
import { outputArgs, writeStructured } from "../lib/output.js";

/**
 * `vg asset` — the sprite-sheet and manifest tooling that used to live in
 * `plugins/asset-pipeline/skills/asset-pipeline/scripts/*.py`. Same flags,
 * same reports, no Python.
 */

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
  },
});
