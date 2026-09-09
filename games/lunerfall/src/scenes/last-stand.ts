import type Phaser from "phaser";
import type { Scene } from "phaser";
import { Math as PhaserMath } from "phaser";

import { sfx } from "../audio/sfx";
import { COLORS } from "../config";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import type { NetLastStand, Snapshot } from "../net/snapshot";
import type { RunState } from "../state/run-state";
import { livePlayers } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { impactRing, popText } from "../sys/fx";
import type { BannerHud } from "./banner-hud";
import type { SceneHooks } from "./scene-hooks";

// Co-op last stand: a fatal hit with both players up downs the victim instead of
// wiping; the partner has BLEED_DUR to hold within REVIVE_RANGE for REVIVE_HOLD.
// s a downed player survives awaiting a revive
const BLEED_DUR = 7;
// s of sustained rescuer overlap to complete a revive
export const REVIVE_HOLD = 1.2;
// px around the downed body that counts as reviving
const REVIVE_RANGE = 22;
// shared hearts restored on revive
const REVIVE_HEARTS = 2;

// Co-op last stand: the host simulates the downed player's bleed-out clock and
// the rescuer's revive hold; guests mirror the broadcast. Both render the
// downed marker.
export class LastStand {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly hooks: SceneHooks;
  // downed marker (ring + bars)
  g?: Phaser.GameObjects.Graphics;
  label?: Phaser.GameObjects.Text;

  constructor(scene: Scene, run: RunState, seat: SeatState, banners: BannerHud, hooks: SceneHooks) {
    this.scene = scene;
    this.run = run;
    this.seat = seat;
    this.banners = banners;
    this.hooks = hooks;
  }

  // Guest: mirror the host's last-stand state; edge-detect enter/exit for the
  // banner + sting (the marker itself renders from the snapshot every frame).
  applyNet(s: Snapshot) {
    const ls = s.lastStand ?? null;
    if (ls && !this.run.downedNet) {
      const mine = s.players.find((p) => p.downed)?.id === this.seat.session?.playerId;
      sfx.downed();
      this.banners.show(mine ? "YOU'RE DOWN — HOLD ON" : "ALLY DOWN — REVIVE!", 1800, "critical");
    } else if (!ls && this.run.downedNet && s.hearts > 0) {
      sfx.revive();
      this.banners.show("REVIVED", 1200, "critical");
    }
    this.run.downedNet = ls;
  }

  // Only in co-op, with both players up and no one already down. A hit taken
  // while a last stand is active (hearts ≤ 0 again) therefore wipes.
  can(): boolean {
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

  // Host: tick the bleed-out clock and the rescuer's revive overlap.
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
    // Overlap fills the revive meter; separating drains it (fast, not a reset).
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
    // On top of anything healed into the pool while down (e.g. mooni's special).
    this.run.hearts = Math.min(this.run.maxHearts, Math.max(0, this.run.hearts) + REVIVE_HEARTS);
    this.destroyUi();
    impactRing(this.scene, ls.pl.x, ls.pl.y - 11, COLORS.teal, 34);
    popText(this.scene, ls.pl.x, ls.pl.y - 30, "REVIVED", "#34e5c8");
    sfx.revive();
    this.banners.show("REVIVED", 1200, "critical");
    this.hooks.updateHud();
  }

  // Bleed-out expired (or the rescuer fell): the shared run is over.
  private fail() {
    this.run.downed = null;
    this.destroyUi();
    this.hooks.playerDie();
  }

  private view(): NetLastStand | null {
    if (this.seat.role === "guest") {
      return this.run.downedNet;
    }
    if (!this.run.downed) {
      return null;
    }
    return { bleed: this.run.downed.bleedT, rev: this.run.downed.reviveT / REVIVE_HOLD };
  }

  // Downed marker, drawn each frame on BOTH clients: a pulsing revive ring, a
  // shrinking bleed-out bar, a teal revive-progress bar, and the rescuer prompt.
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
