// How a guest draws every brawler it does not control. Each one renders a fixed
// delay behind the host's clock, blending the two host frames that bracket
// that moment (`Interpolator`, all of them on the one `RemoteClock` of the
// host's snapshot), so motion is as even as the host's sim however unevenly
// frames arrive — never a chase toward the newest pose, which surges on every
// packet and stalls on every gap. Positions come from the host's actual
// motion, so a body pushing into a wall is drawn against it, not inside it.
//
// The discrete half of each row (health, death, cues, bush cover) is applied
// when render time reaches the frame that carried it, so a swing starts when
// the body swinging it gets there.
import { Interpolator, lerp, lerpAngle } from "@vibedgames/multiplayer";
import type { RemoteClock } from "@vibedgames/multiplayer";

import { BRAWLER_RADIUS, TUNING } from "../config";
import type { BrawlerDef } from "../config";
import type { Brawler } from "../entities/brawler";
import { leapFlight, leapPoint } from "../entities/movement";
import type { MoverWorld } from "../entities/movement";
import { INTERP_DELAY_MS } from "./protocol";
import type { BrawlerState } from "./snapshot";

interface PuppetPose {
  facing: number;
  x: number;
  z: number;
}

/** What a puppet's track writes: its pose, and the discrete state rows carry. */
export type PuppetBody = Pick<
  Brawler,
  | "alive"
  | "ammo"
  | "burst"
  | "cubes"
  | "deadT"
  | "def"
  | "evadeCooldown"
  | "evasion"
  | "facing"
  | "flash"
  | "hp"
  | "inBush"
  | "kills"
  | "maxHp"
  | "meleeCue"
  | "netAir"
  | "netLeap"
  | "rangedCue"
  | "rank"
  | "recoil"
  | "reloadT"
  | "revealT"
  | "root"
  | "squash"
  | "superCharge"
  | "swing"
  | "vel"
>;

interface PendingRow {
  state: BrawlerState;
  t: number;
}

const lerpPose = (a: PuppetPose, b: PuppetPose, k: number): PuppetPose => ({
  facing: lerpAngle(a.facing, b.facing, k),
  x: lerp(a.x, b.x, k),
  z: lerp(a.z, b.z, k),
});

/** Most frames a puppet waits on: three seconds at 30 Hz. */
const MAX_PENDING = 90;
/** A late frame keeps the body moving this long along its last motion, then holds it. */
const MAX_EXTRAPOLATE_MS = 100;

const scratch = { x: 0, y: 0, z: 0 };

export const maxHpFor = (def: BrawlerDef, cubes: number): number => def.hp + cubes * TUNING.cubeHp;

/** Fold a host row's discrete state into a puppet, `age` seconds after the frame that carried it. */
export const applyPuppetRow = (b: PuppetBody, n: BrawlerState, age: number): void => {
  if (n.hp < b.hp) {
    b.flash = 1;
    b.squash = 1;
  }
  if (n.ammo + n.reload < b.ammo + b.reloadT - 0.5 || n.charge < b.superCharge - 0.5) {
    b.recoil = 1;
  }
  b.hp = n.hp;
  b.maxHp = maxHpFor(b.def, n.cubes);
  b.ammo = n.ammo;
  b.reloadT = n.reload;
  b.superCharge = n.charge;
  b.cubes = n.cubes;
  b.kills = n.kills;
  b.rank = n.rank;
  b.evadeCooldown = n.evadeCooldown;
  b.inBush = n.concealed;
  b.revealT = 0;
  b.meleeCue = n.melee ? { ...n.melee, elapsed: n.melee.elapsed + age } : null;
  b.rangedCue = n.alive && n.ranged ? { ...n.ranged, elapsed: n.ranged.elapsed + age } : null;
  b.evasion = n.evasion ? { ...n.evasion, elapsed: n.evasion.elapsed + age } : null;
  b.netLeap = n.leap ? { ...n.leap, t: n.leap.t + age } : null;
  b.netAir = n.leap !== null;
  if (b.alive && !n.alive) {
    b.alive = false;
    b.hp = 0;
    b.deadT = 0;
    b.burst = null;
    b.swing = null;
    b.meleeCue = null;
    b.rangedCue = null;
    b.evasion = null;
    b.netLeap = null;
    b.netAir = false;
  }
};

/** One remote brawler's timeline on a guest. */
export class PuppetTrack {
  private readonly interp: Interpolator<PuppetPose>;
  private pending: PendingRow[] = [];
  private posedAt: number | null = null;

  constructor(clock: RemoteClock) {
    this.interp = new Interpolator({
      clock,
      delayMs: INTERP_DELAY_MS,
      lerp: lerpPose,
      maxExtrapolateMs: MAX_EXTRAPOLATE_MS,
    });
  }

  /** A frame stamped `t` on the host's clock arrived at local `receivedAt`. */
  receive(t: number, state: BrawlerState, receivedAt: number): void {
    this.interp.push(t, { facing: state.facing, x: state.x, z: state.z }, receivedAt);
    this.pending.push({ state, t });
    if (this.pending.length > MAX_PENDING) {
      this.pending.shift();
    }
  }

  /**
   * The host changed (a new clock) or the body teleported: apply what is
   * queued now and forget the motion history, so the next frame places the
   * body outright instead of gliding from where the old timeline left it.
   */
  flush(b: PuppetBody): void {
    for (const row of this.pending) {
      applyPuppetRow(b, row.state, 0);
    }
    this.pending = [];
    this.interp.clear();
  }

  /** Pose the body for local time `now` (render time `renderAt` on the host's clock). */
  pose(b: PuppetBody, now: number, renderAt: number, world: MoverWorld): void {
    while (this.pending.length > 0) {
      const [row] = this.pending;
      if (!row || row.t > renderAt) {
        break;
      }
      this.pending.shift();
      applyPuppetRow(b, row.state, Math.max(0, renderAt - row.t) / 1000);
    }
    const pose = this.interp.sample(now);
    if (!pose) {
      return;
    }
    const pos = b.root.position;
    const fromX = pos.x;
    const fromZ = pos.z;
    pos.x = pose.x;
    pos.z = pose.z;
    if (b.netLeap) {
      leapPoint(b.netLeap, leapFlight(b.def), world.heightAt, scratch);
      pos.y = Math.max(world.heightAt(pos.x, pos.z), scratch.y);
    } else {
      // Interpolation can clip a corner and extrapolation can run on into cover.
      world.resolveCircle(pos, BRAWLER_RADIUS);
      pos.y = world.heightAt(pos.x, pos.z);
    }
    b.facing = pose.facing;
    // Catch-up sub-steps pose the same instant twice; only real time passing is motion.
    const since = this.posedAt === null ? 0 : (now - this.posedAt) / 1000;
    if (since > 0) {
      b.vel.set((pos.x - fromX) / since, (pos.z - fromZ) / since);
      this.posedAt = now;
    } else if (this.posedAt === null) {
      this.posedAt = now;
    }
  }
}
