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
import { join } from "node:path";

type Target = {
  os: "darwin" | "linux" | "win32";
  cpu: "x64" | "arm64";
  bunTarget: string;
};

// opentui also ships win32-arm64, but bun can't cross-compile to it yet.
// Linux targets are glibc; musl users are out of luck for now.
const allTargets: Target[] = [
  { os: "darwin", cpu: "arm64", bunTarget: "bun-darwin-arm64" },
  { os: "darwin", cpu: "x64", bunTarget: "bun-darwin-x64" },
  { os: "linux", cpu: "arm64", bunTarget: "bun-linux-arm64" },
  { os: "linux", cpu: "x64", bunTarget: "bun-linux-x64" },
  { os: "win32", cpu: "x64", bunTarget: "bun-windows-x64" },
];

const hostOnly = process.argv.includes("--host");
const targets = hostOnly
  ? allTargets.filter((t) => t.os === process.platform && t.cpu === process.arch)
  : allTargets;
if (targets.length === 0) {
  throw new Error(`No build target matches this host (${process.platform}-${process.arch}).`);
}

const rootDir = join(import.meta.dirname, "..");
const outDir = join(rootDir, "dist", "npm");

const manifest: unknown = JSON.parse(readFileSync(join(rootDir, "package.json"), "utf8"));
if (
  typeof manifest !== "object" ||
  manifest === null ||
  !("version" in manifest) ||
  typeof manifest.version !== "string"
) {
  throw new Error("apps/factory/package.json is missing a string version");
}
const { version } = manifest;
const description = "vibedgames factory — an autonomous agent that builds and runs browser games";

rmSync(outDir, { recursive: true, force: true });

const platformPackageName = (target: Target) => `@vibedgames/factory-${target.os}-${target.cpu}`;

for (const target of targets) {
  const packageDir = join(outDir, `factory-${target.os}-${target.cpu}`);
  const binName = target.os === "win32" ? "vg-factory.exe" : "vg-factory";
  mkdirSync(join(packageDir, "bin"), { recursive: true });

  const result = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      `--target=${target.bunTarget}`,
      join(rootDir, "src", "index.ts"),
      "--outfile",
      join(packageDir, "bin", binName),
    ],
    { stdio: "inherit", cwd: rootDir },
  );
  if (result.status !== 0) {
    throw new Error(`bun build failed for ${target.bunTarget}`);
  }

  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify(
      {
        name: platformPackageName(target),
        version,
        description: `${description} (${target.os}-${target.cpu} binary)`,
        os: [target.os],
        cpu: [target.cpu],
        files: ["bin"],
        publishConfig: { access: "public" },
      },
      null,
      2,
    ),
  );
}

console.log(`Staged ${targets.length} packages in ${outDir} (version ${version})`);
