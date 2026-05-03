export function collectRepeatedStringFlag(
  value: string | string[] | undefined,
  rawArgs: string[],
  flag: string,
): string[] {
  const rawValues = collectRawFlagValues(rawArgs, flag);
  if (rawValues.length > 0) return rawValues;
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function collectRawFlagValues(rawArgs: string[], flag: string): string[] {
  const values: string[] = [];
  const inlinePrefix = `${flag}=`;
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === undefined || arg === "--") break;
    if (arg.startsWith(inlinePrefix)) {
      values.push(arg.slice(inlinePrefix.length));
      continue;
    }
    if (arg !== flag) continue;
    const next = rawArgs[index + 1];
    // Treat any leading-dash token as the next flag, not as a value, so
    // `--image -n 2` doesn't silently consume `-n` as the image path.
    // Lone `-` (a stdin marker in many CLIs) is left as a literal value.
    if (
      next === undefined ||
      next === "--" ||
      (next.length > 1 && next.startsWith("-"))
    ) {
      continue;
    }
    values.push(next);
    index++;
  }
  return values;
}
