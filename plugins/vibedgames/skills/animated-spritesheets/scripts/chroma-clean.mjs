#!/usr/bin/env node
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  Bitmap,
  cleanChroma,
  despillChroma,
  fail,
  failUsage,
  getFlag,
  getInt,
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

const chromaOf = (args) => {
  const [r, g, b] = parseColor(getString(args, "chroma") ?? "#00FF00");

  return [r, g, b];
};

const inputsFor = (input, glob) => {
  if (!existsSync(input)) {
    fail(`input not found: ${input}`);
  }

  if (!statSync(input).isDirectory()) {
    return [input];
  }

  const frames = globFrames(input, glob);

  if (frames.length === 0) {
    fail(`no files matched ${glob} in ${input}`);
  }

  return frames;
};

const siblingOutput = (src, suffix) => {
  const name = path.basename(src).replace(/\.[^.]+$/u, "");

  return path.join(path.dirname(src), `${name}-${suffix}.png`);
};

const COMMANDS = {
  clean(args) {
    const input = getString(args, "input");

    if (!input) {
      failUsage("--input is required");
    }

    const chroma = chromaOf(args);

    const settings = {
      chroma,
      decontam: !getFlag(args, "no-decontam"),
      despillRadius: getInt(args, "despill-radius", 2),
      fringeRadius: getInt(args, "fringe-radius", 1),
      tolerance: getNumber(args, "tolerance", 90),
    };

    const cleanOne = (src, out) => {
      const result = cleanChroma(Bitmap.fromFile(src), settings);
      result.image.toFile(out);

      return {
        chromaRgb: chroma,
        decontam: result.decontam,
        despill: result.despill,
        fringe: result.fringe,
        input: src,
        key: result.key,
        output: out,
      };
    };

    if (statSync(input).isDirectory()) {
      const outDir = getString(args, "out-dir") ?? input;

      const frames = inputsFor(input, getString(args, "glob") ?? "*.png").map((frame) =>
        cleanOne(frame, path.join(outDir, path.basename(frame))),
      );

      writeJsonFile(path.join(outDir, "clean-metadata.json"), {
        frames,
        inputDir: input,
        outDir,
      });
      console.log(outDir);

      return;
    }

    const out = getString(args, "out") ?? siblingOutput(input, "clean");
    const meta = cleanOne(input, out);
    writeJsonFile(path.join(path.dirname(out), "clean-metadata.json"), meta);
    console.log(out);
  },

  despill(args) {
    const input = getString(args, "input");

    if (!input) {
      failUsage("--input is required");
    }

    const chroma = chromaOf(args);
    const edgeRadius = getInt(args, "edge-radius", 2);
    const bandOnly = !getFlag(args, "whole-image");
    const frames = inputsFor(input, getString(args, "glob") ?? "*.png");

    const outDir =
      getString(args, "out-dir") ?? (statSync(input).isDirectory() ? input : path.dirname(input));

    const metadata = [];

    for (const frame of frames) {
      const { image, record } = despillChroma(Bitmap.fromFile(frame), {
        bandOnly,
        chroma,
        edgeRadius,
      });

      const out = path.join(outDir, path.basename(frame));
      image.toFile(out);
      metadata.push({ input: frame, output: out, ...record });
    }

    writeJsonFile(path.join(outDir, "despill-metadata.json"), {
      bandOnly,
      chromaRgb: chroma,
      edgeRadius,
      frames: metadata,
    });
    console.log(outDir);
  },

  fringe(args) {
    const input = getString(args, "input");

    if (!input) {
      failUsage("--input is required");
    }

    const chroma = chromaOf(args);
    const edgeRadius = getInt(args, "edge-radius", 1);
    const frames = inputsFor(input, getString(args, "glob") ?? "*.png");

    const outDir =
      getString(args, "out-dir") ?? (statSync(input).isDirectory() ? input : path.dirname(input));

    const metadata = [];
    const warnings = [];

    for (const frame of frames) {
      const { image, record } = removeChromaFringe(Bitmap.fromFile(frame), {
        chroma,
        edgeRadius,
      });

      const out = path.join(outDir, path.basename(frame));
      image.toFile(out);
      metadata.push({ input: frame, output: out, ...record });

      if (record.warning) {
        warnings.push({
          frame: path.basename(frame),
          keptPixels: record.keptPixels,
          removedFringePixels: record.removedFringePixels,
          removedToKeptRatio: record.removedToKeptRatio,
          warning: record.warning,
        });
      }
    }

    writeJsonFile(path.join(outDir, "fringe-metadata.json"), {
      chromaRgb: chroma,
      edgeRadius,
      frames: metadata,
      highRemovalRatioThreshold: HIGH_FRINGE_REMOVAL_RATIO,
      warnings,
    });
    console.log(outDir);
  },

  key(args) {
    const [, src] = args.positionals;

    if (!src && !getString(args, "input")) {
      failUsage("--input is required");
    }

    const input = getString(args, "input") ?? src;

    if (statSync(input).isDirectory()) {
      fail("key expects a single PNG; use fringe/despill for directories");
    }

    const { image, record } = keyMatte(Bitmap.fromFile(input), {
      chroma: chromaOf(args),
      keepLargest: getFlag(args, "keep-largest"),
      tolerance: getNumber(args, "tolerance", 90),
    });

    const out = getString(args, "out") ?? siblingOutput(input, "keyed");
    image.toFile(out);
    writeJsonFile(path.join(path.dirname(out), "key-metadata.json"), {
      input,
      output: out,
      ...record,
    });
    console.log(out);
  },
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["keep-largest", "no-decontam", "whole-image"],
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
  });

  const [command] = args.positionals;
  const run = COMMANDS[command];

  if (!run) {
    fail(
      `Usage: node chroma-clean.mjs <clean|key|fringe|despill> --input <path> [--chroma '#00FF00']`,
    );
  }

  run(args);
});
