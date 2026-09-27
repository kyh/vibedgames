import type { BrawlerId } from "../config";

export interface RangedCue {
  elapsed: number;
  isSuper: boolean;
}

export interface RangedPose {
  advance: number;
  bodyDrop: number;
  bodyPitch: number;
  bodyYaw: number;
  leftPitch: number;
  leftRoll: number;
  leftYaw: number;
  loaded: boolean;
  rightPitch: number;
  rightRoll: number;
  rightYaw: number;
  weaponPitch: number;
  weaponRoll: number;
  weaponVisible: boolean;
  weaponYaw: number;
}

const REST: RangedPose = {
  advance: 0,
  bodyDrop: 0,
  bodyPitch: 0,
  bodyYaw: 0,
  leftPitch: 0,
  leftRoll: 0,
  leftYaw: 0,
  loaded: true,
  rightPitch: 0,
  rightRoll: 0,
  rightYaw: 0,
  weaponPitch: 0,
  weaponRoll: 0,
  weaponVisible: true,
  weaponYaw: 0,
};

const DURATIONS: Record<BrawlerId, [number, number]> = {
  ace: [0.32, 0.5],
  dusty: [0, 0],
  flint: [0.42, 0.56],
  fuse: [0.48, 0.68],
  moss: [0.44, 0.65],
  nyx: [0, 0],
  pip: [0.46, 0.66],
  rowan: [0.4, 0.54],
  titan: [0, 0],
};

export const rangedPoseDuration = (id: BrawlerId, isSuper: boolean): number =>
  DURATIONS[id][isSuper ? 1 : 0];

interface RangedPhase {
  hold: number;
  isSuper: boolean;
  power: number;
  recover: number;
  release: number;
  t: number;
}

const wrenPose = ({ hold, isSuper, power, recover, release, t }: RangedPhase): RangedPose =>
  // The bow arm stays extended while the string hand snaps back, then draws again.
  ({
    ...REST,
    bodyDrop: isSuper ? hold * 0.07 : 0,
    bodyYaw: -release * 0.16 * power,
    leftPitch: release * 0.55 - recover * 0.2,
    leftRoll: release * 0.34 * power,
    leftYaw: -release * 0.7 * power + recover * 0.25,
    loaded: t >= 0.4,
    rightPitch: -release * 0.16 * power,
    weaponPitch: -release * 0.13 * power,
    weaponRoll: isSuper ? -release * 0.52 : release * 0.08,
  });

const emberPose = ({ hold, isSuper, power, recover, release }: RangedPhase): RangedPose =>
  // Ember flicks fire from the staff; the meteor calls both staff and open palm upward.
  ({
    ...REST,
    bodyPitch: release * (isSuper ? -0.17 : 0.13) + recover * 0.1,
    bodyYaw: release * 0.15,
    leftPitch: -hold * (isSuper ? 1.6 : 0.65),
    leftRoll: -hold * (isSuper ? 0.6 : 0.25),
    rightPitch: -release * (isSuper ? 0.85 : 0.3) + recover * 0.12,
    rightRoll: -release * 0.15,
    weaponPitch: release * (isSuper ? -0.55 : 0.4) + recover * 0.16,
    weaponRoll: -release * 0.16 * power,
  });

const rowanPose = ({ isSuper, power, recover, release, t }: RangedPhase): RangedPose =>
  // Follow the released javelin through with the shoulder, then reach back for another.
  ({
    ...REST,
    advance: release * 0.13 * power,
    bodyDrop: isSuper ? release * 0.09 : 0,
    bodyPitch: release * 0.21 * power,
    bodyYaw: -release * 0.32 * power,
    leftPitch: release * 0.38,
    leftRoll: -release * 0.3 * power,
    rightPitch: release * 0.85 - recover * 0.35,
    rightRoll: -release * 0.27 * power,
    rightYaw: -release * 0.38 * power + recover * 0.2,
    weaponPitch: -recover * 0.3,
    weaponVisible: t >= 0.58,
    weaponYaw: recover * 0.2,
  });

const mossPose = ({ hold, isSuper, recover, release }: RangedPhase): RangedPose =>
  // Thorns sweep sideways; the seedpod rises from a low, two-handed gathering gesture.
  ({
    ...REST,
    bodyDrop: isSuper ? hold * 0.11 : 0,
    bodyPitch: isSuper ? -release * 0.12 : release * 0.09,
    bodyYaw: release * (isSuper ? -0.18 : 0.3) - recover * 0.1,
    leftPitch: -hold * (isSuper ? 1.45 : 0.5),
    leftRoll: -hold * (isSuper ? 0.55 : 0.25),
    leftYaw: release * 0.35,
    rightPitch: -release * (isSuper ? 0.65 : 0.1),
    rightRoll: release * 0.25 - recover * 0.12,
    weaponPitch: -release * (isSuper ? 0.42 : 0.1),
    weaponRoll: release * (isSuper ? -0.2 : 0.48) - recover * 0.2,
    weaponYaw: release * 0.28,
  });

const flintPose = ({ hold, isSuper, power, recover, release, t }: RangedPhase): RangedPose =>
  // A short stock kick, then the support hand recocks the crossbow beneath it.
  ({
    ...REST,
    advance: -release * 0.05 * power,
    bodyDrop: isSuper ? hold * 0.08 : 0,
    bodyPitch: -release * 0.12 * power,
    leftPitch: -release * 0.2 + recover * 0.7,
    leftRoll: recover * 0.2,
    loaded: t >= 0.55,
    rightPitch: -release * 0.3 * power,
    weaponPitch: -release * 0.25 * power + recover * 0.13,
    weaponRoll: recover * (isSuper ? 0.12 : 0.23),
  });

const pipPose = ({ isSuper, power, recover, release, t }: RangedPhase): RangedPose =>
  // A quick sidearm toss; Grand Brew gets a two-handed heave and deeper follow-through.
  ({
    ...REST,
    advance: release * 0.06 * power,
    bodyDrop: isSuper ? recover * 0.09 : 0,
    bodyPitch: release * 0.19 * power,
    bodyYaw: isSuper ? 0 : -release * 0.3,
    leftPitch: isSuper ? -release * 1.3 + recover * 0.4 : recover * 0.25,
    leftRoll: isSuper ? release * 0.5 : 0,
    rightPitch: -release * (isSuper ? 1.2 : 0.6) + recover * 0.65,
    rightRoll: release * (isSuper ? -0.2 : -0.65) + recover * 0.2,
    weaponRoll: recover * 0.3,
    weaponVisible: t >= 0.6,
  });

/** Shots release immediately. Recoil, recocking and follow-through carry their weight. */
export const sampleRangedPose = (cue: RangedCue | null, id: BrawlerId): RangedPose => {
  if (!cue) {
    return REST;
  }
  const duration = rangedPoseDuration(id, cue.isSuper);
  if (duration === 0 || cue.elapsed < 0 || cue.elapsed >= duration) {
    return REST;
  }
  const t = cue.elapsed / duration;
  const phase: RangedPhase = {
    hold: (1 - t) ** 2,
    isSuper: cue.isSuper,
    power: cue.isSuper ? 1.5 : 1,
    recover: Math.sin(t * Math.PI) ** 2,
    release: Math.max(0, 1 - t / 0.45) ** 2,
    t,
  };
  switch (id) {
    case "ace": {
      return wrenPose(phase);
    }
    case "fuse": {
      return emberPose(phase);
    }
    case "rowan": {
      return rowanPose(phase);
    }
    case "moss": {
      return mossPose(phase);
    }
    case "flint": {
      return flintPose(phase);
    }
    case "pip": {
      return pipPose(phase);
    }
    default: {
      return REST;
    }
  }
};
