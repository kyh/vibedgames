import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * `scripts/bot-playtest.mjs` ships with the playtest skill rather than this
 * package, but it only runs through `vg playtest` and is the least-exercised
 * code in that pairing — so its input contract is covered here rather than
 * nowhere. These drive the real script as a subprocess.
 *
 * Every assertion is about argument validation, which happens before the
 * script shells out to anything. Nothing here asserts on what `vg playtest`
 * does, because `vg` is this package's own bin and isn't on PATH in CI — a
 * test that depended on it would pass locally and fail on a fresh runner.
 */
const BOT = fileURLToPath(
  new URL("../../../plugins/tooling/skills/playtest/scripts/bot-playtest.mjs", import.meta.url),
);

/** Exit code the script uses for "the harness itself failed". */
const HARNESS_FAILURE = 2;

function run(args: string[]): { status: number; stderr: string } {
  const res = spawnSync("node", [BOT, ...args], { encoding: "utf8", timeout: 30_000 });
  return { status: res.status ?? -1, stderr: (res.stderr ?? "") + (res.stdout ?? "") };
}

function scriptFile(steps: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "bot-playtest-")), "sweep.json");
  writeFileSync(path, JSON.stringify(steps));
  return path;
}

test("requires exactly one target", () => {
  assert.match(run([]).stderr, /Pass --url .* or --game/);
  assert.match(run(["--url", "http://x", "--game", "y"]).stderr, /either --url or --game/);
});

test("rejects a seed that would never take", () => {
  // `?seed=NaN` is ignored by the game and `seed(NaN)` poisons the RNG — either
  // way the report would claim a seed that never applied.
  for (const bad of ["foo", "Infinity", "-Infinity", ""]) {
    const { status, stderr } = run(["--url", "http://x", "--seed", bad]);
    assert.equal(status, HARNESS_FAILURE, `--seed ${JSON.stringify(bad)} should be rejected`);
    assert.match(stderr, /`--seed` must be a finite number/);
  }
});

test("rejects a nonsensical reaction delay", () => {
  for (const bad of ["-5", "abc"]) {
    assert.match(
      run(["--url", "http://x", "--reaction-delay", bad]).stderr,
      /`--reaction-delay` must be a non-negative number/,
    );
  }
});

test("rejects an unknown flag rather than ignoring it", () => {
  const { status, stderr } = run(["--url", "http://x", "--headless"]);
  assert.equal(status, HARNESS_FAILURE);
  assert.match(stderr, /Unknown argument: --headless/);
});

test("reports a flag that is missing its value", () => {
  assert.match(run(["--url"]).stderr, /`--url` needs a value/);
});

test("names an unsupported key code, before launching anything", () => {
  // The old behaviour surfaced this mid-run, after a browser start and a
  // seeded reload, looking like a harness fault rather than a bad script.
  const path = scriptFile([{ keys: ["KeyW", "F13"], ms: 100 }]);
  const { status, stderr } = run(["--url", "http://x", "--script", path]);
  assert.equal(status, HARNESS_FAILURE);
  assert.match(stderr, /unsupported key code "F13"/);
});

test("accepts every key family the docs promise", () => {
  const path = scriptFile([
    { keys: ["KeyW", "KeyA", "Digit1", "ArrowLeft", "Space"], ms: 100 },
    { keys: ["ShiftLeft", "ControlRight", "AltLeft", "Period", "Slash"], ms: 100 },
  ]);
  // Asserts only that validation let these through. What happens next depends
  // on whether `vg` is installed, so it is deliberately not asserted.
  const { stderr } = run(["--url", "http://localhost:1", "--script", path]);
  assert.doesNotMatch(stderr, /unsupported key code/);
  assert.doesNotMatch(stderr, /needs a (non-empty|positive)/);
});

test("rejects malformed steps", () => {
  assert.match(
    run(["--url", "http://x", "--script", scriptFile([])]).stderr,
    /non-empty JSON array/,
  );
  assert.match(
    run(["--url", "http://x", "--script", scriptFile([{ keys: [], ms: 100 }])]).stderr,
    /step 0 needs a non-empty `keys` array/,
  );
  assert.match(
    run(["--url", "http://x", "--script", scriptFile([{ keys: ["KeyW"], ms: 0 }])]).stderr,
    /step 0 needs a positive `ms` duration/,
  );
});
