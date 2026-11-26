#!/usr/bin/env node
// @ts-check
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

const leadingInteger = (text = "") => Number(/^\s*[+-]?\d+/u.exec(text)?.[0] ?? Number.NaN);

const parseCell = (value = "") => {
  const parts = value.toLowerCase().split("x");

  if (parts.length !== 2) {
    fail(`cell must be WxH, got: '${value}'`);
  }

  const width = leadingInteger(parts[0]);
  const height = leadingInteger(parts[1]);

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    fail(`cell must be WxH integers, got: '${value}'`);
  }

  return [width, height];
};

const readContract = (path = "") => {
  if (path === "") {
    failUsage("--contract is required");
  }

  return loadSizeContract(JSON.parse(readFileSync(path, "utf-8")), path);
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["strict"],
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
  });

  const audit = () => {
    const source = getString(args, "source") ?? "";

    if (source === "") {
      failUsage("--source is required");
    }

    const contract = readContract(getString(args, "contract"));

    const report = auditSizeContract(source, contract, {
      frameGlob: getString(args, "frame-glob") ?? "frame-*.png",
      stage: getString(args, "stage") ?? "runtime",
    });

    const out = getString(args, "out") ?? "";

    if (out !== "") {
      writeJsonFile(out, report);
    }

    console.log(toPythonJson(report));

    if (getFlag(args, "strict") && report.status !== "pass") {
      process.exit(1);
    }
  };

  const derive = () => {
    const source = getString(args, "source") ?? "";
    const out = getString(args, "out") ?? "";

    if (source === "") {
      failUsage("--source is required");
    }

    if (out === "") {
      failUsage("--out is required");
    }

    const contract = deriveSizeContract(source, {
      action: getString(args, "action") ?? null,
      anchorPolicy: getString(args, "anchor-policy") ?? "grounded",
      cellSize: parseCell(getString(args, "cell") ?? `${FRAME_WIDTH}x${FRAME_HEIGHT}`),
      direction: getString(args, "direction") ?? null,
      frameGlob: getString(args, "frame-glob") ?? "frame-*.png",
      name: getString(args, "name") ?? null,
      pivot: getString(args, "pivot") ?? "base-center",
    });

    writeJsonFile(out, contract);
    console.log(out);
  };

  const prompt = () => {
    const contract = readContract(getString(args, "contract"));

    for (const line of promptGuidanceForContract(contract)) {
      console.log(`- ${line}`);
    }
  };

  const run = new Map([
    ["audit", audit],
    ["derive", derive],
    ["prompt", prompt],
  ]).get(args.positionals[0] ?? "");

  if (run === undefined) {
    failUsage("Usage: node size-contract.mjs <derive|audit|prompt> ...");
  }

  run?.();
});
