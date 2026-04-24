import { spawn } from "node:child_process";

import consola from "consola";

const REPO = "kyh/vibedgames";

export type InstallSkillsOptions = {
  agent?: string;
  yes?: boolean;
  global?: boolean;
};

export const installSkills = async (opts: InstallSkillsOptions) => {
  const args = ["-y", "skills", "add", REPO];
  if (opts.agent) args.push("-a", opts.agent);
  if (opts.global) args.push("-g");
  if (opts.yes) args.push("-y");

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  consola.start(`Running: ${npx} ${args.join(" ")}`);

  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(npx, args, { stdio: "inherit" });
    child.on("exit", (c) => resolve(c ?? 1));
    child.on("error", reject);
  });

  if (code !== 0) {
    throw new Error(`skills exited with code ${code}`);
  }

  consola.success(`Installed vibedgames skills from ${REPO}`);
};
