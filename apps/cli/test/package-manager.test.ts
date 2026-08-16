import assert from "node:assert/strict";
import { test } from "node:test";

import {
  detectPackageManager,
  globalInstallArgs,
  globalInstallCommand,
} from "../src/lib/package-manager.js";

/** No inherited env, so each case tests exactly the signal it names. */
const clean: NodeJS.ProcessEnv = {};

test("a global install path names the manager that wrote it", () => {
  const cases: [string, string][] = [
    ["/Users/kim/.bun/install/global/node_modules/vibedgames/dist/index.js", "bun"],
    ["/home/kim/.local/share/pnpm/global/5/node_modules/vibedgames/dist/index.js", "pnpm"],
    ["/Users/kim/Library/pnpm/global/5/node_modules/vibedgames/dist/index.js", "pnpm"],
    ["/home/kim/.pnpm-global/5/node_modules/vibedgames/dist/index.js", "pnpm"],
    ["/home/kim/.yarn/bin/node_modules/vibedgames/dist/index.js", "yarn"],
    ["/usr/local/share/.config/yarn/global/node_modules/vibedgames/dist/index.js", "yarn"],
    ["/usr/local/lib/node_modules/vibedgames/dist/index.js", "npm"],
    ["/opt/homebrew/lib/node_modules/vibedgames/dist/index.js", "npm"],
    ["C:\\Users\\kim\\AppData\\Roaming\\npm\\node_modules\\vibedgames\\dist\\index.js", "npm"],
    ["C:\\Users\\kim\\.bun\\install\\global\\node_modules\\vibedgames\\dist\\index.js", "bun"],
  ];
  for (const [path, expected] of cases) {
    assert.equal(detectPackageManager(path, clean), expected, path);
  }
});

test("a project-local .pnpm directory is not a global pnpm install", () => {
  // Running from a repo checkout — pnpm's virtual store, not its global root.
  assert.equal(
    detectPackageManager(
      "/srv/app/node_modules/.pnpm/vibedgames@0.3.1/node_modules/vibedgames/dist/index.js",
      clean,
    ),
    "npm",
  );
});

test("the invoking manager is the fallback when the path says nothing", () => {
  const path = "/somewhere/unrecognised/vibedgames/dist/index.js";
  assert.equal(
    detectPackageManager(path, { npm_config_user_agent: "pnpm/9.1.0 npm/? node/v22" }),
    "pnpm",
  );
  assert.equal(
    detectPackageManager(path, { npm_config_user_agent: "yarn/4.2.2 npm/? node/v22" }),
    "yarn",
  );
  assert.equal(detectPackageManager(path, { npm_config_user_agent: "bun/1.1.0" }), "bun");
  // An unfamiliar agent is not a guess to act on.
  assert.equal(detectPackageManager(path, { npm_config_user_agent: "deno/2.0" }), "npm");
});

test("npm is the last resort", () => {
  assert.equal(detectPackageManager("/somewhere/unrecognised/vibedgames", clean), "npm");
});

test("the path wins over the invoking manager", () => {
  // `pnpm dlx vg update` on an npm-installed CLI must still use npm: the
  // install location is what determines where an upgrade lands.
  assert.equal(
    detectPackageManager("/usr/local/lib/node_modules/vibedgames/dist/index.js", {
      npm_config_user_agent: "pnpm/9.1.0",
    }),
    "npm",
  );
});

test("each manager gets its own global install invocation", () => {
  assert.deepEqual(globalInstallArgs("npm"), ["install", "-g", "vibedgames"]);
  assert.deepEqual(globalInstallArgs("pnpm"), ["add", "-g", "vibedgames"]);
  assert.deepEqual(globalInstallArgs("yarn"), ["global", "add", "vibedgames"]);
  assert.deepEqual(globalInstallArgs("bun"), ["add", "-g", "vibedgames"]);
});

test("the copy-paste command matches what would be run", () => {
  assert.equal(globalInstallCommand("npm"), "npm install -g vibedgames");
  assert.equal(globalInstallCommand("pnpm"), "pnpm add -g vibedgames");
  assert.equal(globalInstallCommand("yarn"), "yarn global add vibedgames");
  assert.equal(globalInstallCommand("bun"), "bun add -g vibedgames");
  assert.equal(globalInstallCommand("pnpm", "other-pkg"), "pnpm add -g other-pkg");
});
