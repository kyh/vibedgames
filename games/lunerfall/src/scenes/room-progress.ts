import type { Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { biomePalette } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { pickRelics, RARITY_COLOR } from "../data/relics";
import type { Relic } from "../data/relics";
import type { RoomType } from "../data/rooms";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import { livePlayers } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { explosion, hitSpark, impactRing, popText } from "../sys/fx";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { SceneHooks } from "./scene-hooks";

const CLEAR_BANNER = new Map<RoomType, string>([
  ["boss", "DESCEND"],
  ["elite", "ELITE CLEAR — pick a path"],
]);

export interface RoomProgressDeps {
  scene: Scene;
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  hooks: SceneHooks;
}

// Run progression inside a room: rewards (hearts, gold, relics, features,
// merchant buys), the clear condition, and the doors that lead on.
export class RoomProgress {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly hooks: SceneHooks;

  constructor(deps: RoomProgressDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.hooks = deps.hooks;
  }

  private applyRelic(relic: Relic) {
    this.run.ownedRelics.add(relic.id);
    relic.apply(this.run.mods);
    const before = this.run.maxHearts;
    // Floor at 1 heart so glass-cannon relics can't lock a 0-heart run; extra max
    // hearts arrive filled, and a reduced max clamps current hearts down.
    this.run.maxHearts = Math.max(1, this.run.mods.maxHearts);
    this.run.hearts = Math.min(
      this.run.hearts + Math.max(0, this.run.maxHearts - before),
      this.run.maxHearts,
    );
    sfx.pickup("local");
    this.hooks.updateHud();
  }

  stepMerchant() {
    for (const m of this.room.merchantItems) {
      if (m.bought || this.run.gold < m.relic.price) {
        continue;
      }
      const box = { bottom: m.y, left: m.x - 10, right: m.x + 10, top: m.y - 22 };
      if (livePlayers(this.seat).some((pl) => rectsOverlap(box, pl.body.hurtBox()))) {
        m.bought = true;
        this.run.gold -= m.relic.price;
        this.applyRelic(m.relic);
        // The buy is the whole point of a shrine room: ring it in the relic's
        // own rarity colour so the moment of purchase reads, not just its text.
        impactRing(this.scene, m.x, m.y - 16, RARITY_COLOR[m.relic.rarity], 24);
        popText(this.scene, m.x, m.y - 30, m.relic.name, "#e83fa0");
        popText(this.scene, m.x, m.y - 12, `⬡ -${m.relic.price}`, "#ffd15c");
        this.scene.tweens.add({
          alpha: 0,
          duration: 350,
          onComplete: () => m.g.destroy(),
          targets: m.g,
          y: m.y - 6,
        });
      }
    }
  }

  heal(n: number, by: Player = this.seat.player) {
    this.run.hearts = Math.min(this.run.maxHearts, this.run.hearts + n);
    sfx.heal(by === this.seat.player ? "local" : "routine");
    this.hooks.updateHud();
  }

  gainGold(n: number) {
    this.run.gold += Math.round(n * this.run.mods.goldMult);
  }

  stepFeature() {
    const f = this.room.feature;
    if (!f || f.used) {
      return;
    }
    const box = { bottom: f.y, left: f.x - 10, right: f.x + 10, top: f.y - 20 };
    if (!livePlayers(this.seat).some((pl) => rectsOverlap(box, pl.body.hurtBox()))) {
      return;
    }
    f.used = true;
    this.scene.tweens.add({
      alpha: 0,
      duration: 400,
      onComplete: () => f.g.destroy(),
      targets: f.g,
      y: f.y - 6,
    });
    if (this.expedition.type === "rest") {
      this.heal(2);
      popText(this.scene, f.x, f.y - 22, "+HP", "#34e5c8");
    } else {
      // treasure cache: a free relic (or gold if the player owns them all).
      const [relic] = pickRelics(1, this.run.ownedRelics);
      if (relic) {
        this.applyRelic(relic);
        const rc = RARITY_COLOR[relic.rarity];
        popText(this.scene, f.x, f.y - 22, relic.name, `#${rc.toString(16).padStart(6, "0")}`);
      } else {
        this.gainGold(20);
        popText(this.scene, f.x, f.y - 22, "+20", "#ffd15c");
      }
    }
    this.hooks.updateHud();
  }

  checkClear() {
    if (!this.run.mustClear || this.run.cleared) {
      return;
    }
    const enemiesDone = this.room.enemies.every((e) => e.body.dead);
    const bossDone = this.room.boss ? this.room.boss.body.dead && this.run.bossDeadT > 0.9 : true;
    if (enemiesDone && bossDone) {
      this.run.cleared = true;
      if (this.run.mods.regen > 0 && this.run.hearts < this.run.maxHearts) {
        this.heal(this.run.mods.regen);
      }
      for (const d of this.room.doors) {
        d.setActive(true);
      }
      this.roomClearFx(this.expedition.type, this.expedition.biome);
    }
  }

  bossDefeatFx(x: number, y: number, biome: number) {
    const color = bossKind(biome).tint;
    explosion(this.scene, x, y - 20, 60, color);
    impactRing(this.scene, x, y - 12, color, 82);
  }

  roomClearFx(type: RoomType, biome: number) {
    const color = biomePalette(biome).oneway;
    for (const door of this.room.doors) {
      impactRing(this.scene, door.x, door.y - 20, color, type === "elite" ? 32 : 22);
      if (type === "elite") {
        hitSpark(this.scene, door.x, door.y - 20, color, 10);
      }
    }
    this.banners.show(CLEAR_BANNER.get(type) ?? "CLEAR — pick a path", 1400, "objective");
  }

  checkDoors() {
    // Trailer scenes are single-room shots: a door walk-through mid-take would
    // rebuild the world under the camera.
    if (this.hooks.trailerActive()) {
      return;
    }
    // No leaving a downed teammate behind: doors lock during a last stand.
    if (!this.run.cleared || this.run.state !== "active" || this.run.downed) {
      return;
    }
    for (const d of this.room.doors) {
      if (
        d.active &&
        livePlayers(this.seat).some((pl) => rectsOverlap(d.triggerRect(), pl.body.hurtBox()))
      ) {
        this.enterDoor(d.index);
        return;
      }
    }
  }

  private enterDoor(index: number) {
    const offer = this.run.offers[index];
    if (!offer || this.run.state !== "active") {
      return;
    }
    this.run.state = "transition";
    this.run.transT = 0;
    this.run.transBuilt = false;
    this.run.pendingOffer = offer;
    sfx.door("local");
  }

  announceBoss(biome: number) {
    if (this.room.bossAnnounced) {
      return;
    }
    this.room.bossAnnounced = true;
    sfx.bossRoar();
    this.banners.show(bossKind(biome).banner, 1600, "arrival");
  }
}
