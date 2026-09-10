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

// The lint bans runtime `typeof`; these checks are typeof-free equivalents for
// values decoded from JSON (plain objects and primitive strings only).
const isPlainObject = (v) => Object.prototype.toString.call(v) === "[object Object]";
const isString = (v) => String(v) === v;

/** Print this file's header docblock, so `--help` cannot drift from the docs. */
const printHelp = () => {
  const source = readFileSync(import.meta.filename, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);
  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();
  process.stdout.write(`${text || "No help available."}\n`);
};

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
  displacement: 5,
  framesAdvanced: 100,
  /** Displacement (world units) below which a step counts as "didn't move". */
  motionEpsilon: 0.2,
  stuckRun: 2,
};

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

const parseArgs = (argv) => {
  const opts = {
    expectProgress: false,
    game: null,
    headed: false,
    keepOpen: false,
    reactionDelay: 0,
    script: DEFAULT_SCRIPT,
    seed: 12_345,
    url: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const takeValue = () => {
      const value = argv[i + 1];
      if (value === undefined) {
        fail(`\`${arg}\` needs a value.`);
      }
      i += 1;
      return value;
    };
    // `Number("")` is 0, not NaN, so an empty value would slip past the finite
    // checks below and silently seed with 0 instead of saying anything.
    const num = () => {
      const raw = takeValue();
      return raw.trim() === "" ? Number.NaN : Number(raw);
    };
    if (arg === "--url") {
      opts.url = takeValue();
    } else if (arg === "--game") {
      opts.game = takeValue();
    } else if (arg === "--seed") {
      opts.seed = num();
    } else if (arg === "--reaction-delay") {
      opts.reactionDelay = num();
    } else if (arg === "--script") {
      opts.script = readScript(takeValue());
    } else if (arg === "--expect-progress") {
      opts.expectProgress = true;
    } else if (arg === "--headed") {
      opts.headed = true;
    } else if (arg === "--keep-open") {
      opts.keepOpen = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      fail(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.url && !opts.game) {
    fail("Pass --url <url> or --game <slug>.");
  }
  if (opts.url && opts.game) {
    fail("Pass either --url or --game, not both.");
  }
  // Validated here rather than at the URL so both seeding paths are covered:
  // `?seed=NaN` is ignored by the game and `seed(NaN)` poisons the RNG, and
  // either way the report would claim a seed that never took.
  if (!Number.isFinite(opts.seed)) {
    fail("`--seed` must be a finite number.");
  }
  if (!Number.isFinite(opts.reactionDelay) || opts.reactionDelay < 0) {
    fail("`--reaction-delay` must be a non-negative number of milliseconds.");
  }
  validateScript(opts.script);
  return opts;
};

/**
 * Load a `--script` file. A missing path or malformed JSON is a mistake in the
 * command, not a crash: raw `ENOENT`/`SyntaxError` stack traces read as a bug
 * in the harness and bury the one line that says which file is wrong.
 */
const readScript = (path) => {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    fail(`couldn't read --script ${path}.`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`--script ${path} isn't valid JSON: ${error.message}`);
  }
};

/**
 * Check the input script before anything launches. An unsupported key code or
 * a malformed step would otherwise surface mid-run, after a browser start and
 * a seeded reload, reported as a harness failure with no hint that the script
 * itself was the problem.
 */
const validatePointer = (pointer, index) => {
  const { x, y } = pointer;
  // Fractions of the viewport, so a script isn't tied to one window size.
  for (const [name, value] of [
    ["x", x],
    ["y", y],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      fail(`step ${index}: \`pointer.${name}\` must be a viewport fraction between 0 and 1.`);
    }
  }
  if (pointer.down !== undefined && pointer.down !== true && pointer.down !== false) {
    fail(`step ${index}: \`pointer.down\` must be a boolean.`);
  }
};

const validateScript = (script) => {
  if (!Array.isArray(script) || script.length === 0) {
    fail("`--script` must be a non-empty JSON array of { keys, ms } steps.");
  }
  for (const [index, step] of script.entries()) {
    if (!isPlainObject(step)) {
      fail(`step ${index} must be an object.`);
    }
    const keys = step.keys ?? [];
    if (!Array.isArray(keys)) {
      fail(`step ${index}: \`keys\` must be an array.`);
    }
    if (keys.length === 0 && !step.pointer) {
      fail(`step ${index} needs a non-empty \`keys\` array or a \`pointer\`.`);
    }
    if (!Number.isFinite(step.ms) || step.ms <= 0) {
      fail(`step ${index} needs a positive \`ms\` duration.`);
    }
    if (
      step.expectMotion !== undefined &&
      step.expectMotion !== true &&
      step.expectMotion !== false
    ) {
      fail(`step ${index}: \`expectMotion\` must be a boolean.`);
    }
    if (step.pointer) {
      validatePointer(step.pointer, index);
    }
    // Throws (exit 2) naming the offending code.
    for (const code of keys) {
      keyFields(code);
    }
  }
};

/**
 * Whether a step is claiming the player should move, and so can count toward a
 * stuck run. A pointer step counts because the games that use one steer with
 * it (aim-and-thrust); a bare attack or menu key does not.
 */
const expectsMotion = (step) => {
  if (step.expectMotion === true || step.expectMotion === false) {
    return step.expectMotion;
  }
  return Boolean(step.pointer) || (step.keys ?? []).some((code) => MOVEMENT_CODES.has(code));
};

/**
 * The step whose inputs are currently down. A keydown — or a mouse button —
 * left dangling by an early exit stays stuck in the game and poisons the next
 * run against the same daemon, so anything that ends the process releases it.
 */
let inFlight = null;

const releaseHeldInputs = () => {
  const step = inFlight;
  // Disown before dispatching, so a release that itself fails can't recurse
  // back through `fail` forever when the CLI is what's broken.
  inFlight = null;
  // A step is the only thing that puts an input down or starts the sampler, and
  // it can only start once the page is open — so no step means nothing to undo.
  // Reaching for the browser anyway would have `--seed nonsense` bootstrap
  // agent-browser and download Chrome just to report a typo.
  if (!step) {
    return;
  }

  // One eval for all of it: this runs when the run is already failing, and each
  // extra subprocess is another chance to die before the release lands. The
  // sampler goes too — a 40ms interval left running in the daemon's page
  // outlives this process for the same reason a held key would.
  const parts = [
    "clearInterval(window.__BOT_TICK__);",
    ...keyParts("keyup", step.keys ?? []),
    ...pointerParts(step.pointer, "up"),
  ];
  // Raw spawn rather than `playtest`, which calls `fail` when the CLI can't be
  // run — and `fail` calls this. Best-effort by design: the run is already over,
  // and there is nothing useful to do if the release itself can't be delivered.
  spawnSync("vg", ["playtest", "eval", `(() => { ${parts.join("\n")}\nreturn true; })()`], {
    encoding: "utf-8",
    timeout: 30_000,
  });
};

/** `code` → `keyCode`, for codes whose keyCode isn't derivable from the name. */
const NAMED_KEYS = {
  AltLeft: 18,
  AltRight: 18,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  ArrowUp: 38,
  Backquote: 192,
  Backslash: 220,
  Backspace: 8,
  BracketLeft: 219,
  BracketRight: 221,
  Comma: 188,
  ControlLeft: 17,
  ControlRight: 17,
  Delete: 46,
  Enter: 13,
  Equal: 187,
  Escape: 27,
  Minus: 189,
  Period: 190,
  Quote: 222,
  Semicolon: 186,
  ShiftLeft: 16,
  ShiftRight: 16,
  Slash: 191,
  Space: 32,
  Tab: 9,
};

/** The `key` value a browser reports for a given `code`. */
const NAMED_VALUES = {
  AltLeft: "Alt",
  AltRight: "Alt",
  Backquote: "`",
  Backslash: "\\",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  ControlLeft: "Control",
  ControlRight: "Control",
  Equal: "=",
  Minus: "-",
  Period: ".",
  Quote: "'",
  Semicolon: ";",
  ShiftLeft: "Shift",
  ShiftRight: "Shift",
  Slash: "/",
  Space: " ",
};

/**
 * What a US keyboard reports as `key` while Shift is held. The keyCodes above
 * already assume that layout, so this stays consistent with them.
 */
const SHIFTED = {
  Backquote: "~",
  Backslash: "|",
  BracketLeft: "{",
  BracketRight: "}",
  Comma: "<",
  Digit0: ")",
  Digit1: "!",
  Digit2: "@",
  Digit3: "#",
  Digit4: "$",
  Digit5: "%",
  Digit6: "^",
  Digit7: "&",
  Digit8: "*",
  Digit9: "(",
  Equal: "+",
  Minus: "_",
  Period: ">",
  Quote: '"',
  Semicolon: ":",
  Slash: "?",
};

/**
 * The `key` a browser reports for `code` with Shift down. Without this a step
 * holding Shift sets `shiftKey: true` but still reports the unshifted value, so
 * a binding written against `event.key === "A"` never fires — the same class of
 * miss the modifier flags were added to fix.
 */
const shiftedKey = (code, key) => {
  if (/^Key[A-Z]$/u.test(code)) {
    return key.toUpperCase();
  }
  return SHIFTED[code] ?? key;
};

/** `keyCode` and `key` for a KeyboardEvent `code`. */
const keyFields = (code) => {
  const letter = /^Key(?<letter>[A-Z])$/u.exec(code)?.groups?.letter;
  if (letter) {
    return [letter.codePointAt(0), letter.toLowerCase()];
  }
  const digit = /^Digit(?<digit>[0-9])$/u.exec(code)?.groups?.digit;
  if (digit) {
    return [48 + Number(digit), digit];
  }
  // `in` would accept inherited names, so `toString` became a key with an
  // undefined keyCode instead of an unsupported-code failure.
  if (Object.hasOwn(NAMED_KEYS, code)) {
    return [NAMED_KEYS[code], Object.hasOwn(NAMED_VALUES, code) ? NAMED_VALUES[code] : code];
  }
  fail(
    `unsupported key code "${code}". Supported: Key<A-Z>, Digit<0-9>, and ${Object.keys(NAMED_KEYS).join(", ")}.`,
  );
};

const keyInits = (codes) => {
  // Modifiers held in the same step have to show up as flags on their
  // companions too, or `Shift+W` arrives as a plain `w` and the binding a
  // script was written to exercise never fires.
  const modifiers = {
    altKey: codes.some((c) => c === "AltLeft" || c === "AltRight"),
    ctrlKey: codes.some((c) => c === "ControlLeft" || c === "ControlRight"),
    shiftKey: codes.some((c) => c === "ShiftLeft" || c === "ShiftRight"),
  };
  return codes.map((code) => {
    const [keyCode, key] = keyFields(code);
    const reported = modifiers.shiftKey ? shiftedKey(code, key) : key;
    return JSON.stringify({
      code,
      key: reported,
      keyCode,
      which: keyCode,
      ...modifiers,
      bubbles: true,
    });
  });
};

/**
 * In-page source pressing or releasing a step's keys — all of them in one
 * statement, since simultaneous keys should land together.
 *
 * NOT `vg playtest keydown/keyup`: as of agent-browser 0.34 those dispatch an
 * event with an empty `code` and `keyCode: 0`, which engines that match on
 * keyCode (Phaser among them) silently ignore. `press` populates the event
 * correctly but is a discrete tap, so it can't express a hold. Dispatching the
 * event ourselves is the only way to hold a properly-formed key. The tradeoff
 * is `isTrusted: false`, which matters only for games that check it.
 */
const keyParts = (type, codes) => {
  if (codes.length === 0) {
    return [];
  }
  // Dispatched at the focused element, not at `window`. A real keypress starts
  // there and bubbles up through document to window, so listeners on all three
  // fire once; dispatching on `window` fires only window's, and a game using
  // `document.addEventListener("keydown", …)` is reported as dead input.
  return [
    `{ const t = document.activeElement ?? document.body ?? window;
      for (const init of [${keyInits(codes).join(",")}]) t.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, init)); }`,
  ];
};

/** In-page source moving/pressing (`"down"`) or releasing (`"up"`) the cursor. */
const pointerParts = (pointer, phase) => {
  if (!pointer) {
    return [];
  }
  const down = pointer.down === true;
  if (phase === "up") {
    return down ? [POINTER_FN, pointerCall(pointer, "pointerup", 0)] : [];
  }
  return [
    POINTER_FN,
    pointerCall(pointer, "pointermove", down ? 1 : 0),
    ...(down ? [pointerCall(pointer, "pointerdown", 1)] : []),
  ];
};

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
 * Read player state the same way at every sample site.
 *
 * All three axes, defaulting to 0. Picking `y ?? z` instead would read a 3D
 * game that exposes both as if it moved on x/y, and a game whose travel is on
 * x/z reports as motionless.
 */
const READ_FN = `const __botRead = () => {
  const d = window.__GAME_DIAGNOSTICS__, p = (d && d.player) || {};
  return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, frame: (d && d.frame) ?? 0, score: (d && d.score) ?? 0, complete: !!(d && d.complete) };
};
const __botDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);`;

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
    t.path += __botDist(c, t.last);
    t.peak = Math.max(t.peak, __botDist(c, t.start));
    t.last = c;
    if (c.score > t.score) t.score = c.score;
  }, ${SAMPLE_MS});`;

const TRACK_END = `${READ_FN}
  clearInterval(window.__BOT_TICK__);
  const t = window.__BOT_TRACK__;
  if (!t) return null;
  const c = __botRead();
  const path = t.path + __botDist(c, t.last);
  const peak = Math.max(t.peak, __botDist(c, t.start));
  return { path: +path.toFixed(3), peak: +peak.toFixed(3), frameBefore: t.start.frame, frame: c.frame, scoreBefore: t.start.score, score: Math.max(t.score, c.score), x: c.x, y: c.y, z: c.z, complete: c.complete };`;

const pointerCall = (pointer, type, buttons) =>
  `window.__botPointer(${JSON.stringify({ x: pointer.x, y: pointer.y })}, ${JSON.stringify(type)}, ${buttons});`;

/** Press the step's inputs and start measuring, in one round trip. */
const beginStep = (step) => {
  // Tracking first: a game that moves the player synchronously on keydown
  // would otherwise fold that movement into the baseline and report peak 0.
  const parts = [
    TRACK_BEGIN,
    ...pointerParts(step.pointer, "down"),
    ...keyParts("keydown", step.keys ?? []),
  ];
  // Claim the step BEFORE dispatching: an eval that fails part-way through can
  // still have pressed something, and an input this process never releases
  // stays held in the daemon's page for the next run.
  inFlight = step;
  evaluate(`(() => { ${parts.join("\n")}\nreturn true; })()`);
};

/** Release the step's inputs and return what moved while they were held. */
const endStep = (step) => {
  const parts = [
    ...keyParts("keyup", step.keys ?? []),
    ...pointerParts(step.pointer, "up"),
    TRACK_END,
  ];
  // Only disown the step once the release has actually landed. Clearing first
  // would leave `releaseHeldInputs` with nothing to do on the failure path —
  // the one path where it matters.
  const summary = evaluate(`(() => { ${parts.join("\n")} })()`);
  inFlight = null;
  return summary;
};

// Ctrl-C mid-hold leaves the key down and the sampler running in a daemon page
// that outlives this process, which is the same poison an early exit causes.
// `sleep` blocks the thread, so the handler lands once the current hold ends.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    releaseHeldInputs();
    process.exit(HARNESS_FAILURE);
  });
}

const fail = (message) => {
  releaseHeldInputs();
  console.error(`bot-playtest: ${message}`);
  process.exit(HARNESS_FAILURE);
};

/**
 * Block for `ms`. The game runs in a separate browser process and the tracker
 * samples from inside the page, so neither needs the harness awake — holding
 * here costs nothing and saves a `vg playtest wait` subprocess per step.
 */
const sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Run one `vg playtest` command. */
const playtest = (args) => {
  const res = spawnSync("vg", ["playtest", ...args], { encoding: "utf-8", timeout: 120_000 });
  if (res.error) {
    fail(`couldn't run \`vg playtest\` — is the vg CLI installed? (${res.error.message})`);
  }
  return { status: res.status ?? 1, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
};

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
const payload = (args, key) => {
  const { status, stdout, stderr } = playtest([...args, "--json"]);
  const text = stdout.trim();
  if (status !== 0) {
    fail(`\`${args[0]}\` failed: ${stderr.trim() || text}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(`\`${args[0]} --json\` did not return JSON: ${text.slice(0, 200)}`);
  }
  if (parsed?.success === false) {
    fail(`\`${args[0]}\` failed: ${JSON.stringify(parsed.error)}`);
  }
  if (!parsed?.data || !(key in parsed.data)) {
    fail(
      `unexpected agent-browser response for \`${args[0]}\` (no data.${key}): ${text.slice(0, 200)}`,
    );
  }
  return parsed.data[key];
};

const evaluate = (expression) => payload(["eval", expression], "result");

/** Console messages at error level — `console` returns every level. */
const readConsoleErrors = () => {
  const entries = payload(["console"], "messages");
  if (!Array.isArray(entries)) {
    fail("`console` returned a non-array `messages`.");
  }
  return entries
    .filter((entry) => entry?.type === "error")
    .map((entry) => entry?.text ?? JSON.stringify(entry));
};

/**
 * Renderer string of the game's own WebGL context, so a SwiftShader run can't
 * pass as performance evidence. Null fields when the canvas isn't WebGL.
 */
const readGpuInfo = () => {
  const info = evaluate(
    `(() => {
      const canvas = document.querySelector("canvas");
      let gl = null;
      try { gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl") ?? null; } catch { gl = null; }
      if (!gl) { return null; }
      const debug = gl.getExtension("WEBGL_debug_renderer_info");
      return {
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      };
    })()`,
  );
  if (!isPlainObject(info) || !isString(info.renderer)) {
    return { renderer: null, softwareRendered: null, vendor: null };
  }
  return {
    renderer: info.renderer,
    softwareRendered: /swiftshader|llvmpipe|software|basic render/iu.test(info.renderer),
    vendor: isString(info.vendor) ? info.vendor : null,
  };
};

/** The run's baseline, read the same way the per-step tracker reads. */
const SAMPLE = `(() => { ${READ_FN} return __botRead(); })()`;

const CONTRACT_READY =
  "window.__GAME_DIAGNOSTICS__ !== undefined && window.__GAME_TEST_HOOKS__ !== undefined";

/**
 * Navigate and wait for the diagnostics contract.
 *
 * Logs are cleared BEFORE navigating, never after: anything the game logs while
 * booting belongs to this run, and clearing afterwards would erase exactly the
 * boot errors the report exists to catch. That holds for the seeded reload too,
 * where the logs worth keeping are the *second* boot's.
 *
 * Waits for the CONTRACT, not for frames. Most games boot into a menu where the
 * loop hasn't started, so frames only advance once setState('active-play') has
 * skipped it — waiting on frames first would deadlock on exactly the games that
 * implement the contract correctly.
 */
const boot = (target, opts, whenAbsent) => {
  playtest(["console", "--clear"]);
  playtest(["errors", "--clear"]);

  const open = playtest(["open", ...target, ...(opts.headed ? ["--headed"] : [])]);
  if (open.status !== 0) {
    fail(`couldn't open the game: ${open.stderr.trim() || open.stdout.trim()}`);
  }

  if (playtest(["wait", "--fn", CONTRACT_READY]).status !== 0) {
    fail(whenAbsent);
  }
};

/** Drive the script step by step, measuring motion and score against the baseline. */
const runScript = (opts, before) => {
  let prev = before;
  let distance = 0;
  let maxStepDisplacement = 0;
  let stuckSteps = 0;
  let stuckRun = 0;
  let longestStuckRun = 0;
  let stepOfFirstScore = null;

  for (const [index, step] of opts.script.entries()) {
    beginStep(step);
    sleep(step.ms);
    const moved = endStep(step);
    // A slower "reaction time" models a less skilled player; comparing runs at
    // 0ms and 300ms shows whether difficulty pressure is real or decorative.
    if (opts.reactionDelay > 0) {
      sleep(opts.reactionDelay);
    }
    // Silently skipping would leave `prev` at the baseline, reporting
    // framesAdvanced 0 — a broken harness dressed up as a stalled game.
    if (!moved) {
      fail(`step ${index} lost its in-page tracker; the page probably navigated mid-run.`);
    }

    distance += moved.path;
    maxStepDisplacement = Math.max(maxStepDisplacement, moved.peak);
    const progressed = moved.score > moved.scoreBefore;
    if (progressed && stepOfFirstScore === null) {
      stepOfFirstScore = index;
    }

    // Stuck signature: frames advanced, the player tried to move, and nothing
    // came of it. Counted as a RUN rather than a total, because one step that
    // moves nothing is a key the game doesn't bind, while several in a row is
    // a player wedged in geometry — only the second is worth failing over.
    if (expectsMotion(step)) {
      const stuck =
        moved.frame > moved.frameBefore && moved.peak < THRESHOLDS.motionEpsilon && !progressed;
      if (stuck) {
        stuckSteps += 1;
        stuckRun += 1;
        longestStuckRun = Math.max(longestStuckRun, stuckRun);
      } else {
        stuckRun = 0;
      }
    }
    prev = moved;
  }

  return { distance, longestStuckRun, maxStepDisplacement, prev, stepOfFirstScore, stuckSteps };
};

/**
 * Two ways a game can honour a seed, and `seed?.()` alone silently skips the
 * second: games whose scene is single-start (games/starfall) deliberately
 * omit the hook and read `?seed=` at boot instead. Calling an absent hook
 * would leave the run unseeded while the report still claimed the seed — the
 * exact "silent no-op hook" the contract warns about. So detect which one
 * this game implements, and for boot-only games reload with the param.
 */
const applySeed = (opts) => {
  const boot0 = evaluate(
    "({ hasSeedHook: typeof window.__GAME_TEST_HOOKS__?.seed === 'function', href: location.href })",
  );
  if (boot0?.hasSeedHook) {
    return "hook";
  }
  if (!isString(boot0?.href)) {
    fail("couldn't read location.href to apply the seed.");
  }
  const url = new URL(boot0.href);
  url.searchParams.set("seed", String(opts.seed));
  boot([url.toString()], opts, "the game stopped publishing diagnostics after the seeded reload.");
  return "boot-param";
};

const main = () => {
  const opts = parseArgs(process.argv.slice(2));

  boot(
    opts.game ? ["--game", opts.game] : [opts.url],
    opts,
    "the game never published window.__GAME_DIAGNOSTICS__ / window.__GAME_TEST_HOOKS__. Either it crashed on boot, or it doesn't implement the diagnostics contract (see references/bot-playtest.md).",
  );

  const seedApplied = applySeed(opts);

  // seed() must RESTART the run, not just reseed — frames rendered before this
  // call were unseeded and must not be measured. setState('active-play') is
  // what leaves the menu. Stash the frame it left off at so the wait below
  // proves the loop moved *after* the hooks, rather than passing instantly on
  // a game that was already past frame 10.
  const ack = evaluate(
    `(async () => { const h = window.__GAME_TEST_HOOKS__; h.seed?.(${opts.seed}); const ack = await h.setState?.('active-play'); window.__BOT_F0__ = h && window.__GAME_DIAGNOSTICS__.frame; return ack === undefined ? null : ack; })()`,
  );
  // The ack is optional (void hooks keep working) but asserted when present:
  // a hook that answers with a different state applied a different state.
  if (ack !== null && (!isPlainObject(ack) || ack.state !== "active-play")) {
    fail(
      `setState('active-play') acknowledged ${JSON.stringify(ack)} instead of { state: 'active-play' } — the hook applied a different state or is a no-op (see references/bot-playtest.md).`,
    );
  }

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
  const { distance, longestStuckRun, maxStepDisplacement, prev, stepOfFirstScore, stuckSteps } =
    runScript(opts, before);

  // `console` returns every level, so filter to errors there; `errors` is
  // uncaught exceptions only. Both go through `payload`, so a failed collection
  // is a harness failure rather than "no errors found" — reporting a clean run
  // because the check itself broke is the worst outcome here.
  const consoleErrors = readConsoleErrors();
  const pageErrors = payload(["errors"], "errors");
  if (!Array.isArray(pageErrors)) {
    fail("`errors` returned a non-array `errors`.");
  }
  const gpu = readGpuInfo();

  const report = {
    complete: prev.complete,
    consoleErrors,
    distanceTravelled: Number(distance.toFixed(2)),
    framesAdvanced: prev.frame - before.frame,
    // Which GPU rasterized the run. Under software rendering the functional
    // checks above still hold; any frame-rate read from the run does not.
    gpu,
    longestStuckRun,
    maxStepDisplacement: Number(maxStepDisplacement.toFixed(2)),
    pageErrors,
    reactionDelay: opts.reactionDelay,
    scoreAfter: prev.score,
    scoreBefore: before.score,
    seed: opts.seed,
    // How the seed actually landed, so a reader can tell a real seeded run
    // from one where the hook quietly did nothing.
    seedApplied,
    stepOfFirstScore,
    steps: opts.script.length,
    stuckSteps,
    // Report what was asked for, not a second guess at the URL — `vg playtest`
    // owns slug→URL resolution and follows VG_API_URL when doing it.
    target: opts.game ? `game:${opts.game}` : opts.url,
  };

  const failures = [];
  const warnings = [];
  if (report.framesAdvanced <= THRESHOLDS.framesAdvanced) {
    failures.push(`game loop stalled (framesAdvanced ${report.framesAdvanced})`);
  }
  // Gated on the largest displacement any ONE step achieved, not on the summed
  // path: path accumulates every sampled wobble, so a game with an idle bob and
  // completely dead input can drift past a total-distance threshold and look
  // responsive. Peak-from-step-start stays bounded by how far the player
  // actually got.
  if (report.maxStepDisplacement <= THRESHOLDS.displacement) {
    failures.push(
      `player did not respond to input (maxStepDisplacement ${report.maxStepDisplacement}) — if this game steers with the mouse, give the script \`pointer\` steps`,
    );
  }
  if (report.longestStuckRun > THRESHOLDS.stuckRun) {
    failures.push(
      `player wedged for ${report.longestStuckRun} consecutive movement steps (longestStuckRun)`,
    );
  }
  // Failing needs more consecutive stuck steps than the script even contains,
  // so silence here proves nothing. Say so rather than let a green run imply a
  // check that could never have run.
  const motionSteps = opts.script.filter(expectsMotion).length;
  if (motionSteps <= THRESHOLDS.stuckRun) {
    warnings.push(
      `stuck detection never applied: ${motionSteps} step(s) ask the player to move, and failing needs more than ${THRESHOLDS.stuckRun} in a row`,
    );
  }
  // An assertion only when the caller says the script performs the game's
  // scoring verb. Inferring that from "was --script passed?" got it wrong in
  // both directions — a tweaked copy of the default sweep would fail a healthy
  // game, which is the verdict-you-learn-to-ignore this exists to avoid.
  if (report.scoreAfter <= report.scoreBefore) {
    const message = "the run never progressed the objective";
    if (opts.expectProgress) {
      failures.push(message);
    } else {
      warnings.push(
        `${message} — pass \`--expect-progress\` once your script performs this game's scoring verb, to make that an assertion`,
      );
    }
  }
  if (report.consoleErrors.length > 0) {
    failures.push(`${report.consoleErrors.length} console error(s)`);
  }
  if (report.pageErrors.length > 0) {
    failures.push(`${report.pageErrors.length} uncaught page error(s)`);
  }

  console.log(JSON.stringify({ ...report, failures, warnings }, null, 2));

  if (!opts.keepOpen) {
    playtest(["close"]);
  }

  if (failures.length > 0) {
    console.error(`\nbot-playtest: FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }
  for (const warning of warnings) {
    console.error(`bot-playtest: warning — ${warning}`);
  }
  console.error("\nbot-playtest: PASSED");
};

main();
