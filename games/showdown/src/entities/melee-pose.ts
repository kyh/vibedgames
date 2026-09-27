import type { MeleeStyle } from "../config";

export interface MeleeCue {
  angle: number;
  elapsed: number;
  recovery: number;
  windup: number;
}

export interface MeleePose {
  advance: number;
  armPitch: number;
  armRoll: number;
  armYaw: number;
  bodyPitch: number;
  bodyYaw: number;
  commitment: number;
  guard: number;
  weaponPitch: number;
  weaponRoll: number;
  weaponYaw: number;
}

interface MeleeSequence {
  contact: MeleePose;
  draw: MeleePose;
  drawFraction: number;
  follow: MeleePose;
  followDuration: number;
  rest: MeleePose;
}

const REST: MeleePose = {
  advance: 0,
  armPitch: 0,
  armRoll: 0,
  armYaw: 0,
  bodyPitch: 0,
  bodyYaw: 0,
  commitment: 0,
  guard: 0,
  weaponPitch: 0.24,
  weaponRoll: -0.16,
  weaponYaw: 0,
};

const SWORD: MeleeSequence = {
  contact: {
    advance: 0.17,
    armPitch: -0.65,
    armRoll: -0.1,
    armYaw: 0,
    bodyPitch: 0.16,
    bodyYaw: 0,
    commitment: 1,
    guard: 1,
    weaponPitch: Math.PI / 2,
    weaponRoll: 0,
    weaponYaw: 0,
  },
  draw: {
    advance: -0.09,
    armPitch: -0.3,
    armRoll: 0.72,
    armYaw: 0.82,
    bodyPitch: -0.13,
    bodyYaw: 0.68,
    commitment: 1,
    guard: 0.7,
    weaponPitch: 1.32,
    weaponRoll: -0.08,
    weaponYaw: 1.85,
  },
  drawFraction: 0.5,
  follow: {
    advance: 0.13,
    armPitch: -0.55,
    armRoll: -0.8,
    armYaw: -1.1,
    bodyPitch: 0.1,
    bodyYaw: -0.78,
    commitment: 1,
    guard: 0.8,
    weaponPitch: 1.82,
    weaponRoll: 0.08,
    weaponYaw: -1.9,
  },
  followDuration: 0.13,
  rest: REST,
};

const HAMMER: MeleeSequence = {
  contact: { ...SWORD.contact, advance: 0.23, armPitch: -0.7, bodyPitch: 0.32 },
  draw: {
    advance: -0.14,
    armPitch: -1.68,
    armRoll: 0.22,
    armYaw: 0.1,
    bodyPitch: -0.27,
    bodyYaw: 0.24,
    commitment: 1,
    guard: 0.85,
    weaponPitch: -1.38,
    weaponRoll: 0.08,
    weaponYaw: 0.12,
  },
  drawFraction: 0.6,
  follow: {
    advance: 0.19,
    armPitch: -1.4,
    armRoll: -0.18,
    armYaw: -0.24,
    bodyPitch: 0.42,
    bodyYaw: -0.27,
    commitment: 1,
    guard: 0.9,
    weaponPitch: 2.35,
    weaponRoll: -0.12,
    weaponYaw: -0.17,
  },
  followDuration: 0.18,
  rest: { ...REST, weaponPitch: 0.12, weaponRoll: 0.14 },
};

const SPEAR: MeleeSequence = {
  contact: { ...SWORD.contact, advance: 0.31, armPitch: -0.88, bodyPitch: 0.26 },
  draw: {
    ...SWORD.draw,
    advance: -0.2,
    armPitch: 0.95,
    armRoll: 0.06,
    armYaw: 0.1,
    bodyPitch: -0.2,
    bodyYaw: 0.42,
    weaponPitch: 1.39,
    weaponRoll: 0,
    weaponYaw: 0.06,
  },
  drawFraction: 0.52,
  follow: {
    ...SWORD.follow,
    advance: 0.36,
    armPitch: -0.88,
    armRoll: -0.12,
    armYaw: -0.1,
    bodyPitch: 0.29,
    bodyYaw: -0.18,
    weaponPitch: 1.59,
    weaponRoll: 0,
    weaponYaw: 0,
  },
  followDuration: 0.12,
  rest: { ...REST, weaponPitch: 0.85, weaponRoll: -0.08 },
};

const DAGGERS: MeleeSequence = {
  contact: { ...SWORD.contact, advance: 0.21, armPitch: -0.4, bodyPitch: 0.22 },
  draw: {
    ...SWORD.draw,
    advance: -0.1,
    armPitch: -0.12,
    armRoll: 0.8,
    armYaw: 0.68,
    bodyYaw: 0.28,
    weaponPitch: 1.1,
    weaponRoll: 0.05,
    weaponYaw: 1.52,
  },
  drawFraction: 0.42,
  follow: {
    ...SWORD.follow,
    advance: 0.16,
    armPitch: -0.32,
    armRoll: -0.85,
    armYaw: -0.95,
    bodyYaw: -0.4,
    weaponPitch: 2.04,
    weaponRoll: -0.08,
    weaponYaw: -1.72,
  },
  followDuration: 0.1,
  rest: { ...REST, weaponPitch: 0.6, weaponRoll: -0.28 },
};

const SEQUENCES: Record<MeleeStyle, MeleeSequence> = {
  cleave: SWORD,
  flurry: DAGGERS,
  smash: HAMMER,
  thrust: SPEAR,
};

const mixPose = (from: MeleePose, to: MeleePose, t: number): MeleePose => ({
  advance: from.advance + (to.advance - from.advance) * t,
  armPitch: from.armPitch + (to.armPitch - from.armPitch) * t,
  armRoll: from.armRoll + (to.armRoll - from.armRoll) * t,
  armYaw: from.armYaw + (to.armYaw - from.armYaw) * t,
  bodyPitch: from.bodyPitch + (to.bodyPitch - from.bodyPitch) * t,
  bodyYaw: from.bodyYaw + (to.bodyYaw - from.bodyYaw) * t,
  commitment: from.commitment + (to.commitment - from.commitment) * t,
  guard: from.guard + (to.guard - from.guard) * t,
  weaponPitch: from.weaponPitch + (to.weaponPitch - from.weaponPitch) * t,
  weaponRoll: from.weaponRoll + (to.weaponRoll - from.weaponRoll) * t,
  weaponYaw: from.weaponYaw + (to.weaponYaw - from.weaponYaw) * t,
});

const smooth = (t: number): number => t * t * (3 - 2 * t);

export const meleeFollowTime = (style: MeleeStyle, recovery: number): number =>
  Math.min(SEQUENCES[style].followDuration, recovery * 0.4);

/** Contact is the combat deadline. Late snapshots sample recovery directly. */
export const sampleMeleePose = (cue: MeleeCue | null, style: MeleeStyle): MeleePose => {
  const sequence = SEQUENCES[style];
  const { contact, draw, follow, rest } = sequence;
  if (!cue || cue.elapsed <= 0 || cue.elapsed >= cue.windup + cue.recovery) {
    return rest;
  }
  const drawUntil = cue.windup * sequence.drawFraction;
  if (cue.elapsed < drawUntil) {
    return mixPose(rest, draw, smooth(cue.elapsed / drawUntil));
  }
  if (cue.elapsed < cue.windup) {
    const t = (cue.elapsed - drawUntil) / (cue.windup - drawUntil);
    return mixPose(draw, contact, t * t);
  }
  const afterContact = cue.elapsed - cue.windup;
  const followUntil = meleeFollowTime(style, cue.recovery);
  if (afterContact < followUntil) {
    const t = afterContact / followUntil;
    return mixPose(contact, follow, 1 - (1 - t) ** 2);
  }
  const t = (afterContact - followUntil) / (cue.recovery - followUntil);
  return mixPose(follow, rest, smooth(t));
};
