/**
 * The pilot's browser: agent-browser, driven directly rather than through
 * `vg playtest`. Each `vg playtest` call is a node start plus a version probe
 * (~230 ms); the binary itself answers an eval in under 10 ms, and a pilot
 * that decides several times a second can't afford the wrapper.
 *
 * Holds the in-page motion tracker and the record of what is currently
 * pressed, so an early exit can release it: a keydown left dangling stays
 * stuck in the game and poisons the next run against the same daemon.
 */

import { spawnSync } from "node:child_process";

import type { JsonValue } from "../types.js";
import { isJsonObject, isJsonString } from "../types.js";
import type { HeldInputs } from "./controls.js";
import { NOTHING_HELD } from "./controls.js";
import { HarnessError } from "./errors.js";
import { keyParts, pointerParts, samePointer } from "./keys.js";

/** How often the in-page tracker samples player state. */
const SAMPLE_MS = 40;

/**
 * Read player state the same way at every sample site. All three axes,
 * defaulting to 0, so a game whose travel is on x/z isn't read as motionless.
 */
const READ_FN = `const __botRead = () => {
  const d = window.__GAME_DIAGNOSTICS__, p = (d && d.player) || {};
  return { x: p.x ?? 0, y: p.y ?? 0, z: p.z ?? 0, frame: (d && d.frame) ?? 0, score: (d && d.score) ?? 0, complete: !!(d && d.complete) };
};
const __botDist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);`;

/**
 * Start sampling player state inside the page. Peak displacement and path
 * length across a window are what tell a real stuck-on-geometry case from a
 * round trip — net displacement is zero for a jump that works perfectly.
 */
const TRACK_BEGIN = `{
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
  }, ${SAMPLE_MS});
}`;

/**
 * Fold the latest sample in, summarise the window since the last flush, and
 * start a new window from here WITHOUT stopping the sampler — the next
 * window begins immediately, so nothing between decisions is lost.
 */
const FLUSH = `(() => {
  const t = window.__BOT_TRACK__;
  if (!t) return null;
  const c = __botRead();
  t.path += __botDist(c, t.last);
  const out = { path: +t.path.toFixed(3), peak: +Math.max(t.peak, __botDist(c, t.start)).toFixed(3), frameBefore: t.start.frame, frame: c.frame, scoreBefore: t.start.score, score: Math.max(t.score, c.score), x: c.x, y: c.y, z: c.z, complete: c.complete };
  t.start = c; t.last = c; t.path = 0; t.peak = 0; t.score = c.score;
  return out;
})()`;

/** A JSON-safe copy of the game's diagnostics, or null if they can't be serialized. */
const SNAPSHOT = `(() => { try { return JSON.parse(JSON.stringify(window.__GAME_DIAGNOSTICS__ ?? null)); } catch { return null; } })()`;

const CONTRACT_READY =
  "window.__GAME_DIAGNOSTICS__ !== undefined && window.__GAME_TEST_HOOKS__ !== undefined";

/** What moved during one tracked window. */
export interface Window {
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

/** The run's baseline, read the same way the tracker reads. */
export interface Sample {
  frame: number;
  score: number;
  complete: boolean;
}

export interface TickResult {
  window: Window;
  game: JsonValue;
}

export interface GpuInfo {
  renderer: string | null;
  softwareRendered: boolean | null;
  vendor: string | null;
}

const num = (value: JsonValue | undefined): number => (Number.isFinite(value) ? Number(value) : 0);

const readWindow = (value: JsonValue): Window | null => {
  if (!isJsonObject(value)) {
    return null;
  }
  return {
    complete: value.complete === true,
    frame: num(value.frame),
    frameBefore: num(value.frameBefore),
    path: num(value.path),
    peak: num(value.peak),
    score: num(value.score),
    scoreBefore: num(value.scoreBefore),
    x: num(value.x),
    y: num(value.y),
    z: num(value.z),
  };
};

export interface LaunchOptions {
  url: string;
  seed: number;
  headed: boolean;
}

export interface Launched {
  before: Sample;
  seedApplied: "hook" | "boot-param";
  /** The game's own `window.__GAME_PILOT__`, if it publishes one. */
  manifest: JsonValue | null;
}

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export class GameBrowser {
  private held: HeldInputs | null = null;
  private readonly bin: string;
  private readonly session: string;

  constructor(bin: string, session: string) {
    this.bin = bin;
    this.session = session;
  }

  /** Run one agent-browser command in this session. */
  run(args: string[]): CommandResult {
    const res = spawnSync(this.bin, ["--session", this.session, ...args], {
      encoding: "utf-8",
      timeout: 120_000,
    });
    if (res.error) {
      throw new HarnessError(`couldn't run the playtest browser (${res.error.message}).`);
    }
    return { status: res.status ?? 1, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
  }

  /**
   * Read the payload of a `--json` command. agent-browser wraps every JSON
   * response as `{ success, data, error }`, with the command's payload under
   * `data` — `data.result` for `eval`, `data.messages` for `console`.
   * Verified against agent-browser 0.34. A shape this doesn't recognize is a
   * harness failure, not something to guess around.
   */
  payload(args: string[], key: string): JsonValue {
    const { status, stdout, stderr } = this.run([...args, "--json"]);
    const text = stdout.trim();
    if (status !== 0) {
      throw new HarnessError(`\`${args[0]}\` failed: ${stderr.trim() || text}`);
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new HarnessError(`\`${args[0]} --json\` did not return JSON: ${text.slice(0, 200)}`);
    }
    if (!isJsonObject(parsed)) {
      throw new HarnessError(`unexpected response for \`${args[0]}\`: ${text.slice(0, 200)}`);
    }
    if (parsed.success === false) {
      throw new HarnessError(`\`${args[0]}\` failed: ${JSON.stringify(parsed.error)}`);
    }
    const { data } = parsed;
    if (!isJsonObject(data) || !(key in data)) {
      throw new HarnessError(
        `unexpected agent-browser response for \`${args[0]}\` (no data.${key}): ${text.slice(0, 200)}`,
      );
    }
    return data[key] ?? null;
  }

  evaluate(expression: string): JsonValue {
    return this.payload(["eval", expression], "result");
  }

  /**
   * Navigate and wait for the diagnostics contract. Logs are cleared BEFORE
   * navigating so boot errors belong to this run. Waits for the CONTRACT,
   * not for frames: most games boot into a menu where the loop hasn't
   * started, so frames only advance once setState('active-play') has run.
   */
  private boot(url: string, headed: boolean, whenAbsent: string): void {
    this.run(["console", "--clear"]);
    this.run(["errors", "--clear"]);
    const open = this.run(["open", url, ...(headed ? ["--headed"] : [])]);
    if (open.status !== 0) {
      throw new HarnessError(`couldn't open the game: ${open.stderr.trim() || open.stdout.trim()}`);
    }
    if (this.run(["wait", "--fn", CONTRACT_READY]).status !== 0) {
      throw new HarnessError(whenAbsent);
    }
  }

  /**
   * Two ways a game can honour a seed: a `seed()` hook that restarts the run,
   * or a `?seed=` boot param for games whose scene is single-start. Calling
   * an absent hook would leave the run unseeded while the report still
   * claimed the seed, so detect which one this game implements.
   */
  private applySeed(seed: number, headed: boolean): "hook" | "boot-param" {
    const probe = this.evaluate(
      "({ hasSeedHook: typeof window.__GAME_TEST_HOOKS__?.seed === 'function', href: location.href })",
    );
    if (isJsonObject(probe) && probe.hasSeedHook === true) {
      return "hook";
    }
    const href = isJsonObject(probe) ? probe.href : undefined;
    if (!isJsonString(href)) {
      throw new HarnessError("couldn't read location.href to apply the seed.");
    }
    const url = new URL(href);
    url.searchParams.set("seed", String(seed));
    this.boot(
      url.toString(),
      headed,
      "the game stopped publishing diagnostics after the seeded reload.",
    );
    return "boot-param";
  }

  /** Open the game, seed it, start a run and wait for the loop to be live. */
  launch({ url, seed, headed }: LaunchOptions): Launched {
    this.boot(
      url,
      headed,
      "the game never published window.__GAME_DIAGNOSTICS__ / window.__GAME_TEST_HOOKS__. Either it crashed on boot, or it doesn't implement the diagnostics contract (see the playtest skill's references/pilot-playtest.md).",
    );
    const seedApplied = this.applySeed(seed, headed);

    // seed() must RESTART the run — frames rendered before it were unseeded.
    // setState('active-play') is what leaves the menu. Stash the frame it
    // left off at so the wait below proves the loop moved *after* the hooks.
    const ack = this.evaluate(
      `(async () => { const h = window.__GAME_TEST_HOOKS__; h.seed?.(${seed}); const ack = await h.setState?.('active-play'); window.__BOT_F0__ = h && window.__GAME_DIAGNOSTICS__.frame; return ack === undefined ? null : ack; })()`,
    );
    // The ack is optional (void hooks keep working) but asserted when present.
    if (ack !== null && (!isJsonObject(ack) || ack.state !== "active-play")) {
      throw new HarnessError(
        `setState('active-play') acknowledged ${JSON.stringify(ack)} instead of { state: 'active-play' } — the hook applied a different state or is a no-op.`,
      );
    }
    const live = this.run([
      "wait",
      "--fn",
      "(window.__GAME_DIAGNOSTICS__?.frame ?? 0) > 10 && window.__GAME_DIAGNOSTICS__.frame !== window.__BOT_F0__",
    ]);
    if (live.status !== 0) {
      throw new HarnessError(
        "diagnostics are published but the loop never advanced after seed()/setState('active-play') — check they aren't no-ops.",
      );
    }

    const sample = this.evaluate(`(() => { ${READ_FN} return __botRead(); })()`);
    const before: Sample = isJsonObject(sample)
      ? { complete: sample.complete === true, frame: num(sample.frame), score: num(sample.score) }
      : { complete: false, frame: 0, score: 0 };
    const manifest = this.evaluate(
      "(() => { try { return JSON.parse(JSON.stringify(window.__GAME_PILOT__ ?? null)); } catch { return null; } })()",
    );
    return { before, manifest, seedApplied };
  }

  /** The game's diagnostics right now, and start the motion tracker. */
  start(): JsonValue {
    return this.evaluate(`(() => { ${READ_FN} ${TRACK_BEGIN} return ${SNAPSHOT}; })()`);
  }

  /**
   * Switch the held inputs to `next`, then report what moved since the last
   * flush (everything under the previous inputs) and what the game looks
   * like now — one round trip. Claims `next` BEFORE dispatching: an eval that
   * fails part-way can still have pressed something.
   */
  apply(next: HeldInputs): TickResult {
    const prev = this.held ?? NOTHING_HELD;
    const release = prev.keys.filter((code) => !next.keys.includes(code));
    const press = next.keys.filter((code) => !prev.keys.includes(code));
    const pointerChanged = !samePointer(prev.pointer, next.pointer);
    const parts = [
      READ_FN,
      `const w = ${FLUSH};`,
      ...(pointerChanged ? pointerParts(prev.pointer, "up") : []),
      ...keyParts("keyup", release),
      ...(pointerChanged ? pointerParts(next.pointer, "down") : []),
      ...keyParts("keydown", press),
      `return { window: w, game: ${SNAPSHOT} };`,
    ];
    this.held = next;
    const result = this.evaluate(`(() => { ${parts.join("\n")} })()`);
    const window = isJsonObject(result) ? readWindow(result.window ?? null) : null;
    if (!window) {
      throw new HarnessError("the page lost its in-page tracker; it probably navigated mid-run.");
    }
    return { game: isJsonObject(result) ? (result.game ?? null) : null, window };
  }

  /** Release everything, stop the sampler, and return the final window. */
  finish(): Window | null {
    const held = this.held ?? NOTHING_HELD;
    const parts = [
      READ_FN,
      ...keyParts("keyup", held.keys),
      ...pointerParts(held.pointer, "up"),
      `const out = ${FLUSH};`,
      "clearInterval(window.__BOT_TICK__);",
      "return out;",
    ];
    const result = this.evaluate(`(() => { ${parts.join("\n")} })()`);
    // Only disown once the release has actually landed.
    this.held = null;
    return readWindow(result);
  }

  /**
   * Best-effort release on the failure path: one eval, raw spawn, no throw.
   * Disowns before dispatching so a release that itself fails can't recurse.
   */
  releaseHeldInputs(): void {
    const { held } = this;
    this.held = null;
    if (!held) {
      return;
    }
    const parts = [
      "clearInterval(window.__BOT_TICK__);",
      ...keyParts("keyup", held.keys),
      ...pointerParts(held.pointer, "up"),
    ];
    spawnSync(
      this.bin,
      ["--session", this.session, "eval", `(() => { ${parts.join("\n")}\nreturn true; })()`],
      { encoding: "utf-8", timeout: 30_000 },
    );
  }

  /** Console messages at error level — `console` returns every level. */
  consoleErrors(): string[] {
    const entries = this.payload(["console"], "messages");
    if (!Array.isArray(entries)) {
      throw new HarnessError("`console` returned a non-array `messages`.");
    }
    return entries
      .filter((entry) => isJsonObject(entry) && entry.type === "error")
      .map((entry) =>
        isJsonObject(entry) && isJsonString(entry.text) ? entry.text : JSON.stringify(entry),
      );
  }

  /** Uncaught page errors. */
  pageErrors(): JsonValue[] {
    const errors = this.payload(["errors"], "errors");
    if (!Array.isArray(errors)) {
      throw new HarnessError("`errors` returned a non-array `errors`.");
    }
    return errors;
  }

  /**
   * Renderer string of the game's own WebGL context, so a SwiftShader run
   * can't pass as performance evidence.
   */
  gpuInfo(): GpuInfo {
    const info = this.evaluate(
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
    if (!isJsonObject(info) || !isJsonString(info.renderer)) {
      return { renderer: null, softwareRendered: null, vendor: null };
    }
    return {
      renderer: info.renderer,
      softwareRendered: /swiftshader|llvmpipe|software|basic render/iu.test(info.renderer),
      vendor: isJsonString(info.vendor) ? info.vendor : null,
    };
  }

  close(): void {
    this.run(["close"]);
  }
}
