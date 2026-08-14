import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

import { readProjectConfig } from "../lib/config-file.js";

/**
 * `vg playtest` — drive a browser to actually play the game.
 *
 * This is a thin passthrough to agent-browser (a native browser-automation CLI
 * built for agents), not a wrapper with its own vocabulary: every argument goes
 * through untouched so the skill can teach upstream's command surface and we
 * inherit its improvements for free. index.ts routes `vg playtest …` here
 * BEFORE citty parses anything, so `--help`/`--version` reach the binary; the
 * citty command below exists only so `vg --help` lists the subcommand.
 *
 * The one thing layered on top is `--game [slug]`, which resolves a deployed
 * game's URL so an agent can playtest what it just shipped with no local setup.
 *
 * Pinned to a minor: agent-browser is pre-1.0, so patches are welcome but a
 * minor bump can move the command surface out from under the playtest skill.
 */

const PKG = "agent-browser";
const PKG_SPEC = `${PKG}@^0.34.0`;

/** Subcommands that take a URL, and so can accept `--game`. */
const NAVIGATE = new Set(["open", "goto", "navigate"]);

/**
 * Global flags that consume the following token. Needed so `--session p1` isn't
 * mistaken for the subcommand `p1`. Only flags that can legitimately appear
 * BEFORE the subcommand matter here; everything else starting with `-` is
 * treated as a boolean, and `--flag=value` needs no entry at all.
 */
const VALUED_GLOBAL_FLAGS = new Set([
  "--session",
  "--profile",
  "--engine",
  "--executable-path",
  "--timeout",
  "--idle-timeout",
  "--args",
  "--proxy",
  "--state",
  "--headers",
  "--tools",
]);

/** Index of the subcommand token, or -1 when the args are all flags. */
function findSubcommand(args: string[]): number {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!arg.startsWith("-")) return i;
    if (VALUED_GLOBAL_FLAGS.has(arg)) i += 1; // skip its value
  }
  return -1;
}

/** True if agent-browser is on PATH (installed via npm, brew, or cargo). */
function isInstalled(bin: string): boolean {
  // cross-spawn's sync sets `error` to null on success (node's spawnSync leaves
  // it undefined), so test truthiness rather than comparing against undefined.
  const res = spawn.sync(bin, ["--version"], { stdio: "ignore", timeout: 30_000 });
  return res.status === 0 && !res.error;
}

/** The agent-browser binary to use. VG_AGENT_BROWSER_BIN overrides (dev). */
function resolveBinary(): string | null {
  const override = process.env.VG_AGENT_BROWSER_BIN;
  if (override) return existsSync(override) ? override : null;
  return isInstalled(PKG) ? PKG : null;
}

/**
 * Install agent-browser globally, then provision its browser. Upstream ships
 * these as two steps (`npm i -g` puts the Rust binary in place; `install`
 * fetches Chrome for Testing and reuses an existing Chrome/Brave/Playwright
 * install when it finds one), so a first run pays for both.
 */
function bootstrap(): string {
  consola.start(`Installing the playtest browser (${PKG})…`);
  const install = spawn.sync("npm", ["install", "-g", PKG_SPEC], { stdio: "inherit" });
  if (install.status !== 0 || install.error) {
    consola.error(`Couldn't install ${PKG}. Try manually: npm install -g ${PKG_SPEC}`);
    process.exit(1);
  }

  const bin = resolveBinary();
  if (!bin) {
    consola.error(
      `Installed ${PKG_SPEC} but \`${PKG}\` isn't on PATH. Check that npm's global bin directory is in your PATH (\`npm bin -g\`).`,
    );
    process.exit(1);
  }

  consola.start("Provisioning the browser (first run only)…");
  const provision = spawn.sync(bin, ["install"], { stdio: "inherit" });
  if (provision.status !== 0) {
    consola.error(
      `\`${PKG} install\` failed. On Linux you may need system libraries: ${PKG} install --with-deps`,
    );
    process.exit(1);
  }

  consola.success("Playtest browser ready.");
  return bin;
}

/** `https://{slug}.vibedgames.com` for `slug`, or the current project's slug. */
function resolveGameUrl(slug: string | null): string {
  if (slug) return `https://${slug}.vibedgames.com`;

  let config: { slug: string } | null = null;
  try {
    config = readProjectConfig(process.cwd());
  } catch (err) {
    consola.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (!config) {
    consola.error(
      "`--game` with no slug reads vibedgames.json, and none was found here. Pass a slug (`vg playtest --game my-game`) or run from a deployed project.",
    );
    process.exit(1);
  }
  return `https://${config.slug}.vibedgames.com`;
}

/**
 * Replace `--game [slug]` with the resolved URL. `--game` is only meaningful
 * on a navigating subcommand, so anywhere else it's a hard error rather than a
 * silently ignored flag — an agent that typo'd `vg playtest --game snapshot`
 * should be told, not handed an unrelated success.
 */
export function expandGameFlag(args: string[], resolveUrl = resolveGameUrl): string[] {
  const index = args.indexOf("--game");
  if (index === -1) return args;

  const next = args[index + 1];
  const slug = next !== undefined && !next.startsWith("-") ? next : null;
  const rest = [...args.slice(0, index), ...args.slice(index + (slug ? 2 : 1))];

  // `vg playtest --game` (or `--session p1 --game`) with no subcommand means
  // "open it" — prepend `open` so global flags still lead.
  const at = findSubcommand(rest);
  if (at === -1) return [...rest, "open", resolveUrl(slug)];

  const command = rest[at] as string;
  if (!NAVIGATE.has(command)) {
    consola.error(
      `\`--game\` sets the URL to open, so it only works with \`${[...NAVIGATE].join("`, `")}\` — not \`${command}\`. Open the game first, then run \`vg playtest ${command} …\` against it.`,
    );
    process.exit(1);
  }

  return [...rest.slice(0, at + 1), resolveUrl(slug), ...rest.slice(at + 1)];
}

/** Resolve (installing on first use) and exec agent-browser. Never returns. */
export function runPlaytest(rawArgs: string[]): never {
  const args = expandGameFlag(rawArgs);

  // `vg playtest install` is the explicit re-provision path — don't bootstrap
  // underneath it and run the install twice.
  const bin = resolveBinary() ?? (args[0] === "install" ? null : bootstrap());
  if (!bin) {
    consola.error(`\`${PKG}\` isn't installed. Run \`vg playtest\` with any other command first.`);
    process.exit(1);
  }

  const result = spawn.sync(bin, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

export const playtestCommand = defineCommand({
  meta: {
    name: "playtest",
    description:
      "Drive a real browser to play a game — snapshot, click, hold keys, read state, screenshot, diff (installs the browser on first use). All arguments pass through: `vg playtest open <url>`, `vg playtest --game <slug>` to open a deployed game, `vg playtest --help` for the full command surface.",
  },
  run: ({ rawArgs }) => {
    // Normally unreachable (index.ts routes `vg playtest` before citty), but
    // keeps the command functional if invoked programmatically.
    runPlaytest(rawArgs);
  },
});
