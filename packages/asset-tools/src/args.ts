/**
 * A small `argparse`-shaped argv reader for the skill scripts.
 *
 * The scripts it serves are the direct replacements for the Python ones, so
 * this accepts the spellings those accepted: `--flag`, `--key value`,
 * `--key=value`, repeated options, and positionals. It deliberately does no
 * schema validation — each script checks the handful of options it cares
 * about and reports a message an agent can act on.
 */

import { readFileSync } from "node:fs";

export type Args = {
  positionals: string[];
  /** Every `--key` seen, in order, so repeatable options keep their sequence. */
  options: Map<string, string[]>;
};

export type ParseOptions = {
  /**
   * Options that take no value. A script MUST list every name it later reads
   * with `getFlag`.
   *
   * Without the list there is no way to tell `--pretty file.ase` (a flag then a
   * positional) from `--out file.png` (an option and its value), and guessing
   * silently eats the positional — `argparse` knew because the script declared
   * its arguments, and this is that declaration.
   */
  booleans?: readonly string[];
  /**
   * Options that take a value — every name the script later reads with
   * `getString`, `getNumber` or `getAll`.
   *
   * Together with `booleans` this is the script's whole option surface, and
   * anything outside it is rejected. Without that, a misspelled `--k-colours 4`
   * parsed fine, was never read, and the run silently used the default: the
   * caller believes a setting was applied that never was. `argparse` called
   * that "unrecognized arguments" and exited 2.
   */
  values?: readonly string[];
};

/**
 * The script's own header docblock, which is its help text.
 *
 * `argparse` built `--help` from the declarations; here the authoritative
 * description of a script is the comment at the top of it. Reading that back
 * means help cannot drift from the documentation the way a second copy of the
 * usage string would.
 */
function headerDoc(entry: string | undefined): string | null {
  if (!entry) return null;
  let source: string;
  try {
    source = readFileSync(entry, "utf8");
  } catch {
    return null;
  }
  const match = /^(?:#![^\n]*\n)?\/\*\*([\s\S]*?)\*\//.exec(source);
  if (!match) return null;
  const text = match[1]!
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

export function parseArgs(argv: string[], options: ParseOptions = {}): Args {
  const booleans = new Set(options.booleans ?? []);
  // `help` is free on every script, as `-h`/`--help` were under argparse.
  const known = new Set([...booleans, ...(options.values ?? []), "help"]);
  // A script that declares nothing gets the old permissive parse; every shipped
  // script declares, and a test enforces that.
  const strict = options.booleans !== undefined || options.values !== undefined;
  const unknown: string[] = [];
  const positionals: string[] = [];
  const parsed = new Map<string, string[]>();

  const push = (key: string, value: string) => {
    const existing = parsed.get(key);
    if (existing) existing.push(value);
    else parsed.set(key, [value]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;

    // `-h` is the one short option argparse gave every script for free.
    if (token === "-h") {
      push("help", "true");
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    // A bare `--` ends option parsing, as it does in any POSIX tool.
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      const name = body.slice(0, equals);
      if (strict && !known.has(name)) unknown.push(`--${name}`);
      push(name, body.slice(equals + 1));
      continue;
    }
    if (booleans.has(body)) {
      push(body, "true");
      continue;
    }
    if (strict && !known.has(body)) {
      unknown.push(`--${body}`);
      // Skip what looks like its value too, so one typo reports once rather
      // than turning the following filename into a second complaint.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) i += 1;
      continue;
    }

    const next = argv[i + 1];
    // A declared value option takes the next token, unless that token is
    // itself an option or there is nothing left.
    if (next === undefined || next.startsWith("--")) {
      push(body, "true");
    } else {
      push(body, next);
      i += 1;
    }
  }

  if (unknown.length > 0) failUsage(`unrecognized arguments: ${unknown.join(" ")}`);

  // `-h`/`--help` short-circuits before any required-argument check, the way
  // argparse did, so asking a script what it does never looks like misuse.
  if (parsed.has("help")) {
    const help = headerDoc(process.argv[1]);
    process.stdout.write(`${help ?? "No help available."}\n`);
    process.exit(0);
  }

  return { positionals, options: parsed };
}

export function getString(args: Args, key: string): string | undefined {
  return args.options.get(key)?.at(-1);
}

export function getAll(args: Args, key: string): string[] {
  return args.options.get(key) ?? [];
}

export function getFlag(args: Args, key: string): boolean {
  const value = getString(args, key);
  return value !== undefined && value !== "false";
}

export function getNumber(args: Args, key: string, fallback: number): number {
  const raw = getString(args, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`--${key} must be a number, got "${raw}"`);
  return value;
}

/** Exit with a message on stderr and a non-zero status, like `SystemExit`. */
export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/**
 * Exit 2 for a malformed invocation — an unknown value for a flag with a fixed
 * set of choices. `argparse` reserves that code for usage errors and scripts
 * distinguish it from a run that started and then failed, so the ported
 * scripts keep the same convention.
 */
export function failUsage(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

/**
 * Run a script body, turning thrown errors into a clean one-line message.
 * A stack trace tells an agent nothing it can act on; the message does.
 */
export function main(run: () => void): void {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
