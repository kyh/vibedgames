import { decodeFire } from "../net/fire-wire";
import type { PeerRoster } from "../net/peer-roster";
import type { WireValue } from "../net/wire-read";
import { SENTRY_LIFETIME_MS } from "../shared/constants";
import type { Vec } from "../shared/constants";
import type { Link } from "../state/link";
import type { Beam } from "./beam";
import type { BeamOwner, BeamSim } from "./beam-sim";
import type { ShooterHits } from "./shooter-hits";
import { buildVolley } from "./volley";
import type { FireSpec } from "./volley";

/** A shot that shows up this far behind its shooter's drawn moment (ms) is
 *  dropped — unless it is a mine, which still sits there for seconds. */
const MAX_CATCH_UP_MS = 1000;
/** Fast-forward substep for a shot that arrived late (ms). */
const CATCH_UP_STEP_MS = 1000 / 30;
/** Queued shots per shooter: far above any fire rate across the render delay,
 *  a bound for a tab that sleeps while events keep arriving. */
const QUEUE_CAP = 64;

const NO_BEAMS: readonly Beam[] = [];

interface Turret {
  x: number;
  y: number;
  /** Server clock. */
  until: number;
}

interface Shooter {
  owner: BeamOwner;
  /** Fire events waiting for the shooter's drawn moment to reach them. */
  queue: FireSpec[];
  beams: Beam[];
  turret: Turret | null;
  /** Server-clock moment of the last update; null while not drawn. */
  at: number | null;
}

export interface RemoteFireDeps {
  link: Link;
  roster: PeerRoster;
  sim: BeamSim;
  hits: ShooterHits;
}

/**
 * Every other player's shots, rebuilt from their `fire` events and flown
 * here with the same beam code as mine (sys/beam-sim.ts). A shot is stamped
 * with server time, like its shooter's pose, so it plays on the timeline the
 * ship is drawn on — REMOTE_RENDER_DELAY_MS behind the room clock — and
 * leaves the hull where you see it. Victims hit-test these copies
 * (sys/shield.ts): what drains you is what you saw.
 */
export class RemoteFire {
  private readonly shooters = new Map<string, Shooter>();

  /** Trailer only: a staged peer's bolts, placed by the director each frame. */
  private readonly staged = new Map<string, Beam[]>();

  private readonly link: Link;

  private readonly roster: PeerRoster;

  private readonly sim: BeamSim;

  private readonly hits: ShooterHits;

  constructor(deps: RemoteFireDeps) {
    this.link = deps.link;
    this.roster = deps.roster;
    this.sim = deps.sim;
    this.hits = deps.hits;
  }

  /** A `fire` event (socket listener): decode and queue — the work happens
   *  in the frame loop. Events are not interest-filtered: a shooter out of
   *  range fires from past the edge of the screen, so its shots are dropped
   *  here, like the hull. */
  receive(from: string, payload: WireValue): void {
    if (from === this.link.myId || this.link.peers[from]?.visible === false) {
      return;
    }
    const spec = decodeFire(payload);
    if (!spec) {
      return;
    }
    const { queue } = this.shooterFor(from);
    queue.push(spec);
    if (queue.length > QUEUE_CAP) {
      queue.shift();
    }
  }

  /** Once per frame, after the roster refresh. */
  update(perfNow: number): void {
    const { peers, peerStates } = this.link;
    const at = this.roster.renderTime(perfNow);
    for (const [id, sh] of this.shooters) {
      if (!(id in peers)) {
        this.shooters.delete(id);
        continue;
      }
      const st = peerStates.get(id);
      if (!st || !st.alive || !st.present) {
        // The owner's beams and turret die with it (Shield.die); so do ours,
        // and shots queued from before the death never play.
        sh.beams = [];
        sh.turret = null;
        sh.queue.length = 0;
        sh.at = null;
        continue;
      }
      const dt = sh.at === null ? 0 : Math.min(0.1, Math.max(0, (at - sh.at) / 1000));
      sh.at = at;
      if (sh.beams.length > 0) {
        sh.beams = this.sim.step(sh.beams, sh.owner, dt, at);
        this.hits.react(sh.beams, sh.owner, at);
        this.sim.tickMines(sh.beams, sh.owner, at);
      }
      if (sh.turret && at >= sh.turret.until) {
        sh.turret = null;
      }
      while (sh.queue.length > 0) {
        const [spec] = sh.queue;
        if (!spec || spec.t > at) {
          break;
        }
        sh.queue.shift();
        this.spawn(sh, spec, at);
      }
    }
  }

  /** A shooter's live beams — the victim-side PvP test reads these. */
  beamsOf(id: string): readonly Beam[] {
    return this.staged.get(id) ?? this.shooters.get(id)?.beams ?? NO_BEAMS;
  }

  /** Every remote shooter's beams and the server-clock moment they are at. */
  forEachVolley(draw: (beams: readonly Beam[], at: number) => void, perfNow: number): void {
    for (const sh of this.shooters.values()) {
      if (sh.at !== null && sh.beams.length > 0) {
        draw(sh.beams, sh.at);
      }
    }
    for (const [id, beams] of this.staged) {
      if (this.link.peerStates.get(id)?.alive) {
        draw(beams, perfNow);
      }
    }
  }

  /** A shooter's SENTRY turret and how long it has left (ms), or null. */
  turretOf(id: string): (Vec & { leftMs: number }) | null {
    const sh = this.shooters.get(id);
    if (!sh?.turret || sh.at === null) {
      return null;
    }
    return { leftMs: sh.turret.until - sh.at, x: sh.turret.x, y: sh.turret.y };
  }

  /** Trailer: stage (or with null, clear) a fake peer's bolts. */
  stage(id: string, beams: Beam[] | null): void {
    if (beams) {
      this.staged.set(id, beams);
    } else {
      this.staged.delete(id);
    }
  }

  private shooterFor(id: string): Shooter {
    let sh = this.shooters.get(id);
    if (!sh) {
      sh = {
        at: null,
        beams: [],
        owner: {
          hull: () => {
            const st = this.link.peerStates.get(id);
            return st && st.alive ? { x: st.x, y: st.y } : null;
          },
          id,
          local: false,
        },
        queue: [],
        turret: null,
      };
      this.shooters.set(id, sh);
    }
    return sh;
  }

  /** Put one received volley in the air, flown forward to `at` if it is late. */
  private spawn(sh: Shooter, spec: FireSpec, at: number): void {
    const { weapon } = spec;
    if (spec.kind === "volley" && weapon.sentry) {
      sh.turret = { until: spec.t + SENTRY_LIFETIME_MS, x: spec.x, y: spec.y };
    }
    const late = at - spec.t;
    const isMine = spec.kind === "volley" && weapon.mine;
    if (late > MAX_CATCH_UP_MS && !isMine) {
      return;
    }
    if (isMine) {
      this.sim.capMines(sh.beams);
    }
    let fresh = buildVolley(spec);
    if (!isMine) {
      let { t } = spec;
      while (t < at && fresh.length > 0) {
        const stepMs = Math.min(CATCH_UP_STEP_MS, at - t);
        t += stepMs;
        fresh = this.sim.step(fresh, sh.owner, stepMs / 1000, t);
      }
    }
    sh.beams.push(...fresh);
  }
}
