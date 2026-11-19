import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Where a project's playable build is.
 *
 * - `build`: a build-tool project (package.json) whose output exists.
 * - `unbuilt`: a build-tool project with no output yet — its root index.html
 *   is the source template and references files a browser cannot load.
 * - `plain`: no package.json, so the directory is the game as written.
 */
export type BuildDir =
  | { kind: "build"; dir: string; name: string }
  | { kind: "unbuilt"; dir: string }
  | { kind: "plain"; dir: string };

const BUILD_OUTPUTS = ["dist", "build", "out"];

export const resolveBuildDir: (dir: string) => BuildDir = (dir) => {
  if (!existsSync(path.join(dir, "package.json"))) {
    return { dir, kind: "plain" };
  }

  for (const name of BUILD_OUTPUTS) {
    if (existsSync(path.join(dir, name, "index.html"))) {
      return { dir: path.join(dir, name), kind: "build", name };
    }
  }

  return { dir, kind: "unbuilt" };
};
