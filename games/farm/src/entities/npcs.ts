import Phaser from "phaser";
import { TILE, DEPTH, CHAR_ORIGIN_Y } from "../config";
import { store } from "../systems/store";
import {
  NPCS,
  NPC_IDS,
  REACTION_DELTA,
  REACTION_LINE,
  giftable,
  hearts,
  type NpcId,
} from "../data/npcs";
import type { Item } from "../data/items";
import { burst } from "../render/fx";
import { Sound } from "../render/audio";
import type { GameScene } from "../scenes/game-scene";

type Live = {
  id: NpcId;
  spr: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  home: { x: number; y: number };
  target: { x: number; y: number };
  rest: number;
  lineIdx: number;
};

export class NpcManager {
  private scene: GameScene;
  private live: Live[] = [];
  private talkedToday = new Set<NpcId>();
  private giftedToday = new Set<NpcId>();

  constructor(scene: GameScene) {
    this.scene = scene;
  }

  spawnAll(): void {
    for (const id of NPC_IDS) {
      const def = NPCS[id];
      if (store.npcFriendship[id] === undefined) store.npcFriendship[id] = 0;
      const x = def.homeTile.tx * TILE + 8,
        y = def.homeTile.ty * TILE + 14;
      const shadow = this.scene.add
        .sprite(x, y + 1, "char-shadow-tex")
        .setOrigin(0.5, 0.5)
        .setScale(1.1, 1)
        .setAlpha(0.35);
      const spr = this.scene.add
        .sprite(x, y, "p-idle")
        .setOrigin(0.5, CHAR_ORIGIN_Y)
        .play("p-idle");
      spr.setTint(def.tint);
      spr.setDepth(DEPTH.entityBase + y);
      shadow.setDepth(spr.depth - 1);
      this.live.push({
        id,
        spr,
        shadow,
        home: { x, y },
        target: { x, y },
        rest: Phaser.Math.FloatBetween(0, 3),
        lineIdx: 0,
      });
    }
  }

  update(dt: number): void {
    const day = this.scene.timeMin < 20 * 60 && this.scene.timeMin > 7 * 60;
    for (const l of this.live) {
      l.rest -= dt;
      if (l.rest <= 0 && day) {
        l.target = {
          x: l.home.x + Phaser.Math.Between(-28, 28),
          y: l.home.y + Phaser.Math.Between(-20, 20),
        };
        l.rest = Phaser.Math.FloatBetween(1.5, 4);
      }
      const dx = l.target.x - l.spr.x,
        dy = l.target.y - l.spr.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.5 && day) {
        const sp = 20 * dt;
        l.spr.x += (dx / dist) * sp;
        l.spr.y += (dy / dist) * sp;
        l.spr.setFlipX(dx < 0);
        if (l.spr.anims.currentAnim?.key !== "p-walk") l.spr.play("p-walk", true);
      } else if (l.spr.anims.currentAnim?.key !== "p-idle") {
        l.spr.play("p-idle", true);
      }
      l.spr.setDepth(DEPTH.entityBase + l.spr.y);
      l.shadow.setPosition(l.spr.x, l.spr.y + 1);
      l.shadow.setDepth(l.spr.depth - 1);
    }
  }

  tryTalk(tx: number, ty: number, item: Item | null): boolean {
    for (const l of this.live) {
      const nx = Math.floor(l.spr.x / TILE),
        ny = Math.floor((l.spr.y - 1) / TILE);
      if (Math.abs(nx - tx) <= 1 && Math.abs(ny - ty) <= 1) {
        const def = NPCS[l.id];
        l.spr.setFlipX(this.scene.player.x < l.spr.x);
        if (item && giftable(item) && !this.giftedToday.has(l.id)) {
          this.giveGift(l, item);
        } else {
          this.talk(l, def.greeting, def.lines);
        }
        return true;
      }
    }
    return false;
  }

  private giveGift(l: Live, item: Item): void {
    const def = NPCS[l.id];
    if (!store.inv.remove(item, 1)) return;
    this.giftedToday.add(l.id);
    const reaction = def.react(item);
    store.npcFriendship[l.id] = Math.min(
      500,
      (store.npcFriendship[l.id] ?? 0) + REACTION_DELTA[reaction],
    );
    burst(this.scene, l.spr.x, l.spr.y - 16, {
      colors: reaction === "dislike" ? [0x888888, 0xb0b0b0] : [0xff5d7a, 0xff9ed2, 0xffe27a],
      count: 8,
      up: true,
      speed: 45,
    });
    Sound.coins();
    this.emitDialogue(l.id, REACTION_LINE[reaction]);
    this.scene.requestSave();
  }

  private talk(l: Live, greeting: string, lines: string[]): void {
    const first = !this.talkedToday.has(l.id);
    if (first) {
      this.talkedToday.add(l.id);
      store.npcFriendship[l.id] = Math.min(500, (store.npcFriendship[l.id] ?? 0) + 5);
    }
    const text = first ? greeting : (lines[l.lineIdx % lines.length] ?? greeting);
    l.lineIdx += 1;
    Sound.click();
    this.emitDialogue(l.id, text);
  }

  private emitDialogue(id: NpcId, text: string): void {
    const def = NPCS[id];
    this.scene.events.emit("dialogue", {
      name: def.name,
      role: def.role,
      text,
      hearts: hearts(store.npcFriendship[id] ?? 0),
    });
  }

  runOvernight(): void {
    this.talkedToday.clear();
    this.giftedToday.clear();
  }
}
