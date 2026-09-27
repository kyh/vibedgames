/**
 * What the playtester can do to a game, and the questions that turn that into a
 * decision. A control scheme is a `move` choice (one option held per tick)
 * plus independent yes/no `actions`, each described in prose — the
 * descriptions are literally the model's criteria, so they carry the game's
 * meaning ("run right, towards the flag"), not just the key name.
 *
 * Schemes come from three places, in precedence order: an explicit
 * `--controls` (preset name or JSON file), the game's own
 * `window.__GAME_PLAYTEST__` manifest, and the `wasd` preset.
 */

import { readFileSync } from "node:fs";

import type { JsonObject, JsonValue } from "../types.js";
import { isJsonObject, isJsonString } from "../types.js";
import { HarnessError } from "./errors.js";
import type { Pointer } from "./keys.js";
import { keyFields } from "./keys.js";

export interface MoveOption {
  description: string;
  keys: string[];
  pointer: Pointer | null;
  /** The game's manifest carries a per-frame `reflex` for this move (it lives in the page, not here). */
  reflex: boolean;
}

export interface ActionOption {
  description: string;
  keys: string[];
}

export interface Controls {
  goal: string;
  move: Record<string, MoveOption>;
  actions: Record<string, ActionOption>;
  /**
   * The per-decision movement that proves input reaches the player, in the
   * units of `player.x/y/z`. Null = the pixel-scale default; a game that
   * measures in world units (most 3D games) moves a fraction of that.
   */
  minDisplacement: number | null;
}

export const DEFAULT_GOAL =
  "Play the game well: stay alive, keep moving through the level, raise the score, and avoid whatever the state marks as hazards, enemies or damage.";

const NONE: MoveOption = {
  description: "Hold no movement input — stay still",
  keys: [],
  pointer: null,
  reflex: false,
};

const move = (description: string, keys: string[]): MoveOption => ({
  description,
  keys,
  pointer: null,
  reflex: false,
});

const directions = (up: string, down: string, left: string, right: string) => ({
  down: move("Move down / backward", [down]),
  down_left: move("Move diagonally down and left", [down, left]),
  down_right: move("Move diagonally down and right", [down, right]),
  left: move("Move left", [left]),
  none: NONE,
  right: move("Move right", [right]),
  up: move("Move up / forward", [up]),
  up_left: move("Move diagonally up and left", [up, left]),
  up_right: move("Move diagonally up and right", [up, right]),
});

const ACTION_PRESET = {
  action: { description: "press the action key (jump, fire or confirm)", keys: ["Space"] },
};

export const PRESETS = new Map<string, Controls>([
  [
    "arrows",
    {
      actions: ACTION_PRESET,
      goal: DEFAULT_GOAL,
      minDisplacement: null,
      move: directions("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"),
    },
  ],
  [
    "wasd",
    {
      actions: ACTION_PRESET,
      goal: DEFAULT_GOAL,
      minDisplacement: null,
      move: directions("KeyW", "KeyS", "KeyA", "KeyD"),
    },
  ],
]);

export const DEFAULT_PRESET = "wasd";
export const PRESET_NAMES = [...PRESETS.keys()];

// Annotated on the identifier, not just the arrow: TypeScript only narrows
// after a never-returning call when the callee's declared type says so.
const fail: (message: string) => never = (message) => {
  throw new HarnessError(message);
};

const nonEmptyString = (value: JsonValue | undefined): value is string =>
  isJsonString(value) && value.trim() !== "";

const readKeys = (value: JsonValue | undefined, where: string): string[] => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isJsonString)) {
    fail(`${where}: \`keys\` must be an array of KeyboardEvent codes.`);
  }
  for (const code of value) {
    try {
      keyFields(code);
    } catch (error) {
      // Re-thrown with the scheme's address, so the author knows which
      // manifest to fix, not just which code was wrong.
      fail(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return value;
};

/**
 * Check a `pointer` before anything launches. Fractions of the viewport, so a
 * scheme isn't tied to one window size; pixels are the tempting mistake, and
 * they'd silently aim off-screen.
 */
const readPointer = (value: JsonValue | undefined, where: string): Pointer | null => {
  if (value === undefined) {
    return null;
  }
  if (!isJsonObject(value)) {
    fail(`${where}: \`pointer\` must be an object { x, y, down? }.`);
  }
  const { x, y, down } = value;
  for (const [name, axis] of [
    ["x", x],
    ["y", y],
  ] as const) {
    if (!Number.isFinite(axis) || Number(axis) < 0 || Number(axis) > 1) {
      fail(`${where}: \`pointer.${name}\` must be a viewport fraction between 0 and 1.`);
    }
  }
  if (down !== undefined && down !== true && down !== false) {
    fail(`${where}: \`pointer.down\` must be a boolean.`);
  }
  return { down: down === true, x: Number(x), y: Number(y) };
};

const readDescription = (option: JsonObject, where: string): string => {
  if (!nonEmptyString(option.description)) {
    fail(`${where} needs a non-empty \`description\` — that is what the model decides from.`);
  }
  return option.description;
};

const readMoveOption = (value: JsonValue, where: string): MoveOption => {
  if (!isJsonObject(value)) {
    fail(`${where} must be an object with a \`description\`.`);
  }
  return {
    description: readDescription(value, where),
    keys: readKeys(value.keys, where),
    pointer: readPointer(value.pointer, where),
    reflex: value.reflex === true,
  };
};

const readActionOption = (value: JsonValue, where: string): ActionOption => {
  if (!isJsonObject(value)) {
    fail(`${where} must be an object with a \`description\`.`);
  }
  if (value.pointer !== undefined) {
    fail(
      `${where}: actions are keys only. A pointer belongs in a \`move\` option (aim-and-thrust games put \`down: true\` there).`,
    );
  }
  const keys = readKeys(value.keys, where);
  if (keys.length === 0) {
    fail(`${where} needs a non-empty \`keys\` array.`);
  }
  return { description: readDescription(value, where), keys };
};

/**
 * Validate a scheme from JSON (a `--controls` file or the game's
 * `__GAME_PLAYTEST__`). `source` names where it came from in every error, so a
 * game author knows which manifest to fix.
 */
export const parseControls = (raw: JsonValue, source: string): Controls => {
  if (!isJsonObject(raw)) {
    fail(`${source} must be a JSON object with \`move\` (and optionally \`actions\`, \`goal\`).`);
  }
  if (raw.goal !== undefined && !nonEmptyString(raw.goal)) {
    fail(`${source}: \`goal\` must be a non-empty string.`);
  }
  if (!isJsonObject(raw.move) || Object.keys(raw.move).length === 0) {
    fail(
      `${source}: \`move\` must map at least one option label to { description, keys | pointer }.`,
    );
  }
  const moves: Record<string, MoveOption> = {};
  for (const [label, option] of Object.entries(raw.move)) {
    moves[label] = readMoveOption(option, `${source} move.${label}`);
  }
  if (
    !Object.values(moves).some(
      (option) => option.keys.length > 0 || option.pointer || option.reflex,
    )
  ) {
    fail(`${source}: no \`move\` option holds any input, so the playtester could never move.`);
  }
  // A choice needs two options, so a one-move scheme gets a no-input partner.
  // Never otherwise: given a state that points nowhere the model takes "hold
  // nothing" at high confidence, so an unasked-for `none` freezes the run and
  // hides how little the diagnostics said. A game where waiting is a real
  // play declares its own.
  if (Object.keys(moves).length < 2 && !Object.hasOwn(moves, "none")) {
    moves.none = NONE;
  }
  const actions: Record<string, ActionOption> = {};
  if (raw.actions !== undefined) {
    if (!isJsonObject(raw.actions)) {
      fail(`${source}: \`actions\` must map option labels to { description, keys }.`);
    }
    for (const [label, option] of Object.entries(raw.actions)) {
      actions[label] = readActionOption(option, `${source} actions.${label}`);
    }
  }
  const { minDisplacement } = raw;
  if (
    minDisplacement !== undefined &&
    (!Number.isFinite(minDisplacement) || Number(minDisplacement) <= 0)
  ) {
    fail(`${source}: \`minDisplacement\` must be a positive number, in the units of player.x/y.`);
  }
  return {
    actions,
    goal: nonEmptyString(raw.goal) ? raw.goal : DEFAULT_GOAL,
    minDisplacement: minDisplacement === undefined ? null : Number(minDisplacement),
    move: moves,
  };
};

/** Resolve `--controls`: a preset name, or a JSON file. */
export const readControlsArg = (value: string): Controls => {
  const preset = PRESETS.get(value);
  if (preset) {
    return preset;
  }
  let text: string;
  try {
    text = readFileSync(value, "utf-8");
  } catch {
    fail(
      `couldn't read --controls ${value} (not a preset — those are ${PRESET_NAMES.join(", ")} — and not a readable file).`,
    );
  }
  let raw: JsonValue;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    fail(
      `--controls ${value} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseControls(raw, `--controls ${value}`);
};
