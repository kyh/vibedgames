import { Interpolator, RemoteClock, lerp, lerpAngle } from "@vibedgames/multiplayer";
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

interface PeerEntry {
  /** The SDK state object this entry last parsed — a new one means a patch. */
  raw: WireRecord | undefined;
  net: PlayerNetState | null;
  /** The clock this peer's stream is read through, held to relearn it. */
  clock: RemoteClock;
  /** Dropped (its seat held in the reconnect grace) when last seen: its
   *  updates come back by a new route. */
  away: boolean;
  interp: Interpolator<Pose>;
  /** Alive and in the arena at the last parse: a respawn or re-entry is a
   *  teleport, so the interpolator restarts instead of gliding across it. */
  live: boolean;
  /** Newest pose as sent, with its stamp — the host's targeting reads this. */
  latest: (Pose & { t: number }) | null;
}

/**
 * Every peer's state, parsed once per patch instead of once per frame, and
 * every remote ship's pose interpolated at least ~100 ms behind the moment
 * its updates arrive (the Interpolator buffers the stamped updates and blends
 * the pair around that moment). Each sender's stream reads its server-time
 * stamps through its own RemoteClock, which learns from arrivals how long
 * that sender's updates take to get here (sender → server → here), so the
 * delay only has to cover jitter, and measures that jitter, so the delay
 * grows when the stream needs more; the sender's shots play at the same
 * render time (sys/remote-fire.ts). Fills `link.peerStates` each frame with
 * the pose folded in, so hit tests, homing, the minimap and the hull all
 * agree on where a ship is.
 */
export class PeerRoster {
  private readonly entries = new Map<string, PeerEntry>();

  private readonly link: Link;

  constructor(link: Link) {
    this.link = link;
  }

  /** Take in any new peer states. Called from the socket listener as each
   *  message lands, so each update's arrival time is exact — the sender's
   *  clock learns its relay from it — and two patches arriving within one
   *  frame both reach the buffer. Cheap: a state object only changes when a
   *  patch lands. A peer out of interest range is not parsed: what it holds
   *  is stale. A peer back from its own drop is relearned here too, so the
   *  drop is seen even while this tab is hidden. */
  ingest(perfNow: number): void {
    const { peers, myId, offline } = this.link;
    if (offline) {
      return;
    }
    for (const [id, player] of Object.entries(peers)) {
      if (id === myId) {
        continue;
      }
      const hidden = player.visible === false;
      const entry = hidden ? this.entries.get(id) : this.entryFor(id);
      if (!entry) {
        continue;
      }
      if (player.connected === false) {
        entry.away = true;
      } else if (entry.away) {
        // Its route to the server is new (another network, another colo): a
        // clock timed by the old, quicker one would run its ship past the
        // newest update until the window forgot it (~2 s on a route 300 ms
        // slower after a 1.5 s blip), so it measures the route afresh.
        entry.away = false;
        entry.clock.relearn();
      }
      if (!hidden && player.state !== entry.raw) {
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
      // Out of interest range (past the edge of any screen): its state
      // stopped updating, so it is absent here too. Its poses go: coming
      // back, the ship appears where it is instead of gliding in from where
      // it left. Its clock stays: the route is the same, and a new clock
      // starts its hold from nothing, so for seconds after every return
      // (a ship at the edge of range flickers out and back) the ship would
      // be drawn short of the delay its stream needs.
      if (player.visible === false) {
        const entry = this.entries.get(id);
        if (entry && entry.raw !== undefined) {
          forget(entry);
        }
        link.peerStates.set(id, null);
        continue;
      }
      // Offline peers are the trailer's staged fakes, mutated in place and
      // placed precisely: re-read every frame and drawn where they are put.
      if (link.offline) {
        link.peerStates.set(id, readNetState(player));
        continue;
      }
      const entry = this.entries.get(id);
      const net = entry?.net ?? null;
      if (entry && net) {
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

  /** The moment (server time) this peer is drawn at — its shots play on the
   *  same timeline as its hull (sys/remote-fire.ts). The Interpolator's own
   *  render time: its delay grows past REMOTE_RENDER_DELAY_MS when the stream
   *  needs it, so a fixed offset would drift off the hull. Null before any
   *  stamp. */
  renderTime(id: string, perfNow: number): number | null {
    const entry = this.entries.get(id);
    if (!entry || !entry.clock.synced) {
      return null;
    }
    return entry.interp.renderTime(perfNow);
  }

  /** My own connection came back: every peer's updates now reach me by a new
   *  route. A clock still timed by the old, quicker one would run their ships
   *  past the newest update until its window forgot it, so each measures its
   *  route afresh, easing onto it without a jump. */
  relearn(): void {
    for (const entry of this.entries.values()) {
      entry.clock.relearn();
    }
  }

  /** Host targeting: a guest's newest pose led toward the present along its
   *  velocity (capped), not where the guest is drawn 100 ms in the past. */
  lead(id: string, perfNow: number): Vec | null {
    const st = this.link.peerStates.get(id);
    if (!st || !st.alive) {
      return null;
    }
    const latest = this.entries.get(id)?.latest;
    if (!latest) {
      return { x: st.x, y: st.y };
    }
    // The stamp is server time, so this is the pose's whole age: the trip
    // here included.
    const ageMs = this.link.serverNow(perfNow) - latest.t;
    const ageS = Math.min(LEAD_CAP_MS, Math.max(0, ageMs)) / 1000;
    return { x: latest.x + latest.vx * ageS, y: latest.y + latest.vy * ageS };
  }

  private entryFor(id: string): PeerEntry {
    let entry = this.entries.get(id);
    if (!entry) {
      const clock = new RemoteClock();
      entry = {
        away: false,
        clock,
        interp: new Interpolator<Pose>({ clock, delayMs: REMOTE_RENDER_DELAY_MS, lerp: blendPose }),
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

/** A peer out of interest range: drop its poses and parsed state, keep its
 *  clock. Its next state is parsed afresh, as a re-entry. */
const forget = (entry: PeerEntry): void => {
  entry.interp.clear();
  entry.raw = undefined;
  entry.net = null;
  entry.latest = null;
  entry.live = false;
};

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
  if (entry.interp.push(net.t, pose, perfNow)) {
    entry.latest = { ...pose, t: net.t };
  }
};
