import type Phaser from "phaser";
import { TintModes } from "phaser";

import { ENEMY_ORIGIN_Y, ENEMY_SCALE, interp } from "../config";
import { showActorPose } from "../data/actor-animation";
import { enemyPose } from "../data/actor-presentation";
import type { EnemyAction } from "../data/actor-presentation";
import type { EnemyKind } from "../data/enemies";
import type { EnemyPose } from "../net/snapshot";
import type { Grid } from "../sys/grid";
import { EnemyBody } from "./enemy-body";
import type { EnemyState } from "./enemy-body";

// Phaser view over EnemyBody: picks the animation clip from the sim state and
// renders a white hit-flash.
export class Enemy {
  readonly body: EnemyBody;
  readonly sprite: Phaser.GameObjects.Sprite;
  // affix recolour (elite enemies); restored after a hit-flash
  baseTint = 0xff_ff_ff;
  private flashing = false;
  private posed = false;

  constructor(scene: Phaser.Scene, grid: Grid, kind: EnemyKind, x: number, y: number) {
    this.body = new EnemyBody(kind, grid, x, y);
    this.sprite = scene.add.sprite(x, y, kind.name);
    this.sprite.setOrigin(0.5, ENEMY_ORIGIN_Y).setScale(ENEMY_SCALE);
    this.sprite.play(`${kind.name}:spawn`);
  }

  // The clip for an FSM state — from the sim on the host, from the wire pose on
  // a guest, so both play the same one.
  private clip(state: EnemyState, moving: boolean): string {
    const n = this.body.kind.name;
    if (state === "dead") {
      if (n === "bomber") {
        return "explode";
      }
      return n === "warrior" ? "dead" : "death";
    }
    if (state === "hurt") {
      return "hit";
    }
    if (state === "spawn") {
      return "spawn";
    }
    const loco = moving ? "run" : "idle";
    switch (this.body.kind.behavior) {
      case "melee": {
        return state === "windup" || state === "attack" ? "strike" : loco;
      }
      case "charger": {
        return state === "charge" ? "charge" : loco;
      }
      case "archer": {
        return state === "windup" ? "shoot" : loco;
      }
      case "bomber": {
        return state === "windup" ? "electrocute" : loco;
      }
      default: {
        return loco;
      }
    }
  }

  // Re-time a clip to its FSM state (authored ~10fps is choppy + longer than the
  // action). Shared by render + applyNet so host and guest play identically.
  private clipMs(suffix: string): number | undefined {
    const k = this.body.kind;
    switch (suffix) {
      case "run": {
        return 460;
      }
      case "strike": {
        return ((k.windup ?? 0.3) + (k.active ?? 0.12)) * 1000;
      }
      case "charge": {
        return (k.chargeTime ?? 0.45) * 1000;
      }
      case "shoot":
      case "electrocute": {
        return (k.windup ?? 0.45) * 1000;
      }
      case "hit": {
        return 200;
      }
      case "spawn": {
        return 400;
      }
      // idle / death keep authored timing
      default: {
        return undefined;
      }
    }
  }

  private playSuffix(key: string, suffix: string) {
    if (this.posed) {
      this.sprite.anims.resume();
      this.posed = false;
    }
    // already looping this clip
    if (this.sprite.anims.currentAnim?.key === key) {
      return;
    }
    // timeScale, not duration: a play `duration` freezes per-frame-duration anims.
    this.sprite.play(key, true);
    const ms = this.clipMs(suffix);
    const authored = this.sprite.anims.currentAnim?.duration ?? 0;
    this.sprite.anims.timeScale = ms !== undefined && ms > 0 && authored > 0 ? authored / ms : 1;
  }

  action(): EnemyAction {
    return { elapsed: this.body.stateT, state: this.body.state };
  }

  private applyAction(action: EnemyAction): boolean {
    const pose = enemyPose(this.body.kind, action);
    if (!pose) {
      return false;
    }
    showActorPose(this.sprite, this.body.kind.name, pose);
    this.posed = true;
    return true;
  }

  render(alpha = 1) {
    const b = this.body;
    if (!this.applyAction(this.action())) {
      const suffix = this.clip(b.state, Math.abs(b.vx) > 10);
      this.playSuffix(`${b.kind.name}:${suffix}`, suffix);
    }
    this.sprite.setFlipX(b.facing < 0);
    this.sprite.setPosition(
      Math.round(interp(b.prevX, b.x, alpha)),
      Math.round(interp(b.prevY, b.y, alpha)),
    );
    const flash = b.hitFlash > 0;
    if (flash && !this.flashing) {
      this.sprite.setTint(0xff_ff_ff).setTintMode(TintModes.FILL);
      this.flashing = true;
    } else if (!flash && this.flashing) {
      this.sprite.setTint(this.baseTint).setTintMode(TintModes.MULTIPLY);
      this.flashing = false;
    }
  }

  /** Elite affix recolour (a guest learns it from the cast). */
  setBaseTint(tint: number) {
    if (tint === this.baseTint) {
      return;
    }
    this.baseTint = tint;
    if (!this.flashing) {
      this.sprite.setTint(tint).setTintMode(TintModes.MULTIPLY);
    }
  }

  // Guest: draw this puppet at a pose interpolated from the host's snapshots
  // (no local sim), playing the pose the host's FSM state implies.
  applyPose(p: EnemyPose) {
    if (!this.applyAction({ elapsed: p.elapsed, state: p.state })) {
      const suffix = this.clip(p.state, p.moving);
      this.playSuffix(`${this.body.kind.name}:${suffix}`, suffix);
    }
    this.sprite.setFlipX(p.flip);
    this.sprite.setPosition(Math.round(p.x), Math.round(p.y));
    if (p.flash && !this.flashing) {
      this.sprite.setTint(0xff_ff_ff).setTintMode(TintModes.FILL);
      this.flashing = true;
    } else if (!p.flash && this.flashing) {
      this.sprite.setTint(this.baseTint).setTintMode(TintModes.MULTIPLY);
      this.flashing = false;
    }
  }

  destroy() {
    this.sprite.destroy();
  }
}
