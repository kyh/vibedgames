#!/usr/bin/env node
import {
  failUsage,
  getFlag,
  getInt,
  getString,
  main,
  parseArgs,
  runQc,
  toPythonJson,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["fail-on-hints", "json", "strict"],
    values: ["frame-height", "frame-width"],
  });

  const [sheet = ""] = args.positionals;

  if (sheet === "") {
    failUsage("a spritesheet path is required");
  }

  const frameWidth =
    getString(args, "frame-width") === undefined ? null : getInt(args, "frame-width", 0);

  const frameHeight =
    getString(args, "frame-height") === undefined ? null : getInt(args, "frame-height", 0);

  const report = runQc(sheet, frameWidth, frameHeight);

  if (getFlag(args, "json")) {
    console.log(toPythonJson(report));
  } else {
    console.log(
      `[${report.verdict.toUpperCase()}] ${report.sheet}` +
        `  (${report.frameCount} frames ${report.frameWidth}x${report.frameHeight})`,
    );

    for (const check of report.checks) {
      const marker = check.severity === "warn" ? "!" : "?";
      console.log(
        `  ${marker} ${check.check}: frames [${check.frames.join(", ")}] — ${check.detail}`,
      );
    }

    if (report.checks.length === 0) {
      console.log("  no issues: sizes consistent, facing consistent, no clipping or empty cells.");
    }
  }

  if (getFlag(args, "fail-on-hints") && report.verdict !== "clean") {
    process.exit(1);
  }

  if (getFlag(args, "strict") && report.verdict === "warn") {
    process.exit(1);
  }
});
