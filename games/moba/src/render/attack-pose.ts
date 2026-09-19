export interface AttackCue {
  startedAt: number;
  resolveAt: number;
  facing: 1 | -1;
}

/** Original sheet contact cells: archer loose 6, TNT throw 2, barrel spark 2,
 * other unit slashes 3. Sample against authority time, including late snapshots. */
const sheetContactFrame = (key: string): number => {
  if (key.startsWith("u-archer-")) {
    return 6;
  }
  if (key.startsWith("u-tnt-") || key.startsWith("u-barrel-")) {
    return 2;
  }
  return 3;
};

const attackContactFrame = (key: string, count: number): number =>
  Math.min(count - 1, sheetContactFrame(key));

export const attackRecoveryFrame = (progress: number, key: string, count: number) => {
  if (count < 1 || !Number.isFinite(progress) || progress < 0 || progress >= 1) {
    return null;
  }
  const contact = attackContactFrame(key, count);
  return Math.min(count - 1, contact + Math.floor(progress * (count - contact)));
};

export const attackClipFrame = (cue: AttackCue, now: number, key: string, count: number) => {
  if (count < 1 || now < cue.startedAt || now >= cue.resolveAt + 170) {
    return null;
  }
  const contact = attackContactFrame(key, count);
  if (now < cue.resolveAt) {
    return Math.floor(
      (contact * (now - cue.startedAt)) / Math.max(1, cue.resolveAt - cue.startedAt),
    );
  }
  return attackRecoveryFrame((now - cue.resolveAt) / 170, key, count);
};

/** A fallback for sheets without an attack clip. The host's wind-up deadline
 * controls the lean and strike; rendering never schedules or delays damage. */
export const attackPose = (cue: AttackCue, now: number) => {
  if (now >= cue.resolveAt + 170) {
    return null;
  }
  if (now < cue.resolveAt) {
    const t = Math.max(0, (now - cue.startedAt) / Math.max(1, cue.resolveAt - cue.startedAt));
    return { angle: -cue.facing * 9 * t * t, x: -cue.facing * 4 * t * t };
  }
  const recovery = 1 - (now - cue.resolveAt) / 170;
  return { angle: cue.facing * 12 * recovery ** 2, x: cue.facing * 7 * recovery ** 2 };
};
