/**
 * Action timing semantics and genre profiles for sprite animation — the single
 * source of truth for *how* each animation should be generated and curated.
 *
 * The core idea is that an animation's type drives both how many frames it
 * needs and which frames carry the action:
 *
 * - `timing` — loop | one_shot | transition | hold: the animation's shape.
 * - `selectionPolicy` — which frames carry the meaningful action, used to
 *   budget frames:
 *     `cycle`                     compact loop window (idle/walk/run)
 *     `action_window`             the meaningful action span (attack)
 *     `full_duration_include_end` use the whole span and KEEP the final frame
 *                                 (jump/death/get_up land on an end pose)
 *     `hold_pose`                 a stable held pose, little motion
 *                                 (crouch/block)
 */

import { lookup } from "./json.js";

export type Timing = "loop" | "one_shot" | "transition" | "hold";
export type SelectionPolicy = "cycle" | "action_window" | "full_duration_include_end" | "hold_pose";

export type ActionPreset = {
  action: string;
  defaultFrames: number;
  recommendedFrames: number[];
  fps: number;
  timing: Timing;
  loopable: boolean;
  selectionPolicy: SelectionPolicy;
};

export type ActionFacts = ActionPreset & {
  anchorPolicy: "preserve-motion" | "grounded";
  profileOverride?: boolean;
  requestedFrames?: number;
  coercedFrames?: number;
  frameWarning?: string;
};

const action = (
  name: string,
  defaultFrames: number,
  recommendedFrames: number[],
  fps: number,
  timing: Timing,
  loopable: boolean,
  selectionPolicy: SelectionPolicy,
): ActionPreset => ({
  action: name,
  defaultFrames,
  recommendedFrames,
  fps,
  timing,
  loopable,
  selectionPolicy,
});

/**
 * Generic engine action vocabulary. Game-facing names (light-punch,
 * heavy-kick) map onto these underlying motion contracts; the action ids stay
 * generic. Insertion order is the listing order.
 */
export const ACTIONS = {
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end",
  ),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
} satisfies Record<string, ActionPreset>;

export type Profile = {
  profile: string;
  description: string;
  /** Default anchor direction for the genre. */
  direction: string;
  actions: string[];
  /** Per-profile runtime frame-count overrides. */
  frameOverrides: Record<string, number>;
};

const PLATFORMER: Profile = {
  profile: "platformer",
  description: "Side-view platformer defaults: loops, jumps, attacks, reactions, death.",
  direction: "w",
  actions: ["idle", "walk", "run", "jump", "roll", "attack", "hurt", "crouch", "death"],
  frameOverrides: {},
};

const FIGHTING: Profile = {
  profile: "fighting-game",
  description: "Side-view brawler/fighter: longer loops, blocks, knockdown/get-up transitions.",
  direction: "w",
  actions: [
    "idle",
    "walk",
    "run",
    "jump",
    "crouch",
    "hurt",
    "walk_forward",
    "walk_backward",
    "light_attack",
    "heavy_attack",
    "attack",
    "block_high",
    "block_low",
    "knockdown",
    "get_up",
    "death",
  ],
  // Core loops widen to 12; hurt/jump/crouch widen to 8.
  frameOverrides: {
    idle: 12,
    walk: 12,
    run: 12,
    attack: 12,
    death: 12,
    hurt: 8,
    jump: 8,
    crouch: 8,
  },
};

const POINT_AND_CLICK: Profile = {
  profile: "point-and-click",
  description: "Classic adventure character: dialogue + object-interaction gestures, video-first.",
  direction: "sw",
  actions: ["idle", "walk", "talk", "interact", "pick_up", "use", "examine", "give", "shrug"],
  frameOverrides: {},
};

export const PROFILES = {
  platformer: PLATFORMER,
  "fighting-game": FIGHTING,
  "point-and-click": POINT_AND_CLICK,
  // `adventure` is an alias and is hidden from listings.
  adventure: POINT_AND_CLICK,
} satisfies Record<string, Profile>;

const PROFILE_ALIASES = new Set(["adventure"]);

function presetOf(actionId: string): ActionPreset {
  const preset = lookup(ACTIONS, actionId);
  if (!preset) {
    const known = Object.keys(ACTIONS).sort().join(", ");
    throw new Error(`unknown action '${actionId}'; expected one of: ${known}`);
  }
  return preset;
}

/** Canonical profile ids, excluding aliases. */
export function canonicalProfiles(): string[] {
  return Object.keys(PROFILES).filter((key) => !PROFILE_ALIASES.has(key));
}

export function resolveProfile(profileId: string | null): Profile {
  const key = profileId ?? "platformer";
  const profile = lookup(PROFILES, key);
  if (!profile) {
    const known = canonicalProfiles().sort().join(", ");
    throw new Error(`unknown profile '${key}'; expected one of: ${known}`);
  }
  return profile;
}

export function actionFacts(actionId: string, profile: Profile | null = null): ActionFacts {
  const preset = presetOf(actionId);

  const facts: ActionFacts = {
    ...preset,
    recommendedFrames: [...preset.recommendedFrames],
    // Transitions (jump/death/get_up) keep their vertical travel; everything
    // else lands feet on a shared baseline.
    anchorPolicy: preset.timing === "transition" ? "preserve-motion" : "grounded",
  };

  const override = profile?.frameOverrides[actionId];
  if (override !== undefined) {
    facts.defaultFrames = override;
    facts.profileOverride = true;
  }
  return facts;
}

export type CoercedFrameCount = { frames: number; warning: string | null };

/**
 * Snap an unsupported frame count to the nearest recommended value. On an
 * equidistant request the LARGER value wins — asking for 9 frames of walk
 * gives 10, not 8, because dropping motion is worse than paying for a frame.
 */
export function coerceFrameCount(actionId: string, requested: number): CoercedFrameCount {
  const recommended = presetOf(actionId).recommendedFrames;
  if (recommended.includes(requested)) return { frames: requested, warning: null };

  let nearest = recommended[0]!;
  for (const value of recommended) {
    const better =
      Math.abs(value - requested) < Math.abs(nearest - requested) ||
      (Math.abs(value - requested) === Math.abs(nearest - requested) && value > nearest);
    if (better) nearest = value;
  }
  return {
    frames: nearest,
    warning:
      `frame count ${requested} not recommended for ${actionId}; coerced to ${nearest} ` +
      // The source holds these as a tuple, so the message renders them with
      // parentheses even though the facts payload lists them with brackets.
      `(recommended: (${recommended.join(", ")}))`,
  };
}

/** An action-facts field value — what the preset listings print. */
export type PresetFieldValue = string | number | boolean | null | undefined | PresetFieldValue[];

/**
 * Render a value the way Python's `str()` would, so the human-readable
 * (non-`--json`) output of these scripts is unchanged: `True`/`False` rather
 * than `true`/`false`, and lists as `[8, 10, 12]`.
 */
export function formatPythonValue(value: PresetFieldValue): string {
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null || value === undefined) return "None";
  if (Array.isArray(value)) return `[${value.map(formatPythonValue).join(", ")}]`;
  return String(value);
}
