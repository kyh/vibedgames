import consola from "consola";

export function isJsonOutput(args: { json?: boolean }): boolean {
  return Boolean(args.json) || process.env.VG_JSON_OUTPUT === "1";
}

export function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function writeError(
  args: { json?: boolean },
  payload: { message: string; [key: string]: unknown },
): void {
  if (isJsonOutput(args)) {
    process.stdout.write(JSON.stringify({ error: payload }, null, 2) + "\n");
    return;
  }
  consola.error(payload.message);
  for (const [key, value] of Object.entries(payload)) {
    if (key === "message") continue;
    consola.log(`  ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  }
}
