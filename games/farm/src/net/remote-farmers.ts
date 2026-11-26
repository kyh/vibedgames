import type Phaser from "phaser";

import type { Interpolator, PlayerMap } from "@vibedgames/multiplayer";

import { CHAR_ORIGIN_Y, DEPTH, REMOTE_SNAP_PX } from "../config";
import type { CharAction } from "../data/character";
import type { JsonValue } from "../json";
import { farmerTrack, readFarmer } from "./farmer-wire";
import type { FarmerSample } from "./farmer-wire";

/** A farmer's name tag: the first characters of its player id. */
export const farmerTag = (id: string) => id.slice(0, 4);

const FARMER_ALPHA = 0.92;
const DROPPED_ALPHA = 0.4;

interface Farmer {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  track: Interpolator<FarmerSample>;
  state: JsonValue | undefined;
  revision: number | null;
  playing: boolean;
  dropped: boolean;
}

const showDropped = (f: Farmer, id: string, dropped: boolean) => {
  if (f.dropped === dropped) {
    return;
  }

  f.dropped = dropped;
  f.sprite.setAlpha(dropped ? DROPPED_ALPHA : FARMER_ALPHA);
  f.label.setText(dropped ? `${farmerTag(id)} reconnecting…` : farmerTag(id));
};

export class RemoteFarmers {
  farmers = new Map<string, Farmer>();

  private readonly scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Take in the room's player states; call every frame (unchanged ones cost nothing).
   *  A farmer out of interest range (`visible: false`) is dropped, playback and
   *  all: its state stops updating, and comes back whole when it is in range.
   *  One whose connection dropped (`connected: false`) stays, marked as
   *  reconnecting, until it is back or the room gives its seat up. */
  sync(players: PlayerMap, myId: string | null) {
    const seen = new Set<string>();

    for (const [id, player] of Object.entries(players)) {
      if (id === myId || player.visible === false) {
        continue;
      }

      const known = this.farmers.get(id);

      if (known && known.state === player.state) {
        seen.add(id);
        showDropped(known, id, player.connected === false);
        continue;
      }

      const read = readFarmer(player.state);

      if (!read) {
        continue;
      }

      seen.add(id);
      const f = known ?? this.spawn(id, read.sample);
      showDropped(f, id, player.connected === false);
      f.state = player.state;
      const { sample } = read;
      const last = f.track.latest;

      if (
        last &&
        (last.away !== sample.away ||
          Math.hypot(sample.x - last.x, sample.y - last.y) > REMOTE_SNAP_PX)
      ) {
        f.track.clear();
      }

      f.track.push(read.t, sample);
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

  /** Draw every farmer at its track's render time, on its sender's clock. */
  update(now = performance.now()) {
    for (const f of this.farmers.values()) {
      const s = f.track.sample(now);

      if (!s) {
        continue;
      }

      f.sprite.setVisible(!s.away);
      f.shadow.setVisible(!s.away);
      f.label.setVisible(!s.away);

      if (s.away) {
        continue;
      }

      f.sprite
        .setPosition(s.x, s.y)
        .setFlipX(s.flip)
        .setDepth(DEPTH.entityBase + s.y);
      f.shadow.setPosition(s.x, s.y + 1).setDepth(f.sprite.depth - 1);
      f.label.setPosition(s.x, s.y - 26).setDepth(f.sprite.depth + 1);
      this.animate(f, s);
    }
  }

  count() {
    return this.farmers.size;
  }

  private animate(f: Farmer, s: FarmerSample) {
    if (s.clip === null) {
      f.revision = null;
      const key = s.moving ? "p-walk" : "p-idle";

      if (f.sprite.anims.currentAnim?.key !== key || !f.sprite.anims.isPlaying) {
        f.sprite.play(key, true);
      }

      return;
    }

    if (
      f.revision === null ||
      s.revision > f.revision ||
      (s.revision === f.revision && s.playing !== f.playing)
    ) {
      this.seekClip(f, s, s.clip);
    }
  }

  private seekClip(f: Farmer, s: FarmerSample, clip: CharAction) {
    const key = `p-${clip}`;
    const frame = this.scene.anims.get(key)?.frames[s.frame];

    if (!frame) {
      return;
    }

    const { anims } = f.sprite;

    if (anims.currentAnim?.key !== key || !anims.isPlaying) {
      f.sprite.play(key, true);
    }

    anims.setCurrentFrame(frame);
    anims.accumulator = s.elapsed;

    if (!s.playing) {
      anims.pause();
    }

    f.revision = s.revision;
    f.playing = s.playing;
  }

  private spawn(id: string, s: FarmerSample) {
    const shadow = this.scene.add
      .sprite(s.x, s.y + 1, "char-shadow-tex")
      .setOrigin(0.5, 0.5)
      .setScale(1.1, 1)
      .setAlpha(0.3)
      .setVisible(!s.away);

    const sprite = this.scene.add
      .sprite(s.x, s.y, "p-idle")
      .setOrigin(0.5, CHAR_ORIGIN_Y)
      .setAlpha(FARMER_ALPHA)
      .setVisible(!s.away);

    sprite.play("p-idle");

    const label = this.scene.add
      .text(s.x, s.y - 26, farmerTag(id), {
        backgroundColor: "rgba(20,24,40,0.55)",
        color: "#ffffff",
        fontFamily: "monospace",
        fontSize: "8px",
        padding: { bottom: 1, left: 2, right: 2, top: 1 },
      })
      .setOrigin(0.5, 1)
      .setVisible(!s.away);

    const f: Farmer = {
      dropped: false,
      label,
      playing: true,
      revision: null,
      shadow,
      sprite,
      state: undefined,
      track: farmerTrack(),
    };

    this.farmers.set(id, f);

    return f;
  }
}
