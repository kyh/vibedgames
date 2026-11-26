import { readFileSync } from "node:fs";

export interface Args {
  positionals: string[];
  /** Every `--key` seen, in order, so repeatable options keep their sequence. */
  options: Map<string, string[]>;
}

export interface ParseOptions {
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
}

const headerDoc = (entry: string | undefined) => {
  if (entry === undefined || entry === "") {
    return null;
  }

  let source: string;

  try {
    source = readFileSync(entry, "utf-8");
  } catch {
    return null;
  }

  const doc = /^(?:#![^\n]*\n)?\/\*\*(?<doc>[\s\S]*?)\*\//u.exec(source)?.groups?.doc;

  if (doc === undefined) {
    return null;
  }

  const text = doc
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();

  return text.length > 0 ? text : null;
};

/** Exit with a message on stderr and a non-zero status, like `SystemExit`. */
export const fail = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(1);
};

/**
 * Exit 2 for a malformed invocation — an unknown value for a flag with a fixed
 * set of choices. `argparse` reserves that code for usage errors and scripts
 * distinguish it from a run that started and then failed, so the ported
 * scripts keep the same convention.
 */
export const failUsage = (message: string): never => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const declaredOptions = (options: ParseOptions) => {
  const booleans = new Set(options.booleans);
  const known = new Set([...booleans, ...(options.values ?? []), "help"]);
  const strict = options.booleans !== undefined || options.values !== undefined;

  return { booleans, known, strict };
};

const isValueToken = (token: string | undefined): token is string =>
  token !== undefined && !token.startsWith("--");

export const parseArgs = (argv: string[], options: ParseOptions = {}) => {
  const { booleans, known, strict } = declaredOptions(options);
  const unknown: string[] = [];
  const positionals: string[] = [];
  const parsed = new Map<string, string[]>();

  const push = (key: string, value: string) => {
    const existing = parsed.get(key);

    if (existing) {
      existing.push(value);
    } else {
      parsed.set(key, [value]);
    }
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] ?? "";

    if (token === "-h") {
      push("help", "true");
      continue;
    }

    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    const body = token.slice(2);
    const equals = body.indexOf("=");

    if (equals !== -1) {
      const name = body.slice(0, equals);

      if (strict && !known.has(name)) {
        unknown.push(`--${name}`);
      }

      push(name, body.slice(equals + 1));
      continue;
    }

    if (booleans.has(body)) {
      push(body, "true");
      continue;
    }

    if (strict && !known.has(body)) {
      unknown.push(`--${body}`);

      if (isValueToken(argv[i + 1])) {
        i += 1;
      }

      continue;
    }

    const next = argv[i + 1];

    if (isValueToken(next)) {
      push(body, next);
      i += 1;
    } else {
      push(body, "true");
    }
  }

  if (unknown.length > 0) {
    failUsage(`unrecognized arguments: ${unknown.join(" ")}`);
  }

  if (parsed.has("help")) {
    const help = headerDoc(process.argv[1]);
    process.stdout.write(`${help ?? "No help available."}\n`);
    process.exit(0);
  }

  return { options: parsed, positionals };
};

export const getString = (args: Args, key: string) => args.options.get(key)?.at(-1);

export const getAll = (args: Args, key: string) => args.options.get(key) ?? [];

export const getFlag = (args: Args, key: string) => {
  const value = getString(args, key);

  return value !== undefined && value !== "false";
};

export const getNumber = (args: Args, key: string, fallback: number) => {
  const raw = getString(args, key);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isFinite(value)) {
    failUsage(`--${key} must be a number, got "${raw}"`);
  }

  return value;
};

/**
 * A whole number, for the options `argparse` declared `type=int`.
 *
 * `getNumber` accepted `--rows 3.7` and the grid maths quietly truncated it,
 * so a sheet was sliced on a geometry nobody asked for and the run exited 0.
 * Python refused it outright, and so does this.
 */
export const getInt = (args: Args, key: string, fallback: number) => {
  const raw = getString(args, key);

  if (raw === undefined) {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    failUsage(`--${key} must be a whole number, got "${raw}"`);
  }

  return value;
};

/**
 * Run a script body, turning thrown errors into a clean one-line message.
 * A stack trace tells an agent nothing it can act on; the message does.
 */
export const main = (run: () => void) => {
  try {
    run();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
};
