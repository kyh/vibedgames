// Bot-playtest diagnostics contract (see the playwright skill's
// references/bot-playtest.md and the lunerfall reference implementation):
// __GAME_DIAGNOSTICS__ is read-only per-frame telemetry, __GAME_TEST_HOOKS__
// are the mutations a test may perform. Always exposed, like the existing
// __game probe — JSON-serializable primitives only, one object mutated in
// place (no per-frame allocation).
//
// Starfall-specific hook shape:
// - No `seed(n)` hook: GameScene is single-start by design (create() fields
//   assume one boot per page load), so an honest mid-run reseed+restart isn't
//   possible. Seeding uses the contract's boot-time alternative instead — a
//   `?seed=N` query param read in main.ts before the game constructs.
// - `setPausedForScreenshot` is OFFLINE-ONLY: it rides the same real freeze as
//   the wrapper pause (pausable sim clock in shared/clock.ts + loop sleep), so
//   every stored deadline holds and nothing teleports on resume. Online it's a
//   no-op — freezing the shared world would stall the other players.
// - `setState('active-play')` forces the offline solo fallback immediately
//   (instead of waiting out the 4s connect grace) and dismisses the start
//   overlay. Online play is untouched: the hook only ever runs when a test
//   calls it.

export type Diagnostics = {
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
};

export const diag: Diagnostics = {
  frame: 0,
  score: 0,
  complete: false,
  player: { x: 0, y: 0, speed: 0 },
  entities: 0,
  beams: 0,
  beacon: null,
};

export type TestHooks = {
  setState(name: string): void;
  setPausedForScreenshot(paused: boolean): void;
};

export function installTestHooks(hooks: {
  activePlay(): void;
  /** Offline-only real freeze (see header). No-op while online. */
  setPaused(paused: boolean): void;
}): void {
  Reflect.set(globalThis, "__GAME_DIAGNOSTICS__", diag);
  const testHooks: TestHooks = {
    setState(name: string): void {
      if (name === "active-play") hooks.activePlay();
    },
    setPausedForScreenshot(paused: boolean): void {
      hooks.setPaused(paused);
    },
  };
  Reflect.set(globalThis, "__GAME_TEST_HOOKS__", testHooks);
}
