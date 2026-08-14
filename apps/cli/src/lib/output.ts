/**
 * Shared stdout helpers for machine-readable output.
 *
 * The skills are written for an agent, so nearly every command grew a
 * `--json` flag and the docs then piped it through `jq` to pull out a single
 * value. That made `jq` a hard prerequisite for following the generate
 * skill at all. `--field` removes it: the CLI does the selection itself and
 * prints a bare scalar that a shell can capture directly.
 */

export type OutputArgs = { json?: boolean; field?: string };

export function isJsonOutput(args: OutputArgs): boolean {
  return Boolean(args.json) || process.env.VG_JSON_OUTPUT === "1";
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Resolve a dotted path against a decoded JSON value. Supports array indexing
 * in both `items[0]` and `items.0` spellings, since agents write both.
 * Returns `undefined` for any path that doesn't resolve.
 */
export function selectField(value: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);

  let current = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      // Negative indices count from the end, which is handy for "the last
      // frame" style selections.
      current = current.at(index);
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Render one selected value for shell capture. Scalars print bare so
 * `$(vg ... --field url)` needs no unquoting; arrays of scalars print one per
 * line so they can be looped over; anything structural falls back to JSON.
 */
export function formatField(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v))) {
      return value.map((v) => (v === null ? "" : String(v))).join("\n");
    }
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

/**
 * The standard exit path for a command that produced structured data.
 * `--field` wins over `--json` when both are passed, since asking for one
 * value is the more specific request. Returns false when neither flag was
 * given, so the caller can fall through to its human-readable rendering.
 */
export function writeStructured(value: unknown, args: OutputArgs): boolean {
  if (args.field) {
    const selected = selectField(value, args.field);
    if (selected === undefined) {
      // Silence here would look like an empty result rather than a typo, and
      // an agent would happily carry the empty string forward.
      process.stderr.write(`No such field: ${args.field}\n`);
      process.exit(1);
    }
    process.stdout.write(`${formatField(selected)}\n`);
    return true;
  }
  if (isJsonOutput(args)) {
    writeJson(value);
    return true;
  }
  return false;
}

/** The `--json`/`--field` arg pair, for spreading into a citty `args` block. */
export const outputArgs = {
  json: { type: "boolean", description: "Print structured JSON to stdout." },
  field: {
    type: "string",
    description:
      "Print a single value from the JSON result, e.g. --field request_id or --field images[0].url. Prints scalars bare for shell capture.",
  },
} as const;
