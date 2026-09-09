import Phaser from "phaser";

import type { PlayerMap } from "@vibedgames/multiplayer";

import { CHAR_ORIGIN_Y, DEPTH } from "../config";
import { CHAR_FRAMES } from "../scenes/boot-scene";
import type { CharAction } from "../scenes/boot-scene";
import { isJsonNumber, isJsonObject, isJsonString } from "../json";
import type { JsonValue } from "../json";

// Renders the other players' farmers in the shared co-op world. They're the
// same character sprite as the local player, name-tagged and depth-sorted with
// everything else, smoothed toward the ~12 Hz position updates.

export interface FarmerPose {
  clip: CharAction;
  frame: number;
  elapsed: number;
  playing: boolean;
  revision: number;
}
export interface FarmerState {
  x: number;
  y: number;
  f: boolean;
  m: boolean;
  pose: FarmerPose | null;
}

const action = (value: JsonValue | undefined): value is CharAction =>
  isJsonString(value) && Object.hasOwn(CHAR_FRAMES, value);

/** Optional presentation metadata. Older peers retain their idle/walk fallback. */
export function readFarmerPose(value: JsonValue | undefined): FarmerPose | null {
  if (!isJsonObject(value)) {
    return null;
  }
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
  ) {
    return null;
  }
  return { clip, elapsed, frame, playing, revision };
}

/** The local farmer's current clip with its sub-frame age, so peers show the tool mid-swing. */
export function farmerPose(sprite: Phaser.GameObjects.Sprite, revision: number): FarmerPose | null {
  const anim = sprite.anims;
  const clip = anim.currentAnim?.key.replace(/^p-/, "");
  if (!action(clip)) {
    return null;
  }
  return {
    clip,
    elapsed: anim.accumulator,
    frame: (anim.currentFrame?.index ?? 1) - 1,
    playing: anim.isPlaying,
    revision,
  };
}

export function readFarmer(state: JsonValue | undefined): FarmerState | null {
  if (!isJsonObject(state)) {
    return null;
  }
  const { x } = state;
  const { y } = state;
  if (!isJsonNumber(x) || !isJsonNumber(y)) {
    return null;
  }
  return {
    f: state["f"] === true,
    m: state["m"] === true,
    pose: readFarmerPose(state["pose"]),
    x,
    y,
  };
}

interface Farmer {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  tx: number;
  ty: number;
  seeded: boolean;
  moving: boolean;
  poseRevision: number | null;
}

const LERP = 12;

export class RemoteFarmers {
  private farmers = new Map<string, Farmer>();

  constructor(private readonly scene: Phaser.Scene) {}

  sync(players: PlayerMap, myId: string | null): void {
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) {
        continue;
      }
      const st = readFarmer(player.state);
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
      const { pose } = st;
      if (pose) {
        // Seek only when the sender (re)started a clip or paused/finished one;
        // between packets the clip runs locally, so packet jitter never shows.
        const restarted = pose.revision !== f.poseRevision;
        if (restarted || pose.playing !== f.sprite.anims.isPlaying) {
          const key = `p-${pose.clip}`;
          const frame = this.scene.anims.get(key)?.frames[pose.frame];
          if (frame) {
            if (f.sprite.anims.currentAnim?.key !== key || !f.sprite.anims.isPlaying) {
              f.sprite.play(key, true);
            }
            f.sprite.anims.setCurrentFrame(frame);
            f.sprite.anims.accumulator = pose.elapsed;
            if (!pose.playing) {
              f.sprite.anims.pause();
            }
            f.poseRevision = pose.revision;
          }
        }
      } else {
        f.poseRevision = null;
      }
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
        if (f.sprite.anims.currentAnim?.key !== anim || !f.sprite.anims.isPlaying) {
          f.sprite.play(anim, true);
        }
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
    const f: Farmer = {
      label,
      moving: false,
      poseRevision: null,
      seeded: true,
      shadow,
      sprite,
      tx: st.x,
      ty: st.y,
    };
    this.farmers.set(id, f);
    return f;
  }
}
