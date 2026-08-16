#!/usr/bin/env node
/**
 * Chroma matte cleanup: key a flat matte to transparency, sweep matte-tinted
 * fringe, and despill residual matte tint on the edge band.
 *
 * An alternative to segmentation background removal. Generate sprites on a
 * flat chroma matte (#00FF00 default, #FF00FF when the subject is green), key
 * the matte out, then optionally clean the fringe and despill.
 *
 * Subcommands:
 *   clean     key -> fringe -> despill -> decontaminate (recommended)
 *   key       key the matte out to transparency
 *   fringe    sweep matte-tinted fringe pixels
 *   despill   neutralise matte tint without deleting pixels
 */
import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  Bitmap,
  cleanChroma,
  despillChroma,
  fail,
  failUsage,
  getFlag,
  getNumber,
  getString,
  globFrames,
  HIGH_FRINGE_REMOVAL_RATIO,
  keyMatte,
  main,
  parseArgs,
  parseColor,
  removeChromaFringe,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

function chromaOf(args) {
  const [r, g, b] = parseColor(getString(args, "chroma") ?? "#00FF00");
  return [r, g, b];
}

/** A single file, or every glob match inside a directory. */
function inputsFor(input, glob) {
  if (!existsSync(input)) fail(`input not found: ${input}`);
  if (!statSync(input).isDirectory()) return [input];
  const frames = globFrames(input, glob);
  if (frames.length === 0) fail(`no files matched ${glob} in ${input}`);
  return frames;
}

/** `sprite.png` -> `sprite-keyed.png`, alongside the original. */
function siblingOutput(src, suffix) {
  const name = basename(src).replace(/\.[^.]+$/, "");
  return join(dirname(src), `${name}-${suffix}.png`);
}

const COMMANDS = {
  key(args) {
    const src = args.positionals[1];
    if (!src && !getString(args, "input")) failUsage("--input is required");
    const input = getString(args, "input") ?? src;
    if (statSync(input).isDirectory()) {
      fail("key expects a single PNG; use fringe/despill for directories");
    }

    const { image, record } = keyMatte(Bitmap.fromFile(input), {
      chroma: chromaOf(args),
      tolerance: getNumber(args, "tolerance", 90),
      keepLargest: getFlag(args, "keep-largest"),
    });

    const out = getString(args, "out") ?? siblingOutput(input, "keyed");
    image.toFile(out);
    writeJsonFile(join(dirname(out), "key-metadata.json"), {
      input,
      output: out,
      ...record,
    });
    console.log(out);
  },

  fringe(args) {
    const input = getString(args, "input");
    if (!input) failUsage("--input is required");
    const chroma = chromaOf(args);
    const edgeRadius = getNumber(args, "edge-radius", 1);
    const frames = inputsFor(input, getString(args, "glob") ?? "*.png");
    const outDir =
      getString(args, "out-dir") ?? (statSync(input).isDirectory() ? input : dirname(input));

    const metadata = [];
    const warnings = [];
    for (const frame of frames) {
      const { image, record } = removeChromaFringe(Bitmap.fromFile(frame), {
        chroma,
        edgeRadius,
      });
      const out = join(outDir, basename(frame));
      image.toFile(out);
      metadata.push({ input: frame, output: out, ...record });
      if (record.warning) {
        warnings.push({
          frame: basename(frame),
          warning: record.warning,
          removedFringePixels: record.removedFringePixels,
          keptPixels: record.keptPixels,
          removedToKeptRatio: record.removedToKeptRatio,
        });
      }
    }

    writeJsonFile(join(outDir, "fringe-metadata.json"), {
      chromaRgb: chroma,
      edgeRadius,
      highRemovalRatioThreshold: HIGH_FRINGE_REMOVAL_RATIO,
      frames: metadata,
      warnings,
    });
    console.log(outDir);
  },

  despill(args) {
    const input = getString(args, "input");
    if (!input) failUsage("--input is required");
    const chroma = chromaOf(args);
    const edgeRadius = getNumber(args, "edge-radius", 2);
    const bandOnly = !getFlag(args, "whole-image");
    const frames = inputsFor(input, getString(args, "glob") ?? "*.png");
    const outDir =
      getString(args, "out-dir") ?? (statSync(input).isDirectory() ? input : dirname(input));

    const metadata = [];
    for (const frame of frames) {
      const { image, record } = despillChroma(Bitmap.fromFile(frame), {
        chroma,
        edgeRadius,
        bandOnly,
      });
      const out = join(outDir, basename(frame));
      image.toFile(out);
      metadata.push({ input: frame, output: out, ...record });
    }

    writeJsonFile(join(outDir, "despill-metadata.json"), {
      chromaRgb: chroma,
      edgeRadius,
      bandOnly,
      frames: metadata,
    });
    console.log(outDir);
  },

  clean(args) {
    const input = getString(args, "input");
    if (!input) failUsage("--input is required");
    const chroma = chromaOf(args);
    const settings = {
      chroma,
      tolerance: getNumber(args, "tolerance", 90),
      fringeRadius: getNumber(args, "fringe-radius", 1),
      despillRadius: getNumber(args, "despill-radius", 2),
      decontam: !getFlag(args, "no-decontam"),
    };

    const cleanOne = (src, out) => {
      const result = cleanChroma(Bitmap.fromFile(src), settings);
      result.image.toFile(out);
      return {
        input: src,
        output: out,
        chromaRgb: chroma,
        key: result.key,
        fringe: result.fringe,
        despill: result.despill,
        decontam: result.decontam,
      };
    };

    if (statSync(input).isDirectory()) {
      const outDir = getString(args, "out-dir") ?? input;
      const frames = inputsFor(input, getString(args, "glob") ?? "*.png").map((frame) =>
        cleanOne(frame, join(outDir, basename(frame))),
      );
      writeJsonFile(join(outDir, "clean-metadata.json"), {
        inputDir: input,
        outDir,
        frames,
      });
      console.log(outDir);
      return;
    }

    const out = getString(args, "out") ?? siblingOutput(input, "clean");
    const meta = cleanOne(input, out);
    writeJsonFile(join(dirname(out), "clean-metadata.json"), meta);
    console.log(out);
  },
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: [
      "chroma",
      "despill-radius",
      "edge-radius",
      "fringe-radius",
      "glob",
      "input",
      "out",
      "out-dir",
      "tolerance",
    ],
    booleans: ["keep-largest", "no-decontam", "whole-image"],
  });
  const command = args.positionals[0];
  const run = COMMANDS[command];
  if (!run) {
    fail(
      `Usage: node chroma_clean.mjs <clean|key|fringe|despill> --input <path> [--chroma '#00FF00']`,
    );
  }
  run(args);
});
