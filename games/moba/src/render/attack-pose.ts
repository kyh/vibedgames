export type AttackCue = { startedAt: number; resolveAt: number; facing: 1 | -1 };

/** A fallback for sheets without an attack clip. The host's wind-up deadline
 * controls the lean and strike; rendering never schedules or delays damage. */
export function attackPose(cue: AttackCue, now: number) {
  if (now >= cue.resolveAt + 170) return null;
  if (now < cue.resolveAt) {
    const t = Math.max(0, (now - cue.startedAt) / Math.max(1, cue.resolveAt - cue.startedAt));
    return { x: -cue.facing * 4 * t * t, angle: -cue.facing * 9 * t * t };
  }
  const recovery = 1 - (now - cue.resolveAt) / 170;
  return { x: cue.facing * 7 * recovery ** 2, angle: cue.facing * 12 * recovery ** 2 };
}
