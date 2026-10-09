import type Phaser from "phaser";

import type { Interpolator, PlayerMap } from "@vibedgames/multiplayer";

import { CHAR_ORIGIN_Y, DEPTH, REMOTE_SNAP_PX } from "../config";
import type { CharAction } from "../data/character";
import type { JsonValue } from "../json";
import { farmerTrack, readFarmer } from "./farmer-wire";
import type { FarmerSample } from "./farmer-wire";

// Renders the other players' farmers in the shared co-op world. They're the
// same character sprite as the local player, name-tagged and depth-sorted with
// everything else. Each sender stamps its 20 Hz updates with the room's server
// clock, and each farmer here plays them back 100 ms or more behind the moment
// they could have arrived — every farmer on its own sender's clock
// (farmerTrack), which learns that sender's route and how far behind its
// stream must play never to run dry — blending the two updates around that
// moment: position, facing and clip all from the same pair, so a farmer never
// walks before the walk clip starts or slides in an idle pose.

/** A farmer's name tag: the first characters of its player id. */
export const farmerTag = (id: string): string => id.slice(0, 4);

const FARMER_ALPHA = 0.92;
/** A farmer whose connection dropped stands where it was, faded, while the
 *  room holds its seat for the reconnect. */
const DROPPED_ALPHA = 0.4;

interface Farmer {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  track: Interpolator<FarmerSample>;
  /** The player state last read: an unchanged one is not parsed again. */
  state: JsonValue | undefined;
  /** The clip revision and playing flag last applied (null: none yet). */
  revision: number | null;
  playing: boolean;
  /** Its connection is down and the room is holding its seat. */
  dropped: boolean;
}

/** Mark a farmer whose connection dropped — faded, its tag saying so — or
 *  unmark it once it is back. Without this it would just stand frozen, as if
 *  its farmer had stopped playing or the room had stalled. */
const showDropped = (f: Farmer, id: string, dropped: boolean): void => {
  if (f.dropped === dropped) {
    return;
  }
  f.dropped = dropped;
  f.sprite.setAlpha(dropped ? DROPPED_ALPHA : FARMER_ALPHA);
  f.label.setText(dropped ? `${farmerTag(id)} reconnecting…` : farmerTag(id));
};

export class RemoteFarmers {
  private farmers = new Map<string, Farmer>();

  private readonly scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Take in the room's player states; call every frame (unchanged ones cost nothing).
   *  A farmer out of interest range (`visible: false`) is dropped, playback and
   *  all: its state stops updating, and comes back whole when it is in range.
   *  One whose connection dropped (`connected: false`) stays, marked as
   *  reconnecting, until it is back or the room gives its seat up. */
  sync(players: PlayerMap, myId: string | null): void {
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
      // A jump (out of the mine, a reload) is a new place, not a walk there.
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
  update(now = performance.now()): void {
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

  count(): number {
    return this.farmers.size;
  }

  private animate(f: Farmer, s: FarmerSample): void {
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

  /** Start (or pause) the sender's clip where it stood; between seeks the clip
   *  runs locally, so update jitter never shows in the animation. */
  private seekClip(f: Farmer, s: FarmerSample, clip: CharAction): void {
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

  private spawn(id: string, s: FarmerSample): Farmer {
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
