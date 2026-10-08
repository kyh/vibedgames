import type Phaser from "phaser";

import type { Interpolator, PlayerMap, SenderClock, ServerClock } from "@vibedgames/multiplayer";

import { CHAR_ORIGIN_Y, DEPTH, REMOTE_SNAP_PX } from "../config";
import type { CharAction } from "../data/character";
import type { JsonValue } from "../json";
import { farmerTrack, playbackClock, readFarmer } from "./farmer-wire";
import type { FarmerSample } from "./farmer-wire";

// Renders the other players' farmers in the shared co-op world. They're the
// same character sprite as the local player, name-tagged and depth-sorted with
// everything else. Each sender stamps its 20 Hz updates with the room's server
// clock, and each farmer here plays them back a little behind that clock,
// blending the two updates around that moment — position, facing and clip all
// from the same pair, so a farmer never walks before the walk clip starts or
// slides in an idle pose. One clock for every sender: nothing to estimate per
// farmer, and nothing changes when the host does.

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
}

export class RemoteFarmers {
  private farmers = new Map<string, Farmer>();

  private readonly scene: Phaser.Scene;
  private readonly clock: SenderClock;

  /** `server`: the room's server clock, which every sender stamps with. */
  constructor(scene: Phaser.Scene, server: ServerClock) {
    this.scene = scene;
    this.clock = playbackClock(server);
  }

  /** Take in the room's player states; call every frame (unchanged ones cost nothing). */
  sync(players: PlayerMap, myId: string | null): void {
    const seen = new Set<string>();
    for (const [id, player] of Object.entries(players)) {
      if (id === myId) {
        continue;
      }
      const known = this.farmers.get(id);
      if (known && known.state === player.state) {
        seen.add(id);
        continue;
      }
      const read = readFarmer(player.state);
      if (!read) {
        continue;
      }
      seen.add(id);
      const f = known ?? this.spawn(id, read.sample);
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

  /** Draw every farmer where it was a moment ago on the room's clock (see playbackClock). */
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
      .setAlpha(0.92)
      .setVisible(!s.away);
    sprite.play("p-idle");
    const label = this.scene.add
      .text(s.x, s.y - 26, id.slice(0, 4), {
        backgroundColor: "rgba(20,24,40,0.55)",
        color: "#ffffff",
        fontFamily: "monospace",
        fontSize: "8px",
        padding: { bottom: 1, left: 2, right: 2, top: 1 },
      })
      .setOrigin(0.5, 1)
      .setVisible(!s.away);
    const f: Farmer = {
      label,
      playing: true,
      revision: null,
      shadow,
      sprite,
      state: undefined,
      track: farmerTrack(this.clock),
    };
    this.farmers.set(id, f);
    return f;
  }
}
