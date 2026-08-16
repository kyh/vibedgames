import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

import { getBaseUrl } from "../lib/config.js";
import { SLUG_RE, readProjectConfig } from "../lib/config-file.js";

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
 * A minimum version is enforced: agent-browser is pre-1.0, so a minor bump can
 * move the command surface out from under the playtest skill.
 */

const PKG = "agent-browser";
const MIN_VERSION = { major: 0, minor: 34 };
const PKG_SPEC = `${PKG}@^${MIN_VERSION.major}.${MIN_VERSION.minor}.0`;

/**
 * Subcommands that take a URL. Used to decide whether a bare `--game` still
 * needs an `open` in front of it, and — via `findSubcommand` — to tell a
 * misplaced `--game` from a well-formed one. An unknown verb still degrades to
 * agent-browser's own error rather than to a wrong guess here.
 */
const URL_TAKING = new Set(["open", "goto", "navigate", "url"]);

/**
 * The installed agent-browser's version, or null if the binary can't be run.
 *
 * Doubles as the "is it installed?" probe: a version we can read is proof the
 * binary works, which a bare exit code isn't.
 */
function installedVersion(bin: string): string | null {
  // cross-spawn's sync sets `error` to null on success (node's spawnSync leaves
  // it undefined), so test truthiness rather than comparing against undefined.
  const res = spawn.sync(bin, ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (res.status !== 0 || res.error) return null;
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(res.stdout ?? "");
  return match ? match[0] : "unknown";
}

/**
 * Whether a version is new enough for the playtest skill.
 *
 * A floor, not an exact pin, so a newer agent-browser is left alone: someone
 * running 0.35 installed it for a reason, and downgrading a shared global tool
 * to match this skill would break their other work to fix a risk that may not
 * exist. PKG_SPEC still caps what a *fresh* install pulls in.
 *
 * An unparseable version passes: a binary from brew or cargo may not report a
 * semver at all, and blocking it would be worse than trusting it.
 */
function meetsMinimum(version: string): boolean {
  const parts = /^(\d+)\.(\d+)\./.exec(version);
  if (!parts) return true;
  const major = Number(parts[1]);
  const minor = Number(parts[2]);
  if (major !== MIN_VERSION.major) return major > MIN_VERSION.major;
  return minor >= MIN_VERSION.minor;
}

type Binary = { bin: string; version: string | null };

/** The agent-browser binary to use. VG_AGENT_BROWSER_BIN overrides (dev). */
function resolveBinary(): Binary | null {
  const override = process.env.VG_AGENT_BROWSER_BIN;
  if (override) return existsSync(override) ? { bin: override, version: null } : null;
  const version = installedVersion(PKG);
  return version === null ? null : { bin: PKG, version };
}

/**
 * Install agent-browser globally, then provision its browser. Upstream ships
 * these as two steps (`npm i -g` puts the Rust binary in place; `install`
 * fetches Chrome for Testing and reuses an existing Chrome/Brave/Playwright
 * install when it finds one), so a first run pays for both.
 */
function bootstrap(): Binary {
  consola.start(`Installing the playtest browser (${PKG})…`);
  const install = spawn.sync("npm", ["install", "-g", PKG_SPEC], { stdio: "inherit" });
  if (install.status !== 0 || install.error) {
    consola.error(`Couldn't install ${PKG}. Try manually: npm install -g ${PKG_SPEC}`);
    process.exit(1);
  }

  const resolved = resolveBinary();
  if (!resolved) {
    consola.error(
      `Installed ${PKG_SPEC} but \`${PKG}\` isn't on PATH. Check that npm's global bin directory is in your PATH (\`npm bin -g\`).`,
    );
    process.exit(1);
  }

  consola.start("Provisioning the browser (first run only)…");
  const provision = spawn.sync(resolved.bin, ["install"], { stdio: "inherit" });
  if (provision.status !== 0) {
    consola.error(
      `\`${PKG} install\` failed. On Linux you may need system libraries: ${PKG} install --with-deps`,
    );
    process.exit(1);
  }

  consola.success("Playtest browser ready.");
  return resolved;
}

/**
 * Bring an agent-browser older than the minimum up to it.
 *
 * The floor exists because agent-browser is pre-1.0: the playtest skill teaches
 * a command surface, and the bot script depends on response shapes, both of
 * which a minor bump can move. Installing the spec only on first use would
 * leave an older global install — already on PATH from some earlier project —
 * driving every run, which is how a documented contract silently stops holding.
 */
function ensureMinimum(resolved: Binary): Binary {
  if (resolved.version === null || meetsMinimum(resolved.version)) return resolved;

  // The bot script shells out to `vg playtest` once per step, so an upgrade
  // that can't stick — read-only npm prefix, offline, locked-down CI — would
  // otherwise retry on every one of those calls. One attempt per stale version
  // per machine (the stamp lives in the temp dir, so a reboot retries).
  const stamp = join(tmpdir(), `vg-${PKG}-upgrade-${resolved.version}`);
  if (existsSync(stamp)) return resolved;

  consola.warn(
    `Found ${PKG} ${resolved.version}, but the playtest skill needs at least ${MIN_VERSION.major}.${MIN_VERSION.minor}. Upgrading…`,
  );
  const upgrade = spawn.sync("npm", ["install", "-g", PKG_SPEC], { stdio: "inherit" });
  const upgraded = upgrade.status === 0 && !upgrade.error ? resolveBinary() : null;
  if (!upgraded || (upgraded.version !== null && !meetsMinimum(upgraded.version))) {
    // Continue anyway: an older binary handles most commands fine, and failing
    // outright would strand anyone who can't write to npm's global prefix.
    try {
      writeFileSync(stamp, "");
    } catch {
      // A stamp we can't write only costs a retry next time.
    }
    consola.warn(
      `Couldn't upgrade ${PKG}. Continuing on ${resolved.version} — run \`npm install -g ${PKG_SPEC}\` if commands misbehave.`,
    );
    return resolved;
  }
  return upgraded;
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
  if (!SLUG_RE.test(resolved)) {
    consola.error(`Invalid game slug "${resolved}". Use lowercase letters, digits, and hyphens.`);
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
/**
 * The subcommand in `args`, when one can be identified without knowing
 * agent-browser's flag grammar.
 *
 * A bare token is a flag's value if a flag sits immediately before it, and a
 * subcommand otherwise — `--session p1 snapshot` has `p1` claimed by
 * `--session`, leaving `snapshot` as the first unclaimed token. `--session=p1`
 * carries its own value and claims nothing. That holds for any single-valued
 * flag, known or not, so no mirror of upstream's options can drift here.
 *
 * Deliberately incomplete: agent-browser's boolean flags take an OPTIONAL
 * `true`/`false`, so `--headed snapshot` is genuinely ambiguous without knowing
 * that `--headed` is boolean — and knowing that for ~50 options means mirroring
 * a grammar that moves every release. This catches the shapes people actually
 * type; anything past it reaches agent-browser as before.
 */
export function findSubcommand(args: string[]): string | null {
  for (const [index, arg] of args.entries()) {
    if (arg.startsWith("-")) continue;
    const previous = args[index - 1];
    if (previous !== undefined && previous.startsWith("-") && !previous.includes("=")) continue;
    return arg;
  }
  return null;
}

export function expandGameFlag(args: string[], resolveUrl = resolveGameUrl): string[] {
  if (!args.includes("--game")) return args;

  // Catch `vg playtest snapshot --game x`, where the URL has nowhere to go —
  // agent-browser silently runs the snapshot and ignores the stray URL, so
  // leaving it to upstream costs a wrong answer rather than an error. Skipped
  // when some verb here does take a URL, which is the well-formed case.
  const hasUrlVerb = args.some((a) => URL_TAKING.has(a));
  const subcommand = hasUrlVerb ? null : findSubcommand(args);
  if (subcommand !== null) {
    consola.error(
      `\`--game\` supplies a URL, so it only works with \`${[...URL_TAKING].join("`, `")}\` — not \`${subcommand}\`. Open the game first, then run \`vg playtest ${subcommand} …\` against it.`,
    );
    process.exit(1);
  }

  const out: string[] = [];
  // `entries()` types each element as string, so no assertion is needed to
  // index the array; `consumed` skips a slug already claimed by its flag.
  let consumed = false;
  let opened = false;
  for (const [index, arg] of args.entries()) {
    if (consumed) {
      consumed = false;
      continue;
    }
    if (arg !== "--game") {
      out.push(arg);
      continue;
    }
    const next = args[index + 1];
    const slug = next !== undefined && !next.startsWith("-") ? next : null;
    consumed = slug !== null;
    // Decided from the whole array rather than from what came before the flag,
    // so `--game x open` substitutes in place instead of emitting a second
    // `open`. Once per expansion, so repeating `--game` yields one verb and
    // several URLs — the shape `diff url` wants.
    if (!hasUrlVerb && !opened) {
      out.push("open");
      opened = true;
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
  const resolved = resolveBinary();
  const { bin } = resolved ? ensureMinimum(resolved) : bootstrap();

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
