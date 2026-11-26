import { spawn } from "node:child_process";

/** Run `file` with `args` and resolve its text output; rejects when it cannot start or exits non-zero. */
export const execFileText = async (
  file: string,
  args: readonly string[],
  options: { timeout?: number } = {},
) => {
  const { promise, resolve, reject } = Promise.withResolvers<{ stderr: string; stdout: string }>();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];

  const child = spawn(file, args, {
    stdio: ["pipe", "pipe", "pipe"],
    timeout: options.timeout,
  });

  child.stdout.on("data", (chunk: Buffer) => {
    stdout.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr.push(chunk);
  });
  child.on("error", reject);
  child.on("close", (code, signal) => {
    const text = {
      stderr: Buffer.concat(stderr).toString("utf-8"),
      stdout: Buffer.concat(stdout).toString("utf-8"),
    };

    if (code === 0) {
      resolve(text);
    } else {
      reject(new Error(`${file} ${args.join(" ")} failed (${signal ?? code}): ${text.stderr}`));
    }
  });
  child.stdin.end();

  return await promise;
};
