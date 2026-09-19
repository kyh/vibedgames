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

export interface ActionPreset {
  action: string;
  defaultFrames: number;
  recommendedFrames: number[];
  fps: number;
  timing: Timing;
  loopable: boolean;
  selectionPolicy: SelectionPolicy;
}

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
  fps,
  loopable,
  recommendedFrames,
  selectionPolicy,
  timing,
});

/**
 * Generic engine action vocabulary. Game-facing names (light-punch,
 * heavy-kick) map onto these underlying motion contracts; the action ids stay
 * generic. Insertion order is the listing order.
 */
export const ACTIONS = {
  attack: action("attack", 8, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  block_high: action("block_high", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  block_low: action("block_low", 8, [4, 6, 8, 10], 10, "hold", true, "hold_pose"),
  crouch: action("crouch", 6, [5, 6, 8], 8, "hold", true, "hold_pose"),
  dash: action("dash", 6, [5, 6, 8], 14, "one_shot", false, "action_window"),
  death: action("death", 10, [8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  examine: action("examine", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  get_up: action("get_up", 12, [6, 8, 10, 12], 8, "transition", false, "full_duration_include_end"),
  give: action("give", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  heavy_attack: action("heavy_attack", 12, [6, 8, 10, 12], 10, "one_shot", false, "action_window"),
  hurt: action("hurt", 6, [4, 5, 6, 8], 8, "one_shot", false, "action_window"),
  idle: action("idle", 10, [8, 10, 12], 6, "loop", true, "cycle"),
  interact: action("interact", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  jump: action("jump", 6, [6, 8, 10], 8, "transition", false, "full_duration_include_end"),
  knockdown: action(
    "knockdown",
    12,
    [8, 10, 12],
    8,
    "transition",
    false,
    "full_duration_include_end",
  ),
  light_attack: action("light_attack", 8, [6, 8, 10, 12], 12, "one_shot", false, "action_window"),
  pick_up: action("pick_up", 12, [8, 10, 12], 8, "one_shot", false, "action_window"),
  roll: action("roll", 8, [6, 8, 10], 14, "one_shot", false, "action_window"),
  run: action("run", 8, [8, 10, 12], 12, "loop", true, "cycle"),
  shrug: action("shrug", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  talk: action("talk", 12, [8, 10, 12], 8, "loop", true, "cycle"),
  use: action("use", 10, [8, 10, 12], 8, "one_shot", false, "action_window"),
  walk: action("walk", 8, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_backward: action("walk_backward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
  walk_forward: action("walk_forward", 12, [8, 10, 12], 10, "loop", true, "cycle"),
} satisfies Record<string, ActionPreset>;

export interface Profile {
  profile: string;
  description: string;
  /** Default anchor direction for the genre. */
  direction: string;
  actions: string[];
  /** Per-profile runtime frame-count overrides. */
  frameOverrides: Record<string, number>;
}

const PLATFORMER: Profile = {
  actions: ["idle", "walk", "run", "jump", "roll", "attack", "hurt", "crouch", "death"],
  description: "Side-view platformer defaults: loops, jumps, attacks, reactions, death.",
  direction: "w",
  frameOverrides: {},
  profile: "platformer",
};

const FIGHTING: Profile = {
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
  description: "Side-view brawler/fighter: longer loops, blocks, knockdown/get-up transitions.",
  direction: "w",
  // Core loops widen to 12; hurt/jump/crouch widen to 8.
  frameOverrides: {
    attack: 12,
    crouch: 8,
    death: 12,
    hurt: 8,
    idle: 12,
    jump: 8,
    run: 12,
    walk: 12,
  },
  profile: "fighting-game",
};

const POINT_AND_CLICK: Profile = {
  actions: ["idle", "walk", "talk", "interact", "pick_up", "use", "examine", "give", "shrug"],
  description: "Classic adventure character: dialogue + object-interaction gestures, video-first.",
  direction: "sw",
  frameOverrides: {},
  profile: "point-and-click",
};

// oxlint-disable-next-line sort-keys -- key order is the listing order `canonicalProfiles` exposes
export const PROFILES = {
  platformer: PLATFORMER,
  "fighting-game": FIGHTING,
  "point-and-click": POINT_AND_CLICK,
  // `adventure` is an alias and is hidden from listings.
  adventure: POINT_AND_CLICK,
} satisfies Record<string, Profile>;

const PROFILE_ALIASES = new Set(["adventure"]);

const presetOf = (actionId: string): ActionPreset => {
  const preset = lookup(ACTIONS, actionId);
  if (!preset) {
    const known = Object.keys(ACTIONS).toSorted().join(", ");
    throw new Error(`unknown action '${actionId}'; expected one of: ${known}`);
  }
  return preset;
};

/** Canonical profile ids, excluding aliases. */
export const canonicalProfiles = (): string[] =>
  Object.keys(PROFILES).filter((key) => !PROFILE_ALIASES.has(key));

export const resolveProfile = (profileId: string | null): Profile => {
  // oxlint-disable-next-line unicorn/prefer-default-parameters -- null is a legal argument; a default parameter only covers undefined
  const key = profileId ?? "platformer";
  const profile = lookup(PROFILES, key);
  if (!profile) {
    const known = canonicalProfiles().toSorted().join(", ");
    throw new Error(`unknown profile '${key}'; expected one of: ${known}`);
  }
  return profile;
};

export const actionFacts = (actionId: string, profile: Profile | null = null): ActionFacts => {
  const preset = presetOf(actionId);

  const facts: ActionFacts = {
    ...preset,
    // Transitions (jump/death/get_up) keep their vertical travel; everything
    // else lands feet on a shared baseline.
    anchorPolicy: preset.timing === "transition" ? "preserve-motion" : "grounded",
    recommendedFrames: [...preset.recommendedFrames],
  };

  const override = profile?.frameOverrides[actionId];
  if (override !== undefined) {
    facts.defaultFrames = override;
    facts.profileOverride = true;
  }
  return facts;
};

export interface CoercedFrameCount {
  frames: number;
  warning: string | null;
}

/**
 * Snap an unsupported frame count to the nearest recommended value. On an
 * equidistant request the LARGER value wins — asking for 9 frames of walk
 * gives 10, not 8, because dropping motion is worse than paying for a frame.
 */
export const coerceFrameCount = (actionId: string, requested: number): CoercedFrameCount => {
  const recommended = presetOf(actionId).recommendedFrames;
  if (recommended.includes(requested)) {
    return { frames: requested, warning: null };
  }

  const [firstRecommended] = recommended;
  if (firstRecommended === undefined) {
    throw new Error(`action '${actionId}' has no recommended frame counts`);
  }
  let nearest = firstRecommended;
  for (const value of recommended) {
    const better =
      Math.abs(value - requested) < Math.abs(nearest - requested) ||
      (Math.abs(value - requested) === Math.abs(nearest - requested) && value > nearest);
    if (better) {
      nearest = value;
    }
  }
  return {
    frames: nearest,
    warning:
      `frame count ${requested} not recommended for ${actionId}; coerced to ${nearest} ` +
      // The source holds these as a tuple, so the message renders them with
      // parentheses even though the facts payload lists them with brackets.
      `(recommended: (${recommended.join(", ")}))`,
  };
};

/** An action-facts field value — what the preset listings print. */
export type PresetFieldValue = string | number | boolean | null | undefined | PresetFieldValue[];

/**
 * Render a value the way Python's `str()` would, so the human-readable
 * (non-`--json`) output of these scripts is unchanged: `True`/`False` rather
 * than `true`/`false`, and lists as `[8, 10, 12]`.
 */
export const formatPythonValue = (value: PresetFieldValue): string => {
  if (value === true) {
    return "True";
  }
  if (value === false) {
    return "False";
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (Array.isArray(value)) {
    return `[${value.map(formatPythonValue).join(", ")}]`;
  }
  return String(value);
};
