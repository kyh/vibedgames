/**
 * Work out which package manager installed this CLI, so a self-update uses it.
 *
 * `vg init` and `vg update` both used to shell out to `npm install -g
 * vibedgames` unconditionally. On a machine where the CLI came from pnpm, bun
 * or yarn, that is wrong twice over: npm may not be installed at all, and if it
 * is, it installs a *second* copy into a different global prefix — so the
 * update silently lands somewhere the shell isn't looking and `vg --version`
 * doesn't move.
 *
 * The install path is the evidence. Each manager puts globals somewhere
 * recognisable, so the directory this file was loaded from names the manager
 * that put it there.
 */

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const PKG_NAME = "vibedgames";

/**
 * Global install directory fingerprints, most specific first.
 *
 * The npm entries come last because they are the loosest: `lib/node_modules`
 * is npm's global prefix on unix and `npm\node_modules` is its Windows one,
 * but neither is distinctive enough to check before the managers that have a
 * directory named after them.
 */
const SIGNATURES: [PackageManager, RegExp][] = [
  ["bun", /[/\\]\.bun[/\\]/],
  // pnpm's global store, not a project-local `node_modules/.pnpm`.
  ["pnpm", /[/\\](?:pnpm[/\\]global|\.pnpm-global|Library[/\\]pnpm)[/\\]/],
  ["yarn", /[/\\](?:\.yarn|yarn[/\\]global|\.config[/\\]yarn)[/\\]/],
  ["npm", /[/\\]lib[/\\]node_modules[/\\]/],
  ["npm", /[/\\]npm[/\\]node_modules[/\\]/],
];

/**
 * `npm_config_user_agent` is set by whichever manager is running us — reliable
 * when `vg` was invoked through a script (`pnpm vg …`), absent otherwise.
 */
function fromUserAgent(userAgent: string | undefined): PackageManager | null {
  if (!userAgent) return null;
  const name = userAgent.split("/")[0];
  return name === "npm" || name === "pnpm" || name === "yarn" || name === "bun" ? name : null;
}

/**
 * `installPath` is where the CLI is installed — normally the directory this
 * module resolves from. Bun's own runtime is a signal in its own right.
 */
export function detectPackageManager(
  installPath: string,
  env: NodeJS.ProcessEnv = process.env,
): PackageManager {
  for (const [manager, signature] of SIGNATURES) {
    if (signature.test(installPath)) return manager;
  }
  // Bun reports itself in versions; running under it means `bun add` works.
  if ("Bun" in globalThis) return "bun";
  return fromUserAgent(env.npm_config_user_agent) ?? "npm";
}

/** The argv that installs or upgrades a package globally, per manager. */
export function globalInstallArgs(manager: PackageManager, pkg = PKG_NAME): string[] {
  switch (manager) {
    case "pnpm":
      return ["add", "-g", pkg];
    case "yarn":
      return ["global", "add", pkg];
    case "bun":
      return ["add", "-g", pkg];
    case "npm":
      return ["install", "-g", pkg];
  }
}

/** The command a user can copy-paste when the automatic update can't run. */
export function globalInstallCommand(manager: PackageManager, pkg = PKG_NAME): string {
  return `${manager} ${globalInstallArgs(manager, pkg).join(" ")}`;
}
