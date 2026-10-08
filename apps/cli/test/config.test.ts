import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { isJsonObject } from "../src/lib/types.js";
import { makeCleanups, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Run `vg config …` against its own config dir, the way an agent would. */
const vg = (configHome: string, ...args: string[]) => {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    VG_NO_AUTO_UPDATE: "1",
    XDG_CONFIG_HOME: configHome,
  };
  delete env.VG_GENERATE_PROVIDER;
  delete env.VG_CODEX_BIN;
  const res = spawnSync(process.execPath, ["--import", "tsx", CLI, "config", ...args], {
    cwd: path.dirname(path.dirname(CLI)),
    encoding: "utf-8",
    env,
  });
  return { code: res.status, stderr: res.stderr, stdout: res.stdout };
};

const json = (stdout: string) => {
  const data: unknown = JSON.parse(stdout);
  assert.ok(isJsonObject(data));
  return data;
};

test("vg config set/get/unset round-trips a setting with deterministic exits", () => {
  const home = makeTmpDir(cleanups, "vg-config-");

  const before = vg(home, "get", "generate.provider", "--json");
  assert.equal(before.code, 0);
  assert.deepEqual(json(before.stdout), {
    key: "generate.provider",
    source: "default",
    value: "vibedgames",
  });

  const set = vg(home, "set", "generate.provider", "codex", "--json");
  assert.equal(set.code, 0);
  assert.equal(json(set.stdout).effective, "codex");

  const bare = vg(home, "get", "generate.provider");
  assert.equal(bare.stdout, "codex\n");

  const list = vg(home, "--json");
  assert.equal(list.code, 0);
  const listed = json(list.stdout);
  assert.ok(Array.isArray(listed.settings));
  assert.equal(
    listed.settings.some(
      (s) => isJsonObject(s) && s.key === "generate.provider" && s.value === "codex",
    ),
    true,
  );

  const unset = vg(home, "unset", "generate.provider", "--field", "value");
  assert.equal(unset.code, 0);
  assert.equal(unset.stdout, "vibedgames\n");
});

test("vg config rejects unknown keys and bad values with exit 1", () => {
  const home = makeTmpDir(cleanups, "vg-config-");
  const unknown = vg(home, "set", "generate.providr", "codex");
  assert.equal(unknown.code, 1);
  assert.match(unknown.stderr, /Unknown setting: generate\.providr/u);

  const bad = vg(home, "set", "generate.provider", "coddex");
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /must be one of: vibedgames, codex/u);
  assert.equal(vg(home, "get", "generate.provider").stdout, "vibedgames\n");

  const flag = vg(home, "get", "generate.provider", "--jsn");
  assert.equal(flag.code, 2);
});
