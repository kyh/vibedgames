import spawn from "cross-spawn";

export type RunResult = { code: number; output: string };

export type RunOptions = {
  /**
   * Mirror the child's output to this process as it arrives. Long steps
   * (`npx skills add` clones a repo per skill) otherwise look hung: the
   * buffered output is only readable once the child has already exited.
   */
  stream?: boolean;
};

/**
 * True when the command never started, as opposed to running and failing.
 * `run` turns a spawn error into an exit code, so the message is the only
 * thing that separates "no such binary" from "the binary said no".
 */
export const isMissingCommand = (result: RunResult): boolean =>
  result.code !== 0 && /ENOENT|not found|not recognized/i.test(result.output);

export const run = (cmd: string, args: string[], options: RunOptions = {}): Promise<RunResult> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const collect = (stream: NodeJS.WriteStream) => (c: Buffer) => {
      chunks.push(c);
      if (options.stream) stream.write(c);
    };
    child.stdout?.on("data", collect(process.stderr));
    child.stderr?.on("data", collect(process.stderr));
    child.on("error", (err) => resolve({ code: 1, output: `${err.message}\n` }));
    child.on("close", (code) =>
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") }),
    );
  });
