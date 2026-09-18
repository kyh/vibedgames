import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { makeCleanups, makeTmpDir } from "./_helpers.js";
import type { JsonValue } from "../src/lib/types.js";

/**
 * `scripts/pilot-playtest.mjs` ships with the playtest skill; like the bot
 * script, its input contract is covered here rather than nowhere. These drive
 * the real script as a subprocess.
 *
 * Every assertion is about argument validation, which happens before the
 * script shells out to anything or calls the decision model. PATH is emptied
 * so `vg` can't be found even on a dogfooded machine, and TYPESAFE_API_KEY is
 * set to a dummy so the key check doesn't mask the flag under test — a run
 * that survives validation then fails on the missing CLI, never on a real
 * browser or a real API call.
 */
const PILOT = fileURLToPath(
  new URL("../../../plugins/tooling/skills/playtest/scripts/pilot-playtest.mjs", import.meta.url),
);

/** Exit code the script uses for "the harness itself failed". */
const HARNESS_FAILURE = 2;

const run = (args: string[], env: Record<string, string> = {}) => {
  const res = spawnSync(process.execPath, [PILOT, ...args], {
    encoding: "utf-8",
    // node is invoked by absolute path, so nothing here needs a PATH lookup.
    env: { ...process.env, PATH: "", TYPESAFE_API_KEY: "test-key", ...env },
    timeout: 30_000,
  });
  // Both streams, because a message's stream is not what these assert on.
  return { output: (res.stderr ?? "") + (res.stdout ?? ""), status: res.status ?? -1 };
};

const { cleanups, drain } = makeCleanups();
afterEach(drain);

const controlsFile = (controls: JsonValue): string => {
  const file = path.join(makeTmpDir(cleanups, "pilot-playtest-"), "controls.json");
  writeFileSync(file, JSON.stringify(controls));
  return file;
};

/** A run that passed validation reaches the CLI lookup, which PATH="" makes fail. */
const REACHED_CLI = /couldn't run `vg playtest`/u;

test("requires exactly one target", () => {
  assert.match(run([]).output, /Pass --url .* or --game/u);
  assert.match(run(["--url", "http://x", "--game", "y"]).output, /either --url or --game/u);
});

test("requires TYPESAFE_API_KEY, and says where to get one, before launching anything", () => {
  const { status, output } = run(["--url", "http://x"], { TYPESAFE_API_KEY: "" });
  assert.equal(status, HARNESS_FAILURE);
  assert.match(output, /TYPESAFE_API_KEY is not set/u);
  assert.match(output, /console\.typesafe\.ai/u);
  assert.doesNotMatch(output, REACHED_CLI);
});

test("reports a bad flag before the missing key", () => {
  // An agent fixing its command should see the command's mistake first.
  const { output } = run(["--url", "http://x", "--ticks", "0"], { TYPESAFE_API_KEY: "" });
  assert.match(output, /`--ticks` must be a positive integer/u);
  assert.doesNotMatch(output, /TYPESAFE_API_KEY/u);
});

test("rejects a seed that would never take", () => {
  for (const bad of ["foo", "Infinity", ""]) {
    const { status, output } = run(["--url", "http://x", "--seed", bad]);
    assert.equal(status, HARNESS_FAILURE, `--seed ${JSON.stringify(bad)} should be rejected`);
    assert.match(output, /`--seed` must be a finite number/u);
  }
});

test("rejects a tick count or hold length outside what the harness can drive", () => {
  for (const bad of ["0", "-3", "2.5", "abc"]) {
    assert.match(
      run(["--url", "http://x", "--ticks", bad]).output,
      /`--ticks` must be a positive integer/u,
    );
  }
  // Below ~80ms edge-triggered input never sees the hold; above a few seconds
  // the in-page await outlives agent-browser's eval timeout.
  for (const bad of ["5", "79", "5001", "nope"]) {
    assert.match(
      run(["--url", "http://x", "--tick-ms", bad]).output,
      /`--tick-ms` must be between 80 and 5000/u,
    );
  }
});

test("rejects an unknown flag rather than ignoring it", () => {
  const { status, output } = run(["--url", "http://x", "--headless"]);
  assert.equal(status, HARNESS_FAILURE);
  assert.match(output, /Unknown argument: --headless/u);
});

test("reports a flag that is missing its value", () => {
  assert.match(run(["--url"]).output, /`--url` needs a value/u);
  assert.match(run(["--url", "http://x", "--goal"]).output, /`--goal` needs a value/u);
  assert.match(run(["--url", "http://x", "--goal", ""]).output, /`--goal` must not be empty/u);
});

test("accepts both built-in control schemes", () => {
  for (const preset of ["wasd", "arrows"]) {
    const { output } = run(["--url", "http://localhost:1", "--controls", preset]);
    assert.match(output, REACHED_CLI, `preset ${preset} should pass validation`);
  }
});

test("names a --controls value that is neither a preset nor a readable file", () => {
  const dir = makeTmpDir(cleanups, "pilot-playtest-");
  const missing = run(["--url", "http://x", "--controls", path.join(dir, "absent.json")]);
  assert.equal(missing.status, HARNESS_FAILURE);
  assert.match(missing.output, /couldn't read --controls/u);
  assert.match(missing.output, /arrows, wasd/u);
  assert.doesNotMatch(missing.output, /at Object\./u, "should not surface a stack trace");

  const malformed = path.join(dir, "malformed.json");
  writeFileSync(malformed, "{not json");
  const bad = run(["--url", "http://x", "--controls", malformed]);
  assert.equal(bad.status, HARNESS_FAILURE);
  assert.match(bad.output, /isn't valid JSON/u);
});

test("accepts a custom scheme with keyboard and pointer moves, and fills in `none`", () => {
  const file = controlsFile({
    actions: { fire: { description: "fire the cannon", keys: ["KeyJ"] } },
    goal: "Reach the flag.",
    move: {
      aim_right: { description: "aim right and thrust", pointer: { down: true, x: 0.8, y: 0.5 } },
      left: { description: "walk left", keys: ["ArrowLeft"] },
    },
  });
  const { output } = run(["--url", "http://localhost:1", "--controls", file]);
  assert.match(output, REACHED_CLI);
});

test("names an unsupported key code in a scheme before launching anything", () => {
  const file = controlsFile({ move: { up: { description: "up", keys: ["F13"] } } });
  const { status, output } = run(["--url", "http://x", "--controls", file]);
  assert.equal(status, HARNESS_FAILURE);
  assert.match(output, /unsupported key code "F13"/u);
  assert.doesNotMatch(output, REACHED_CLI);
});

test("rejects a scheme the pilot could not act on", () => {
  const cases: [JsonValue, RegExp][] = [
    [[], /must be a JSON object/u],
    [{ move: {} }, /`move` must map at least one option/u],
    [{ move: { wait: { description: "wait" } } }, /no `move` option holds any input/u],
    [{ move: { up: { keys: ["KeyW"] } } }, /controls\.move\.up needs a non-empty `description`/u],
    [
      {
        actions: { jump: { description: "jump" } },
        move: { up: { description: "up", keys: ["KeyW"] } },
      },
      /controls\.actions\.jump needs a non-empty `keys` array/u,
    ],
    [
      {
        actions: { fire: { description: "fire", pointer: { down: true, x: 0.5, y: 0.5 } } },
        move: { up: { description: "up", keys: ["KeyW"] } },
      },
      /actions are keys only/u,
    ],
    [
      { move: { aim: { description: "aim", pointer: { x: 640, y: 0.5 } } } },
      /must be a viewport fraction between 0 and 1/u,
    ],
    [
      { goal: "", move: { up: { description: "up", keys: ["KeyW"] } } },
      /`goal` must be a non-empty string/u,
    ],
  ];
  for (const [controls, message] of cases) {
    const { status, output } = run(["--url", "http://x", "--controls", controlsFile(controls)]);
    assert.equal(status, HARNESS_FAILURE, `${JSON.stringify(controls)} should be rejected`);
    assert.match(output, message);
  }
});
