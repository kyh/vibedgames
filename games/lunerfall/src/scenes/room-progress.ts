import type { Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { biomePalette } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { pickRelics, RARITY_COLOR } from "../data/relics";
import type { Relic } from "../data/relics";
import type { RoomType } from "../data/rooms";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import { explosion, hitSpark, impactRing, popText } from "../sys/fx";
import type { GameScene } from "./game-scene";

const CLEAR_BANNER = new Map<RoomType, string>([
  ["boss", "DESCEND"],
  ["elite", "ELITE CLEAR — pick a path"],
]);

type ProgressCtx = Scene &
  Pick<
    GameScene,
    | "banners"
    | "boss"
    | "bossDeadT"
    | "cleared"
    | "doors"
    | "enemies"
    | "feature"
    | "gold"
    | "hearts"
    | "lastStand"
    | "livePlayers"
    | "maxHearts"
    | "merchantItems"
    | "mods"
    | "mustClear"
    | "offers"
    | "ownedRelics"
    | "pendingOffer"
    | "player"
    | "run"
    | "state"
    | "trailer"
    | "transBuilt"
    | "transT"
    | "updateHud"
  >;

// Run progression inside a room: rewards (hearts, gold, relics, features,
// merchant buys), the clear condition, and the doors that lead on.
export class RoomProgress {
  private readonly scene: ProgressCtx;
  bossAnnounced = false;

  constructor(scene: ProgressCtx) {
    this.scene = scene;
  }

  private applyRelic(relic: Relic) {
    this.scene.ownedRelics.add(relic.id);
    relic.apply(this.scene.mods);
    const before = this.scene.maxHearts;
    // Floor at 1 heart so glass-cannon relics can't lock a 0-heart run; extra max
    // hearts arrive filled, and a reduced max clamps current hearts down.
    this.scene.maxHearts = Math.max(1, this.scene.mods.maxHearts);
    this.scene.hearts = Math.min(
      this.scene.hearts + Math.max(0, this.scene.maxHearts - before),
      this.scene.maxHearts,
    );
    sfx.pickup("local");
    this.scene.updateHud();
  }

  stepMerchant() {
    for (const m of this.scene.merchantItems) {
      if (m.bought || this.scene.gold < m.relic.price) {
        continue;
      }
      const box = { bottom: m.y, left: m.x - 10, right: m.x + 10, top: m.y - 22 };
      if (this.scene.livePlayers().some((pl) => rectsOverlap(box, pl.body.hurtBox()))) {
        m.bought = true;
        this.scene.gold -= m.relic.price;
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

  heal(n: number, by: Player = this.scene.player) {
    this.scene.hearts = Math.min(this.scene.maxHearts, this.scene.hearts + n);
    sfx.heal(by === this.scene.player ? "local" : "routine");
    this.scene.updateHud();
  }

  gainGold(n: number) {
    this.scene.gold += Math.round(n * this.scene.mods.goldMult);
  }

  stepFeature() {
    const f = this.scene.feature;
    if (!f || f.used) {
      return;
    }
    const box = { bottom: f.y, left: f.x - 10, right: f.x + 10, top: f.y - 20 };
    if (!this.scene.livePlayers().some((pl) => rectsOverlap(box, pl.body.hurtBox()))) {
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
    if (this.scene.run.type === "rest") {
      this.heal(2);
      popText(this.scene, f.x, f.y - 22, "+HP", "#34e5c8");
    } else {
      // treasure cache: a free relic (or gold if the player owns them all).
      const [relic] = pickRelics(1, this.scene.ownedRelics);
      if (relic) {
        this.applyRelic(relic);
        const rc = RARITY_COLOR[relic.rarity];
        popText(this.scene, f.x, f.y - 22, relic.name, `#${rc.toString(16).padStart(6, "0")}`);
      } else {
        this.gainGold(20);
        popText(this.scene, f.x, f.y - 22, "+20", "#ffd15c");
      }
    }
    this.scene.updateHud();
  }

  checkClear() {
    if (!this.scene.mustClear || this.scene.cleared) {
      return;
    }
    const enemiesDone = this.scene.enemies.every((e) => e.body.dead);
    const bossDone = this.scene.boss
      ? this.scene.boss.body.dead && this.scene.bossDeadT > 0.9
      : true;
    if (enemiesDone && bossDone) {
      this.scene.cleared = true;
      if (this.scene.mods.regen > 0 && this.scene.hearts < this.scene.maxHearts) {
        this.heal(this.scene.mods.regen);
      }
      for (const d of this.scene.doors) {
        d.setActive(true);
      }
      this.roomClearFx(this.scene.run.type, this.scene.run.biome);
    }
  }

  bossDefeatFx(x: number, y: number, biome: number) {
    const color = bossKind(biome).tint;
    explosion(this.scene, x, y - 20, 60, color);
    impactRing(this.scene, x, y - 12, color, 82);
  }

  roomClearFx(type: RoomType, biome: number) {
    const color = biomePalette(biome).oneway;
    for (const door of this.scene.doors) {
      impactRing(this.scene, door.x, door.y - 20, color, type === "elite" ? 32 : 22);
      if (type === "elite") {
        hitSpark(this.scene, door.x, door.y - 20, color, 10);
      }
    }
    this.scene.banners.show(CLEAR_BANNER.get(type) ?? "CLEAR — pick a path", 1400, "objective");
  }

  checkDoors() {
    // Trailer scenes are single-room shots: a door walk-through mid-take would
    // rebuild the world under the camera.
    if (this.scene.trailer.active) {
      return;
    }
    // No leaving a downed teammate behind: doors lock during a last stand.
    if (!this.scene.cleared || this.scene.state !== "active" || this.scene.lastStand.live) {
      return;
    }
    for (const d of this.scene.doors) {
      if (
        d.active &&
        this.scene.livePlayers().some((pl) => rectsOverlap(d.triggerRect(), pl.body.hurtBox()))
      ) {
        this.enterDoor(d.index);
        return;
      }
    }
  }

  private enterDoor(index: number) {
    const offer = this.scene.offers[index];
    if (!offer || this.scene.state !== "active") {
      return;
    }
    this.scene.state = "transition";
    this.scene.transT = 0;
    this.scene.transBuilt = false;
    this.scene.pendingOffer = offer;
    sfx.door("local");
  }

  announceBoss(biome: number) {
    if (this.bossAnnounced) {
      return;
    }
    this.bossAnnounced = true;
    sfx.bossRoar();
    this.scene.banners.show(bossKind(biome).banner, 1600, "arrival");
  }
}
