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

export type ClipTiming = { dur: number; contact: number };

export const CLIP_TIMING: Record<string, ClipTiming> = {
  // ── Rig_Medium melee ──
  Melee_2H_Attack_Chop: { dur: 1.633, contact: 0.44 },
  Melee_2H_Attack_Slice: { dur: 1.1, contact: 0.34 },
  Melee_2H_Attack_Spin: { dur: 2.4, contact: 0.42 }, // OVERRIDE: the whirl's first blade pass sweeps the room just before mid-clip
  Melee_2H_Attack_Spinning: { dur: 0.667, contact: 0.4 },
  Melee_1H_Attack_Chop: { dur: 1.067, contact: 0.54 },
  Melee_1H_Attack_Slice_Diagonal: { dur: 1, contact: 0.41 },
  Melee_1H_Attack_Slice_Horizontal: { dur: 1.367, contact: 0.3 }, // OVERRIDE 0.19: swipe reads mid-swing, not first hand flick
  Melee_1H_Attack_Stab: { dur: 1.6, contact: 0.24 },
  Melee_1H_Attack_Jump_Chop: { dur: 1.333, contact: 0.54 },
  Melee_Dualwield_Attack_Chop: { dur: 1.267, contact: 0.43 },
  Melee_Dualwield_Attack_Slice: { dur: 1.167, contact: 0.47 },
  Melee_Dualwield_Attack_Stab: { dur: 1.6, contact: 0.24 },
  Melee_Unarmed_Attack_Punch_A: { dur: 1.167, contact: 0.37 },
  // ── Rig_Medium ranged/cast ──
  Ranged_Bow_Release: { dur: 1.333, contact: 0.31 },
  Ranged_Bow_Release_Up: { dur: 1.367, contact: 0.3 }, // OVERRIDE 0.13: string release, hand barely moves
  Ranged_Magic_Shoot: { dur: 0.933, contact: 0.38 }, // OVERRIDE 0.08: bolt leaves on the forward thrust
  Ranged_Magic_Raise: { dur: 2.1, contact: 0.55 }, // OVERRIDE 0.13: the raise crescendos past mid-clip
  Ranged_Magic_Summon: { dur: 4.3, contact: 0.68 },
  Ranged_Magic_Spellcasting: { dur: 0.667, contact: 0.5 }, // OVERRIDE 0.86: continuous weave, mid-clip reads best
  Throw: { dur: 1.367, contact: 0.45 },
  // ── Rig_Medium misc one-shots the render fits to windows ──
  Hit_A: { dur: 0.667, contact: 0.5 },
  Hit_B: { dur: 0.867, contact: 0.5 },
  Jump_Start: { dur: 0.6, contact: 0.5 },
  Jump_Land: { dur: 0.667, contact: 0.5 },
  Dodge_Forward: { dur: 0.4, contact: 0.5 },
  PickUp: { dur: 1.3, contact: 0.5 },
  Melee_Blocking: { dur: 1.067, contact: 0.5 },
  Dodge_Backward: { dur: 0.4, contact: 0.5 },
  Spawn_Air: { dur: 1.3, contact: 0.5 },
  // ── Rig_Large (frost golem / boss) — native Large clip names ──
  Melee_2H_Attack: { dur: 1.333, contact: 0.35 },
  Melee_2H_Slam: { dur: 2.833, contact: 0.33 },
  Melee_Unarmed_Smash: { dur: 3.467, contact: 0.27 },
};

// ── Playback speed ───────────────────────────────────────────────────────────
// 2H greatsword/hammer swings play 1.5× faster than authored (snappier heavy
// weapons); a couple of marathon cast clips are compressed so a cast never
// roots the character for multiple seconds (fixes the old ONE_SHOT_CAP cutoff
// that chopped Summon/Raise mid-motion).
const CLIP_SPEED: Record<string, number> = {
  Ranged_Magic_Summon: 3.0, // 4.3s → ~1.4s cast
  Ranged_Magic_Raise: 1.75, // 2.1s → ~1.2s cast
  // dive-chop contact lands exactly at the JUMP leap's touchdown (~250ms):
  // 0.54 × 1333ms / 2.9 ≈ 248ms — the slam fx, damage, and blade all agree
  Melee_1H_Attack_Jump_Chop: 2.9,
};
export const TWO_H_SPEED = 1.5;

/** Base playback rate for a clip (before interval fitting speeds it further). */
export function clipSpeed(clip: string): number {
  return CLIP_SPEED[clip] ?? (clip.startsWith("Melee_2H_") ? TWO_H_SPEED : 1);
}

// ── Basic-attack swing clips ─────────────────────────────────────────────────
// Per-champ swing rotations, cycled by the synced swingCount (parallel to
// champions.ts basicRhythm). Creeps included — the render and the sim's strike
// timing both key off this ONE table.
export const ATTACK_SETS: Record<string, string[]> = {
  knight: ["Melee_2H_Attack_Chop", "Melee_2H_Attack_Slice", "Melee_2H_Attack_Spin"],
  rogue: ["Melee_Dualwield_Attack_Chop", "Melee_Dualwield_Attack_Slice"],
  ranger: ["Ranged_Bow_Release"],
  mage: ["Ranged_Magic_Shoot"],
  blackknight: [
    "Melee_1H_Attack_Chop",
    "Melee_1H_Attack_Slice_Diagonal",
    "Melee_1H_Attack_Slice_Horizontal",
  ],
  witch: ["Ranged_Magic_Shoot"],
  skwarrior: ["Melee_1H_Attack_Chop", "Melee_1H_Attack_Stab"],
  skminion: ["Melee_Unarmed_Attack_Punch_A", "Melee_1H_Attack_Chop"],
  skmage: ["Ranged_Magic_Shoot"],
  frostgolem: ["Melee_2H_Attack", "Melee_2H_Slam", "Melee_Unarmed_Smash"], // native Large names
};

/** The swing clip a unit's `swingCount`-th basic attack plays. */
export function swingClip(champId: string, swingCount: number): string {
  const set = ATTACK_SETS[champId];
  if (!set || set.length === 0) return "Melee_1H_Attack_Chop";
  return set[Math.max(0, swingCount - 1) % set.length]!;
}

// ── Ability cast clips ───────────────────────────────────────────────────────
// Which clip each ability cast plays (render) — and therefore when its strike
// connects (sim). DASH rides Dodge_Forward everywhere; JUMP is the aerial
// dive-chop for every champ.
export const ABILITY_CLIPS: Record<string, Partial<Record<string, string>>> = {
  knight: {
    Q: "Melee_2H_Attack_Slice",
    W: "Melee_2H_Attack_Chop",
    E: "Melee_Blocking",
    R: "Melee_2H_Attack_Spinning",
    DASH: "Dodge_Forward",
    JUMP: "Melee_1H_Attack_Jump_Chop",
  },
  ranger: {
    Q: "Ranged_Bow_Release_Up",
    W: "Ranged_Bow_Release",
    E: "PickUp",
    R: "Ranged_Bow_Release_Up",
    DASH: "Dodge_Forward",
    JUMP: "Melee_1H_Attack_Jump_Chop",
  },
  mage: {
    Q: "Ranged_Magic_Shoot",
    W: "Ranged_Magic_Raise",
    E: "Ranged_Magic_Shoot",
    R: "Ranged_Magic_Summon",
    DASH: "Dodge_Forward",
    JUMP: "Melee_1H_Attack_Jump_Chop",
  },
  rogue: {
    Q: "Melee_Dualwield_Attack_Stab",
    W: "Melee_Dualwield_Attack_Slice",
    E: "Dodge_Backward",
    R: "Melee_Dualwield_Attack_Slice",
    DASH: "Dodge_Forward",
    JUMP: "Melee_1H_Attack_Jump_Chop",
  },
  blackknight: {
    Q: "Melee_1H_Attack_Slice_Horizontal",
    W: "Melee_1H_Attack_Chop",
    E: "Melee_Blocking",
    R: "Melee_2H_Attack_Chop",
    DASH: "Dodge_Forward",
    JUMP: "Melee_1H_Attack_Jump_Chop",
  },
  witch: {
    Q: "Ranged_Magic_Shoot",
    W: "Ranged_Magic_Summon",
    E: "Ranged_Magic_Raise",
    R: "Ranged_Magic_Raise",
    DASH: "Dodge_Forward",
    JUMP: "Melee_1H_Attack_Jump_Chop",
  },
};

// ── Shared timing math (sim windups ↔ render timeScales) ─────────────────────

/** The timeScale the render plays `clip` at so the WHOLE clip fits inside
 *  `intervalMs` (never clipped, sped up only when needed). */
export function fitTimeScale(clip: string, intervalMs: number): number {
  const t = CLIP_TIMING[clip];
  const base = clipSpeed(clip);
  if (!t) return base;
  return Math.max(base, (t.dur * 1000) / Math.max(1, intervalMs));
}

/** How long `clip` actually plays on screen inside `intervalMs`. */
export function clipPlayMs(clip: string, intervalMs: number): number {
  const t = CLIP_TIMING[clip];
  if (!t) return intervalMs;
  return (t.dur * 1000) / fitTimeScale(clip, intervalMs);
}

/** Milliseconds from swing start until the blade/shot visually connects, for a
 *  swing whose full interval is `intervalMs`. This IS the sim's windup. */
export function strikeMs(clip: string, intervalMs: number): number {
  const t = CLIP_TIMING[clip];
  if (!t) return intervalMs * 0.45; // unknown clip — the old default feel
  return t.contact * clipPlayMs(clip, intervalMs);
}

/** Strike moment of an ability's cast clip played at its natural (unfitted)
 *  speed — used to schedule ability damage on the animation's contact frame. */
export function castStrikeMs(champId: string, key: string): number {
  const clip = ABILITY_CLIPS[champId]?.[key];
  if (!clip) return 0;
  const t = CLIP_TIMING[clip];
  if (!t) return 0;
  return (t.contact * t.dur * 1000) / clipSpeed(clip);
}
