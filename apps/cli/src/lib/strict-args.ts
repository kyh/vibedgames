/**
 * Reject flags a command does not declare.
 *
 * citty hard-codes `strict: false` on node's `parseArgs`, so an unknown flag is
 * parsed and then dropped: `vg deploy ./dist --slugg wrong` deploys to the
 * *default* slug and exits 0. A human notices the wrong URL in the output; an
 * agent reads exit 0 and carries on. The skill scripts already fail this way
 * (`unrecognized arguments: …`, exit 2), so this matches them.
 *
 * Only for commands whose flags are a closed set. `vg generate run` forwards
 * arbitrary `--param value` pairs to a model's schema and must stay permissive,
 * and `vg playtest`/`vg factory` are passthroughs to another binary's grammar.
 */

/** The subset of citty's `ArgDef` this check reads. */
type ArgSpec = { type?: string; alias?: string | string[] };

const UNRECOGNIZED_EXIT = 2;

function declaredNames(argsDef: Record<string, ArgSpec>): Set<string> {
  const names = new Set<string>();
  for (const [name, spec] of Object.entries(argsDef)) {
    if (spec.type === "positional") continue;
    names.add(name);
    // citty accepts a camelCase arg under its kebab spelling too.
    names.add(name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`));
    const alias = spec.alias;
    if (typeof alias === "string") names.add(alias);
    else if (Array.isArray(alias)) for (const a of alias) names.add(a);
  }
  // citty answers these itself; they never reach a command's `args`.
  names.add("help");
  names.add("version");
  return names;
}

/**
 * The long flags in `rawArgs` that `argsDef` does not declare, in the order
 * they were typed. Everything after a bare `--` is a passthrough payload and is
 * left alone.
 */
export function unknownFlags(rawArgs: string[], argsDef: Record<string, ArgSpec>): string[] {
  const known = declaredNames(argsDef);
  const unknown: string[] = [];

  for (const raw of rawArgs) {
    if (raw === "--") break;
    if (!raw.startsWith("--") || raw.length === 2) continue;
    const flag = (raw.slice(2).split("=")[0] ?? "").trim();
    if (flag.length === 0) continue;
    // `--no-foo` is citty's negation of the boolean `foo`.
    const negated = flag.startsWith("no-") ? flag.slice(3) : null;
    if (known.has(flag)) continue;
    if (negated !== null && known.has(negated)) continue;
    unknown.push(`--${flag}`);
  }

  return unknown;
}

/** Exit 2 naming every undeclared flag, or return so the command can run. */
export function assertKnownFlags(rawArgs: string[], argsDef: Record<string, ArgSpec>): void {
  const unknown = unknownFlags(rawArgs, argsDef);
  if (unknown.length === 0) return;
  process.stderr.write(`unrecognized arguments: ${unknown.join(" ")}\n`);
  process.exit(UNRECOGNIZED_EXIT);
}
