#!/usr/bin/env node
/**
 * Build a review GIF from a selected frame order.
 *
 * The order is explicit rather than alphabetical, so an animation can be
 * reviewed in a different sequence than the frames were generated in —
 * swapping two frames of a walk cycle, or holding a wind-up longer — without
 * renaming anything.
 *
 * Example:
 *   node build-sequence-gif.mjs --input-dir runtime --order 01,03,02,04 \
 *       --out review/walk.gif --durations-ms 120,90,120,90 --flat-bg '#202028'
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildSequenceGif,
  fail,
  failUsage,
  getString,
  main,
  parseArgs,
  parseColor,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["durations-ms", "flat-bg", "input-dir", "order", "out", "pattern"],
  });
  const inputDir = getString(args, "input-dir");
  const order = getString(args, "order");
  const out = getString(args, "out");
  if (!inputDir) failUsage("--input-dir is required");
  if (!order) failUsage("--order is required, e.g. --order 01,03,02,04");
  if (!out) failUsage("--out is required");

  const ids = order
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (ids.length === 0) fail("No frames selected");

  const pattern = getString(args, "pattern") ?? "frame-{id}.png";
  const durationsSpec = getString(args, "durations-ms");
  let durations = null;
  if (durationsSpec) {
    durations = durationsSpec
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number);
    if (durations.length !== ids.length) {
      fail("durations-ms length must match frame order length");
    }
  }

  const flatBg = getString(args, "flat-bg");
  const frames = ids.map((id, i) => ({
    path: resolve(inputDir, pattern.replace("{id}", id)),
    delayMs: durations ? durations[i] : 120,
  }));

  let gif;
  try {
    gif = buildSequenceGif(frames, flatBg ? parseColor(flatBg) : null);
  } catch (error) {
    // A missing frame is the common failure and the path is the useful part.
    if (error && error.code === "ENOENT") fail(`frame file not found: ${error.path}`);
    throw error;
  }

  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, gif);
  console.log(out);
});
