#!/usr/bin/env node
/**
 * bot-playtest — drive a scripted input sweep through a browser game and
 * measure whether it actually PLAYS: loop alive, input alive, objective
 * reachable, no softlocks, no errors.
 *
 * Zero dependencies. Shells out to `vg playtest` (agent-browser), which keeps
 * a daemon alive between calls, so one invocation per step is cheap.
 *
 * The game must expose the diagnostics contract — see references/bot-playtest.md.
 *
 *   node bot-playtest.mjs --url http://localhost:5173
 *   node bot-playtest.mjs --game my-game --seed 42
 *   node bot-playtest.mjs --url http://localhost:5173 --script ./sweep.json
 *   node bot-playtest.mjs --url http://localhost:5173 --reaction-delay 300
 *
 * Exit 0 = the game plays. Exit 1 = it doesn't (report says why). Exit 2 = the
 * harness itself failed (browser missing, game never booted).
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const HARNESS_FAILURE = 2;

// A generic sweep: hold each direction long enough to cross a room, so a
// stuck-on-geometry game shows up as a softlock window rather than as noise.
const DEFAULT_SCRIPT = [
  { keys: ["KeyW"], ms: 1000 },
  { keys: ["KeyA"], ms: 1900 },
  { keys: ["KeyD"], ms: 3400 },
  { keys: ["KeyS"], ms: 1700 },
  { keys: ["KeyA"], ms: 3400 },
  { keys: ["Space"], ms: 600 },
];

const THRESHOLDS = {
  framesAdvanced: 100,
  distanceTravelled: 5,
  softlockWindows: 2,
};

function parseArgs(argv) {
  const opts = {
    url: null,
    game: null,
    seed: 12345,
    script: DEFAULT_SCRIPT,
    reactionDelay: 0,
    headed: false,
    keepOpen: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) fail(`\`${arg}\` needs a value.`);
      i += 1;
      return value;
    };
    if (arg === "--url") opts.url = next();
    else if (arg === "--game") opts.game = next();
    else if (arg === "--seed") opts.seed = Number(next());
    else if (arg === "--reaction-delay") opts.reactionDelay = Number(next());
    else if (arg === "--script") opts.script = JSON.parse(readFileSync(next(), "utf8"));
    else if (arg === "--headed") opts.headed = true;
    else if (arg === "--keep-open") opts.keepOpen = true;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!opts.url && !opts.game) fail("Pass --url <url> or --game <slug>.");
  if (opts.url && opts.game) fail("Pass either --url or --game, not both.");
  return opts;
}

/**
 * Keys currently held. A keydown left dangling by an early exit stays stuck in
 * the game and poisons the next run against the same daemon, so anything that
 * ends the process releases these first.
 */
const held = new Set();

function releaseHeldKeys() {
  // Clear before releasing: `dispatchKey` can itself call `fail`, and this must
  // not recurse forever when the CLI is what's broken.
  const keys = [...held];
  held.clear();
  for (const key of keys) dispatchKey("keyup", key);
}

const NAMED_KEYS = {
  ArrowLeft: [37, "ArrowLeft"],
  ArrowUp: [38, "ArrowUp"],
  ArrowRight: [39, "ArrowRight"],
  ArrowDown: [40, "ArrowDown"],
  Space: [32, " "],
  Enter: [13, "Enter"],
  Escape: [27, "Escape"],
  Tab: [9, "Tab"],
  ShiftLeft: [16, "Shift"],
  ShiftRight: [16, "Shift"],
  ControlLeft: [17, "Control"],
  ControlRight: [17, "Control"],
};

/** `keyCode` and `key` for a KeyboardEvent `code`. */
function keyFields(code) {
  if (code in NAMED_KEYS) return NAMED_KEYS[code];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return [letter[1].charCodeAt(0), letter[1].toLowerCase()];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return [48 + Number(digit[1]), digit[1]];
  fail(
    `unsupported key code "${code}". Use a KeyboardEvent code: KeyW, ArrowLeft, Space, Digit1, ShiftLeft…`,
  );
}

/**
 * Press or release a key by dispatching a KeyboardEvent in the page.
 *
 * NOT `vg playtest keydown/keyup`: as of agent-browser 0.34 those dispatch an
 * event with an empty `code` and `keyCode: 0`, which engines that match on
 * keyCode (Phaser among them) silently ignore. `press` populates the event
 * correctly but is a discrete tap, so it can't express a hold. Dispatching the
 * event ourselves is the only way to hold a properly-formed key. The tradeoff
 * is `isTrusted: false`, which matters only for games that check it.
 */
function dispatchKey(type, code) {
  const [keyCode, key] = keyFields(code);
  const { status, stdout, stderr } = playtest([
    "eval",
    `(() => { window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, keyCode: ${keyCode}, which: ${keyCode}, bubbles: true })); return true; })()`,
  ]);
  if (status !== 0) fail(`${type} ${code} failed: ${stderr.trim() || stdout.trim()}`);
}

function fail(message) {
  releaseHeldKeys();
  console.error(`bot-playtest: ${message}`);
  process.exit(HARNESS_FAILURE);
}

/** Run one `vg playtest` command. Returns { status, stdout, stderr }. */
function playtest(args) {
  const res = spawnSync("vg", ["playtest", ...args], { encoding: "utf8", timeout: 120_000 });
  if (res.error)
    fail(`couldn't run \`vg playtest\` — is the vg CLI installed? (${res.error.message})`);
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Parse a `--json` response body.
 *
 * agent-browser wraps every JSON response as `{ success, data, error }`, with
 * the command's payload under `data` — `data.result` for `eval`,
 * `data.messages` for `console`. Verified against agent-browser 0.34; the
 * fallbacks below keep this working if a later version flattens the envelope.
 */
function parseResponse(stdout) {
  const text = stdout.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Evaluate an expression in the page and return its value. */
function evaluate(expression) {
  const { status, stdout, stderr } = playtest(["eval", expression, "--json"]);
  if (status !== 0) fail(`eval failed: ${stderr.trim() || stdout.trim()}`);
  const parsed = parseResponse(stdout);
  if (parsed === null) return null;
  if (parsed.raw !== undefined) return parsed.raw;
  if (parsed.success === false) fail(`eval failed: ${JSON.stringify(parsed.error)}`);
  if (parsed.data && "result" in parsed.data) return parsed.data.result;
  if ("result" in parsed) return parsed.result;
  return parsed;
}

/**
 * Console messages at error level. `console` returns every level, so filter
 * here. An unrecognized shape is reported raw rather than swallowed — better a
 * noisy report than an empty one that reads as "no errors".
 */
function readConsoleErrors() {
  const parsed = parseResponse(playtest(["console", "--json"]).stdout);
  if (parsed === null) return [];
  if (parsed.raw !== undefined) return [parsed.raw];
  const entries =
    parsed.data?.messages ?? parsed.messages ?? (Array.isArray(parsed) ? parsed : null);
  if (!Array.isArray(entries)) return [JSON.stringify(parsed)];
  return entries
    .filter((entry) => {
      const level = entry?.type ?? entry?.level;
      return typeof level === "string" && level.toLowerCase() === "error";
    })
    .map((entry) => entry?.text ?? entry?.message ?? JSON.stringify(entry));
}

const SAMPLE = `(() => {
  const d = window.__GAME_DIAGNOSTICS__;
  if (!d) return null;
  const p = d.player || {};
  return {
    frame: d.frame ?? 0,
    score: d.score ?? 0,
    complete: !!d.complete,
    x: p.x ?? 0,
    // 3D games report depth on z; 2D games on y. Either way it's "the other axis".
    y: p.y ?? p.z ?? 0,
  };
})()`;

function sleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = opts.game ? ["--game", opts.game] : [opts.url];

  const open = playtest(["open", ...target, ...(opts.headed ? ["--headed"] : [])]);
  if (open.status !== 0)
    fail(`couldn't open the game: ${open.stderr.trim() || open.stdout.trim()}`);

  // Clear anything the daemon carried over from a previous run so the error
  // counts below belong to this run only.
  playtest(["console", "--clear"]);
  playtest(["errors", "--clear"]);

  // Wait for the CONTRACT, not for frames. Most games boot into a menu where
  // the game loop hasn't started, so frames only begin advancing once
  // setState('active-play') has skipped it — waiting on frames first would
  // deadlock on exactly the games that implement the contract correctly.
  const ready = playtest([
    "wait",
    "--fn",
    "window.__GAME_DIAGNOSTICS__ !== undefined && window.__GAME_TEST_HOOKS__ !== undefined",
  ]);
  if (ready.status !== 0) {
    console.error(
      "bot-playtest: the game never published window.__GAME_DIAGNOSTICS__ / window.__GAME_TEST_HOOKS__. Either it crashed on boot, or it doesn't implement the diagnostics contract (see references/bot-playtest.md).",
    );
    process.exit(HARNESS_FAILURE);
  }

  // seed() must RESTART the run, not just reseed — frames rendered before this
  // call were unseeded and must not be measured. setState('active-play') is
  // what leaves the menu.
  evaluate(
    `(() => { const h = window.__GAME_TEST_HOOKS__; if (!h) return false; h.seed?.(${opts.seed}); h.setState?.('active-play'); return true; })()`,
  );

  const live = playtest(["wait", "--fn", "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10"]);
  if (live.status !== 0) {
    console.error(
      "bot-playtest: diagnostics are published but the loop never advanced past frame 10. seed()/setState('active-play') should start a run — check they aren't no-ops (see references/bot-playtest.md).",
    );
    process.exit(HARNESS_FAILURE);
  }

  const before = evaluate(SAMPLE);
  if (!before) fail("window.__GAME_DIAGNOSTICS__ is not published — nothing to measure.");

  let prev = before;
  let distance = 0;
  let softlockWindows = 0;
  let stepOfFirstScore = -1;

  opts.script.forEach((step, index) => {
    for (const key of step.keys) {
      held.add(key);
      dispatchKey("keydown", key);
    }
    playtest(["wait", String(step.ms)]);
    releaseHeldKeys();
    // A slower "reaction time" models a less skilled player; comparing runs at
    // 0ms and 300ms shows whether difficulty pressure is real or decorative.
    sleep(opts.reactionDelay);

    const snap = evaluate(SAMPLE);
    if (!snap) return;
    const moved = Math.hypot(snap.x - prev.x, snap.y - prev.y);
    distance += moved;
    const progressed = snap.score > prev.score;
    if (progressed && stepOfFirstScore === -1) stepOfFirstScore = index;
    // Softlock signature: frames advance, held input moves nothing, no progress.
    if (snap.frame > prev.frame && moved < 0.2 && !progressed) softlockWindows += 1;
    prev = snap;
  });

  // `console` returns every level, so filter to errors here. `errors` (uncaught
  // exceptions) has no JSON mode — any non-empty output is a failure.
  const consoleErrors = readConsoleErrors();
  const pageErrors = playtest(["errors"]).stdout.trim();

  const report = {
    url: opts.game ? `https://${opts.game}.vibedgames.com` : opts.url,
    seed: opts.seed,
    reactionDelay: opts.reactionDelay,
    steps: opts.script.length,
    framesAdvanced: prev.frame - before.frame,
    scoreBefore: before.score,
    scoreAfter: prev.score,
    distanceTravelled: Number(distance.toFixed(2)),
    stepOfFirstScore,
    softlockWindows,
    complete: prev.complete,
    consoleErrors,
    pageErrors,
  };

  const failures = [];
  if (report.framesAdvanced <= THRESHOLDS.framesAdvanced)
    failures.push(`game loop stalled (framesAdvanced ${report.framesAdvanced})`);
  if (report.distanceTravelled <= THRESHOLDS.distanceTravelled)
    failures.push(
      `player did not respond to input (distanceTravelled ${report.distanceTravelled})`,
    );
  if (report.softlockWindows > THRESHOLDS.softlockWindows)
    failures.push(
      `held input repeatedly produced nothing (softlockWindows ${report.softlockWindows})`,
    );
  if (report.scoreAfter <= report.scoreBefore)
    failures.push("the sweep never progressed the objective");
  if (report.consoleErrors.length > 0)
    failures.push(`${report.consoleErrors.length} console error(s)`);
  if (report.pageErrors) failures.push("uncaught page error(s)");

  console.log(JSON.stringify({ ...report, failures }, null, 2));

  if (!opts.keepOpen) playtest(["close"]);

  if (failures.length > 0) {
    console.error(`\nbot-playtest: FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }
  console.error("\nbot-playtest: PASSED");
}

main();
