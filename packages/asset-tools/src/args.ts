/**
 * A small `argparse`-shaped argv reader for the skill scripts.
 *
 * The scripts it serves are the direct replacements for the Python ones, so
 * this accepts the spellings those accepted: `--flag`, `--key value`,
 * `--key=value`, repeated options, and positionals. It deliberately does no
 * schema validation — each script checks the handful of options it cares
 * about and reports a message an agent can act on.
 */

export type Args = {
  positionals: string[];
  /** Every `--key` seen, in order, so repeatable options keep their sequence. */
  options: Map<string, string[]>;
};

export function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();

  const push = (key: string, value: string) => {
    const existing = options.get(key);
    if (existing) existing.push(value);
    else options.set(key, [value]);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals !== -1) {
      push(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    // A bare `--flag` is a boolean unless the next token is a value. A value
    // that itself starts with `--` would be ambiguous, so it reads as a flag.
    if (next === undefined || next.startsWith("--")) {
      push(body, "true");
    } else {
      push(body, next);
      i += 1;
    }
  }

  return { positionals, options };
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
