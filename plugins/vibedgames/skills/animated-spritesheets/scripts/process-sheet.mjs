#!/usr/bin/env node
import { existsSync } from "node:fs";

import {
  fail,
  failUsage,
  getFlag,
  getInt,
  getNumber,
  getString,
  main,
  parseArgs,
  parseColor,
  processSheet,
  toPythonJson,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["json", "no-pixel-snap", "no-qc", "recover"],
    values: ["action", "char-fill", "chroma", "cols", "frames", "out-dir", "rows", "snap-k-colors"],
  });

  const readOptions = () => {
    const [board = ""] = args.positionals;

    if (board === "") {
      failUsage("a pose board PNG is required");
    }

    if (!existsSync(board)) {
      fail(`board not found: ${board}`);
    }

    const action = getString(args, "action") ?? "";

    if (action === "") {
      failUsage("--action is required");
    }

    const outDir = getString(args, "out-dir") ?? "";

    if (outDir === "") {
      failUsage("--out-dir is required");
    }

    const rows = getInt(args, "rows", 0);
    const cols = getInt(args, "cols", 0);

    if (rows <= 0 || cols <= 0) {
      fail("--rows and --cols must be positive integers");
    }

    const charFill = getNumber(args, "char-fill", 0.5);

    if (!(charFill > 0 && charFill <= 1)) {
      fail("--char-fill must be in (0, 1]");
    }

    const snapKColors = getInt(args, "snap-k-colors", 16);

    if (snapKColors <= 0) {
      fail("--snap-k-colors must be a positive integer");
    }

    const requested = getString(args, "frames");

    if (requested !== undefined && getInt(args, "frames", 0) <= 0) {
      fail("--frames must be a positive integer");
    }

    const frames = requested === undefined ? undefined : getInt(args, "frames", 0);

    return { action, board, charFill, cols, frames, outDir, rows, snapKColors };
  };

  const [chromaR, chromaG, chromaB] = parseColor(getString(args, "chroma") ?? "#00FF00");

  const result = processSheet({
    ...readOptions(),
    chroma: [chromaR, chromaG, chromaB],
    pixelSnap: !getFlag(args, "no-pixel-snap"),
    qc: !getFlag(args, "no-qc"),
    recover: getFlag(args, "recover"),
    warn: (message) => {
      process.stderr.write(`[process_sheet] warning: ${message}\n`);
    },
  });

  const { action, fps, frames, gif, qc, spritesheet } = result;

  if (getFlag(args, "json")) {
    const summary = {
      action,
      fps,
      frames,
      gif,
      path: "image",
      pixelSnap: result.pixelSnap,
      qc: qc ? qc.verdict : "skipped",
      runtimeFrames: result.runtimeFrames,
      slicing: result.slicing,
      spritesheet,
    };

    console.log(toPythonJson(qc ? { ...summary, qcChecks: qc.checks } : summary));

    return;
  }

  const lines = [
    `\n=== ${action} (image): ${frames} frames @ ${fps}fps ===`,
    `  sheet: ${spritesheet}`,
    `  gif: ${gif}`,
  ];

  if (qc) {
    lines.push(`  qc: [${qc.verdict.toUpperCase()}]`);

    for (const check of qc.checks) {
      lines.push(
        `      ${check.severity === "warn" ? "!" : "?"} ${check.check}: ` +
          `frames [${check.frames.join(", ")}] — ${check.detail}`,
      );
    }
  }

  console.log(lines.join("\n"));
});
