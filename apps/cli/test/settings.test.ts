import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  removeSetting,
  resolveSetting,
  saveSetting,
  settingsPath,
  validate,
} from "../src/lib/settings.js";
import { makeCleanups, makeTmpDir, stubEnv } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const isolate = (): void =>
  stubEnv(cleanups, {
    VG_CODEX_BIN: undefined,
    VG_GENERATE_PROVIDER: undefined,
    VG_NO_AUTO_UPDATE: undefined,
    XDG_CONFIG_HOME: makeTmpDir(cleanups),
  });

test("a setting resolves from its env var, else the saved value, else the default", () => {
  isolate();
  assert.deepEqual(resolveSetting("generate.provider"), {
    key: "generate.provider",
    source: "default",
    value: "vibedgames",
  });

  saveSetting("generate.provider", "codex");
  assert.deepEqual(resolveSetting("generate.provider"), {
    key: "generate.provider",
    source: "config",
    value: "codex",
  });
  assert.equal(path.dirname(settingsPath()), path.join(process.env.XDG_CONFIG_HOME ?? "", "vg"));

  stubEnv(cleanups, { VG_GENERATE_PROVIDER: "Vibedgames" });
  assert.deepEqual(resolveSetting("generate.provider"), {
    key: "generate.provider",
    source: "env",
    value: "vibedgames",
  });
});

test("update.auto is off whenever VG_NO_AUTO_UPDATE is set", () => {
  isolate();
  assert.equal(resolveSetting("update.auto").value, "true");
  saveSetting("update.auto", "false");
  assert.equal(resolveSetting("update.auto").value, "false");
  removeSetting("update.auto");
  stubEnv(cleanups, { VG_NO_AUTO_UPDATE: "1" });
  assert.deepEqual(resolveSetting("update.auto"), {
    key: "update.auto",
    source: "env",
    value: "false",
  });
});

test("removeSetting drops only that key and reports whether it was saved", () => {
  isolate();
  saveSetting("generate.provider", "codex");
  saveSetting("generate.codex-bin", "/opt/codex");
  assert.equal(removeSetting("generate.provider"), true);
  assert.equal(removeSetting("generate.provider"), false);
  assert.equal(resolveSetting("generate.provider").source, "default");
  assert.equal(resolveSetting("generate.codex-bin").value, "/opt/codex");
});

test("validate holds enum settings to their values; bad saved values read as the default", () => {
  isolate();
  assert.equal(validate("generate.provider", "codex"), null);
  assert.match(validate("generate.provider", "coddex") ?? "", /one of: vibedgames, codex/u);
  assert.match(validate("update.auto", "yes") ?? "", /one of: true, false/u);
  assert.match(validate("generate.codex-bin", " ") ?? "", /can't be empty/u);

  // A hand-edited file with a bad value, an unknown key, or broken JSON never breaks a run.
  mkdirSync(path.dirname(settingsPath()), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ "generate.provider": "coddex", other: 1 }));
  assert.equal(resolveSetting("generate.provider").source, "default");
  saveSetting("update.auto", "false");
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf-8")), {
    "generate.provider": "coddex",
    other: 1,
    "update.auto": "false",
  });
  writeFileSync(settingsPath(), "{ not json");
  assert.equal(resolveSetting("update.auto").source, "default");
});
