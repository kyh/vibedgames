import type {
  ActionOption,
  Diagnostics,
  MoveOption,
  PlaytestManifest,
  PlaytestPointer,
  PlaytestTarget,
  Reflex,
  ReflexInputs,
  TestHooks,
} from "./types.js";

export type {
  ActionOption,
  Diagnostics,
  MoveOption,
  PlayerPosition,
  PlaytestManifest,
  PlaytestPointer,
  PlaytestTarget,
  Reflex,
  ReflexInputs,
  SetStateResult,
  TestHooks,
} from "./types.js";

// SAFETY: the three playtest globals are optional on PlaytestTarget, so any
// object — the browser's window included — satisfies it; nothing is read
// from it that the type does not declare.
const defaultTarget = (): PlaytestTarget => globalThis as PlaytestTarget;

/**
 * Publish `window.__GAME_DIAGNOSTICS__` as a live getter: `read()` runs on
 * every access, so the playtest always sees the current frame and the game
 * never copies state it isn't being asked for. Call once at boot.
 */
export const publishDiagnostics = <TGame extends Diagnostics>(
  read: () => TGame,
  target: PlaytestTarget = defaultTarget(),
): void => {
  Object.defineProperty(target, "__GAME_DIAGNOSTICS__", {
    configurable: true,
    enumerable: true,
    get: read,
  });
};

/** Publish `window.__GAME_TEST_HOOKS__`. Returns the hooks, typed as you passed them. */
export const publishTestHooks = <THooks extends TestHooks>(
  hooks: THooks,
  target: PlaytestTarget = defaultTarget(),
): THooks => {
  target.__GAME_TEST_HOOKS__ = hooks;
  return hooks;
};

/** Identity, for typing a manifest you build somewhere other than the `publishPlaytest` call. */
export const definePlaytest = <TGame extends Diagnostics>(
  manifest: PlaytestManifest<TGame>,
): PlaytestManifest<TGame> => manifest;

// Annotated on the identifier, not just the arrow: TypeScript only narrows
// after a never-returning call when the callee's declared type says so.
const fail: (message: string) => never = (message) => {
  throw new TypeError(`__GAME_PLAYTEST__ ${message}`);
};

const isText = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

const isFraction = (value: number | undefined): value is number =>
  value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;

const checkKeys = (keys: string[] | undefined, where: string): void => {
  if (keys !== undefined && !(Array.isArray(keys) && keys.every((key) => isText(key)))) {
    fail(
      `${where}: \`keys\` must be an array of KeyboardEvent codes ("KeyA", "ArrowLeft", "Space").`,
    );
  }
};

const checkPointer = (pointer: PlaytestPointer | undefined, where: string): void => {
  if (pointer === undefined) {
    return;
  }
  if (!isFraction(pointer.x) || !isFraction(pointer.y)) {
    fail(`${where}: \`pointer\` is in viewport fractions — x and y between 0 and 1, not pixels.`);
  }
};

// Realm-safe and typeof-free: a reflex from another frame is still a function.
const isFunction = <TGame extends Diagnostics>(value: Reflex<TGame>): boolean =>
  Object.prototype.toString.call(value) === "[object Function]";

const checkMove = <TGame extends Diagnostics>(label: string, option: MoveOption<TGame>): void => {
  const where = `move.${label}`;
  if (!isText(option.description)) {
    fail(`${where} needs a non-empty \`description\` — that is what the model decides from.`);
  }
  checkKeys(option.keys, where);
  checkPointer(option.pointer, where);
  if (option.reflex !== undefined && !isFunction(option.reflex)) {
    fail(`${where}: \`reflex\` must be a function of the live diagnostics.`);
  }
};

const checkAction = (label: string, option: ActionOption): void => {
  const where = `actions.${label}`;
  if (!isText(option.description)) {
    fail(`${where} needs a non-empty \`description\` — that is what the model decides from.`);
  }
  checkKeys(option.keys, where);
  if (option.keys.length === 0) {
    fail(`${where} needs a non-empty \`keys\` array; a pointer belongs on a \`move\` option.`);
  }
};

/**
 * Publish `window.__GAME_PLAYTEST__`, checking the parts `vg playtest run`
 * would otherwise reject at launch — a missing description, a pointer in
 * pixels — so the mistake surfaces in the game's own console first. Returns
 * the manifest.
 */
export const publishPlaytest = <TGame extends Diagnostics>(
  manifest: PlaytestManifest<TGame>,
  target: PlaytestTarget = defaultTarget(),
): PlaytestManifest<TGame> => {
  if (!isText(manifest.goal)) {
    fail("needs a `goal`: what wins, what kills, which way progress is.");
  }
  const moves = Object.entries(manifest.move);
  if (moves.length === 0) {
    fail("`move` must hold at least one option.");
  }
  for (const [label, option] of moves) {
    checkMove(label, option);
  }
  if (
    !moves.some(([, option]) => option.reflex || option.pointer || (option.keys?.length ?? 0) > 0)
  ) {
    fail("no `move` option holds any input, so the playtester could never move.");
  }
  for (const [label, option] of Object.entries(manifest.actions ?? {})) {
    checkAction(label, option);
  }
  const { minDisplacement } = manifest;
  if (minDisplacement !== undefined && !(Number.isFinite(minDisplacement) && minDisplacement > 0)) {
    fail("`minDisplacement` must be a positive number, in the units of player.x/y.");
  }
  // SAFETY: the manifest is generic over the game's own diagnostics type
  // only so its reflexes are typed at the call site; on the window it is
  // read by code that knows nothing of that type.
  target.__GAME_PLAYTEST__ = manifest as PlaytestManifest;
  return manifest;
};

interface LocationLike {
  location?: { search: string };
}

const readSearch = (): string => {
  // SAFETY: only `location.search` is read, and only if it exists; under
  // Node there is no location and the search is empty.
  const scope = globalThis as LocationLike;
  return scope.location?.search ?? "";
};

/**
 * Whether the page was opened with `?test=1` — the conventional switch for a
 * production build to expose the hooks and manifest to a playtest without
 * shipping them to players. Pair it with your dev flag:
 * `if (import.meta.env.DEV || isPlaytestRequested()) { … }`.
 */
export const isPlaytestRequested = (search = readSearch()): boolean =>
  new URLSearchParams(search).get("test") === "1";

export interface PointerTrackerOptions {
  /** Fraction of the error applied per frame. Higher closes faster and overshoots sooner. */
  gain?: number;
  /** Largest move per frame, in viewport fraction. */
  maxStep?: number;
  /** Where the pointer may travel to, in viewport fraction. */
  min?: number;
  max?: number;
  /** Where the pointer starts. */
  start?: number;
  /** The axis the tracker does not control. */
  y?: number;
  /** Hold the button down while tracking. */
  down?: boolean;
}

/** Walks a pointer along x by a signed error each frame; see {@link pointerTracker}. */
export type PointerTracker = (error: number) => ReflexInputs;

/**
 * The reflex everyone writes: walk the pointer until something the game
 * steers from the cursor sits where it should. Feed it the error each frame —
 * `target − current`, positive to move right — and hold what it returns.
 * Rather than inverting the game's pointer→world mapping, it nudges the
 * cursor by a fraction of the error and lets the game close the loop.
 *
 * @example
 * const track = pointerTracker();
 * track_ball: {
 *   description: "Follow the ball — keep the paddle under it every frame",
 *   reflex: (game) => (game ? track(game.ball.x - game.player.x) : null),
 * }
 */
export const pointerTracker = (options: PointerTrackerOptions = {}): PointerTracker => {
  const gain = options.gain ?? 0.03;
  const maxStep = options.maxStep ?? 0.04;
  const min = options.min ?? 0.05;
  const max = options.max ?? 0.95;
  const y = options.y ?? 0.5;
  const down = options.down ?? false;
  let x = options.start ?? 0.5;
  return (error) => {
    const step = Math.min(maxStep, Math.max(-maxStep, error * gain));
    x = Math.min(max, Math.max(min, x + (Number.isFinite(step) ? step : 0)));
    return { pointer: { down, x, y } };
  };
};

export interface KeyTapperOptions {
  /** Frames each tap stays down. */
  downFrames?: number;
  /** Frames between taps; the game has to see the key up to see the next keydown. */
  upFrames?: number;
}

/** Turns "tap these keys" into the keys to hold this frame; see {@link keyTapper}. */
export type KeyTapper = (codes: string[]) => string[];

/**
 * For verbs a game reads on the keydown EDGE — step one cell, rotate, flap,
 * fire a single shot. A reflex holds what it returns, and a key returned on
 * every frame is one long press: the game sees a single keydown. Call this
 * each frame with the keys to tap and hold what it gives back — the keys for
 * a few frames, then nothing for a few, so every cycle is a fresh keydown.
 * Pass `[]` on frames with nothing to tap.
 *
 * @example
 * const tap = keyTapper();
 * flap_through_gap: {
 *   description: "Fly through the next gap",
 *   reflex: (game) => ({ keys: tap(game && game.player.y > game.gap.y ? ["Space"] : []) }),
 * }
 */
export const keyTapper = (options: KeyTapperOptions = {}): KeyTapper => {
  const downFrames = Math.max(1, options.downFrames ?? 2);
  const upFrames = Math.max(1, options.upFrames ?? 2);
  let frame = 0;
  return (codes) => {
    if (codes.length === 0) {
      // The next request starts on a fresh press rather than mid-gap.
      frame = 0;
      return [];
    }
    const pressed = frame % (downFrames + upFrames) < downFrames;
    frame += 1;
    return pressed ? codes : [];
  };
};

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));

export interface PointerAimOptions {
  /** Where the player sits on screen, in viewport fraction. Camera-follow games: the centre. */
  centreX?: number;
  centreY?: number;
  /** How far from the centre to park the cursor, in viewport fraction of the shorter feel — 0.35 is "full tilt". */
  radius?: number;
  /** Hold the button down while aiming (mouse-fire, click-to-thrust). */
  down?: boolean;
}

/**
 * For games where the cursor is a heading — the ship flies towards it, the
 * hero aims at it — and the camera follows the player. Give it the world
 * vector to the target (`dx`, `dy` in the game's own units, y down) and it
 * parks the cursor in that direction from the player. Direction only: the
 * magnitude is `radius`, so no viewport size or camera zoom is needed.
 * A zero vector parks the cursor on the player.
 *
 * @example
 * attack: {
 *   description: "Fly at the nearest target, firing",
 *   reflex: (game) => (game?.target ? pointerAim(game.target.dx, game.target.dy, { down: true }) : null),
 * }
 */
export const pointerAim = (
  dx: number,
  dy: number,
  options: PointerAimOptions = {},
): ReflexInputs => {
  const centreX = options.centreX ?? 0.5;
  const centreY = options.centreY ?? 0.5;
  const radius = options.radius ?? 0.35;
  const length = Math.hypot(dx, dy);
  // A NaN component would survive `* 0`, so an unusable vector is no offset at all.
  const scale = Number.isFinite(length) && length > 0 ? radius / length : null;
  const offset = (component: number): number => (scale === null ? 0 : component * scale);
  return {
    pointer: {
      down: options.down ?? false,
      x: clampUnit(centreX + offset(dx)),
      y: clampUnit(centreY + offset(dy)),
    },
  };
};
