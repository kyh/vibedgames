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
 * does — the run below empties PATH so `vg` can't be found even on a dogfooded
 * machine where it is linked. Without that, a script that survives validation
 * goes on to launch a real browser: slow, and flaky under turbo's parallelism.
 */
const BOT = fileURLToPath(
  new URL("../../../plugins/tooling/skills/playtest/scripts/bot-playtest.mjs", import.meta.url),
);

/** Exit code the script uses for "the harness itself failed". */
const HARNESS_FAILURE = 2;

function run(args: string[]): { status: number; stderr: string } {
  const res = spawnSync(process.execPath, [BOT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
    // node is invoked by absolute path, so nothing here needs a PATH lookup.
    env: { ...process.env, PATH: "" },
  });
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
    /step 0 needs a non-empty `keys` array or a `pointer`/,
  );
  assert.match(
    run(["--url", "http://x", "--script", scriptFile([{ keys: ["KeyW"], ms: 0 }])]).stderr,
    /step 0 needs a positive `ms` duration/,
  );
});

test("reports a bad --script file as a mistake, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "bot-playtest-"));
  const malformed = join(dir, "malformed.json");
  writeFileSync(malformed, "{not json");

  const missing = run(["--url", "http://x", "--script", join(dir, "absent.json")]);
  assert.equal(missing.status, HARNESS_FAILURE);
  assert.match(missing.stderr, /couldn't read --script/);
  assert.doesNotMatch(missing.stderr, /at Object\./, "should not surface a stack trace");

  const bad = run(["--url", "http://x", "--script", malformed]);
  assert.equal(bad.status, HARNESS_FAILURE);
  assert.match(bad.stderr, /isn't valid JSON/);
});

test("accepts a pointer-only step, for games that steer with the mouse", () => {
  const path = scriptFile([{ pointer: { x: 0.5, y: 0.5, down: true }, ms: 100 }]);
  const { stderr } = run(["--url", "http://localhost:1", "--script", path]);
  assert.doesNotMatch(stderr, /needs a non-empty `keys`/);
  assert.doesNotMatch(stderr, /viewport fraction/);
});

test("rejects pointer coordinates that aren't viewport fractions", () => {
  // Pixels are the tempting mistake, and they'd silently aim off-screen.
  for (const bad of [
    { x: 640, y: 0.5 },
    { x: -0.1, y: 0.5 },
    { x: 0.5, y: "mid" },
  ]) {
    const { status, stderr } = run([
      "--url",
      "http://x",
      "--script",
      scriptFile([{ pointer: bad, ms: 100 }]),
    ]);
    assert.equal(status, HARNESS_FAILURE, `pointer ${JSON.stringify(bad)} should be rejected`);
    assert.match(stderr, /must be a viewport fraction between 0 and 1/);
  }
});

test("rejects a non-boolean expectMotion", () => {
  const path = scriptFile([{ keys: ["KeyW"], ms: 100, expectMotion: "yes" }]);
  assert.match(
    run(["--url", "http://x", "--script", path]).stderr,
    /`expectMotion` must be a boolean/,
  );
});
