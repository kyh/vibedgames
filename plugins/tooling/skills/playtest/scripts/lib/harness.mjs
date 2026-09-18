/**
 * Shared harness for the playtest skill's bot scripts: the `vg playtest`
 * subprocess plumbing, properly-formed held-key and pointer dispatch, the
 * in-page motion tracker, and the boot/seed sequence that gets a game to a
 * live, seeded run. `bot-playtest.mjs` (a scripted sweep) and
 * `pilot-playtest.mjs` (a Jev-driven pilot) both build on it.
 *
 * Zero dependencies. Shells out to `vg playtest` (agent-browser). The game
 * must expose the diagnostics contract — see references/bot-playtest.md.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The lint bans runtime `typeof`; these checks are typeof-free equivalents for
// values decoded from JSON (plain objects and primitive strings only).
export const isPlainObject = (v) => Object.prototype.toString.call(v) === "[object Object]";
export const isString = (v) => String(v) === v;

export const HARNESS_FAILURE = 2;

/** Print a script's header docblock, so `--help` cannot drift from the docs. */
export const printHelp = (file) => {
  const source = readFileSync(file, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);
  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();
  process.stdout.write(`${text || "No help available."}\n`);
};

/** Prefix on every failure message, so a reader knows which script spoke. */
let programName = "playtest";

export const setProgramName = (name) => {
  programName = name;
};

/** How often the in-page tracker samples player state during a hold. */
export const SAMPLE_MS = 40;

/**
 * Codes that mean "the player is trying to move". Only these steps can count
 * as stuck: a game where attack is `KeyJ` would otherwise be accused of a
 * softlock for every attack, since attacking correctly moves nobody.
 */
export const MOVEMENT_CODES = new Set([
  "KeyW",
  "KeyA",
  "KeyS",
  "KeyD",
  "ArrowUp",
  "ArrowLeft",
  "ArrowDown",
  "ArrowRight",
]);

/**
 * The inputs currently down — `{ keys, pointer }`. A keydown — or a mouse
 * button — left dangling by an early exit stays stuck in the game and poisons
 * the next run against the same daemon, so anything that ends the process
 * releases it.
 */
let held = null;

/**
 * Record that `inputs` are about to be pressed. Call BEFORE dispatching: an
 * eval that fails part-way through can still have pressed something, and an
 * input this process never releases stays held in the daemon's page.
 */
export const claimHeld = (inputs) => {
  held = inputs;
};

/** Record that the held inputs have been released — once the release LANDED. */
export const disownHeld = () => {
  held = null;
};

export const releaseHeldInputs = () => {
  const inputs = held;
  // Disown before dispatching, so a release that itself fails can't recurse
  // back through `fail` forever when the CLI is what's broken.
  held = null;
  // Only a hold puts an input down or starts the sampler, and one can only
  // start once the page is open — so nothing held means nothing to undo.
  // Reaching for the browser anyway would have `--seed nonsense` bootstrap
  // agent-browser and download Chrome just to report a typo.
  if (!inputs) {
    return;
  }

  // One eval for all of it: this runs when the run is already failing, and each
  // extra subprocess is another chance to die before the release lands. The
  // sampler goes too — an interval left running in the daemon's page outlives
  // this process for the same reason a held key would.
  const parts = [
    "clearInterval(window.__BOT_TICK__);",
    ...keyParts("keyup", inputs.keys ?? []),
    ...pointerParts(inputs.pointer, "up"),
  ];
  // Raw spawn rather than `playtest`, which calls `fail` when the CLI can't be
  // run — and `fail` calls this. Best-effort by design: the run is already over,
  // and there is nothing useful to do if the release itself can't be delivered.
  spawnSync("vg", ["playtest", "eval", `(() => { ${parts.join("\n")}\nreturn true; })()`], {
    encoding: "utf-8",
    timeout: 30_000,
  });
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

export const fail = (message) => {
  releaseHeldInputs();
  console.error(`${programName}: ${message}`);
  process.exit(HARNESS_FAILURE);
};

/** `code` → `keyCode`, for codes whose keyCode isn't derivable from the name. */
export const NAMED_KEYS = {
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

/** `keyCode` and `key` for a KeyboardEvent `code`. Fails naming an unsupported code. */
export const keyFields = (code) => {
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
 * In-page source pressing or releasing a set of keys — all of them in one
 * statement, since simultaneous keys should land together.
 *
 * NOT `vg playtest keydown/keyup`: as of agent-browser 0.34 those dispatch an
 * event with an empty `code` and `keyCode: 0`, which engines that match on
 * keyCode (Phaser among them) silently ignore. `press` populates the event
 * correctly but is a discrete tap, so it can't express a hold. Dispatching the
 * event ourselves is the only way to hold a properly-formed key. The tradeoff
 * is `isTrusted: false`, which matters only for games that check it.
 */
export const keyParts = (type, codes) => {
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

const pointerCall = (pointer, type, buttons) =>
  `window.__botPointer(${JSON.stringify({ x: pointer.x, y: pointer.y })}, ${JSON.stringify(type)}, ${buttons});`;

/** In-page source moving/pressing (`"down"`) or releasing (`"up"`) the cursor. */
export const pointerParts = (pointer, phase) => {
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
 * Check a `pointer` before anything launches. Fractions of the viewport, so a
 * script isn't tied to one window size; pixels are the tempting mistake, and
 * they'd silently aim off-screen.
 */
export const validatePointer = (pointer, where) => {
  const { x, y } = pointer;
  for (const [name, value] of [
    ["x", x],
    ["y", y],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      fail(`${where}: \`pointer.${name}\` must be a viewport fraction between 0 and 1.`);
    }
  }
  if (pointer.down !== undefined && pointer.down !== true && pointer.down !== false) {
    fail(`${where}: \`pointer.down\` must be a boolean.`);
  }
};

/**
 * Read player state the same way at every sample site.
 *
 * All three axes, defaulting to 0. Picking `y ?? z` instead would read a 3D
 * game that exposes both as if it moved on x/y, and a game whose travel is on
 * x/z reports as motionless.
 */
export const READ_FN = `const __botRead = () => {
  const d = window.__GAME_DIAGNOSTICS__, p = (d && d.player) || {};
  return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, frame: (d && d.frame) ?? 0, score: (d && d.score) ?? 0, complete: !!(d && d.complete) };
};
const __botDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);`;

/**
 * Start sampling player state inside the page for the duration of a hold.
 * Needs READ_FN in scope.
 *
 * Sampling only at hold boundaries measures net displacement, which is zero for
 * every motion that returns where it started — a jump arc being the obvious
 * one. That reads as "held input produced nothing" on a game whose jump works
 * perfectly. Tracking peak displacement and path length across the hold is
 * what tells a real stuck-on-geometry case from a round trip.
 */
export const TRACK_BEGIN_BODY = `const s = __botRead();
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

export const TRACK_BEGIN = `${READ_FN}\n${TRACK_BEGIN_BODY}`;

/**
 * In-page expression summarising the tracker since TRACK_BEGIN and stopping
 * it — null if the tracker was lost (the page navigated). Needs READ_FN.
 */
export const TRACK_SUMMARY = `(() => {
  clearInterval(window.__BOT_TICK__);
  const t = window.__BOT_TRACK__;
  if (!t) return null;
  const c = __botRead();
  const path = t.path + __botDist(c, t.last);
  const peak = Math.max(t.peak, __botDist(c, t.start));
  return { path: +path.toFixed(3), peak: +peak.toFixed(3), frameBefore: t.start.frame, frame: c.frame, scoreBefore: t.start.score, score: Math.max(t.score, c.score), x: c.x, y: c.y, z: c.z, complete: c.complete };
})()`;

export const TRACK_END = `${READ_FN}\nreturn ${TRACK_SUMMARY};`;

/** The run's baseline, read the same way the per-step tracker reads. */
export const SAMPLE = `(() => { ${READ_FN} return __botRead(); })()`;

/**
 * Block for `ms`. The game runs in a separate browser process and the tracker
 * samples from inside the page, so neither needs the harness awake — holding
 * here costs nothing and saves a `vg playtest wait` subprocess per step.
 */
export const sleep = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Run one `vg playtest` command. */
export const playtest = (args) => {
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
export const payload = (args, key) => {
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

export const evaluate = (expression) => payload(["eval", expression], "result");

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
 * Console errors and uncaught page errors for the run so far. Both go through
 * `payload`, so a failed collection is a harness failure rather than "no errors
 * found" — reporting a clean run because the check itself broke is the worst
 * outcome here.
 */
export const collectErrors = () => {
  const consoleErrors = readConsoleErrors();
  const pageErrors = payload(["errors"], "errors");
  if (!Array.isArray(pageErrors)) {
    fail("`errors` returned a non-array `errors`.");
  }
  return { consoleErrors, pageErrors };
};

/**
 * Renderer string of the game's own WebGL context, so a SwiftShader run can't
 * pass as performance evidence. Null fields when the canvas isn't WebGL.
 */
export const readGpuInfo = () => {
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
const boot = (target, headed, whenAbsent) => {
  playtest(["console", "--clear"]);
  playtest(["errors", "--clear"]);

  const open = playtest(["open", ...target, ...(headed ? ["--headed"] : [])]);
  if (open.status !== 0) {
    fail(`couldn't open the game: ${open.stderr.trim() || open.stdout.trim()}`);
  }

  if (playtest(["wait", "--fn", CONTRACT_READY]).status !== 0) {
    fail(whenAbsent);
  }
};

/**
 * Two ways a game can honour a seed, and `seed?.()` alone silently skips the
 * second: games whose scene is single-start (games/starfall) deliberately
 * omit the hook and read `?seed=` at boot instead. Calling an absent hook
 * would leave the run unseeded while the report still claimed the seed — the
 * exact "silent no-op hook" the contract warns about. So detect which one
 * this game implements, and for boot-only games reload with the param.
 */
const applySeed = (seed, headed) => {
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
  url.searchParams.set("seed", String(seed));
  boot(
    [url.toString()],
    headed,
    "the game stopped publishing diagnostics after the seeded reload.",
  );
  return "boot-param";
};

/**
 * Open the game, seed it, start a run and wait for the loop to be live.
 * Returns how the seed landed and the baseline sample every metric is measured
 * against. `target` is `["--game", slug]` or `[url]` — `vg playtest` owns
 * slug→URL resolution and follows VG_API_URL when doing it.
 */
export const launch = ({ headed, seed, target }) => {
  boot(
    target,
    headed,
    "the game never published window.__GAME_DIAGNOSTICS__ / window.__GAME_TEST_HOOKS__. Either it crashed on boot, or it doesn't implement the diagnostics contract (see references/bot-playtest.md).",
  );

  const seedApplied = applySeed(seed, headed);

  // seed() must RESTART the run, not just reseed — frames rendered before this
  // call were unseeded and must not be measured. setState('active-play') is
  // what leaves the menu. Stash the frame it left off at so the wait below
  // proves the loop moved *after* the hooks, rather than passing instantly on
  // a game that was already past frame 10.
  const ack = evaluate(
    `(async () => { const h = window.__GAME_TEST_HOOKS__; h.seed?.(${seed}); const ack = await h.setState?.('active-play'); window.__BOT_F0__ = h && window.__GAME_DIAGNOSTICS__.frame; return ack === undefined ? null : ack; })()`,
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

  return { before: evaluate(SAMPLE), seedApplied };
};
