import { spawn } from "node:child_process";

const MAX_CAPTURE = 8 * 1024 * 1024;

/** A command a recipe ran that exited non-zero, with the tail of what it printed. */
export class RecipeCommandError extends Error {
  readonly code: number | null;
  readonly stderr: string;

  constructor(command: string, code: number | null, stderr: string) {
    const tail = stderr.trim().split("\n").slice(-12).join("\n");
    super(`${command} exited with ${code ?? "a signal"}:\n${tail}`);
    this.name = "RecipeCommandError";
    this.code = code;
    this.stderr = stderr;
  }
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  allowFailure?: boolean;
}

export interface ExecResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

const append = (chunks: string[], size: { n: number }, chunk: Buffer) => {
  if (size.n >= MAX_CAPTURE) {
    return;
  }

  const text = chunk.toString("utf-8");
  chunks.push(text);
  size.n += text.length;
};

/** Runs a program with an argument list, never a shell, and collects its output. */
export const exec = (program: string, args: readonly string[], options: ExecOptions = {}) =>
  // oxlint-disable-next-line promise/avoid-new -- child_process exposes events, not a promise
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      signal: options.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const out: string[] = [];
    const err: string[] = [];
    const outSize = { n: 0 };
    const errSize = { n: 0 };

    child.stdout.on("data", (chunk: Buffer) => {
      append(out, outSize, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(err, errSize, chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { code, stderr: err.join(""), stdout: out.join("") };

      if (code !== 0 && !options.allowFailure) {
        reject(new RecipeCommandError(program, code, result.stderr || result.stdout));

        return;
      }

      resolve(result);
    });
  });
