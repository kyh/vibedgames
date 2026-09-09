import type Phaser from "phaser";
import { Math as PhaserMath } from "phaser";

import type { PlayerMap } from "@vibedgames/multiplayer";

import { CHAR_ORIGIN_Y, DEPTH } from "../config";
import { isJsonNumber, isJsonObject } from "../json";
import type { JsonValue } from "../json";

// Renders the other players' farmers in the shared co-op world. They're the
// same character sprite as the local player, name-tagged and depth-sorted with
// everything else, smoothed toward the ~12 Hz position updates.

export interface FarmerState {
  x: number;
  y: number;
  f: boolean;
  m: boolean;
}

export const readFarmer = (state: JsonValue | undefined): FarmerState | null => {
  if (!isJsonObject(state)) {
    return null;
  }
  const { x } = state;
  const { y } = state;
  if (!isJsonNumber(x) || !isJsonNumber(y)) {
    return null;
  }
  return { f: state["f"] === true, m: state["m"] === true, x, y };
};

interface Farmer {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  tx: number;
  ty: number;
  seeded: boolean;
  moving: boolean;
}

const LERP = 12;

export class RemoteFarmers {
  private farmers = new Map<string, Farmer>();
  private readonly scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  sync(players: PlayerMap, myId: string | null): void {
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) {
        continue;
      }
      // SAFETY: player state is decoded JSON off the wire; the package types it
      // `Record<string, unknown>` only because it cannot know game schemas.
      const st = readFarmer(player.state as JsonValue | undefined);
      if (!st) {
        continue;
      }
      seen.add(id);
      let f = this.farmers.get(id);
      if (!f) {
        f = this.spawn(id, st);
      }
      f.tx = st.x;
      f.ty = st.y;
      f.moving = st.m;
      f.sprite.setFlipX(st.f);
    }
    for (const [id, f] of this.farmers) {
      if (!seen.has(id)) {
        f.sprite.destroy();
        f.shadow.destroy();
        f.label.destroy();
        this.farmers.delete(id);
      }
    }
  }

  update(dt: number): void {
    const k = 1 - Math.exp(-LERP * dt);
    for (const f of this.farmers.values()) {
      if (f.seeded) {
        f.sprite.x = f.tx;
        f.sprite.y = f.ty;
        f.seeded = false;
      } else {
        f.sprite.x = PhaserMath.Linear(f.sprite.x, f.tx, k);
        f.sprite.y = PhaserMath.Linear(f.sprite.y, f.ty, k);
      }
      f.sprite.setDepth(DEPTH.entityBase + f.sprite.y);
      f.shadow.setPosition(f.sprite.x, f.sprite.y + 1).setDepth(f.sprite.depth - 1);
      f.label.setPosition(f.sprite.x, f.sprite.y - 26).setDepth(f.sprite.depth + 1);
      const anim = f.moving ? "p-walk" : "p-idle";
      if (f.sprite.anims.currentAnim?.key !== anim) {
        f.sprite.play(anim, true);
      }
    }
  }

  count(): number {
    return this.farmers.size;
  }

  private spawn(id: string, st: FarmerState): Farmer {
    const shadow = this.scene.add
      .sprite(st.x, st.y + 1, "char-shadow-tex")
      .setOrigin(0.5, 0.5)
      .setScale(1.1, 1)
      .setAlpha(0.3);
    const sprite = this.scene.add
      .sprite(st.x, st.y, "p-idle")
      .setOrigin(0.5, CHAR_ORIGIN_Y)
      .setAlpha(0.92);
    sprite.play("p-idle");
    const label = this.scene.add
      .text(st.x, st.y - 26, id.slice(0, 4), {
        backgroundColor: "rgba(20,24,40,0.55)",
        color: "#ffffff",
        fontFamily: "monospace",
        fontSize: "8px",
        padding: { bottom: 1, left: 2, right: 2, top: 1 },
      })
      .setOrigin(0.5, 1);
    const f: Farmer = { label, moving: false, seeded: true, shadow, sprite, tx: st.x, ty: st.y };
    this.farmers.set(id, f);
    return f;
  }
}
