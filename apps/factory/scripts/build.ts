// Builds the publishable npm packages for the factory CLI. Run with bun:
//   bun scripts/build.ts            # all platforms
//   bun scripts/build.ts --host     # current platform only (fast, for testing)
//
// Output layout (everything under dist/npm/ is publish-ready):
//   dist/npm/factory-<os>-<cpu>/   @vibedgames/factory-<os>-<cpu> — bun-compiled
//                                  standalone binary for one platform
//                                  (os/cpu-gated on npm)
//
// The platform packages embed the Bun runtime, the agent markdown (bundled as
// text imports), and opentui's native library — end users need neither Bun
// nor a TS runtime. There is no wrapper package: `vg factory` installs the
// right platform package on first use and execs its binary.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { asJsonObject, isJsonString } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";

interface Target {
  os: "darwin" | "linux" | "win32";
  cpu: "x64" | "arm64";
  bunTarget: string;
}

// opentui also ships win32-arm64, but bun can't cross-compile to it yet.
// Linux targets are glibc; musl users are out of luck for now.
const allTargets: Target[] = [
  { bunTarget: "bun-darwin-arm64", cpu: "arm64", os: "darwin" },
  { bunTarget: "bun-darwin-x64", cpu: "x64", os: "darwin" },
  { bunTarget: "bun-linux-arm64", cpu: "arm64", os: "linux" },
  { bunTarget: "bun-linux-x64", cpu: "x64", os: "linux" },
  { bunTarget: "bun-windows-x64", cpu: "x64", os: "win32" },
];

const hostOnly = process.argv.includes("--host");
const targets = hostOnly
  ? allTargets.filter((t) => t.os === process.platform && t.cpu === process.arch)
  : allTargets;
if (targets.length === 0) {
  throw new Error(`No build target matches this host (${process.platform}-${process.arch}).`);
}

const rootDir = path.join(import.meta.dirname, "..");
const outDir = path.join(rootDir, "dist", "npm");

const manifest: JsonValue = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf-8"));
const version = asJsonObject(manifest)?.version;
if (!isJsonString(version)) {
  throw new Error("apps/factory/package.json is missing a string version");
}
const description = "vibedgames factory — an autonomous agent that builds and runs browser games";

rmSync(outDir, { force: true, recursive: true });

const platformPackageName = (target: Target) => `@vibedgames/factory-${target.os}-${target.cpu}`;

for (const target of targets) {
  const packageDir = path.join(outDir, `factory-${target.os}-${target.cpu}`);
  const binName = target.os === "win32" ? "vg-factory.exe" : "vg-factory";
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });

  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      path.join(rootDir, "src", "index.ts"),
      "--outfile",
      path.join(packageDir, "bin", binName),
    ],
    { cwd: rootDir, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`bun build failed for ${target.bunTarget}`);
  }

  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        cpu: [target.cpu],
        description: `${description} (${target.os}-${target.cpu} binary)`,
        files: ["bin"],
        name: platformPackageName(target),
        os: [target.os],
        publishConfig: { access: "public" },
        version,
      },
      null,
      2,
    ),
  );
}

console.log(`Staged ${targets.length} packages in ${outDir} (version ${version})`);
