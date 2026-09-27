import type { NavStep } from "./nav";

// The playtest pilot: the per-frame hands behind the manifest's moves
// (sys/diag.ts). The decision model picks WHAT a few times a second — fight,
// leave, loot, back off — and this turns that into held inputs at 60 fps,
// because a wall-high ledge or a 100 ms strike window can't wait on a round
// trip. Pure: it reads a plain view and returns held buttons, so the sim
// harness flies it through real rooms.

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

// A plain jump tops out ~56 px; anything higher needs the apex dash in hand before take-off.
const PLAIN_JUMP = 50;
const DEADBAND = 2;
const APEX_VY = -80;
// Attack and dash are read on the keydown edge: tapped, so a press swallowed mid-swing or mid-stun fires again.
const tap = (frame: number): boolean => frame % 6 < 3;
// A grounded jump that hasn't left the floor after this many frames was swallowed; let go and press again.
const JUMP_RETRY = 8;

export class Pilot {
  private jumpFrames = 0;
  private hopping = false;

  exit(view: PilotView, index: number): Intent {
    const door = view.exits[index] ?? view.exits[0];
    return door ? this.steer(view, door.step) : IDLE;
  }

  fight(view: PilotView): Intent {
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

  loot(view: PilotView): Intent {
    return view.pickup ? this.steer(view, view.pickup.step) : IDLE;
  }

  retreat(view: PilotView): Intent {
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

  private steer(view: PilotView, step: NavStep): Intent {
    const out = { ...IDLE, down: step.drop, left: step.dx < -DEADBAND, right: step.dx > DEADBAND };
    const short = step.dy < -DEADBAND;
    // Only a jump this pilot started gets the apex dash — a knock-back or a fall off a ledge keeps it in hand.
    if (this.hopping && !view.grounded && short && view.dashReady && view.player.vy > APEX_VY) {
      this.jumpFrames = 0;
      return { ...out, dash: true, up: true };
    }
    out.jump = this.jump(view, step.jump && (step.dy > -PLAIN_JUMP || view.dashReady));
    return out;
  }

  // Pressed the frame it is wanted, then held through the rise: releasing early cuts the jump short.
  private jump(view: PilotView, wanted: boolean): boolean {
    const held = view.grounded
      ? wanted && this.jumpFrames < JUMP_RETRY
      : this.jumpFrames > 0 && view.player.vy < 0;
    this.jumpFrames = held ? this.jumpFrames + 1 : 0;
    this.hopping = view.grounded ? held : this.hopping;
    return held;
  }
}
