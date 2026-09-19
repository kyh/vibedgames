import type Phaser from "phaser";
import { Math as PhaserMath } from "phaser";
import { TILE, DEPTH, CHAR_ORIGIN_Y } from "../config";
import { store } from "../systems/store";
import { NPCS, NPC_IDS, REACTION_DELTA, REACTION_LINE, giftable, hearts } from "../data/npcs";
import type { NpcId } from "../data/npcs";
import type { Item } from "../data/items";
import { burst } from "../render/fx";
import { Sound } from "../render/audio";
import type { GameScene } from "../scenes/game-scene";

interface Live {
  id: NpcId;
  spr: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  home: { x: number; y: number };
  target: { x: number; y: number };
  rest: number;
  lineIdx: number;
}

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
      if (store.npcFriendship[id] === undefined) {
        store.npcFriendship[id] = 0;
      }
      const x = def.homeTile.tx * TILE + 8;
      const y = def.homeTile.ty * TILE + 14;
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
        home: { x, y },
        id,
        lineIdx: 0,
        rest: PhaserMath.FloatBetween(0, 3),
        shadow,
        spr,
        target: { x, y },
      });
    }
  }

  /** Trailer staging: move an NPC (and its wander anchor) to a tile.
   *  Dead in normal play (NPCs live at their fixed homes). */
  placeNpc(id: NpcId, tx: number, ty: number): void {
    const l = this.live.find((n) => n.id === id);
    if (!l) {
      return;
    }
    const x = tx * TILE + 8;
    const y = ty * TILE + 14;
    l.home = { x, y };
    l.target = { x, y };
    l.rest = 0;
    l.spr.setPosition(x, y);
    l.shadow.setPosition(x, y + 1);
  }

  /** Trailer staging: show exactly these NPCs and hide the rest. Villagers are
   *  drawn from the player's own sprite, so an unstaged one standing in shot
   *  reads as a motionless duplicate of the hero. Dead in normal play. */
  trailerVisible(ids: NpcId[]): void {
    for (const l of this.live) {
      const on = ids.includes(l.id);
      l.spr.setVisible(on);
      l.shadow.setVisible(on);
    }
  }

  /** Trailer staging: send an NPC walking to a tile through the ordinary wander
   *  mover — the anchor moves with them, so they settle there instead of
   *  drifting back. Dead in normal play (NPCs pick their own targets). */
  trailerWalkTo(id: NpcId, tx: number, ty: number): void {
    const l = this.live.find((n) => n.id === id);
    if (!l) {
      return;
    }
    const x = tx * TILE + 8;
    const y = ty * TILE + 14;
    l.home = { x, y };
    l.target = { x, y };
    // long enough that no wander re-roll interrupts the walk
    l.rest = 6;
  }

  /** Trailer staging: a live NPC's feet tile — NPCs wander around their anchor,
   *  so scripted approach/gifting resolves the live position. Dead otherwise. */
  trailerTileOf(id: NpcId): { tx: number; ty: number } | null {
    const l = this.live.find((n) => n.id === id);
    if (!l) {
      return null;
    }
    return { tx: Math.floor(l.spr.x / TILE), ty: Math.floor((l.spr.y - 1) / TILE) };
  }

  update(dt: number): void {
    const day = this.scene.timeMin < 20 * 60 && this.scene.timeMin > 7 * 60;
    for (const l of this.live) {
      l.rest -= dt;
      if (l.rest <= 0 && day) {
        l.target = {
          x: l.home.x + PhaserMath.Between(-28, 28),
          y: l.home.y + PhaserMath.Between(-20, 20),
        };
        l.rest = PhaserMath.FloatBetween(1.5, 4);
      }
      const dx = l.target.x - l.spr.x;
      const dy = l.target.y - l.spr.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 1.5 && day) {
        const sp = 20 * dt;
        l.spr.x += (dx / dist) * sp;
        l.spr.y += (dy / dist) * sp;
        l.spr.setFlipX(dx < 0);
        if (l.spr.anims.currentAnim?.key !== "p-walk") {
          l.spr.play("p-walk", true);
        }
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
      const nx = Math.floor(l.spr.x / TILE);
      const ny = Math.floor((l.spr.y - 1) / TILE);
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
    if (!store.inv.remove(item, 1)) {
      return;
    }
    this.giftedToday.add(l.id);
    const reaction = def.react(item);
    store.npcFriendship[l.id] = Math.min(
      500,
      (store.npcFriendship[l.id] ?? 0) + REACTION_DELTA[reaction],
    );
    burst(this.scene, l.spr.x, l.spr.y - 16, {
      colors:
        reaction === "dislike" ? [0x88_88_88, 0xb0_b0_b0] : [0xff_5d_7a, 0xff_9e_d2, 0xff_e2_7a],
      count: 8,
      speed: 45,
      up: true,
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
      hearts: hearts(store.npcFriendship[id] ?? 0),
      name: def.name,
      role: def.role,
      text,
    });
  }

  runOvernight(): void {
    this.talkedToday.clear();
    this.giftedToday.clear();
  }
}
