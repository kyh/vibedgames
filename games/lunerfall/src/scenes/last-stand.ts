import type Phaser from "phaser";
import type { Scene } from "phaser";
import { Math as PhaserMath } from "phaser";

import { sfx } from "../audio/sfx";
import { COLORS } from "../config";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import type { NetLastStand } from "../net/snapshot";
import type { RunState } from "../state/run-state";
import { livePlayers } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { impactRing, popText } from "../sys/fx";
import type { BannerHud } from "./banner-hud";
import type { SceneHooks } from "./scene-hooks";

const BLEED_DUR = 7;
export const REVIVE_HOLD = 1.2;
const REVIVE_RANGE = 22;
const REVIVE_HEARTS = 2;

export interface LastStandDeps {
  scene: Scene;
  run: RunState;
  seat: SeatState;
  banners: BannerHud;
  hooks: SceneHooks;
}

export class LastStand {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly hooks: SceneHooks;
  g?: Phaser.GameObjects.Graphics;
  label?: Phaser.GameObjects.Text;

  constructor(deps: LastStandDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.hooks = deps.hooks;
  }

  applyNet(ls: NetLastStand | null, downedId: string | null, hearts: number) {
    if (ls && !this.run.downedNet) {
      const mine = downedId === this.seat.session?.playerId;
      sfx.downed();
      this.banners.show(mine ? "YOU'RE DOWN — HOLD ON" : "ALLY DOWN — REVIVE!", 1800, "critical");
    } else if (!ls && this.run.downedNet && hearts > 0) {
      sfx.revive();
      this.banners.show("REVIVED", 1200, "critical");
    }

    this.run.downedNet = ls;
  }

  can() {
    if (this.run.downed || !this.seat.remote) {
      return false;
    }

    return livePlayers(this.seat).every((p) => !p.body.dead && !p.body.downed);
  }

  enter(pl: Player) {
    this.run.hearts = 0;
    this.run.downed = { bleedT: BLEED_DUR, pl, reviveT: 0 };
    pl.body.down();
    this.run.freeze = Math.max(this.run.freeze, 0.1);
    this.hooks.shake(220, 0.012);
    impactRing(this.scene, pl.x, pl.y - 11, COLORS.magenta, 30);
    sfx.downed();
    this.banners.show(
      pl === this.seat.player ? "YOU'RE DOWN — HOLD ON" : "ALLY DOWN — REVIVE!",
      1800,
      "critical",
    );
    this.hooks.updateHud();
  }

  step(dt: number) {
    const ls = this.run.downed;

    if (!ls) {
      return;
    }

    ls.bleedT -= dt;

    if (ls.bleedT <= 0) {
      this.fail();

      return;
    }

    const rescuer = livePlayers(this.seat).find((p) => p !== ls.pl);

    if (!rescuer || rescuer.body.dead) {
      this.fail();

      return;
    }

    const zone = {
      bottom: ls.pl.y + 6,
      left: ls.pl.x - REVIVE_RANGE,
      right: ls.pl.x + REVIVE_RANGE,
      top: ls.pl.y - 30,
    };

    if (rectsOverlap(zone, rescuer.body.hurtBox())) {
      ls.reviveT += dt;
    } else {
      ls.reviveT = Math.max(0, ls.reviveT - dt * 2);
    }

    if (ls.reviveT >= REVIVE_HOLD) {
      this.completeRevive();
    }
  }

  private completeRevive() {
    const ls = this.run.downed;

    if (!ls) {
      return;
    }

    this.run.downed = null;
    ls.pl.body.revive();
    this.run.hearts = Math.min(this.run.maxHearts, Math.max(0, this.run.hearts) + REVIVE_HEARTS);
    this.destroyUi();
    impactRing(this.scene, ls.pl.x, ls.pl.y - 11, COLORS.teal, 34);
    popText(this.scene, ls.pl.x, ls.pl.y - 30, "REVIVED", "#34e5c8");
    sfx.revive();
    this.banners.show("REVIVED", 1200, "critical");
    this.hooks.updateHud();
  }

  private fail() {
    this.run.downed = null;
    this.destroyUi();
    this.hooks.playerDie();
  }

  private view() {
    if (this.seat.role === "guest") {
      return this.run.downedNet;
    }

    if (!this.run.downed) {
      return null;
    }

    return { bleed: this.run.downed.bleedT, rev: this.run.downed.reviveT / REVIVE_HOLD };
  }

  render() {
    const ls = this.view();
    const downed = livePlayers(this.seat).find((p) => p.body.downed);

    if (!ls || !downed) {
      this.destroyUi();

      return;
    }

    if (!this.g) {
      this.g = this.scene.add.graphics().setDepth(66);
    }

    if (!this.label) {
      this.label = this.scene.add
        .text(0, 0, "", { color: "#34e5c8", fontFamily: "monospace", fontSize: "8px" })
        .setOrigin(0.5, 1)
        .setDepth(66);
    }

    const { x } = downed.sprite;
    const { y } = downed.sprite;
    const { g } = this;
    g.clear();
    const pulse = 1 + Math.sin(this.scene.time.now / 160) * 0.12;
    g.lineStyle(1.5, COLORS.teal, 0.75);
    g.strokeCircle(x, y - 10, REVIVE_RANGE * pulse);
    const frac = PhaserMath.Clamp(ls.bleed / BLEED_DUR, 0, 1);
    const w = 26;
    g.fillStyle(0x00_00_00, 0.55);
    g.fillRect(x - w / 2, y - 36, w, 3);
    g.fillStyle(frac < 0.35 ? 0xff_5a_5a : COLORS.magenta, 0.95);
    g.fillRect(x - w / 2, y - 36, w * frac, 3);

    if (ls.rev > 0) {
      g.fillStyle(COLORS.teal, 0.95);
      g.fillRect(x - w / 2, y - 32, w * Math.min(1, ls.rev), 2);
    }

    const mine = downed === this.seat.player;
    this.label
      .setPosition(x, y - 39)
      .setText(mine ? `HOLD ON ${Math.ceil(ls.bleed)}` : `REVIVE ${Math.ceil(ls.bleed)}`)
      .setAlpha(0.7 + Math.sin(this.scene.time.now / 200) * 0.3);
  }

  destroyUi() {
    this.g?.destroy();
    this.g = undefined;
    this.label?.destroy();
    this.label = undefined;
  }
}
