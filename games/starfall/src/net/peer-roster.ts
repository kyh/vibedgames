import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";
import { REMOTE_RENDER_DELAY_MS } from "../shared/constants";
import type { PlayerNetState, Vec } from "../shared/constants";
import type { Link } from "../state/link";
import { readNetState } from "./wire-read";
import type { WireRecord } from "./wire-read";

/** A remote ship's interpolated pose. */
interface Pose {
  x: number;
  y: number;
  angle: number;
  vx: number;
  vy: number;
}

const blendPose = (a: Pose, b: Pose, k: number): Pose => ({
  angle: lerpAngle(a.angle, b.angle, k),
  vx: lerp(a.vx, b.vx, k),
  vy: lerp(a.vy, b.vy, k),
  x: lerp(a.x, b.x, k),
  y: lerp(a.y, b.y, k),
});

/** The host leads a guest's newest pose by at most this much (ms). */
const LEAD_CAP_MS = 150;
/** One-way trip the sender's clock offset can't see (the fastest path), added
 *  back when leading a guest toward the present. */
const LEAD_PATH_MS = 40;

interface PeerEntry {
  /** The SDK state object this entry last parsed — a new one means a patch. */
  raw: WireRecord | undefined;
  net: PlayerNetState | null;
  interp: Interpolator<Pose>;
  /** Alive and in the arena at the last parse: a respawn or re-entry is a
   *  teleport, so the interpolator restarts instead of gliding across it. */
  live: boolean;
  /** Newest pose as sent, with its stamp — the host's targeting reads this. */
  latest: (Pose & { t: number }) | null;
}

/**
 * Every peer's state, parsed once per patch instead of once per frame, and
 * every remote ship's pose interpolated ~100 ms behind its sender's clock
 * (the Interpolator buffers the timestamped updates and blends the pair
 * around that moment). Fills `link.peerStates` each frame with the pose
 * folded in, so hit tests, homing, the minimap and the hull all agree on
 * where a ship is.
 */
export class PeerRoster {
  private readonly entries = new Map<string, PeerEntry>();

  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  /** Take in any new peer states. Called from the socket listener so each
   *  update's arrival time is exact — the sender's clock offset is measured
   *  from it. Cheap: a state object only changes when a patch lands. */
  ingest(perfNow: number): void {
    const { peers, myId, offline } = this.link;
    for (const [id, player] of Object.entries(peers)) {
      if (id === myId || offline) {
        continue;
      }
      const entry = this.entryFor(id);
      if (player.state !== entry.raw) {
        entry.raw = player.state;
        parseInto(entry, readNetState(player), perfNow);
      }
    }
  }

  /** Once per frame, before anything reads `link.peerStates`. */
  refresh(perfNow: number): void {
    const { link } = this;
    const { peers, myId } = link;
    this.ingest(perfNow);
    link.peerStates.clear();
    for (const [id, player] of Object.entries(peers)) {
      // A peer mid-drop (seat held in the reconnect grace) is absent, not a
      // frozen ghost for enemies and beams to target. My own entry is the
      // pilot, read from local state everywhere.
      if (id === myId || player.connected === false) {
        link.peerStates.set(id, null);
        continue;
      }
      // Offline peers are the trailer's staged fakes, mutated in place and
      // placed precisely: re-read every frame and drawn where they are put.
      if (link.offline) {
        link.peerStates.set(id, readNetState(player));
        continue;
      }
      const entry = this.entryFor(id);
      const { net } = entry;
      if (net) {
        const pose = entry.interp.sample(perfNow);
        if (pose) {
          net.x = pose.x;
          net.y = pose.y;
          net.angle = pose.angle;
          net.vx = pose.vx;
          net.vy = pose.vy;
        }
      }
      link.peerStates.set(id, net);
    }
    for (const id of this.entries.keys()) {
      if (!(id in peers)) {
        this.entries.delete(id);
      }
    }
  }

  /** The sender-clock moment this peer is drawn at — its shots play on the
   *  same timeline as its hull (sys/remote-fire.ts). Null before any stamp. */
  renderTime(id: string, perfNow: number): number | null {
    const entry = this.entries.get(id);
    if (!entry || !entry.interp.clock.synced) {
      return null;
    }
    return entry.interp.clock.now(perfNow) - entry.interp.delayMs;
  }

  /** Feed a peer's clock from a stamped event (a shot can beat the first state). */
  observe(id: string, t: number, perfNow: number): void {
    this.entryFor(id).interp.clock.observe?.(t, perfNow);
  }

  /** Host targeting: a guest's newest pose led toward the present along its
   *  velocity (capped), not where the guest is drawn 100 ms in the past. */
  lead(id: string, perfNow: number): Vec | null {
    const st = this.link.peerStates.get(id);
    if (!st || !st.alive) {
      return null;
    }
    const entry = this.entries.get(id);
    const latest = entry?.latest;
    if (!entry || !latest) {
      return { x: st.x, y: st.y };
    }
    const sentAgo = entry.interp.clock.now(perfNow) - latest.t + LEAD_PATH_MS;
    const ageS = Math.min(LEAD_CAP_MS, Math.max(0, sentAgo)) / 1000;
    return { x: latest.x + latest.vx * ageS, y: latest.y + latest.vy * ageS };
  }

  private entryFor(id: string): PeerEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        interp: new Interpolator<Pose>({ delayMs: REMOTE_RENDER_DELAY_MS, lerp: blendPose }),
        latest: null,
        live: false,
        net: null,
        raw: undefined,
      };
      this.entries.set(id, entry);
    }
    return entry;
  }
}

/** Take in a peer's newly parsed state: buffer its pose for interpolation,
 *  restarting the buffer when the ship (re)appears — a respawn or re-entry
 *  is a teleport, not a glide. */
const parseInto = (entry: PeerEntry, net: PlayerNetState | null, perfNow: number): void => {
  entry.net = net;
  if (!net) {
    return;
  }
  const live = net.alive && net.present;
  if (live && !entry.live) {
    entry.interp.clear();
  }
  entry.live = live;
  const pose: Pose = { angle: net.angle, vx: net.vx, vy: net.vy, x: net.x, y: net.y };
  if (net.t > 0 && entry.interp.push(net.t, pose, perfNow)) {
    entry.latest = { ...pose, t: net.t };
  }
};
