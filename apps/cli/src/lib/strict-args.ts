/** The subset of citty's `ArgDef` this check reads. */
interface ArgSpec {
  type?: string;
  alias?: string | string[];
}

const UNRECOGNIZED_EXIT = 2;

const declaredNames = (argsDef: Record<string, ArgSpec>) => {
  const names = new Set<string>();

  for (const [name, spec] of Object.entries(argsDef)) {
    if (spec.type === "positional") {
      continue;
    }

    names.add(name);
    names.add(name.replaceAll(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`));
    const { alias } = spec;

    if (Array.isArray(alias)) {
      for (const a of alias) {
        names.add(a);
      }
    } else if (alias !== undefined) {
      names.add(alias);
    }
  }

  names.add("help");
  names.add("version");

  return names;
};

/**
 * The long flags in `rawArgs` that `argsDef` does not declare, in the order
 * they were typed. Everything after a bare `--` is a passthrough payload and is
 * left alone.
 */
export const unknownFlags = (rawArgs: string[], argsDef: Record<string, ArgSpec>) => {
  const known = declaredNames(argsDef);
  const unknown: string[] = [];

  for (const raw of rawArgs) {
    if (raw === "--") {
      break;
    }

    if (!raw.startsWith("--") || raw.length === 2) {
      continue;
    }

    const flag = (raw.slice(2).split("=")[0] ?? "").trim();

    if (flag.length === 0) {
      continue;
    }

    const negated = flag.startsWith("no-") ? flag.slice(3) : null;

    if (known.has(flag)) {
      continue;
    }

    if (negated !== null && known.has(negated)) {
      continue;
    }

    unknown.push(`--${flag}`);
  }

  return unknown;
};

/** Exit 2 naming every undeclared flag, or return so the command can run. */
export const assertKnownFlags = (rawArgs: string[], argsDef: Record<string, ArgSpec>) => {
  const unknown = unknownFlags(rawArgs, argsDef);

  if (unknown.length === 0) {
    return;
  }

  process.stderr.write(`unrecognized arguments: ${unknown.join(" ")}\n`);
  process.exit(UNRECOGNIZED_EXIT);
};
