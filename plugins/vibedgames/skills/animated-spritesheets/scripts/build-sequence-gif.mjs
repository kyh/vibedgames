#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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

  if (!inputDir) {
    failUsage("--input-dir is required");
  }

  if (!order) {
    failUsage("--order is required, e.g. --order 01,03,02,04");
  }

  if (!out) {
    failUsage("--out is required");
  }

  const ids = order
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  if (ids.length === 0) {
    fail("No frames selected");
  }

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
    delayMs: durations ? durations[i] : 120,
    path: path.resolve(inputDir, pattern.replace("{id}", id)),
  }));

  let gif;

  try {
    gif = buildSequenceGif(frames, flatBg ? parseColor(flatBg) : null);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      fail(`frame file not found: ${error.path}`);
    }

    throw error;
  }

  mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  writeFileSync(out, gif);
  console.log(out);
});
