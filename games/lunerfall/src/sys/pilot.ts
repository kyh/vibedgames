import type { NavStep } from "./nav";

export interface PilotTarget {
  dx: number;
  dy: number;
  step: NavStep;
}

export interface PilotView {
  frame: number;
  player: { vy: number; facing: number };
  grounded: boolean;
  onWall: number;
  dashReady: boolean;
  nearestEnemy: (PilotTarget & { inReach: boolean }) | null;
  exits: (PilotTarget & { open: boolean })[];
  pickup: PilotTarget | null;
}

export interface Intent {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  jump: boolean;
  dash: boolean;
  attack: boolean;
}

const IDLE: Intent = {
  attack: false,
  dash: false,
  down: false,
  jump: false,
  left: false,
  right: false,
  up: false,
};

const PLAIN_JUMP = 50;
const DEADBAND = 2;
const APEX_VY = -80;
const tap = (frame: number) => frame % 6 < 3;
const JUMP_RETRY = 8;

export class Pilot {
  private jumpFrames = 0;
  private hopping = false;

  exit(view: PilotView, index: number) {
    const door = view.exits[index] ?? view.exits[0];

    return door ? this.steer(view, door.step) : IDLE;
  }

  fight(view: PilotView) {
    const foe = view.nearestEnemy;

    if (!foe) {
      return IDLE;
    }

    if (!foe.inReach) {
      return this.steer(view, foe.step);
    }

    const facingAway = Math.sign(foe.dx) !== view.player.facing && Math.abs(foe.dx) > DEADBAND;

    return {
      ...IDLE,
      attack: tap(view.frame),
      left: facingAway && foe.dx < 0,
      right: facingAway && foe.dx > 0,
    };
  }

  loot(view: PilotView) {
    return view.pickup ? this.steer(view, view.pickup.step) : IDLE;
  }

  retreat(view: PilotView) {
    const foe = view.nearestEnemy;

    if (!foe) {
      return IDLE;
    }

    const away = foe.dx > 0 ? -1 : 1;

    return {
      ...IDLE,
      jump: this.jump(view, view.onWall === away),
      left: away < 0,
      right: away > 0,
    };
  }

  private steer(view: PilotView, step: NavStep) {
    const out = { ...IDLE, down: step.drop, left: step.dx < -DEADBAND, right: step.dx > DEADBAND };
    const short = step.dy < -DEADBAND;

    if (this.hopping && !view.grounded && short && view.dashReady && view.player.vy > APEX_VY) {
      this.jumpFrames = 0;

      return { ...out, dash: true, up: true };
    }

    out.jump = this.jump(view, step.jump && (step.dy > -PLAIN_JUMP || view.dashReady));

    return out;
  }

  private jump(view: PilotView, wanted: boolean) {
    const held = view.grounded
      ? wanted && this.jumpFrames < JUMP_RETRY
      : this.jumpFrames > 0 && view.player.vy < 0;

    this.jumpFrames = held ? this.jumpFrames + 1 : 0;
    this.hopping = view.grounded ? held : this.hopping;

    return held;
  }
}
