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
// nor a TS runtime (Alpine needs `apk add libstdc++`, as every Bun binary
// there does). There is no wrapper package: `vg factory` installs the right
// platform package on first use and execs its binary.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { asJsonObject, asString, isJsonString, parseJson } from "../src/json.ts";
import type { JsonValue } from "../src/json.ts";

interface Target {
  os: "darwin" | "linux" | "win32";
  cpu: "x64" | "arm64";
  /** Linux only: the C library the binary links. */
  libc?: "glibc" | "musl";
  bunTarget: Bun.Build.CompileTarget;
}

// opentui also ships win32-arm64, but bun can't cross-compile to it yet.
const allTargets: Target[] = [
  { bunTarget: "bun-darwin-arm64", cpu: "arm64", os: "darwin" },
  { bunTarget: "bun-darwin-x64", cpu: "x64", os: "darwin" },
  { bunTarget: "bun-linux-arm64", cpu: "arm64", libc: "glibc", os: "linux" },
  { bunTarget: "bun-linux-x64", cpu: "x64", libc: "glibc", os: "linux" },
  { bunTarget: "bun-linux-arm64-musl", cpu: "arm64", libc: "musl", os: "linux" },
  { bunTarget: "bun-linux-x64-musl", cpu: "x64", libc: "musl", os: "linux" },
  { bunTarget: "bun-windows-x64", cpu: "x64", os: "win32" },
];

/** The libc this process runs on: musl reports no glibc runtime version. */
const hostLibc = (): Target["libc"] => {
  if (process.platform !== "linux") {
    return undefined;
  }
  const report = asJsonObject(parseJson(JSON.stringify(process.report.getReport())));
  return asString(asJsonObject(report?.header)?.glibcVersionRuntime) ? "glibc" : "musl";
};

const hostOnly = process.argv.includes("--host");
const targets = hostOnly
  ? allTargets.filter(
      (t) => t.os === process.platform && t.cpu === process.arch && t.libc === hostLibc(),
    )
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

const run = (command: string, args: string[]) => {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
};

const opentuiManifest: JsonValue = JSON.parse(
  readFileSync(createRequire(import.meta.url).resolve("@opentui/core/package.json"), "utf-8"),
);
const opentuiVersion = asJsonObject(opentuiManifest)?.version;
if (!isJsonString(opentuiVersion)) {
  throw new Error("@opentui/core's package.json is missing a string version");
}

/**
 * opentui loads its native library from a per-platform package. pnpm installs
 * the glibc and macOS/Windows ones (`supportedArchitectures`); the musl ones
 * are fetched here, at the installed opentui's exact version, since only this
 * build reads them and installing them for every checkout costs hundreds of MB.
 */
const muslNativePackage = (cpu: Target["cpu"]): string => {
  const name = `core-linux-${cpu}-musl`;
  const dir = path.join(rootDir, ".cache", "opentui", `${name}-${opentuiVersion}`);
  if (!existsSync(path.join(dir, "package", "index.bun.js"))) {
    rmSync(dir, { force: true, recursive: true });
    mkdirSync(dir, { recursive: true });
    run("npm", ["pack", `@opentui/${name}@${opentuiVersion}`, "--pack-destination", dir]);
    run("tar", ["xzf", path.join(dir, `opentui-${name}-${opentuiVersion}.tgz`), "-C", dir]);
  }
  return path.join(dir, "package");
};

/**
 * opentui picks its Linux native library by OPENTUI_LIBC at runtime, and
 * imports both libcs' packages by name. Fixing the variable at compile time
 * folds the other libc's import away, so bun embeds one library and needs only
 * that package; a musl build resolves musl's from the fetched copy.
 */
const linuxBuild = (target: Target) => {
  const define = { "process.env.OPENTUI_LIBC": JSON.stringify(target.libc) };
  if (target.libc !== "musl") {
    return { define, plugins: [] };
  }
  const nativePackage = muslNativePackage(target.cpu);
  const plugin: Bun.BunPlugin = {
    name: "opentui-musl-native",
    setup: (build) => {
      build.onResolve({ filter: /^@opentui\/core-linux-(?:x64|arm64)-musl$/u }, () => ({
        path: path.join(nativePackage, "index.bun.js"),
      }));
    },
  };
  return { define, plugins: [plugin] };
};

rmSync(outDir, { force: true, recursive: true });

const platformSuffix = (target: Target) =>
  `${target.os}-${target.cpu}${target.libc === "musl" ? "-musl" : ""}`;

const platformPackageName = (target: Target) => `@vibedgames/factory-${platformSuffix(target)}`;

for (const target of targets) {
  const packageDir = path.join(outDir, `factory-${platformSuffix(target)}`);
  const binName = target.os === "win32" ? "vg-factory.exe" : "vg-factory";
  mkdirSync(path.join(packageDir, "bin"), { recursive: true });

  const linux = target.os === "linux" ? linuxBuild(target) : undefined;
  const result = await Bun.build({
    compile: { outfile: path.join(packageDir, "bin", binName), target: target.bunTarget },
    define: linux?.define,
    entrypoints: [path.join(rootDir, "src", "index.ts")],
    plugins: linux?.plugins,
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `bun build failed for ${target.bunTarget}`);
  }

  writeFileSync(
    path.join(packageDir, "package.json"),
    JSON.stringify(
      {
        cpu: [target.cpu],
        description: `${description} (${platformSuffix(target)} binary)`,
        files: ["bin"],
        // npm installs a libc-gated package only where that libc runs.
        libc: target.libc ? [target.libc] : undefined,
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
