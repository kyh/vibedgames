import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";
import spawn from "cross-spawn";

import { getBaseUrl, getConfigDir } from "../lib/config.js";
import { isNewerVersion } from "../lib/update.js";
import { SLUG_RE, findProjectRoot, readProjectConfig } from "../lib/config-file.js";

const PKG = "agent-browser";
const MIN_VERSION = "0.34.0";
const PKG_SPEC = `${PKG}@^${MIN_VERSION}`;

const UNKNOWN_VERSION = "unknown";

const UPGRADE_RETRY_MS = 24 * 60 * 60_000;

const URL_TAKING = new Set(["open", "goto", "navigate", "url"]);

const KNOWN_VERBS = new Set([...URL_TAKING, "diff"]);

const installedVersion = (bin: string) => {
  const res = spawn.sync(bin, ["--version"], { encoding: "utf-8", timeout: 30_000 });

  if (res.status !== 0 || res.error) {
    return null;
  }

  const match = /\d+\.\d+\.\d+/u.exec(res.stdout ?? "");

  return match ? match[0] : UNKNOWN_VERSION;
};

const meetsMinimum = (version: string) => !isNewerVersion(MIN_VERSION, version);

export interface Binary {
  bin: string;
  version: string;
}

/** The agent-browser binary to use. VG_AGENT_BROWSER_BIN overrides (dev). */
export const resolveBinary = () => {
  const override = process.env.VG_AGENT_BROWSER_BIN;

  if (override) {
    return existsSync(override) ? { bin: override, version: UNKNOWN_VERSION } : null;
  }

  const version = installedVersion(PKG);

  return version === null ? null : { bin: PKG, version };
};

const installGlobal = () => {
  const res = spawn.sync("npm", ["install", "-g", PKG_SPEC], {
    stdio: "inherit",
    timeout: 10 * 60_000,
  });

  return res.status === 0 && !res.error ? resolveBinary() : null;
};

/**
 * Install agent-browser globally, then provision its browser. Upstream ships
 * these as two steps (`npm i -g` puts the Rust binary in place; `install`
 * fetches Chrome for Testing and reuses an existing Chrome/Brave/Playwright
 * install when it finds one), so a first run pays for both.
 */
export const bootstrap = () => {
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
};

const recentlyFailed = (stamp: string) => {
  try {
    return Date.now() - statSync(stamp).mtimeMs < UPGRADE_RETRY_MS;
  } catch {
    return false;
  }
};

const touchStamp = (stamp: string) => {
  try {
    mkdirSync(getConfigDir(), { mode: 0o700, recursive: true });
    writeFileSync(stamp, "");

    return true;
  } catch {
    return false;
  }
};

/**
 * Bring an agent-browser older than the minimum up to it.
 *
 * The floor exists because agent-browser is pre-1.0: the playtest skill teaches
 * a command surface, and the bot script depends on response shapes, both of
 * which a minor bump can move. Installing the spec only on first use would
 * leave an older global install — already on PATH from some earlier project —
 * driving every run, which is how a documented contract silently stops holding.
 */

export const ensureMinimum = (resolved: Binary) => {
  if (meetsMinimum(resolved.version)) {
    return resolved;
  }

  const stamp = path.join(getConfigDir(), `${PKG}-upgrade-failed-${resolved.version}`);

  if (recentlyFailed(stamp)) {
    return resolved;
  }

  consola.warn(
    `Found ${PKG} ${resolved.version}, but the playtest skill needs at least ${MIN_VERSION}. Upgrading…`,
  );
  const upgraded = installGlobal();

  if (!upgraded || !meetsMinimum(upgraded.version)) {
    touchStamp(stamp);
    consola.warn(
      `Couldn't upgrade ${PKG}. Continuing on ${resolved.version} — run \`npm install -g ${PKG_SPEC}\` if commands misbehave.`,
    );

    return resolved;
  }

  return upgraded;
};

const projectSlug = () => {
  let config: { slug: string } | null = null;

  try {
    config = readProjectConfig(process.cwd());
  } catch (error) {
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (!config) {
    consola.error(
      "`--game` with no slug reads vibedgames.json, and none was found here. Pass a slug (`vg playtest --game my-game`) or run from a deployed project.",
    );
    process.exit(1);
  }

  return config.slug;
};

/**
 * The URL a game is served at: a per-slug subdomain of whatever host this CLI
 * is pointed at, so `VG_API_URL=…staging vg playtest --game x` playtests
 * staging rather than silently hitting production the way a hardcoded apex
 * would. Mirrors the derivation the deploy router does server-side.
 */
export const resolveGameUrl = (slug: string | null) => {
  const resolved = slug ?? projectSlug();

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
};

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
export const bareTokens = (args: string[]) =>
  args.filter((arg, index) => {
    if (arg.startsWith("-")) {
      return false;
    }

    const previous = args[index - 1];

    if (KNOWN_VERBS.has(arg) && previous !== "--game") {
      return true;
    }

    return !(previous !== undefined && previous.startsWith("-") && !previous.includes("="));
  });

export const expandGameFlag = (args: string[], resolveUrl = resolveGameUrl) => {
  if (!args.includes("--game")) {
    return args;
  }

  const bare = bareTokens(args);
  const [verb] = bare;

  const hasUrlVerb =
    verb !== undefined &&
    (URL_TAKING.has(verb) || (verb === "diff" && bare[1] !== undefined && URL_TAKING.has(bare[1])));

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

    if (!hasUrlVerb && !opened) {
      out.push("open");
      opened = true;
    }

    out.push(resolveUrl(slug));
  }

  return out;
};

/**
 * agent-browser's session defaults to the literal name `default`, which is
 * shared by every caller on the machine. Two `vg playtest` runs — two projects
 * in two terminals, or two agents on one box — then drive the SAME browser tab:
 * one navigates away mid-run and the other screenshots its page. Scope the
 * session to the project so concurrent playtests can't collide.
 *
 * Left alone when the caller already chose a session, or set one in the
 * environment, or is asking about sessions themselves (`session list` must see
 * every session, not just this project's).
 */
export const withScopedSession = (args: string[], sessionId: () => string) => {
  if (args.includes("--session") || args.some((a) => a.startsWith("--session="))) {
    return args;
  }

  if (process.env.AGENT_BROWSER_SESSION) {
    return args;
  }

  const [verb] = bareTokens(args);

  if (verb === undefined || verb === "session" || verb === "install") {
    return args;
  }

  return ["--session", sessionId(), ...args];
};

/**
 * A stable per-project session name. Keyed on the project root when there is
 * one so every command run from anywhere inside the project shares a browser,
 * and on the cwd otherwise. Hashed because the name lands in a socket path.
 */
export const projectSessionId = () => {
  const root = findProjectRoot(process.cwd()) ?? process.cwd();
  const digest = createHash("sha256").update(root).digest("hex").slice(0, 12);

  return `vg-${digest}`;
};

/**
 * The agent-browser to drive: installed on first use, upgraded to the floor
 * when older. Bootstrap covers `install` too: on a fresh machine that's the
 * most natural first command, and re-running the provision step it just did
 * is harmless.
 */
export const ensureAgentBrowser = () => {
  const resolved = resolveBinary();

  return resolved ? ensureMinimum(resolved) : bootstrap();
};

/** Resolve (installing on first use) and exec agent-browser. Never returns. */
export const runPlaytest = (rawArgs: string[]): never => {
  const args = withScopedSession(expandGameFlag(rawArgs), projectSessionId);
  const { bin } = ensureAgentBrowser();

  const result = spawn.sync(bin, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
};

export const playtestCommand = defineCommand({
  meta: {
    description:
      "Drive a real browser to play a game — snapshot, click, hold keys, read state, screenshot, diff (installs the browser on first use). All arguments pass through: `vg playtest open <url>`, `vg playtest --game <slug>` to open a deployed game, `vg playtest --help` for the full command surface. `vg playtest run` is the exception: a model plays the game and reports (`vg playtest run --help`).",
    name: "playtest",
  },
  run: ({ rawArgs }) => {
    runPlaytest(rawArgs);
  },
});
