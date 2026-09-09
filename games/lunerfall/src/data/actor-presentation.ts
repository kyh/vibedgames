import type { BossState } from "../entities/boss-body";
import type { EnemyState } from "../entities/enemy-body";
import type { EnemyKind } from "./enemies";

/** Authoritative state age, in seconds. Cosmetic only; never advances a body. */
// oxlint-disable-next-line typescript/consistent-type-definitions -- travels inside the JSON snapshot; interfaces get no implicit index signature
export type EnemyAction = {
  state: EnemyState;
  elapsed: number;
};
// oxlint-disable-next-line typescript/consistent-type-definitions -- travels inside the JSON snapshot; interfaces get no implicit index signature
export type BossAction = {
  state: BossState;
  elapsed: number;
};
export interface ActorPose {
  clip: string;
  frame: number;
}

const enemyStates: ReadonlySet<string> = new Set([
  "spawn",
  "chase",
  "windup",
  "attack",
  "charge",
  "recover",
  "hurt",
  "dead",
]);
const bossStates: ReadonlySet<string> = new Set([
  "intro",
  "idle",
  "wave",
  "jump",
  "slam",
  "charge",
  "punch",
  "hurt",
  "phase",
  "dead",
]);

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Optional visual snapshot fields enter from the untyped JSON boundary; validate before playback. */
const isAction = (value: unknown, states: ReadonlySet<string>): boolean =>
  typeof value === "object" &&
  value !== null &&
  "state" in value &&
  typeof value.state === "string" &&
  states.has(value.state) &&
  "elapsed" in value &&
  typeof value.elapsed === "number" &&
  Number.isFinite(value.elapsed) &&
  value.elapsed >= 0;

export const isEnemyAction = (value: unknown): value is EnemyAction => isAction(value, enemyStates);

export const isBossAction = (value: unknown): value is BossAction => isAction(value, bossStates);

export const isActorTint = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xff_ff_ff;
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

const frames = (
  clip: string,
  first: number,
  last: number,
  elapsed: number,
  duration: number,
): ActorPose => {
  const progress = Math.max(0, Math.min(1, elapsed / duration));
  return { clip, frame: Math.min(last, first + Math.floor(progress * (last - first + 1))) };
};

const enemyDeathPose = (kind: EnemyKind, t: number): ActorPose => {
  // Bomber's actual explosion is immediate on death; its first six authored
  // Explode frames are preparation. Start at the measured blast frame (6).
  if (kind.name === "bomber") {
    return frames("explode", 6, 13, t, 0.65);
  }
  if (kind.name === "warrior") {
    return frames("dead", 0, 17, t, 1.8);
  }
  if (kind.name === "archer") {
    return frames("death", 0, 14, t, 1.5);
  }
  return frames("death", 0, 15, t, 1.6);
};

const meleePose = (kind: EnemyKind, state: EnemyState, t: number): ActorPose | null => {
  if (state === "windup") {
    return frames("strike", 0, 2, t, kind.windup ?? 0.3);
  }
  if (state === "attack") {
    return { clip: "strike", frame: 3 };
  }
  if (state === "recover") {
    return frames("strike", 4, 9, t, kind.recover ?? 0.3);
  }
  return null;
};

const chargerPose = (kind: EnemyKind, state: EnemyState, t: number): ActorPose | null => {
  if (state === "windup") {
    return frames("strike", 0, 2, t, kind.windup ?? 0.42);
  }
  if (state === "charge") {
    return frames("strike", 3, 5, t, kind.chargeTime ?? 0.45);
  }
  if (state === "recover") {
    return frames("strike", 6, 8, t, kind.recover ?? 0.5);
  }
  return null;
};

const archerPose = (kind: EnemyKind, state: EnemyState, t: number): ActorPose | null => {
  if (state === "windup") {
    return frames("shoot", 0, 4, t, kind.windup ?? 0.46);
  }
  // The projectile is emitted on entry to recover, not during windup.
  if (state === "recover") {
    return frames("shoot", 5, 8, t, 0.25);
  }
  return null;
};

// Electrocute 8 is a ground discharge. Keep that out of the live fuse;
// Explode supplies the actual discharge when the FSM commits the blast.
const bomberPose = (kind: EnemyKind, state: EnemyState, t: number): ActorPose | null =>
  state === "windup" ? frames("electrocute", 0, 7, t, kind.fuse ?? 0.55) : null;

const attackPose = (kind: EnemyKind, state: EnemyState, t: number): ActorPose | null => {
  switch (kind.behavior) {
    case "melee": {
      return meleePose(kind, state, t);
    }
    case "charger": {
      return chargerPose(kind, state, t);
    }
    case "archer": {
      return archerPose(kind, state, t);
    }
    case "bomber": {
      return bomberPose(kind, state, t);
    }
    default: {
      return null;
    }
  }
};

/** Contact indices measured from the original atlas tags, not new artwork.
 * Warrior Strike 3 / Archer Shoot 5 / Spearman Strike 3 are the forward contacts.
 * Spearman's separately named Charge draws an overhead plant, not its flat lunge.
 * Normal locomotion keeps its existing authored loop (null).
 */
export const enemyPose = (kind: EnemyKind, action: EnemyAction): ActorPose | null => {
  const t = action.elapsed;
  if (action.state === "spawn") {
    return frames("spawn", 0, 7, t, 0.4);
  }
  if (action.state === "hurt") {
    return frames("hit", 0, 2, t, 0.2);
  }
  if (action.state === "dead") {
    return enemyDeathPose(kind, t);
  }
  return attackPose(kind, action.state, t);
};

const punchPose = (t: number): ActorPose => {
  if (t < 0.26) {
    return frames("fire-punch", 0, 5, t, 0.26);
  }
  if (t < 0.4) {
    return { clip: "fire-punch", frame: 6 };
  }
  return frames("fire-punch", 7, 16, t - 0.4, 0.2);
};

const wavePose = (t: number): ActorPose => {
  if (t < 0.5) {
    return frames("flame-wave", 0, 6, t, 0.5);
  }
  if (t < 0.6) {
    return { clip: "flame-wave", frame: 7 };
  }
  return frames("flame-wave", 8, 17, t - 0.6, 0.25);
};

const chargePose = (t: number): ActorPose => {
  if (t < 0.4) {
    return frames("fire-punch", 0, 5, t, 0.4);
  }
  if (t < 0.82) {
    return frames("dash", 0, 3, (t - 0.4) % 0.2, 0.2);
  }
  return { clip: "dash", frame: 3 };
};

const bossPose = (state: BossState, t: number, landed: boolean): ActorPose | null => {
  switch (state) {
    case "punch": {
      return punchPose(t);
    }
    case "wave": {
      return wavePose(t);
    }
    case "jump": {
      return frames("flame-slam", 0, 7, t, 0.34);
    }
    case "slam": {
      // Frames 8–10 hold the fire overhead; ground contact is frame 11.
      // Air time is physics-owned, so never run the ground flash on a timer.
      return frames("flame-slam", 8, 10, t, 0.2);
    }
    case "charge": {
      return chargePose(t);
    }
    case "phase": {
      return frames("flame-slam", 0, 10, t, 0.8);
    }
    case "hurt": {
      return frames("hit", 0, 2, t, 0.2);
    }
    case "dead": {
      return frames("death", 0, 22, t, 2.3);
    }
    case "idle": {
      return landed && t < 0.24 ? frames("flame-slam", 11, 18, t, 0.24) : null;
    }
    case "intro": {
      return null;
    }
    default: {
      return null;
    }
  }
};

/** One bounded transition memory lets a real slam landing finish its drawing.
 * A first/late idle baseline cannot invent that landing, and a new state always
 * interrupts it. All other poses derive directly from the supplied sim age.
 */
export class BossActing {
  private previous: BossState | null = null;
  private previousAge = 0;
  private landed = false;

  reset(): void {
    this.previous = null;
    this.previousAge = 0;
    this.landed = false;
  }

  pose(action: BossAction): ActorPose | null {
    const { state, elapsed: t } = action;
    if (state !== this.previous) {
      this.landed = this.previous === "slam" && state === "idle";
    } else if (t < this.previousAge) {
      this.landed = false;
    }
    this.previous = state;
    this.previousAge = t;
    return bossPose(state, t, this.landed);
  }
}

/** Puppet lerp fraction: 0.35 per frame at 60 Hz, made refresh-rate independent. */
export const remoteBlend = (dt: number): number =>
  Number.isFinite(dt) ? 1 - 0.65 ** (Math.max(0, dt) * 60) : 0;
