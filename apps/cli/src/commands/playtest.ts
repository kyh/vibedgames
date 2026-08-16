import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import spawn from "cross-spawn";

import { getBaseUrl, getConfigDir } from "../lib/config.js";
import { isNewerVersion } from "../lib/update.js";
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
const MIN_VERSION = "0.34.0";
const PKG_SPEC = `${PKG}@^${MIN_VERSION}`;

/** Stands in for a version string we could not read. Always meets the floor. */
const UNKNOWN_VERSION = "unknown";

/** How long a failed upgrade suppresses the next attempt. */
const UPGRADE_RETRY_MS = 24 * 60 * 60_000;

/**
 * Subcommands that take a URL. Used to decide whether a bare `--game` still
 * needs an `open` in front of it, and — over `bareTokens` — to tell a misplaced
 * `--game` from a well-formed one. An unknown verb still degrades to
 * agent-browser's own error rather than to a wrong guess here.
 */
const URL_TAKING = new Set(["open", "goto", "navigate", "url"]);

/**
 * Verbs this module recognizes, used only to tell a subcommand from a flag's
 * value. `diff` is here because `diff url` is how two URLs are compared.
 */
const KNOWN_VERBS = new Set([...URL_TAKING, "diff"]);

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
  return match ? match[0] : UNKNOWN_VERSION;
}

/**
 * Whether a version is new enough for the playtest skill.
 *
 * A floor, not an exact pin, so a newer agent-browser is left alone: someone
 * running 0.35 installed it for a reason, and downgrading a shared global tool
 * to match this skill would break their other work to fix a risk that may not
 * exist. PKG_SPEC still caps what a *fresh* install pulls in.
 *
 * An unparseable version passes — `isNewerVersion` returns false for anything
 * that isn't `x.y.z` — because a binary from brew or cargo may not report a
 * semver at all, and blocking it would be worse than trusting it.
 */
function meetsMinimum(version: string): boolean {
  return !isNewerVersion(MIN_VERSION, version);
}

type Binary = { bin: string; version: string };

/** The agent-browser binary to use. VG_AGENT_BROWSER_BIN overrides (dev). */
function resolveBinary(): Binary | null {
  const override = process.env.VG_AGENT_BROWSER_BIN;
  // A dev-pointed binary is taken on trust — it is typically a local build with
  // no npm version to read, and `meetsMinimum` waves an unparseable one through.
  if (override) return existsSync(override) ? { bin: override, version: UNKNOWN_VERSION } : null;
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
  const resolved = installGlobal();
  if (!resolved) {
    consola.error(
      `Couldn't install ${PKG}, or it isn't on PATH afterwards. Try manually: npm install -g ${PKG_SPEC} — and check that npm's global bin directory is in your PATH (\`npm bin -g\`).`,
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
  if (meetsMinimum(resolved.version)) return resolved;

  // The bot script runs `vg playtest` once per step, so an upgrade that cannot
  // stick — read-only npm prefix, offline, locked-down CI — would otherwise
  // retry its npm round-trip on every one of them. Recorded per user rather
  // than in a shared /tmp, where one account's stamp would silently suppress
  // everyone else's upgrade.
  const stamp = join(getConfigDir(), `${PKG}-upgrade-failed-${resolved.version}`);
  if (recentlyFailed(stamp)) return resolved;

  consola.warn(
    `Found ${PKG} ${resolved.version}, but the playtest skill needs at least ${MIN_VERSION}. Upgrading…`,
  );
  const upgraded = installGlobal();
  if (!upgraded || !meetsMinimum(upgraded.version)) {
    // Continue anyway: an older binary handles most commands fine, and failing
    // outright would strand anyone who can't write to npm's global prefix.
    try {
      mkdirSync(getConfigDir(), { recursive: true, mode: 0o700 });
      writeFileSync(stamp, "");
    } catch {
      // A stamp we cannot write only costs a retry next time.
    }
    consola.warn(
      `Couldn't upgrade ${PKG}. Continuing on ${resolved.version} — run \`npm install -g ${PKG_SPEC}\` if commands misbehave.`,
    );
    return resolved;
  }
  return upgraded;
}

/**
 * Whether an upgrade was already tried recently. Time-boxed rather than
 * permanent: the usual reason one fails is being offline, and a machine that is
 * online tomorrow should get the upgrade rather than stay pinned by a stamp it
 * wrote once.
 */
function recentlyFailed(stamp: string): boolean {
  try {
    return Date.now() - statSync(stamp).mtimeMs < UPGRADE_RETRY_MS;
  } catch {
    return false;
  }
}

/** `npm install -g` the pinned spec, then re-resolve. Null if either step fails. */
function installGlobal(): Binary | null {
  // Bounded so a wedged registry or install script can't hang `vg playtest`
  // forever; generous enough not to cut off a slow but working download.
  const res = spawn.sync("npm", ["install", "-g", PKG_SPEC], {
    stdio: "inherit",
    timeout: 10 * 60_000,
  });
  return res.status === 0 && !res.error ? resolveBinary() : null;
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
 * The tokens in `args` that aren't flags or flag values — agent-browser's verb
 * and its positional arguments, in order.
 *
 * A bare token is a flag's value if a flag sits immediately before it, and a
 * verb otherwise — `--session p1 snapshot` has `p1` claimed by `--session`,
 * leaving `snapshot`. `--session=p1` carries its own value and claims nothing.
 * That holds for any single-valued flag, known or not, so no mirror of
 * upstream's options can drift here.
 *
 * Deliberately incomplete: agent-browser's boolean flags take an OPTIONAL
 * `true`/`false`, so `--headed snapshot` is genuinely ambiguous without knowing
 * that `--headed` is boolean — and knowing that for ~50 options means mirroring
 * a grammar that moves every release. This catches the shapes people actually
 * type; anything past it reaches agent-browser as before.
 */
export function bareTokens(args: string[]): string[] {
  return args.filter((arg, index) => {
    if (arg.startsWith("-")) return false;
    // A token that IS a known verb is one, whatever precedes it. "Preceded by a
    // flag" can't tell a boolean flag from a valued one, so `--headed open`
    // would otherwise read `open` as `--headed`'s value, see no verb at all,
    // and insert a second one — agent-browser then navigates to the literal
    // string "open" and lands on chrome-error://.
    //
    // The cost is a session or profile named exactly after a verb
    // (`--session open`), which is now read as the verb. That is the rarer
    // input by a wide margin, and it fails loudly instead of silently going
    // somewhere wrong.
    if (KNOWN_VERBS.has(arg)) return true;
    const previous = args[index - 1];
    return !(previous !== undefined && previous.startsWith("-") && !previous.includes("="));
  });
}

export function expandGameFlag(args: string[], resolveUrl = resolveGameUrl): string[] {
  if (!args.includes("--game")) return args;

  // Catch `vg playtest snapshot --game x`, where the URL has nowhere to go —
  // agent-browser silently runs the snapshot and ignores the stray URL, so
  // leaving it to upstream costs a wrong answer rather than an error. Skipped
  // when some verb here does take a URL, which is the well-formed case.
  // Both questions — "is a URL-taking verb already here?" and "is some OTHER
  // verb here?" — are read off the same list. Scanning the raw args for the
  // first would also match a flag's value, so `--profile open --game x` would
  // count the profile name as the verb and hand agent-browser a URL with no
  // subcommand at all.
  // Only the VERB decides whether a URL is wanted — `diff` reads its own on the
  // next token. Asking whether ANY bare token is URL-taking lets a positional
  // argument answer for the command: `click open --game x` would pass the guard
  // on the selector named `open` and click the current page.
  const bare = bareTokens(args);
  const verb = bare[0];
  const hasUrlVerb =
    verb !== undefined &&
    (URL_TAKING.has(verb) || (verb === "diff" && bare[1] !== undefined && URL_TAKING.has(bare[1])));

  // A verb that only appears AFTER the flag can't receive the URL: substituting
  // in place would emit `<url> open`, whose first positional agent-browser
  // reads as the subcommand. Say so rather than hand over a dead command.
  const verbLeads = bareTokens(args.slice(0, args.indexOf("--game"))).some((token) =>
    URL_TAKING.has(token),
  );
  if (hasUrlVerb && !verbLeads) {
    consola.error(
      "`--game` supplies the URL to a verb, so it has to come after one: `vg playtest open --game my-game`.",
    );
    process.exit(1);
  }

  const subcommand = hasUrlVerb ? null : (verb ?? null);
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
