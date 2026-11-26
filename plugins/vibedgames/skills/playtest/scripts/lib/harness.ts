import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

import type { JsonObject, JsonValue } from "../_lib/asset-tools.mjs";
import {
  isFiniteJsonNumber,
  isJsonObject,
  isJsonString,
  parseJsonText,
} from "../_lib/asset-tools.mjs";

export const isJsonBoolean = (v: JsonValue | undefined): v is boolean => v === true || v === false;

export interface Pointer {
  x: number;
  y: number;
  down?: boolean;
}

export interface HeldInputs {
  keys?: string[];
  pointer?: Pointer;
}

export interface Sample {
  x: number;
  y: number;
  z: number;
  frame: number;
  score: number;
  complete: boolean;
}

export interface StepSummary {
  path: number;
  peak: number;
  frameBefore: number;
  frame: number;
  scoreBefore: number;
  score: number;
  x: number;
  y: number;
  z: number;
  complete: boolean;
}

export const HARNESS_FAILURE = 2;

/** Print a script's header docblock, so `--help` cannot drift from the docs. */
export const printHelp = (file: string) => {
  const source = readFileSync(file, "utf-8");
  const match = /^(?:#![^\n]*\n)?\/\*\*(?<body>[\s\S]*?)\*\//u.exec(source);

  const text = (match?.groups?.body ?? "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/u, ""))
    .join("\n")
    .trim();

  process.stdout.write(`${text === "" ? "No help available." : text}\n`);
};

let programName = "playtest";

export const setProgramName = (name: string) => {
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

let held: HeldInputs | null = null;

/**
 * Record that `inputs` are about to be pressed. Call BEFORE dispatching: an
 * eval that fails part-way through can still have pressed something, and an
 * input this process never releases stays held in the daemon's page.
 */
export const claimHeld = (inputs: HeldInputs) => {
  held = inputs;
};

/** Record that the held inputs have been released — once the release LANDED. */
export const disownHeld = () => {
  held = null;
};

export const releaseHeldInputs = () => {
  const inputs = held;
  held = null;

  if (inputs === null) {
    return;
  }

  const parts = [
    "clearInterval(window.__BOT_TICK__);",
    ...keyParts("keyup", inputs.keys ?? []),
    ...pointerParts(inputs.pointer, "up"),
  ];

  spawnSync("vg", ["playtest", "eval", `(() => { ${parts.join("\n")}\nreturn true; })()`], {
    encoding: "utf-8",
    timeout: 30_000,
  });
};

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    releaseHeldInputs();
    process.exit(HARNESS_FAILURE);
  });
}

export const fail: (message: string) => never = (message) => {
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
} satisfies Record<string, number>;

const NAMED_VALUES = new Map(
  Object.entries({
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
  }),
);

const KEY_CODES = new Map(Object.entries(NAMED_KEYS));

const SHIFTED = new Map(
  Object.entries({
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
  }),
);

const shiftedKey = (code: string, key: string) => {
  if (/^Key[A-Z]$/u.test(code)) {
    return key.toUpperCase();
  }

  return SHIFTED.get(code) ?? key;
};

/** `keyCode` and `key` for a KeyboardEvent `code`. Fails naming an unsupported code. */
export const keyFields = (code: string) => {
  const letter = /^Key(?<letter>[A-Z])$/u.exec(code)?.groups?.letter;

  if (letter !== undefined) {
    const fields: [number, string] = [letter.codePointAt(0) ?? 0, letter.toLowerCase()];

    return fields;
  }

  const digit = /^Digit(?<digit>[0-9])$/u.exec(code)?.groups?.digit;

  if (digit !== undefined) {
    const fields: [number, string] = [48 + Number(digit), digit];

    return fields;
  }

  const keyCode = KEY_CODES.get(code);

  if (keyCode !== undefined) {
    const fields: [number, string] = [keyCode, NAMED_VALUES.get(code) ?? code];

    return fields;
  }

  return fail(
    `unsupported key code "${code}". Supported: Key<A-Z>, Digit<0-9>, and ${Object.keys(NAMED_KEYS).join(", ")}.`,
  );
};

const keyInits = (codes: string[]) => {
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
export const keyParts = (type: "keydown" | "keyup", codes: string[]) => {
  if (codes.length === 0) {
    return [];
  }

  return [
    `{ const t = document.activeElement ?? document.body ?? window;
      for (const init of [${keyInits(codes).join(",")}]) t.dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, init)); }`,
  ];
};

const POINTER_FN = `window.__botPointer = (frac, type, buttons) => {
  const cx = Math.round(window.innerWidth * frac.x);
  const cy = Math.round(window.innerHeight * frac.y);
  const target = document.elementFromPoint(cx, cy) || document.querySelector("canvas") || window;
  const init = { clientX: cx, clientY: cy, screenX: cx, screenY: cy, bubbles: true, cancelable: true, composed: true, pointerId: 1, isPrimary: true, pointerType: "mouse", button: 0, buttons };
  target.dispatchEvent(new PointerEvent(type, init));
  target.dispatchEvent(new MouseEvent(type === "pointermove" ? "mousemove" : type === "pointerdown" ? "mousedown" : "mouseup", init));
};`;

const pointerCall = (pointer: Pointer, type: string, buttons: number) =>
  `window.__botPointer(${JSON.stringify({ x: pointer.x, y: pointer.y })}, ${JSON.stringify(type)}, ${buttons});`;

/** In-page source moving/pressing (`"down"`) or releasing (`"up"`) the cursor. */
export const pointerParts = (pointer: Pointer | undefined, phase: "down" | "up") => {
  if (pointer === undefined) {
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

const isFraction = (v: JsonValue | undefined): v is number =>
  isFiniteJsonNumber(v) && v >= 0 && v <= 1;

/**
 * Check a `pointer` before anything launches. Fractions of the viewport, so a
 * script isn't tied to one window size; pixels are the tempting mistake, and
 * they'd silently aim off-screen.
 */
export const validatePointer = (pointer: JsonValue, where: string) => {
  const { x, y, down } = isJsonObject(pointer) ? pointer : {};

  if (!isFraction(x)) {
    return fail(`${where}: \`pointer.x\` must be a viewport fraction between 0 and 1.`);
  }

  if (!isFraction(y)) {
    return fail(`${where}: \`pointer.y\` must be a viewport fraction between 0 and 1.`);
  }

  if (down !== undefined && down !== true && down !== false) {
    return fail(`${where}: \`pointer.down\` must be a boolean.`);
  }

  const checked: Pointer = down === undefined ? { x, y } : { down, x, y };

  return checked;
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
export const sleep = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** Run one `vg playtest` command. */
export const playtest = (args: string[]) => {
  const res = spawnSync("vg", ["playtest", ...args], { encoding: "utf-8", timeout: 120_000 });

  if (res.error !== undefined) {
    fail(`couldn't run \`vg playtest\` — is the vg CLI installed? (${res.error.message})`);
  }

  return { status: res.status ?? 1, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
};

const parseJson = (text: string, onError: () => never) => {
  try {
    return parseJsonText(text);
  } catch {
    return onError();
  }
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
export const payload = (args: string[], key: string) => {
  const command = args[0] ?? "";
  const { status, stdout, stderr } = playtest([...args, "--json"]);
  const text = stdout.trim();

  if (status !== 0) {
    const detail = stderr.trim();
    fail(`\`${command}\` failed: ${detail === "" ? text : detail}`);
  }

  const parsed = parseJson(text, () =>
    fail(`\`${command} --json\` did not return JSON: ${text.slice(0, 200)}`),
  );

  const envelope = isJsonObject(parsed) ? parsed : {};

  if (envelope.success === false) {
    fail(`\`${command}\` failed: ${JSON.stringify(envelope.error)}`);
  }

  const { data } = envelope;

  if (!isJsonObject(data) || !(key in data)) {
    return fail(
      `unexpected agent-browser response for \`${command}\` (no data.${key}): ${text.slice(0, 200)}`,
    );
  }

  return data[key];
};

export const evaluate = (expression: string) => payload(["eval", expression], "result");

const readConsoleErrors = () => {
  const entries = payload(["console"], "messages");

  if (!Array.isArray(entries)) {
    return fail("`console` returned a non-array `messages`.");
  }

  return entries
    .filter((entry) => isJsonObject(entry) && entry.type === "error")
    .map((entry) => (isJsonObject(entry) ? entry.text : undefined) ?? JSON.stringify(entry));
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
    return fail("`errors` returned a non-array `errors`.");
  }

  return { consoleErrors, pageErrors };
};

const numberIn = (fields: JsonObject, name: string, what: string) => {
  const value = fields[name];

  if (!isFiniteJsonNumber(value)) {
    return fail(`${what} read a non-number \`${name}\`: ${JSON.stringify(fields)}`);
  }

  return value;
};

/** Read an in-page `__botRead()` result, failing on a shape it can't produce. */
export const readSample = (value: JsonValue | undefined, what: string) => {
  if (!isJsonObject(value)) {
    return fail(`${what} was not an object: ${JSON.stringify(value)}`);
  }

  const sample: Sample = {
    complete: value.complete === true,
    frame: numberIn(value, "frame", what),
    score: numberIn(value, "score", what),
    x: numberIn(value, "x", what),
    y: numberIn(value, "y", what),
    z: numberIn(value, "z", what),
  };

  return sample;
};

/** Read a `TRACK_SUMMARY` result: null when the page lost the tracker. */
export const readSummary = (value: JsonValue | undefined, what: string) => {
  if (value === null) {
    return null;
  }

  const sample = readSample(value, what);
  const fields = isJsonObject(value) ? value : {};

  const summary: StepSummary = {
    ...sample,
    frameBefore: numberIn(fields, "frameBefore", what),
    path: numberIn(fields, "path", what),
    peak: numberIn(fields, "peak", what),
    scoreBefore: numberIn(fields, "scoreBefore", what),
  };

  return summary;
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

  const { renderer, vendor } = isJsonObject(info) ? info : {};

  if (!isJsonString(renderer)) {
    return { renderer: null, softwareRendered: null, vendor: null };
  }

  return {
    renderer,
    softwareRendered: /swiftshader|llvmpipe|software|basic render/iu.test(renderer),
    vendor: isJsonString(vendor) ? vendor : null,
  };
};

const CONTRACT_READY =
  "window.__GAME_DIAGNOSTICS__ !== undefined && window.__GAME_TEST_HOOKS__ !== undefined";

const boot = (target: string[], headed: boolean, whenAbsent: string) => {
  playtest(["console", "--clear"]);
  playtest(["errors", "--clear"]);

  const open = playtest(["open", ...target, ...(headed ? ["--headed"] : [])]);

  if (open.status !== 0) {
    const detail = open.stderr.trim();
    fail(`couldn't open the game: ${detail === "" ? open.stdout.trim() : detail}`);
  }

  if (playtest(["wait", "--fn", CONTRACT_READY]).status !== 0) {
    fail(whenAbsent);
  }
};

const applySeed = (seed: number, headed: boolean) => {
  const boot0 = evaluate(
    "({ hasSeedHook: typeof window.__GAME_TEST_HOOKS__?.seed === 'function', href: location.href })",
  );

  const { hasSeedHook, href } = isJsonObject(boot0) ? boot0 : {};

  if (hasSeedHook === true) {
    return "hook";
  }

  if (!isJsonString(href)) {
    return fail("couldn't read location.href to apply the seed.");
  }

  const url = new URL(href);
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
export const launch = ({
  headed,
  seed,
  target,
}: {
  headed: boolean;
  seed: number;
  target: string[];
}) => {
  boot(
    target,
    headed,
    "the game never published window.__GAME_DIAGNOSTICS__ / window.__GAME_TEST_HOOKS__. Either it crashed on boot, or it doesn't implement the diagnostics contract (see references/scripted-playtest.md).",
  );

  const seedApplied = applySeed(seed, headed);

  const ack = evaluate(
    `(async () => { const h = window.__GAME_TEST_HOOKS__; h.seed?.(${seed}); const ack = await h.setState?.('active-play'); window.__BOT_F0__ = h && window.__GAME_DIAGNOSTICS__.frame; return ack === undefined ? null : ack; })()`,
  );

  if (ack !== null && (!isJsonObject(ack) || ack.state !== "active-play")) {
    fail(
      `setState('active-play') acknowledged ${JSON.stringify(ack)} instead of { state: 'active-play' } — the hook applied a different state or is a no-op (see references/scripted-playtest.md).`,
    );
  }

  const live = playtest([
    "wait",
    "--fn",
    "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10 && window.__GAME_DIAGNOSTICS__.frame !== window.__BOT_F0__",
  ]);

  if (live.status !== 0) {
    fail(
      "diagnostics are published but the loop never advanced after seed()/setState('active-play') — check they aren't no-ops (see references/scripted-playtest.md).",
    );
  }

  return { before: readSample(evaluate(SAMPLE), "the baseline sample"), seedApplied };
};
