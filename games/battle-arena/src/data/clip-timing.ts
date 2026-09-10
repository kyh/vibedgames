// THE one source of truth for animation-driven combat timing. Pure data — no
// engine imports — so the sim can schedule damage at the exact moment the
// render's clip visually connects, and neither side can drift.
//
// { dur, contact }: clip length (s) and the fraction of the clip where the
// blade/shot connects. Measured from the GLB bone tracks by
// tools/measure-clip-timing.mjs (peak world speed of the handslot.r weapon
// mount). Clips whose peak-hand-speed proxy is weak (slow-handed casts, bow
// string releases) carry hand-tuned contacts — marked OVERRIDE.
//
// The render fits every swing clip inside its sim attack interval (speeding it
// up if needed, never clipping it), so:
//   clip play time = min(dur / playbackSpeed, interval)
//   strike moment  = contact × clip play time
// Both sides compute exactly that through swingWindupMs()/fitTimeScale().

export interface ClipTiming {
  dur: number;
  contact: number;
}

export const CLIP_TIMING = new Map<string, ClipTiming>(
  // oxlint-disable-next-line sort-keys -- grouped by rig and attack family, with per-clip override notes
  Object.entries({
    // ── Rig_Medium melee ──
    Melee_2H_Attack_Chop: { contact: 0.44, dur: 1.633 },
    Melee_2H_Attack_Slice: { contact: 0.34, dur: 1.1 },
    // OVERRIDE: the whirl's first blade pass sweeps the room just before mid-clip
    Melee_2H_Attack_Spin: { contact: 0.42, dur: 2.4 },
    Melee_2H_Attack_Spinning: { contact: 0.4, dur: 0.667 },
    Melee_1H_Attack_Chop: { contact: 0.54, dur: 1.067 },
    Melee_1H_Attack_Slice_Diagonal: { contact: 0.41, dur: 1 },
    // OVERRIDE 0.19: swipe reads mid-swing, not first hand flick
    Melee_1H_Attack_Slice_Horizontal: { contact: 0.3, dur: 1.367 },
    Melee_1H_Attack_Stab: { contact: 0.24, dur: 1.6 },
    Melee_1H_Attack_Jump_Chop: { contact: 0.54, dur: 1.333 },
    Melee_Dualwield_Attack_Chop: { contact: 0.43, dur: 1.267 },
    Melee_Dualwield_Attack_Slice: { contact: 0.47, dur: 1.167 },
    Melee_Dualwield_Attack_Stab: { contact: 0.24, dur: 1.6 },
    Melee_Unarmed_Attack_Punch_A: { contact: 0.37, dur: 1.167 },
    // ── Rig_Medium ranged/cast ──
    Ranged_Bow_Release: { contact: 0.31, dur: 1.333 },
    // OVERRIDE 0.13: string release, hand barely moves
    Ranged_Bow_Release_Up: { contact: 0.3, dur: 1.367 },
    // OVERRIDE 0.08: bolt leaves on the forward thrust
    Ranged_Magic_Shoot: { contact: 0.38, dur: 0.933 },
    // OVERRIDE 0.13: the raise crescendos past mid-clip
    Ranged_Magic_Raise: { contact: 0.55, dur: 2.1 },
    Ranged_Magic_Summon: { contact: 0.68, dur: 4.3 },
    // OVERRIDE 0.86: continuous weave, mid-clip reads best
    Ranged_Magic_Spellcasting: { contact: 0.5, dur: 0.667 },
    Throw: { contact: 0.45, dur: 1.367 },
    // ── Rig_Medium misc one-shots the render fits to windows ──
    Hit_A: { contact: 0.5, dur: 0.667 },
    Hit_B: { contact: 0.5, dur: 0.867 },
    Jump_Start: { contact: 0.5, dur: 0.6 },
    Jump_Land: { contact: 0.5, dur: 0.667 },
    Dodge_Forward: { contact: 0.5, dur: 0.4 },
    PickUp: { contact: 0.5, dur: 1.3 },
    Melee_Blocking: { contact: 0.5, dur: 1.067 },
    Dodge_Backward: { contact: 0.5, dur: 0.4 },
    Spawn_Air: { contact: 0.5, dur: 1.3 },
    // ── Rig_Large (frost golem / boss) — native Large clip names ──
    Melee_2H_Attack: { contact: 0.35, dur: 1.333 },
    Melee_2H_Slam: { contact: 0.33, dur: 2.833 },
    Melee_Unarmed_Smash: { contact: 0.27, dur: 3.467 },
  } satisfies Record<string, ClipTiming>),
);

// ── Playback speed ───────────────────────────────────────────────────────────
// 2H greatsword/hammer swings play 1.5× faster than authored (snappier heavy
// weapons); a couple of marathon cast clips are compressed so a cast never
// roots the character for multiple seconds (fixes the old ONE_SHOT_CAP cutoff
// that chopped Summon/Raise mid-motion).
const CLIP_SPEED = new Map<string, number>(
  // oxlint-disable-next-line sort-keys -- ordered by how much each clip is compressed, with a note per entry
  Object.entries({
    // 4.3s → ~1.4s cast
    Ranged_Magic_Summon: 3,
    // 2.1s → ~1.2s cast
    Ranged_Magic_Raise: 1.75,
    // dive-chop contact lands exactly at the JUMP leap's touchdown (~250ms):
    // 0.54 × 1333ms / 2.9 ≈ 248ms — the slam fx, damage, and blade all agree
    Melee_1H_Attack_Jump_Chop: 2.9,
  } satisfies Record<string, number>),
);
export const TWO_H_SPEED = 1.5;

/** Base playback rate for a clip (before interval fitting speeds it further). */
export const clipSpeed = (clip: string): number =>
  CLIP_SPEED.get(clip) ?? (clip.startsWith("Melee_2H_") ? TWO_H_SPEED : 1);

// ── Basic-attack swing clips ─────────────────────────────────────────────────
// Per-champ swing rotations, cycled by the synced swingCount (parallel to
// champions.ts basicRhythm). Creeps included — the render and the sim's strike
// timing both key off this ONE table.
export const ATTACK_SETS = new Map<string, string[]>(
  Object.entries({
    blackknight: [
      "Melee_1H_Attack_Chop",
      "Melee_1H_Attack_Slice_Diagonal",
      "Melee_1H_Attack_Slice_Horizontal",
    ],
    // native Large names
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
export const swingClip = (champId: string, swingCount: number): string => {
  const set = ATTACK_SETS.get(champId);
  if (!set || set.length === 0) {
    return "Melee_1H_Attack_Chop";
  }
  return set[Math.max(0, swingCount - 1) % set.length] ?? "Melee_1H_Attack_Chop";
};

// ── Ability cast clips ───────────────────────────────────────────────────────
// Which clip each ability cast plays (render) — and therefore when its strike
// connects (sim). DASH rides Dodge_Forward everywhere; JUMP is the aerial
// dive-chop for every champ.
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

// ── Shared timing math (sim windups ↔ render timeScales) ─────────────────────

/** The timeScale the render plays `clip` at so the WHOLE clip fits inside
 *  `intervalMs` (never clipped, sped up only when needed). */
export const fitTimeScale = (clip: string, intervalMs: number): number => {
  const t = CLIP_TIMING.get(clip);
  const base = clipSpeed(clip);
  if (!t) {
    return base;
  }
  return Math.max(base, (t.dur * 1000) / Math.max(1, intervalMs));
};

/** How long `clip` actually plays on screen inside `intervalMs`. */
export const clipPlayMs = (clip: string, intervalMs: number): number => {
  const t = CLIP_TIMING.get(clip);
  if (!t) {
    return intervalMs;
  }
  return (t.dur * 1000) / fitTimeScale(clip, intervalMs);
};

/** Milliseconds from swing start until the blade/shot visually connects, for a
 *  swing whose full interval is `intervalMs`. This IS the sim's windup. */
export const strikeMs = (clip: string, intervalMs: number): number => {
  const t = CLIP_TIMING.get(clip);
  if (!t) {
    return intervalMs * 0.45;
    // unknown clip — the old default feel
  }
  return t.contact * clipPlayMs(clip, intervalMs);
};

/** Strike moment of an ability's cast clip played at its natural (unfitted)
 *  speed — used to schedule ability damage on the animation's contact frame. */
export const castStrikeMs = (champId: string, key: string): number => {
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
