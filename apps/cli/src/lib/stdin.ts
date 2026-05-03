/**
 * Read piped stdin if it isn't a TTY. Returns an empty string when nothing
 * is piped, so callers can fall through to other prompt sources.
 */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}
