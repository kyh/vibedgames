import Phaser from "phaser";

import type { PlayerMap } from "@vibedgames/multiplayer";

import { CHAR_ORIGIN_Y, DEPTH } from "../config";
import { CHAR_FRAMES, type CharAction } from "../scenes/boot-scene";
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "../json";

// Renders the other players' farmers in the shared co-op world. They're the
// same character sprite as the local player, name-tagged and depth-sorted with
// everything else, smoothed toward the ~12 Hz position updates.

export type FarmerPose = {
  clip: CharAction;
  frame: number;
  elapsed: number;
  playing: boolean;
  revision: number;
};
export type FarmerState = { x: number; y: number; f: boolean; m: boolean; pose: FarmerPose | null };

const action = (value: JsonValue | undefined): value is CharAction =>
  isJsonString(value) && Object.hasOwn(CHAR_FRAMES, value);

/** Optional presentation metadata. Older peers retain their idle/walk fallback. */
export function readFarmerPose(value: JsonValue | undefined): FarmerPose | null {
  if (!isJsonObject(value)) return null;
  const { clip, frame, elapsed, playing, revision } = value;
  if (
    !action(clip) ||
    !isJsonNumber(frame) ||
    !Number.isInteger(frame) ||
    frame < 0 ||
    frame >= CHAR_FRAMES[clip] ||
    !isJsonNumber(elapsed) ||
    elapsed < 0 ||
    elapsed > 1000 ||
    (playing !== true && playing !== false) ||
    !isJsonNumber(revision) ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return null;
  return { clip, frame, elapsed, playing, revision };
}

/** Read the actual authored clip, including its sub-frame age; never restart a tool. */
export function farmerPose(sprite: Phaser.GameObjects.Sprite, revision: number): FarmerPose | null {
  const anim = sprite.anims;
  if (!anim.currentAnim?.key.startsWith("p-")) return null;
  return readFarmerPose({
    clip: anim.currentAnim?.key.slice(2),
    frame: (anim.currentFrame?.index ?? 0) - 1,
    elapsed: anim.accumulator,
    playing: anim.isPlaying,
    revision,
  });
}

export function readFarmer(state: JsonValue | undefined): FarmerState | null {
  if (!isJsonObject(state)) return null;
  const x = state["x"];
  const y = state["y"];
  if (!isJsonNumber(x) || !isJsonNumber(y)) return null;
  return {
    x,
    y,
    f: state["f"] === true,
    m: state["m"] === true,
    pose: readFarmerPose(state["pose"]),
  };
}

type Farmer = {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  tx: number;
  ty: number;
  seeded: boolean;
  moving: boolean;
  poseRevision: number | null;
};

const LERP = 12;

export class RemoteFarmers {
  private farmers = new Map<string, Farmer>();

  constructor(private readonly scene: Phaser.Scene) {}

  sync(players: PlayerMap, myId: string | null): void {
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) continue;
      const st = readFarmer(player.state);
      if (!st) continue;
      seen.add(id);
      let f = this.farmers.get(id);
      if (!f) f = this.spawn(id, st);
      f.tx = st.x;
      f.ty = st.y;
      f.moving = st.m;
      f.sprite.setFlipX(st.f);
      const pose = st.pose;
      if (pose) {
        if (pose.revision > (f.poseRevision ?? -1)) {
          const key = `p-${pose.clip}`;
          const anim = this.scene.anims.get(key);
          const frame = anim?.frames[pose.frame];
          if (frame) {
            if (
              f.sprite.anims.currentAnim?.key !== key ||
              (pose.playing && !f.sprite.anims.isPlaying)
            )
              f.sprite.play(key, true);
            f.sprite.anims.setCurrentFrame(frame);
            f.sprite.anims.accumulator = pose.elapsed;
            if (!pose.playing) f.sprite.anims.pause();
            f.poseRevision = pose.revision;
          }
        }
      } else f.poseRevision = null;
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
        f.sprite.x = Phaser.Math.Linear(f.sprite.x, f.tx, k);
        f.sprite.y = Phaser.Math.Linear(f.sprite.y, f.ty, k);
      }
      f.sprite.setDepth(DEPTH.entityBase + f.sprite.y);
      f.shadow.setPosition(f.sprite.x, f.sprite.y + 1).setDepth(f.sprite.depth - 1);
      f.label.setPosition(f.sprite.x, f.sprite.y - 26).setDepth(f.sprite.depth + 1);
      if (f.poseRevision === null) {
        const anim = f.moving ? "p-walk" : "p-idle";
        if (f.sprite.anims.currentAnim?.key !== anim || !f.sprite.anims.isPlaying)
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
        fontSize: "8px",
        color: "#ffffff",
        fontFamily: "monospace",
        backgroundColor: "rgba(20,24,40,0.55)",
        padding: { left: 2, right: 2, top: 1, bottom: 1 },
      })
      .setOrigin(0.5, 1);
    const f: Farmer = {
      sprite,
      shadow,
      label,
      tx: st.x,
      ty: st.y,
      seeded: true,
      moving: false,
      poseRevision: null,
    };
    this.farmers.set(id, f);
    return f;
  }
}
