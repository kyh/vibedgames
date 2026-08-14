#!/usr/bin/env node
/**
 * bot-playtest — drive a scripted input sweep through a browser game and
 * measure whether it actually PLAYS: loop alive, input alive, objective
 * reachable, no softlocks, no errors.
 *
 * Zero dependencies. Shells out to `vg playtest` (agent-browser). The daemon
 * keeps the browser alive between calls, but each call still pays a CLI start,
 * so the loop keeps invocations to roughly one per step.
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
  // Clear before releasing: `dispatchKeys` can itself call `fail`, and this must
  // not recurse forever when the CLI is what's broken.
  const keys = [...held];
  held.clear();
  dispatchKeys("keyup", keys);
}

/** `code` → `keyCode`, for codes whose keyCode isn't derivable from the name. */
const NAMED_KEYS = {
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Space: 32,
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  ControlRight: 17,
  AltLeft: 18,
  AltRight: 18,
  Minus: 189,
  Equal: 187,
  Comma: 188,
  Period: 190,
  Slash: 191,
  Backquote: 192,
  BracketLeft: 219,
  BracketRight: 221,
  Backslash: 220,
  Semicolon: 186,
  Quote: 222,
};

/** The `key` value a browser reports for a given `code`. */
const NAMED_VALUES = {
  Space: " ",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  ControlLeft: "Control",
  ControlRight: "Control",
  AltLeft: "Alt",
  AltRight: "Alt",
  Minus: "-",
  Equal: "=",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backquote: "`",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
};

/** `keyCode` and `key` for a KeyboardEvent `code`. */
function keyFields(code) {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return [letter[1].charCodeAt(0), letter[1].toLowerCase()];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return [48 + Number(digit[1]), digit[1]];
  if (code in NAMED_KEYS) return [NAMED_KEYS[code], NAMED_VALUES[code] ?? code];
  fail(
    `unsupported key code "${code}". Supported: Key<A-Z>, Digit<0-9>, and ${Object.keys(NAMED_KEYS).join(", ")}.`,
  );
}

/**
 * Press or release keys by dispatching KeyboardEvents in the page — all keys
 * for a step in one call, since a subprocess per key is the dominant cost of a
 * run and simultaneous keys should land together anyway.
 *
 * NOT `vg playtest keydown/keyup`: as of agent-browser 0.34 those dispatch an
 * event with an empty `code` and `keyCode: 0`, which engines that match on
 * keyCode (Phaser among them) silently ignore. `press` populates the event
 * correctly but is a discrete tap, so it can't express a hold. Dispatching the
 * event ourselves is the only way to hold a properly-formed key. The tradeoff
 * is `isTrusted: false`, which matters only for games that check it.
 */
function dispatchKeys(type, codes) {
  if (codes.length === 0) return;
  const inits = codes.map((code) => {
    const [keyCode, key] = keyFields(code);
    return JSON.stringify({ key, code, keyCode, which: keyCode, bubbles: true });
  });
  const { status, stdout, stderr } = playtest([
    "eval",
    `(() => { for (const init of [${inits.join(",")}]) window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, init)); return true; })()`,
  ]);
  if (status !== 0) fail(`${type} ${codes.join("+")} failed: ${stderr.trim() || stdout.trim()}`);
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
 * Read the payload of a `--json` command. agent-browser wraps every JSON
 * response as `{ success, data, error }`, with the command's payload under
 * `data` — `data.result` for `eval`, `data.messages` for `console`. Verified
 * against agent-browser 0.34.
 *
 * A shape this doesn't recognize is a harness failure, not something to guess
 * around: silently returning the envelope would hand callers `undefined` for
 * every field and produce a report full of zeroes that reads like a broken
 * game rather than a broken harness.
 */
function payload(args, key) {
  const { status, stdout, stderr } = playtest([...args, "--json"]);
  const text = stdout.trim();
  if (status !== 0) fail(`\`${args[0]}\` failed: ${stderr.trim() || text}`);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`\`${args[0]} --json\` did not return JSON: ${text.slice(0, 200)}`);
  }
  if (parsed?.success === false) fail(`\`${args[0]}\` failed: ${JSON.stringify(parsed.error)}`);
  if (!parsed?.data || !(key in parsed.data)) {
    fail(
      `unexpected agent-browser response for \`${args[0]}\` (no data.${key}): ${text.slice(0, 200)}`,
    );
  }
  return parsed.data[key];
}

/** Evaluate an expression in the page and return its value. */
function evaluate(expression) {
  return payload(["eval", expression], "result");
}

/** Console messages at error level — `console` returns every level. */
function readConsoleErrors() {
  const entries = payload(["console"], "messages");
  if (!Array.isArray(entries)) fail("`console` returned a non-array `messages`.");
  return entries
    .filter((entry) => entry?.type === "error")
    .map((entry) => entry?.text ?? JSON.stringify(entry));
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const target = opts.game ? ["--game", opts.game] : [opts.url];

  // Clear BEFORE navigating: anything the game logs while booting is part of
  // this run, and clearing afterwards would erase exactly the boot errors the
  // report exists to catch.
  playtest(["console", "--clear"]);
  playtest(["errors", "--clear"]);

  const open = playtest(["open", ...target, ...(opts.headed ? ["--headed"] : [])]);
  if (open.status !== 0)
    fail(`couldn't open the game: ${open.stderr.trim() || open.stdout.trim()}`);

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
    fail(
      "the game never published window.__GAME_DIAGNOSTICS__ / window.__GAME_TEST_HOOKS__. Either it crashed on boot, or it doesn't implement the diagnostics contract (see references/bot-playtest.md).",
    );
  }

  // seed() must RESTART the run, not just reseed — frames rendered before this
  // call were unseeded and must not be measured. setState('active-play') is
  // what leaves the menu. Stash the frame it left off at so the wait below
  // proves the loop moved *after* the hooks, rather than passing instantly on
  // a game that was already past frame 10.
  evaluate(
    `(() => { const h = window.__GAME_TEST_HOOKS__; h.seed?.(${opts.seed}); h.setState?.('active-play'); window.__BOT_F0__ = h && window.__GAME_DIAGNOSTICS__.frame; })()`,
  );

  const live = playtest([
    "wait",
    "--fn",
    // `!== __BOT_F0__` covers both shapes of a correct seed(): one that resets
    // the counter, and one that just keeps counting up.
    "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10 && window.__GAME_DIAGNOSTICS__.frame !== window.__BOT_F0__",
  ]);
  if (live.status !== 0) {
    fail(
      "diagnostics are published but the loop never advanced after seed()/setState('active-play') — check they aren't no-ops (see references/bot-playtest.md).",
    );
  }

  const before = evaluate(SAMPLE);
  if (!before) fail("window.__GAME_DIAGNOSTICS__ is not published — nothing to measure.");

  let prev = before;
  let distance = 0;
  let softlockWindows = 0;
  let stepOfFirstScore = -1;

  opts.script.forEach((step, index) => {
    for (const key of step.keys) held.add(key);
    dispatchKeys("keydown", step.keys);
    playtest(["wait", String(step.ms)]);
    releaseHeldKeys();
    // A slower "reaction time" models a less skilled player; comparing runs at
    // 0ms and 300ms shows whether difficulty pressure is real or decorative.
    // Wait in the browser, not the harness, so the game keeps running.
    if (opts.reactionDelay > 0) playtest(["wait", String(opts.reactionDelay)]);

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

  // `console` returns every level, so filter to errors there. `errors`
  // (uncaught exceptions) has no JSON mode — any non-empty output is a failure.
  // A failed collection is a harness failure, not "no errors found": reporting
  // a clean run because the check itself broke is the worst outcome here.
  const consoleErrors = readConsoleErrors();
  const errorsOut = playtest(["errors"]);
  if (errorsOut.status !== 0) {
    fail(`couldn't collect page errors: ${errorsOut.stderr.trim() || errorsOut.stdout.trim()}`);
  }
  const pageErrors = errorsOut.stdout.trim();

  const report = {
    // Report what was asked for, not a second guess at the URL — `vg playtest`
    // owns slug→URL resolution and follows VG_API_URL when doing it.
    target: opts.game ? `game:${opts.game}` : opts.url,
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
