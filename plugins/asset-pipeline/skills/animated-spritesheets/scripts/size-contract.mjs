#!/usr/bin/env node
/**
 * Derive and audit a sprite size contract.
 *
 * A size contract pins how big the character should appear and where it sits
 * inside the runtime cell. Derive one from a reference action, then audit
 * later actions against it — two clips generated independently otherwise drift
 * apart in scale and baseline, and the mismatch only becomes obvious in-game
 * when the character visibly grows or sinks as animations switch.
 *
 * Subcommands:
 *   derive   measure a source and write contract.json
 *   audit    check a source against a contract
 *   prompt   print the contract's generation guidance
 *
 * Examples:
 *   node size-contract.mjs derive --source runs/idle/runtime --out runs/contract.json
 *   node size-contract.mjs audit --source runs/attack/runtime --contract runs/contract.json --strict
 *   node size-contract.mjs prompt --contract runs/contract.json
 */
import { readFileSync } from "node:fs";

import {
  auditSizeContract,
  deriveSizeContract,
  fail,
  failUsage,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  getFlag,
  getString,
  loadSizeContract,
  main,
  parseArgs,
  promptGuidanceForContract,
  toPythonJson,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

function parseCell(value) {
  const parts = value.toLowerCase().split("x");
  if (parts.length !== 2) fail(`cell must be WxH, got: '${value}'`);
  const width = Number.parseInt(parts[0], 10);
  const height = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    fail(`cell must be WxH integers, got: '${value}'`);
  }
  return [width, height];
}

function readContract(path) {
  if (!path) failUsage("--contract is required");
  return loadSizeContract(JSON.parse(readFileSync(path, "utf8")), path);
}

const COMMANDS = {
  derive(args) {
    const source = getString(args, "source");
    const out = getString(args, "out");
    if (!source) failUsage("--source is required");
    if (!out) failUsage("--out is required");

    const contract = deriveSizeContract(source, {
      cellSize: parseCell(getString(args, "cell") ?? `${FRAME_WIDTH}x${FRAME_HEIGHT}`),
      frameGlob: getString(args, "frame-glob") ?? "frame-*.png",
      name: getString(args, "name") ?? null,
      action: getString(args, "action") ?? null,
      direction: getString(args, "direction") ?? null,
      anchorPolicy: getString(args, "anchor-policy") ?? "grounded",
      pivot: getString(args, "pivot") ?? "base-center",
    });
    writeJsonFile(out, contract);
    console.log(out);
  },

  audit(args) {
    const source = getString(args, "source");
    if (!source) failUsage("--source is required");
    const contract = readContract(getString(args, "contract"));

    const report = auditSizeContract(source, contract, {
      frameGlob: getString(args, "frame-glob") ?? "frame-*.png",
      stage: getString(args, "stage") ?? "runtime",
    });

    const out = getString(args, "out");
    if (out) writeJsonFile(out, report);
    console.log(toPythonJson(report));

    if (getFlag(args, "strict") && report.status !== "pass") process.exit(1);
  },

  prompt(args) {
    const contract = readContract(getString(args, "contract"));
    // Emitted as a bullet list, so it can be pasted straight into a prompt.
    for (const line of promptGuidanceForContract(contract)) console.log(`- ${line}`);
  },
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: [
      "action",
      "anchor-policy",
      "cell",
      "contract",
      "direction",
      "frame-glob",
      "name",
      "out",
      "pivot",
      "source",
      "stage",
    ],
    booleans: ["strict"],
  });
  const run = COMMANDS[args.positionals[0]];
  if (!run) failUsage("Usage: node size-contract.mjs <derive|audit|prompt> ...");
  run(args);
});
