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
// stuck-on-geometry game shows up as a run of stuck steps rather than as noise.
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
  stuckRun: 2,
};

/** Displacement (world units) below which a step counts as "didn't move". */
const MOTION_EPSILON = 0.2;

/** How often the in-page tracker samples player state during a step. */
const SAMPLE_MS = 40;

/**
 * Codes that mean "the player is trying to move". Only these steps can count
 * as stuck: a game where attack is `KeyJ` would otherwise be accused of a
 * softlock for every attack, since attacking correctly moves nobody. Override
 * per step with `expectMotion` when a game moves on some other key.
 */
const MOVEMENT_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);

function parseArgs(argv) {
  const opts = {
    url: null,
    game: null,
    seed: 12345,
    script: DEFAULT_SCRIPT,
    customScript: false,
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
    // `Number("")` is 0, not NaN, so an empty value would slip past the finite
    // checks below and silently seed with 0 instead of saying anything.
    const num = () => {
      const raw = next();
      return raw.trim() === "" ? Number.NaN : Number(raw);
    };
    if (arg === "--url") opts.url = next();
    else if (arg === "--game") opts.game = next();
    else if (arg === "--seed") opts.seed = num();
    else if (arg === "--reaction-delay") opts.reactionDelay = num();
    else if (arg === "--script") {
      opts.script = JSON.parse(readFileSync(next(), "utf8"));
      opts.customScript = true;
    } else if (arg === "--headed") opts.headed = true;
    else if (arg === "--keep-open") opts.keepOpen = true;
    else fail(`Unknown argument: ${arg}`);
  }
  if (!opts.url && !opts.game) fail("Pass --url <url> or --game <slug>.");
  if (opts.url && opts.game) fail("Pass either --url or --game, not both.");
  // Validated here rather than at the URL so both seeding paths are covered:
  // `?seed=NaN` is ignored by the game and `seed(NaN)` poisons the RNG, and
  // either way the report would claim a seed that never took.
  if (!Number.isFinite(opts.seed)) fail("`--seed` must be a finite number.");
  if (!Number.isFinite(opts.reactionDelay) || opts.reactionDelay < 0) {
    fail("`--reaction-delay` must be a non-negative number of milliseconds.");
  }
  validateScript(opts.script);
  return opts;
}

/**
 * Check the input script before anything launches. An unsupported key code or
 * a malformed step would otherwise surface mid-run, after a browser start and
 * a seeded reload, reported as a harness failure with no hint that the script
 * itself was the problem.
 */
function validateScript(script) {
  if (!Array.isArray(script) || script.length === 0) {
    fail("`--script` must be a non-empty JSON array of { keys, ms } steps.");
  }
  for (const [index, step] of script.entries()) {
    if (!step || typeof step !== "object") fail(`step ${index} must be an object.`);
    const keys = step.keys ?? [];
    if (!Array.isArray(keys)) fail(`step ${index}: \`keys\` must be an array.`);
    if (keys.length === 0 && !step.pointer) {
      fail(`step ${index} needs a non-empty \`keys\` array or a \`pointer\`.`);
    }
    if (!Number.isFinite(step.ms) || step.ms <= 0) {
      fail(`step ${index} needs a positive \`ms\` duration.`);
    }
    if (step.expectMotion !== undefined && typeof step.expectMotion !== "boolean") {
      fail(`step ${index}: \`expectMotion\` must be a boolean.`);
    }
    if (step.pointer) {
      const { x, y } = step.pointer;
      // Fractions of the viewport, so a script isn't tied to one window size.
      for (const [name, value] of [
        ["x", x],
        ["y", y],
      ]) {
        if (!Number.isFinite(value) || value < 0 || value > 1) {
          fail(`step ${index}: \`pointer.${name}\` must be a viewport fraction between 0 and 1.`);
        }
      }
      if (step.pointer.down !== undefined && typeof step.pointer.down !== "boolean") {
        fail(`step ${index}: \`pointer.down\` must be a boolean.`);
      }
    }
    // Throws (exit 2) naming the offending code.
    for (const code of keys) keyFields(code);
  }
}

/**
 * Whether a step is claiming the player should move, and so can count toward a
 * stuck run. A pointer step counts because the games that use one steer with
 * it (aim-and-thrust); a bare attack or menu key does not.
 */
function expectsMotion(step) {
  if (typeof step.expectMotion === "boolean") return step.expectMotion;
  return Boolean(step.pointer) || (step.keys ?? []).some((code) => MOVEMENT_CODES.has(code));
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
function keyInits(codes) {
  return codes.map((code) => {
    const [keyCode, key] = keyFields(code);
    return JSON.stringify({ key, code, keyCode, which: keyCode, bubbles: true });
  });
}

function dispatchKeys(type, codes) {
  if (codes.length === 0) return;
  const { status, stdout, stderr } = playtest([
    "eval",
    `(() => { for (const init of [${keyInits(codes).join(",")}]) window.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, init)); return true; })()`,
  ]);
  if (status !== 0) fail(`${type} ${codes.join("+")} failed: ${stderr.trim() || stdout.trim()}`);
}

/**
 * Pointer dispatch, for games that steer from the cursor rather than the
 * keyboard (aim-and-thrust shooters, twin-stick, point-to-move). Coordinates
 * arrive as viewport fractions so a script survives a window resize. Both the
 * PointerEvent and its MouseEvent twin go out: engines listen for one or the
 * other, and a game that ignores the pointer entirely is exactly the finding
 * a run should surface rather than crash on.
 */
const POINTER_FN = `window.__botPointer = (frac, type, buttons) => {
  const cx = Math.round(window.innerWidth * frac.x);
  const cy = Math.round(window.innerHeight * frac.y);
  const target = document.elementFromPoint(cx, cy) || document.querySelector("canvas") || window;
  const init = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons };
  target.dispatchEvent(new PointerEvent(type, init));
  target.dispatchEvent(new MouseEvent(type === "pointermove" ? "mousemove" : type === "pointerdown" ? "mousedown" : "mouseup", init));
};`;

/**
 * Read player state the same way at every sample site. `y ?? z` keeps 3D games
 * (depth on z) and 2D games (depth on y) on one code path.
 */
const READ_FN = `const __botRead = () => {
  const d = window.__GAME_DIAGNOSTICS__, p = (d && d.player) || {};
  return { x: p.x ?? 0, y: p.y ?? p.z ?? 0, frame: (d && d.frame) ?? 0, score: (d && d.score) ?? 0, complete: !!(d && d.complete) };
};`;

/**
 * Start sampling player state inside the page for the duration of a step.
 *
 * Sampling only at step boundaries measures net displacement, which is zero for
 * every motion that returns where it started — a jump arc being the obvious
 * one. That reads as "held input produced nothing" on a game whose jump works
 * perfectly. Tracking peak displacement and path length across the step is
 * what tells a real stuck-on-geometry case from a round trip.
 */
const TRACK_BEGIN = `${READ_FN}
  const s = __botRead();
  const t = { start: s, last: s, path: 0, peak: 0, score: s.score };
  window.__BOT_TRACK__ = t;
  clearInterval(window.__BOT_TICK__);
  window.__BOT_TICK__ = setInterval(() => {
    const c = __botRead();
    t.path += Math.hypot(c.x - t.last.x, c.y - t.last.y);
    t.peak = Math.max(t.peak, Math.hypot(c.x - t.start.x, c.y - t.start.y));
    t.last = c;
    if (c.score > t.score) t.score = c.score;
  }, ${SAMPLE_MS});`;

const TRACK_END = `${READ_FN}
  clearInterval(window.__BOT_TICK__);
  const t = window.__BOT_TRACK__;
  if (!t) return null;
  const c = __botRead();
  const path = t.path + Math.hypot(c.x - t.last.x, c.y - t.last.y);
  const peak = Math.max(t.peak, Math.hypot(c.x - t.start.x, c.y - t.start.y));
  return { path: +path.toFixed(3), peak: +peak.toFixed(3), frameBefore: t.start.frame, frame: c.frame, scoreBefore: t.start.score, score: Math.max(t.score, c.score), x: c.x, y: c.y, complete: c.complete };`;

function pointerCall(pointer, type, buttons) {
  return `window.__botPointer(${JSON.stringify({ x: pointer.x, y: pointer.y })}, ${JSON.stringify(type)}, ${buttons});`;
}

/** Press the step's inputs and start measuring, in one round trip. */
function beginStep(step) {
  const parts = [];
  if (step.pointer) {
    const down = step.pointer.down === true;
    parts.push(POINTER_FN, pointerCall(step.pointer, "pointermove", down ? 1 : 0));
    if (down) parts.push(pointerCall(step.pointer, "pointerdown", 1));
  }
  const codes = step.keys ?? [];
  if (codes.length > 0) {
    parts.push(
      `for (const init of [${keyInits(codes).join(",")}]) window.dispatchEvent(new KeyboardEvent("keydown", init));`,
    );
  }
  parts.push(TRACK_BEGIN);
  evaluate(`(() => { ${parts.join("\n")}\nreturn true; })()`);
}

/** Release the step's inputs and return what moved while they were held. */
function endStep(step) {
  const parts = [];
  const codes = step.keys ?? [];
  if (codes.length > 0) {
    parts.push(
      `for (const init of [${keyInits(codes).join(",")}]) window.dispatchEvent(new KeyboardEvent("keyup", init));`,
    );
  }
  if (step.pointer?.down === true) {
    parts.push(POINTER_FN, pointerCall(step.pointer, "pointerup", 0));
  }
  parts.push(TRACK_END);
  held.clear();
  return evaluate(`(() => { ${parts.join("\n")} })()`);
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

/** The run's baseline, read the same way the per-step tracker reads. */
const SAMPLE = `(() => { ${READ_FN}
  return window.__GAME_DIAGNOSTICS__ ? __botRead() : null;
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

  // Two ways a game can honour a seed, and `seed?.()` alone silently skips the
  // second: games whose scene is single-start (games/starfall) deliberately
  // omit the hook and read `?seed=` at boot instead. Calling an absent hook
  // would leave the run unseeded while the report still claimed the seed — the
  // exact "silent no-op hook" the contract warns about. So detect which one
  // this game implements, and for boot-only games reload with the param.
  const seedApplied = evaluate("typeof window.__GAME_TEST_HOOKS__?.seed === 'function'")
    ? "hook"
    : "boot-param";

  if (seedApplied === "boot-param") {
    const href = evaluate("location.href");
    if (typeof href !== "string") fail("couldn't read location.href to apply the seed.");
    const url = new URL(href);
    url.searchParams.set("seed", String(opts.seed));

    // Clear before the reload, never after: the first boot's logs are the ones
    // to discard, and clearing afterwards would swallow anything the *seeded*
    // boot reported — the failure this run exists to catch.
    playtest(["console", "--clear"]);
    playtest(["errors", "--clear"]);

    const reopen = playtest(["open", url.toString(), ...(opts.headed ? ["--headed"] : [])]);
    if (reopen.status !== 0) fail(`couldn't reopen with ?seed=: ${reopen.stderr.trim()}`);
    const reready = playtest([
      "wait",
      "--fn",
      "window.__GAME_DIAGNOSTICS__ !== undefined && window.__GAME_TEST_HOOKS__ !== undefined",
    ]);
    if (reready.status !== 0)
      fail("the game stopped publishing diagnostics after the seeded reload.");
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
  let stuckSteps = 0;
  let stuckRun = 0;
  let longestStuckRun = 0;
  let stepOfFirstScore = -1;

  opts.script.forEach((step, index) => {
    for (const key of step.keys ?? []) held.add(key);
    beginStep(step);
    playtest(["wait", String(step.ms)]);
    const moved = endStep(step);
    // A slower "reaction time" models a less skilled player; comparing runs at
    // 0ms and 300ms shows whether difficulty pressure is real or decorative.
    // Wait in the browser, not the harness, so the game keeps running.
    if (opts.reactionDelay > 0) playtest(["wait", String(opts.reactionDelay)]);
    if (!moved) return;

    distance += moved.path;
    const progressed = moved.score > moved.scoreBefore;
    if (progressed && stepOfFirstScore === -1) stepOfFirstScore = index;

    // Stuck signature: frames advanced, the player tried to move, and nothing
    // came of it. Counted as a RUN rather than a total, because one step that
    // moves nothing is a key the game doesn't bind, while several in a row is
    // a player wedged in geometry — only the second is worth failing over.
    if (expectsMotion(step)) {
      const stuck = moved.frame > moved.frameBefore && moved.peak < MOTION_EPSILON && !progressed;
      if (stuck) {
        stuckSteps += 1;
        stuckRun += 1;
        longestStuckRun = Math.max(longestStuckRun, stuckRun);
      } else {
        stuckRun = 0;
      }
    }
    prev = { frame: moved.frame, score: moved.score, complete: moved.complete };
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
    stuckSteps,
    longestStuckRun,
    // How the seed actually landed, so a reader can tell a real seeded run
    // from one where the hook quietly did nothing.
    seedApplied,
    complete: prev.complete,
    consoleErrors,
    pageErrors,
  };

  const failures = [];
  const warnings = [];
  if (report.framesAdvanced <= THRESHOLDS.framesAdvanced)
    failures.push(`game loop stalled (framesAdvanced ${report.framesAdvanced})`);
  if (report.distanceTravelled <= THRESHOLDS.distanceTravelled)
    failures.push(
      `player did not respond to input (distanceTravelled ${report.distanceTravelled}) — if this game steers with the mouse, give the script \`pointer\` steps`,
    );
  if (report.longestStuckRun > THRESHOLDS.stuckRun)
    failures.push(
      `player wedged for ${report.longestStuckRun} consecutive movement steps (longestStuckRun)`,
    );
  // Only an assertion when the caller supplied the game's own verbs. The
  // default sweep is a generic WASD walk that knows nothing about how this
  // game scores, so failing a healthy game on it would train a reader to
  // ignore the verdict — which costs more than the missing signal.
  if (report.scoreAfter <= report.scoreBefore) {
    const message = "the sweep never progressed the objective";
    if (opts.customScript) failures.push(message);
    else
      warnings.push(
        `${message} — expected from the default sweep; pass \`--script\` with this game's core verb to assert progression`,
      );
  }
  if (report.consoleErrors.length > 0)
    failures.push(`${report.consoleErrors.length} console error(s)`);
  if (report.pageErrors) failures.push("uncaught page error(s)");

  console.log(JSON.stringify({ ...report, warnings, failures }, null, 2));

  if (!opts.keepOpen) playtest(["close"]);

  if (failures.length > 0) {
    console.error(`\nbot-playtest: FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }
  for (const warning of warnings) console.error(`bot-playtest: warning — ${warning}`);
  console.error("\nbot-playtest: PASSED");
}

main();
