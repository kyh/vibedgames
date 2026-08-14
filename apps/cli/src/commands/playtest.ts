import { existsSync } from "node:fs";

import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

import { getBaseUrl } from "../lib/config.js";
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

/**
 * Subcommands that take a URL. Used only to decide whether a bare
 * `--game` still needs an `open` in front of it — never to locate the
 * subcommand, so an unknown verb degrades to agent-browser's own error rather
 * than to a wrong guess here.
 */
const URL_TAKING = new Set(["open", "goto", "navigate", "url"]);

/** The slug grammar the deploy path accepts. */
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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

/**
 * The URL a game is served at: a per-slug subdomain of whatever host this CLI
 * is pointed at, so `VG_API_URL=…staging vg playtest --game x` playtests
 * staging rather than silently hitting production the way a hardcoded apex
 * would. Mirrors the derivation the deploy router does server-side.
 */
function resolveGameUrl(slug: string | null): string {
  const resolved = slug ?? projectSlug();

  // The slug lands in the host, so anything outside the deploy grammar could
  // steer the browser off `*.vibedgames.com` entirely — `../`, an embedded
  // `/`, or `evil.com#` would all re-point the origin.
  if (!SLUG.test(resolved)) {
    consola.error(
      `"${resolved}" isn't a valid game slug (lowercase letters, digits, and single hyphens).`,
    );
    process.exit(1);
  }

  const base = new URL(getBaseUrl());
  if (base.hostname === "localhost" || base.hostname === "127.0.0.1") {
    consola.error(
      `\`--game\` resolves a deployed game's subdomain, which a local API URL (${base.host}) doesn't serve. Pass the game's URL directly instead.`,
    );
    process.exit(1);
  }
  return `${base.protocol}//${resolved}.${base.host}`;
}

/** The current project's slug, from the nearest vibedgames.json. */
function projectSlug(): string {
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
  return config.slug;
}

/**
 * Replace each `--game [slug]` with the resolved URL, in place.
 *
 * Substituting where the flag already sits means this never has to work out
 * where agent-browser's subcommand starts, so there's no mirror of its flag
 * grammar here to drift out of date — and repeating the flag works for
 * multi-URL subcommands (`diff url --game a --game b`). The one structural
 * decision left is whether a bare `--game` needs an `open` in front of it,
 * which is settled by looking for a URL-taking verb earlier in the args.
 */
export function expandGameFlag(args: string[], resolveUrl = resolveGameUrl): string[] {
  if (!args.includes("--game")) return args;

  // Catch `vg playtest snapshot --game x`, where the URL has nowhere to go.
  // Guarded on args[0] being a bare token, since that is the only position a
  // subcommand can occupy without a preceding flag possibly claiming it as a
  // value — and skipped entirely when some verb here does take a URL.
  const first = args[0];
  if (first !== undefined && !first.startsWith("-") && !args.some((a) => URL_TAKING.has(a))) {
    consola.error(
      `\`--game\` supplies a URL, so it only works with \`${[...URL_TAKING].join("`, `")}\` — not \`${first}\`. Open the game first, then run \`vg playtest ${first} …\` against it.`,
    );
    process.exit(1);
  }

  const out: string[] = [];
  let urlExpected = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg !== "--game") {
      if (URL_TAKING.has(arg)) urlExpected = true;
      out.push(arg);
      continue;
    }
    const next = args[i + 1];
    const slug = next !== undefined && !next.startsWith("-") ? next : null;
    if (slug !== null) i += 1;
    if (!urlExpected) {
      out.push("open");
      urlExpected = true;
    }
    out.push(resolveUrl(slug));
  }
  return out;
}

/** Resolve (installing on first use) and exec agent-browser. Never returns. */
export function runPlaytest(rawArgs: string[]): never {
  const args = expandGameFlag(rawArgs);

  // Bootstrap covers `install` too: on a fresh machine that's the most natural
  // first command, and re-running the provision step it just did is harmless.
  const bin = resolveBinary() ?? bootstrap();

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
