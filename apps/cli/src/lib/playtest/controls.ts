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

import type { RouterInputs } from "@repo/api";

import type { JsonObject, JsonValue } from "../types.js";
import { isJsonObject, isJsonString } from "../types.js";
import { HarnessError } from "./errors.js";
import type { Pointer } from "./keys.js";
import { keyFields } from "./keys.js";

export interface MoveOption {
  description: string;
  keys: string[];
  pointer: Pointer | null;
}

export interface ActionOption {
  description: string;
  keys: string[];
}

export interface Controls {
  goal: string;
  move: Record<string, MoveOption>;
  actions: Record<string, ActionOption>;
}

export const DEFAULT_GOAL =
  "Play the game well: stay alive, keep moving through the level, raise the score, and avoid whatever the state marks as hazards, enemies or damage.";

const NONE: MoveOption = {
  description: "Hold no movement input — stay still",
  keys: [],
  pointer: null,
};

const move = (description: string, keys: string[]): MoveOption => ({
  description,
  keys,
  pointer: null,
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
      move: directions("ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"),
    },
  ],
  [
    "wasd",
    {
      actions: ACTION_PRESET,
      goal: DEFAULT_GOAL,
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
  if (!Object.values(moves).some((option) => option.keys.length > 0 || option.pointer)) {
    fail(`${source}: no \`move\` option holds any input, so the playtester could never move.`);
  }
  // A no-input option is what the reflex falls back to when it withdraws a
  // move, and what "do nothing" means to the model — supplied when absent.
  if (!Object.hasOwn(moves, "none")) {
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
  return { actions, goal: nonEmptyString(raw.goal) ? raw.goal : DEFAULT_GOAL, move: moves };
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

type Questions = RouterInputs["playtest"]["decide"]["questions"];

/** Question key for an action, kept off `move`'s namespace. */
export const actionKey = (label: string): string => `act:${label}`;

/**
 * The questions the model answers each tick, all in one call. `blocked`
 * moves are left out of the criteria rather than discouraged in prose: the
 * model cannot answer outside its schema, so omission is the one reflex that
 * always lands.
 */
export const buildQuestions = (controls: Controls, blocked: ReadonlySet<string>): Questions => {
  const criteria: Record<string, string> = {};
  for (const [label, option] of Object.entries(controls.move)) {
    if (!blocked.has(label)) {
      criteria[label] = option.description;
    }
  }
  const questions: Questions = {
    move: {
      criteria,
      instructions:
        "Which movement input should the player hold next to pursue `goal`? Decide from `game` (the live state) and `recent` (what the last inputs achieved). Options that recently produced no movement have been removed.",
      type: "choice",
    },
  };
  for (const [label, action] of Object.entries(controls.actions)) {
    questions[actionKey(label)] = {
      criteria: { false: "Not now", true: "Yes, do it now" },
      instructions: `Given \`game\` and \`goal\`, should the player ${action.description} right now?`,
      type: "noul",
    };
  }
  return questions;
};

export interface Decision {
  move: string;
  actions: string[];
  actionProbabilities: Record<string, number>;
  confidence: number | null;
  inputTokens: number;
  outputTokens: number;
}

/** A yes/no answer at or above this probability is acted on. */
export const ACTION_THRESHOLD = 0.5;

const round3 = (value: number): number => Number(value.toFixed(3));

/** Read the provider's answers into a decision, refusing any shape outside the schema asked for. */
export const readDecision = (
  response: JsonValue,
  controls: Controls,
  questions: Questions,
): Decision => {
  const answers = isJsonObject(response) ? response.answers : undefined;
  if (!isJsonObject(answers)) {
    fail(`decision model returned no answers: ${JSON.stringify(response).slice(0, 300)}`);
  }
  const moveAnswer = answers.move;
  const moveQuestion = questions.move;
  const offered = moveQuestion?.type === "choice" ? moveQuestion.criteria : {};
  if (
    !isJsonObject(moveAnswer) ||
    !isJsonString(moveAnswer.choice) ||
    !Object.hasOwn(offered, moveAnswer.choice)
  ) {
    fail(
      `decision model answered \`move\` outside the offered options: ${JSON.stringify(moveAnswer)}`,
    );
  }
  const actions: string[] = [];
  const actionProbabilities: Record<string, number> = {};
  for (const label of Object.keys(controls.actions)) {
    const answer = answers[actionKey(label)];
    const probability = isJsonObject(answer) ? answer.noul : undefined;
    if (!Number.isFinite(probability)) {
      fail(`decision model answered \`${label}\` without a probability: ${JSON.stringify(answer)}`);
    }
    actionProbabilities[label] = round3(Number(probability));
    if (Number(probability) >= ACTION_THRESHOLD) {
      actions.push(label);
    }
  }
  const usage = isJsonObject(response) && isJsonObject(response.usage) ? response.usage : {};
  const { confidence } = moveAnswer;
  return {
    actionProbabilities,
    actions,
    confidence: Number.isFinite(confidence) ? round3(Number(confidence)) : null,
    inputTokens: Number.isFinite(usage.input_tokens) ? Number(usage.input_tokens) : 0,
    move: moveAnswer.choice,
    outputTokens: Number.isFinite(usage.output_tokens) ? Number(usage.output_tokens) : 0,
  };
};

export interface HeldInputs {
  keys: string[];
  pointer: Pointer | null;
}

export const NOTHING_HELD: HeldInputs = { keys: [], pointer: null };

/** The inputs a decision holds: the move's keys plus each chosen action's keys. */
export const inputsFor = (controls: Controls, decision: Decision): HeldInputs => {
  const option = controls.move[decision.move] ?? NONE;
  const keys = new Set(option.keys);
  for (const label of decision.actions) {
    for (const code of controls.actions[label]?.keys ?? []) {
      keys.add(code);
    }
  }
  return { keys: [...keys], pointer: option.pointer };
};

/** Whether a move option asks the player to move, and so can count as stuck. */
export const asksToMove = (controls: Controls, label: string): boolean => {
  const option = controls.move[label];
  return option !== undefined && (option.keys.length > 0 || option.pointer !== null);
};
