import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

/**
 * `vg factory` — the autonomous game factory, shipped as an optional plugin.
 * The vg CLI carries none of it: the factory lives in a per-platform npm
 * package (a bun-compiled standalone binary) that gets installed globally on
 * first use, then every invocation just execs it with the args passed
 * through. index.ts routes `vg factory …` here BEFORE citty parses anything,
 * so even `--help`/`--version` reach the binary untouched; the citty command
 * below exists only so `vg --help` lists the subcommand.
 */

const PKG = `@vibedgames/factory-${process.platform}-${process.arch}`;
const BIN = process.platform === "win32" ? "vg-factory.exe" : "vg-factory";

function npmGlobalRoot(): string | null {
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 30_000 });
    if (res.status !== 0 || res.error !== undefined) return null;
    const root = res.stdout.trim();
    return root || null;
  } catch {
    return null;
  }
}

/** The installed factory binary, or null. VG_FACTORY_BIN overrides (dev). */
function findBinary(): string | null {
  const override = process.env.VG_FACTORY_BIN;
  if (override) return existsSync(override) ? override : null;
  const root = npmGlobalRoot();
  if (!root) return null;
  const path = join(root, PKG, "bin", BIN);
  return existsSync(path) ? path : null;
}

/** Resolve (installing on first use) and exec the factory. Never returns. */
export function runFactory(args: string[]): never {
  let bin = findBinary();
  if (!bin) {
    consola.start(`Installing the factory (${PKG})…`);
    const install = spawnSync("npm", ["install", "-g", PKG], { stdio: "inherit" });
    if (install.status !== 0 || install.error !== undefined) {
      consola.error(`Couldn't install the factory. Try manually: npm install -g ${PKG}`);
      process.exit(1);
    }
    bin = findBinary();
    if (!bin) {
      consola.error(
        `Installed ${PKG} but couldn't find its binary under npm's global root. Check \`npm root -g\`.`,
      );
      process.exit(1);
    }
    consola.success("Factory installed.");
  }
  const result = spawnSync(bin, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

export const factoryCommand = defineCommand({
  meta: {
    name: "factory",
    description:
      "Run the vibedgames factory — an autonomous agent that builds a browser game and evolves it like a studio (optional plugin; installs on first use). All arguments are passed through: `vg factory` opens the dashboard, `vg factory start <slug>` resumes a game.",
  },
  run: ({ rawArgs }) => {
    // Normally unreachable (index.ts routes `vg factory` before citty), but
    // keeps the command functional if invoked programmatically.
    runFactory(rawArgs);
  },
});
