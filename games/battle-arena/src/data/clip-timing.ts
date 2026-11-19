export interface ClipTiming {
  dur: number;
  contact: number;
}

export const CLIP_TIMING = new Map<string, ClipTiming>(
  Object.entries({
    Melee_2H_Attack_Chop: { contact: 0.44, dur: 1.633 },
    Melee_2H_Attack_Slice: { contact: 0.34, dur: 1.1 },
    Melee_2H_Attack_Spin: { contact: 0.42, dur: 2.4 },
    Melee_2H_Attack_Spinning: { contact: 0.4, dur: 0.667 },
    Melee_1H_Attack_Chop: { contact: 0.54, dur: 1.067 },
    Melee_1H_Attack_Slice_Diagonal: { contact: 0.41, dur: 1 },
    Melee_1H_Attack_Slice_Horizontal: { contact: 0.3, dur: 1.367 },
    Melee_1H_Attack_Stab: { contact: 0.24, dur: 1.6 },
    Melee_1H_Attack_Jump_Chop: { contact: 0.54, dur: 1.333 },
    Melee_Dualwield_Attack_Chop: { contact: 0.43, dur: 1.267 },
    Melee_Dualwield_Attack_Slice: { contact: 0.47, dur: 1.167 },
    Melee_Dualwield_Attack_Stab: { contact: 0.24, dur: 1.6 },
    Melee_Unarmed_Attack_Punch_A: { contact: 0.37, dur: 1.167 },
    Ranged_Bow_Release: { contact: 0.31, dur: 1.333 },
    Ranged_Bow_Release_Up: { contact: 0.3, dur: 1.367 },
    Ranged_Magic_Shoot: { contact: 0.38, dur: 0.933 },
    Ranged_Magic_Raise: { contact: 0.55, dur: 2.1 },
    Ranged_Magic_Summon: { contact: 0.68, dur: 4.3 },
    Ranged_Magic_Spellcasting: { contact: 0.5, dur: 0.667 },
    Throw: { contact: 0.45, dur: 1.367 },
    Hit_A: { contact: 0.5, dur: 0.667 },
    Hit_B: { contact: 0.5, dur: 0.867 },
    Jump_Start: { contact: 0.5, dur: 0.6 },
    Jump_Land: { contact: 0.5, dur: 0.667 },
    Dodge_Forward: { contact: 0.5, dur: 0.4 },
    PickUp: { contact: 0.5, dur: 1.3 },
    Melee_Blocking: { contact: 0.5, dur: 1.067 },
    Dodge_Backward: { contact: 0.5, dur: 0.4 },
    Spawn_Air: { contact: 0.5, dur: 1.3 },
    Melee_2H_Attack: { contact: 0.35, dur: 1.333 },
    Melee_2H_Slam: { contact: 0.33, dur: 2.833 },
    Melee_Unarmed_Smash: { contact: 0.27, dur: 3.467 },
  } satisfies Record<string, ClipTiming>),
);

const CLIP_SPEED = new Map<string, number>(
  Object.entries({
    Ranged_Magic_Summon: 3,
    Ranged_Magic_Raise: 1.75,
    Melee_1H_Attack_Jump_Chop: 2.9,
  } satisfies Record<string, number>),
);

export const TWO_H_SPEED = 1.5;

/** Base playback rate for a clip (before interval fitting speeds it further). */
export const clipSpeed = (clip: string) =>
  CLIP_SPEED.get(clip) ?? (clip.startsWith("Melee_2H_") ? TWO_H_SPEED : 1);

export const ATTACK_SETS = new Map<string, string[]>(
  Object.entries({
    blackknight: [
      "Melee_1H_Attack_Chop",
      "Melee_1H_Attack_Slice_Diagonal",
      "Melee_1H_Attack_Slice_Horizontal",
    ],
    frostgolem: ["Melee_2H_Attack", "Melee_2H_Slam", "Melee_Unarmed_Smash"],
    knight: ["Melee_2H_Attack_Chop", "Melee_2H_Attack_Slice", "Melee_2H_Attack_Spin"],
    mage: ["Ranged_Magic_Shoot"],
    ranger: ["Ranged_Bow_Release"],
    rogue: ["Melee_Dualwield_Attack_Chop", "Melee_Dualwield_Attack_Slice"],
    skmage: ["Ranged_Magic_Shoot"],
    skminion: ["Melee_Unarmed_Attack_Punch_A", "Melee_1H_Attack_Chop"],
    skwarrior: ["Melee_1H_Attack_Chop", "Melee_1H_Attack_Stab"],
    witch: ["Ranged_Magic_Shoot"],
  } satisfies Record<string, string[]>),
);

/** The swing clip a unit's `swingCount`-th basic attack plays. */
export const swingClip = (champId: string, swingCount: number) => {
  const set = ATTACK_SETS.get(champId);

  if (!set || set.length === 0) {
    return "Melee_1H_Attack_Chop";
  }

  return set[Math.max(0, swingCount - 1) % set.length] ?? "Melee_1H_Attack_Chop";
};

export const ABILITY_CLIPS = new Map<string, Partial<Record<string, string>>>(
  Object.entries({
    blackknight: {
      DASH: "Dodge_Forward",
      E: "Melee_Blocking",
      JUMP: "Melee_1H_Attack_Jump_Chop",
      Q: "Melee_1H_Attack_Slice_Horizontal",
      R: "Melee_2H_Attack_Chop",
      W: "Melee_1H_Attack_Chop",
    },
    knight: {
      DASH: "Dodge_Forward",
      E: "Melee_Blocking",
      JUMP: "Melee_1H_Attack_Jump_Chop",
      Q: "Melee_2H_Attack_Slice",
      R: "Melee_2H_Attack_Spinning",
      W: "Melee_2H_Attack_Chop",
    },
    mage: {
      DASH: "Dodge_Forward",
      E: "Ranged_Magic_Shoot",
      JUMP: "Melee_1H_Attack_Jump_Chop",
      Q: "Ranged_Magic_Shoot",
      R: "Ranged_Magic_Summon",
      W: "Ranged_Magic_Raise",
    },
    ranger: {
      DASH: "Dodge_Forward",
      E: "PickUp",
      JUMP: "Melee_1H_Attack_Jump_Chop",
      Q: "Ranged_Bow_Release_Up",
      R: "Ranged_Bow_Release_Up",
      W: "Ranged_Bow_Release",
    },
    rogue: {
      DASH: "Dodge_Forward",
      E: "Dodge_Backward",
      JUMP: "Melee_1H_Attack_Jump_Chop",
      Q: "Melee_Dualwield_Attack_Stab",
      R: "Melee_Dualwield_Attack_Slice",
      W: "Melee_Dualwield_Attack_Slice",
    },
    witch: {
      DASH: "Dodge_Forward",
      E: "Ranged_Magic_Raise",
      JUMP: "Melee_1H_Attack_Jump_Chop",
      Q: "Ranged_Magic_Shoot",
      R: "Ranged_Magic_Raise",
      W: "Ranged_Magic_Summon",
    },
  } satisfies Record<string, Partial<Record<string, string>>>),
);

/** The timeScale the render plays `clip` at so the WHOLE clip fits inside
 *  `intervalMs` (never clipped, sped up only when needed). */
export const fitTimeScale = (clip: string, intervalMs: number) => {
  const t = CLIP_TIMING.get(clip);
  const base = clipSpeed(clip);

  if (!t) {
    return base;
  }

  return Math.max(base, (t.dur * 1000) / Math.max(1, intervalMs));
};

/** How long `clip` actually plays on screen inside `intervalMs`. */
export const clipPlayMs = (clip: string, intervalMs: number) => {
  const t = CLIP_TIMING.get(clip);

  if (!t) {
    return intervalMs;
  }

  return (t.dur * 1000) / fitTimeScale(clip, intervalMs);
};

/** Milliseconds from swing start until the blade/shot visually connects, for a
 *  swing whose full interval is `intervalMs`. This IS the sim's windup. */
export const strikeMs = (clip: string, intervalMs: number) => {
  const t = CLIP_TIMING.get(clip);

  if (!t) {
    return intervalMs * 0.45;
  }

  return t.contact * clipPlayMs(clip, intervalMs);
};

/** Strike moment of an ability's cast clip played at its natural (unfitted)
 *  speed — used to schedule ability damage on the animation's contact frame. */
export const castStrikeMs = (champId: string, key: string) => {
  const clip = ABILITY_CLIPS.get(champId)?.[key];

  if (!clip) {
    return 0;
  }

  const t = CLIP_TIMING.get(clip);

  if (!t) {
    return 0;
  }

  return (t.contact * t.dur * 1000) / clipSpeed(clip);
};
