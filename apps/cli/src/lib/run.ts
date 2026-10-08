import spawn from "cross-spawn";

export interface RunResult {
  code: number;
  output: string;
}

/**
 * True when the command never started, as opposed to running and failing.
 * `run` turns a spawn error into an exit code, so the message is the only
 * thing that separates "no such binary" from "the binary said no".
 */
export const isMissingCommand = (result: RunResult): boolean =>
  result.code !== 0 && /ENOENT|not found|not recognized/iu.test(result.output);

export const run = (cmd: string, args: string[]): Promise<RunResult> =>
  // oxlint-disable-next-line promise/avoid-new -- child_process.spawn is event-based
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const collect = (c: Buffer) => {
      chunks.push(c);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (err) => resolve({ code: 1, output: `${err.message}\n` }));
    child.on("close", (code) =>
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf-8") }),
    );
  });
