#!/usr/bin/env node
// @ts-check
import { statSync } from "node:fs";
import path from "node:path";

import {
  analyzeBaseline,
  fail,
  failUsage,
  getInt,
  getString,
  main,
  parseArgs,
  parseFrame,
  resolveTargets,
  writeJsonFile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["frame", "json", "out", "out-dir", "target-bottom", "target-center-x"],
  });

  const [input = ""] = args.positionals;

  if (input === "") {
    failUsage("A PNG file or folder path is required.");
  }

  const frameSpec = getString(args, "frame") ?? "";

  if (frameSpec === "") {
    failUsage("--frame is required, e.g. --frame 256x256");
  }

  const frame = parseFrame(frameSpec);

  const targetBottom = getInt(args, "target-bottom", frame.height - 1);

  const targetCenterX =
    getString(args, "target-center-x") === undefined ? null : getInt(args, "target-center-x", 0);

  const targets = resolveTargets(input);

  if (targets.length === 0) {
    fail(`No PNG files found in ${input}`);
  }

  const out = getString(args, "out") ?? "";
  const outDir = getString(args, "out-dir") ?? "";

  if (out !== "" && outDir !== "") {
    fail("Use either --out or --out-dir, not both.");
  }

  if (out !== "" && targets.length !== 1) {
    fail("--out can only be used with a single PNG input; use --out-dir for folders.");
  }

  const inputIsFile = statSync(input).isFile();

  const reports = targets.map((target) => {
    let outPath = null;

    if (out !== "") {
      outPath = out;
    } else if (outDir !== "") {
      outPath = path.join(
        outDir,
        inputIsFile ? path.basename(target) : path.relative(input, target),
      );
    }

    const report = analyzeBaseline(target, frame, targetBottom, targetCenterX, outPath);
    const bottomRange = report.visibleBottomYRange;
    const shiftRange = report.shiftYRange;
    console.log(
      `${target} frame=${frame.width}x${frame.height}` +
        ` bottom_range=${bottomRange ? `[${bottomRange.join(", ")}]` : "None"}` +
        ` shift_y_range=${shiftRange ? `[${shiftRange.join(", ")}]` : "None"}`,
    );

    return report;
  });

  const json = getString(args, "json") ?? "";

  if (json !== "") {
    writeJsonFile(json, reports);
  }
});
