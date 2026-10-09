import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonValue } from "../lib/types.js";

/**
 * `vg factory` — the autonomous game factory, shipped as an optional plugin.
 * The vg CLI carries none of it: the factory lives in a per-platform npm
 * package (a bun-compiled standalone binary) that gets installed globally on
 * first use, then every invocation just execs it with the args passed
 * through. index.ts routes `vg factory …` here BEFORE citty parses anything,
 * so even `--help`/`--version` reach the binary untouched; the citty command
 * below exists only so `vg --help` lists the subcommand.
 */

/**
 * The platform package carrying a machine's factory binary. Linux has one per
 * C library, and `report` (a `process.report` diagnostic report) tells them
 * apart: glibc's names its runtime version, musl's (Alpine) names none.
 */
export const factoryPackageFor = (
  platform: NodeJS.Platform,
  arch: string,
  report: JsonValue,
): string => {
  const name = `@vibedgames/factory-${platform}-${arch}`;
  if (platform !== "linux") {
    return name;
  }
  const header = isJsonObject(report) ? report.header : undefined;
  return isJsonObject(header) && isJsonString(header.glibcVersionRuntime) ? name : `${name}-musl`;
};

const factoryPackage = (): string => {
  if (process.platform !== "linux") {
    return factoryPackageFor(process.platform, process.arch, null);
  }
  // A diagnostic report is plain data; read back from its text, it is typed.
  const reportText = JSON.stringify(process.report.getReport());
  const report: JsonValue = JSON.parse(reportText);
  return factoryPackageFor(process.platform, process.arch, report);
};

const BIN = process.platform === "win32" ? "vg-factory.exe" : "vg-factory";

const npmGlobalRoot = (): string | null => {
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 30_000 });
    if (res.status !== 0 || res.error !== undefined) {
      return null;
    }
    const root = res.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
};

/** The installed factory binary, or null. VG_FACTORY_BIN overrides (dev). */
const findBinary = (pkg: string): string | null => {
  const override = process.env.VG_FACTORY_BIN;
  if (override) {
    return existsSync(override) ? override : null;
  }
  const root = npmGlobalRoot();
  if (!root) {
    return null;
  }
  const bin = path.join(root, pkg, "bin", BIN);
  return existsSync(bin) ? bin : null;
};

/** Resolve (installing on first use) and exec the factory. Never returns. */
export const runFactory = (args: string[]): never => {
  const pkg = factoryPackage();
  let bin = findBinary(pkg);
  if (!bin) {
    consola.start(`Installing the factory (${pkg})…`);
    const install = spawnSync("npm", ["install", "-g", pkg], { stdio: "inherit" });
    if (install.status !== 0 || install.error !== undefined) {
      consola.error(`Couldn't install the factory. Try manually: npm install -g ${pkg}`);
      process.exit(1);
    }
    bin = findBinary(pkg);
    if (!bin) {
      consola.error(
        `Installed ${pkg} but couldn't find its binary under npm's global root. Check \`npm root -g\`.`,
      );
      process.exit(1);
    }
    consola.success("Factory installed.");
  }
  const result = spawnSync(bin, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
};

export const factoryCommand = defineCommand({
  meta: {
    description:
      "Run the vibedgames factory — an autonomous agent that builds a browser game and evolves it like a studio (optional plugin; installs on first use). All arguments are passed through: `vg factory` opens the dashboard, `vg factory start <slug>` resumes a game.",
    name: "factory",
  },
  run: ({ rawArgs }) => {
    // Normally unreachable (index.ts routes `vg factory` before citty), but
    // keeps the command functional if invoked programmatically.
    runFactory(rawArgs);
  },
});
