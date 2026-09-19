// Playtest contract (see the playtest skill's references/scripted-playtest.md and
// autonomous-playtest.md): __GAME_DIAGNOSTICS__ is read-only per-frame telemetry,
// __GAME_TEST_HOOKS__ are the mutations a test may perform. Diagnostics are
// always exposed, like the existing __game probe — JSON-serializable
// primitives only. The hooks and the manifest (sys/playtest-manifest.ts) only
// exist in dev or under `?test=1`.
//
// Starfall-specific hook shape:
// - `seed(n)` reseeds the gameplay stream and restarts the run as a fresh
//   OFFLINE solo arena. A `?seed=N` boot param (main.ts) seeds before the first
//   roll too.
// - `setPausedForScreenshot` is OFFLINE-ONLY: it rides the same real freeze as
//   the wrapper pause (pausable sim clock in shared/clock.ts + loop sleep), so
//   every stored deadline holds and nothing teleports on resume. Online it's a
//   no-op — freezing the shared world would stall the other players.
// - `setState('active-play')` forces the offline solo fallback immediately
//   (instead of waiting out the 4s connect grace) and dismisses the start
//   overlay. Online play is untouched: the hook only ever runs when a test
//   calls it.

import { isPlaytestRequested, publishDiagnostics, publishTestHooks } from "@vibedgames/playtest";
import type { SetStateResult } from "@vibedgames/playtest";

/** True when the playtest surface (hooks, manifest, rich senses) is live. */
export const PLAYTEST_SURFACE = import.meta.env.DEV || isPlaytestRequested();

/** Something near the ship, as a vector FROM the ship (screen axes: +dx right,
 *  +dy down), px. */
export interface Contact {
  kind: string;
  dx: number;
  dy: number;
  /** Centre-to-centre distance. */
  dist: number;
}

export interface Target extends Contact {
  /** Where to point the nose to hit it: the contact led by the shot's flight
   *  time, still relative to the ship. */
  aimDx: number;
  aimDy: number;
  /** Hull radius (an asteroid shrinks as it is chipped). */
  radius: number;
}

export interface Threat extends Contact {
  /** Free space between my hull and its hull; ≤ 0 is a collision. */
  gap: number;
  /** Closing speed along the line between us, px/s; positive = approaching. */
  closing: number;
}

export interface Diagnostics {
  frame: number;
  /** Run XP — the objective metric: cumulative XP earned this run. Monotonic
   *  (never drops on level-up or the death tax), so `after > before` is a
   *  sound progression assertion. */
  score: number;
  /** Always false: starfall is endless (death respawns, a run never "ends"). */
  complete: boolean;
  player: { x: number; y: number; speed: number };
  /** Live hostiles: enemies + asteroids in the local world. */
  entities: number;
  /** My live beams — lets a bot assert an input path actually fires
   *  (qa-005: held SPACE must autofire with no pointer down). */
  beams: number;
  /** BEACON arena event (dir-004): null between events. One small allocation
   *  per frame WHILE a beacon is live (~48s per ~180s) — the QA-probe value of
   *  phase/controller visibility outweighs the contract's no-alloc lean. */
  beacon: {
    x: number;
    y: number;
    phase: "charge" | "active";
    controllerId: string | null;
    contested: boolean;
  } | null;
  // What a player reads off the screen. Filled only under PLAYTEST_SURFACE, so
  // a real player's frame pays nothing for it.
  alive: boolean;
  /** ms until the ship respawns; 0 while alive. */
  respawnInMs: number;
  /** Respawn invulnerability: nothing can hurt the ship. */
  invulnerable: boolean;
  /** Shield is the health bar: 0 = the next hit kills. */
  shield: number;
  shieldMax: number;
  level: number;
  weapon: string;
  firing: boolean;
  /** Degrees between the nose and the led aim line to `target`; 0 = dead on. */
  aimErrorDeg: number;
  /** What to shoot: the nearest enemy when one is close, else the nearest rock. */
  target: Target | null;
  /** Nearest things that hurt on contact, tightest gap first. */
  threats: Threat[];
  /** Nearest pickups: XP orbs, weapons, shield mods, boosters. */
  pickups: Contact[];
  /** Distance from the ship to each arena wall. */
  walls: { left: number; right: number; up: number; down: number };
  /** Viewport in CSS px and camera zoom: the ship sits at its centre, so a
   *  relative vector maps to a pointer position through these. */
  view: { w: number; h: number; zoom: number };
}

export const diag: Diagnostics = {
  aimErrorDeg: 0,
  alive: false,
  beacon: null,
  beams: 0,
  complete: false,
  entities: 0,
  firing: false,
  frame: 0,
  invulnerable: false,
  level: 1,
  pickups: [],
  player: { speed: 0, x: 0, y: 0 },
  respawnInMs: 0,
  score: 0,
  shield: 0,
  shieldMax: 0,
  target: null,
  threats: [],
  view: { h: 0, w: 0, zoom: 1 },
  walls: { down: 0, left: 0, right: 0, up: 0 },
  weapon: "",
};

export const installTestHooks = (hooks: {
  activePlay: () => void;
  /** Reseed the gameplay stream and restart as a fresh offline solo run. */
  restart: (seed: number) => void;
  /** Offline-only real freeze (see header). No-op while online. */
  setPaused: (paused: boolean) => void;
}): void => {
  publishDiagnostics(() => diag);
  if (!PLAYTEST_SURFACE) {
    return;
  }
  publishTestHooks({
    seed(seed: number): void {
      hooks.restart(seed);
    },
    setPausedForScreenshot(paused: boolean): void {
      hooks.setPaused(paused);
    },
    setState(name: string): SetStateResult {
      if (name === "active-play") {
        hooks.activePlay();
        return { state: name };
      }
    },
  });
};
