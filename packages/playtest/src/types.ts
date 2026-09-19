/**
 * The playtest contract, as types. Three window globals let a browser
 * playtest — `vg playtest`, its scripted bot and the model behind
 * `vg playtest run` — measure and drive a game instead of guessing from
 * pixels:
 *
 * - `window.__GAME_DIAGNOSTICS__` — live, read-only state ({@link Diagnostics})
 * - `window.__GAME_TEST_HOOKS__` — the mutations a playtest may perform ({@link TestHooks})
 * - `window.__GAME_PLAYTEST__` — the controls, in words a model chooses between ({@link PlaytestManifest})
 *
 * The globals ARE the contract; this package only types and publishes them,
 * so a game can also set them by hand and nothing here is required.
 */

/**
 * What a playtest reads every frame. Primitives only — never engine objects:
 * the whole thing is JSON-serialised and, under `vg playtest run`, sent to
 * the decision model several times a second. Add whatever a player can see
 * that a decision needs (the nearest hazard as `dx`/`dy`, where the goal is,
 * `canJump`); the fields here are the ones every playtest relies on.
 */
export interface Diagnostics {
  /** The loop's heartbeat: incremented once per simulated frame. */
  frame: number;
  /** The objective metric — points, distance, waves, gems. Monotonic, so `after > before` is sound. */
  score: number;
  /** A win or a fail state has been reached; the run is over. */
  complete: boolean;
  /**
   * Where the player is, in world units — any of x/y/z; a missing axis reads
   * as 0, so a game whose travel is on x/z publishes just those. `null` while
   * there is no player (a menu, a respawn).
   */
  player?: PlayerPosition | null;
  /** How many live entities the sim is tracking (a cheap load signal). */
  entities?: number;
}

export interface PlayerPosition {
  x?: number;
  y?: number;
  z?: number;
}

/** The mutations a playtest may perform. Gate them behind dev mode or `?test=1` if you like. */
export interface TestHooks {
  /**
   * Reseed the RNG AND restart the run, so everything measured afterwards is
   * seeded. Optional: a game whose scene can only start once leaves it out,
   * and the playtest reloads the page with `?seed=<n>` instead.
   */
  seed?: (seed: number) => void;
  /**
   * Jump to a named state — `'active-play'` skips the menu. Return `{ state }`
   * once applied; a Promise is awaited, for a game that has to finish loading
   * or build a scene first.
   */
  setState: (name: string) => SetStateResult | Promise<SetStateResult>;
  /** Freeze the simulation for a deterministic screenshot, and thaw it. */
  setPausedForScreenshot?: (paused: boolean) => void;
  /** Turn off screen shake, particles and other visual noise a diff would catch. */
  setReducedMotion?: (enabled: boolean) => void;
}

export type SetStateResult = { state: string } | undefined;

/**
 * A pointer position in viewport fractions — `0..1` on each axis, so a
 * manifest isn't tied to one window size — optionally with the button held.
 */
export interface PlaytestPointer {
  x: number;
  y: number;
  down?: boolean;
}

/** What a reflex hands back each frame: KeyboardEvent codes to hold and/or where the pointer is. */
export interface ReflexInputs {
  keys?: string[];
  pointer?: PlaytestPointer | null;
}

/**
 * A per-frame controller for one move. While that move is the model's current
 * intent, `vg playtest run` calls the reflex every frame with the live
 * diagnostics and holds whatever it returns — the model decides *what* a few
 * times a second, the reflex does it at 60 fps. Return `null` to hold nothing.
 */
export type Reflex<TGame extends Diagnostics = Diagnostics> = (
  game: TGame | null,
) => ReflexInputs | null | undefined;

/**
 * One movement option. Exactly one is held at a time, until the next
 * decision. `description` is literally the criterion the model chooses by,
 * so write it as a coach would: "run right, towards the flag".
 */
export interface MoveOption<TGame extends Diagnostics = Diagnostics> {
  description: string;
  /** KeyboardEvent codes held together while this is the chosen move. */
  keys?: string[];
  /** Where to park the pointer, for games that steer from the cursor. */
  pointer?: PlaytestPointer;
  /** The fast-game path: what to hold, recomputed every frame. Overrides `keys`/`pointer`. */
  reflex?: Reflex<TGame>;
}

/** An independent yes/no verb, held for the tick when the model says yes. Keys only. */
export interface ActionOption {
  description: string;
  keys: string[];
}

/**
 * What `vg playtest run` may do to the game, in the words the decision model
 * chooses between. The same shape, minus `reflex`, works as a `--controls`
 * JSON file for a game you can't edit.
 */
export interface PlaytestManifest<TGame extends Diagnostics = Diagnostics> {
  /** The rules: what wins, what kills, which way progress is, what the diagnostic fields mean. */
  goal: string;
  /**
   * One `choice` per decision. Declare a no-input option only if standing
   * still is a real play: given a thin state the model picks it every tick.
   */
  move: Record<string, MoveOption<TGame>>;
  /** One yes/no per decision, each. */
  actions?: Record<string, ActionOption>;
  /**
   * The per-decision movement that proves input reaches the player, in the
   * units of `player.x/y/z`. Defaults to 5, which suits pixels; a game that
   * measures in world units (most 3D games) should set what one decision's
   * worth of movement really is there, or the run fails as "did not respond
   * to input".
   */
  minDisplacement?: number;
}

/** The three globals, on whatever object stands in for `window`. */
export interface PlaytestTarget {
  __GAME_DIAGNOSTICS__?: Diagnostics;
  __GAME_TEST_HOOKS__?: TestHooks;
  __GAME_PLAYTEST__?: PlaytestManifest;
}
