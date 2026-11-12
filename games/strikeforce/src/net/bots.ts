// Bots: fighters the host plays so a thin room still has a match. They sit in
// the rules roster like anyone (rules.ts seats them), so kills, respawns and
// the scoreboard need nothing of their own. The host thinks for them here and
// publishes their bodies under BOTS_KEY; every client — the host included —
// turns that record into ordinary player reports (`botPlayers`), so bots are
// drawn, interpolated and shot exactly like people.
//
// A bot is deliberately a worse shot than a person: it reacts late, fires
// slower than the rifle, hits less with range and deals less per hit.
import type { JsonRecord, JsonValue, PlayerMap } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { StrikeforceGame } from "../core/types";
import { safestSpawn } from "./map";
import type { Spawn } from "./map";
import { q3 } from "./protocol";
import { BOTS } from "./rules";
import type { Fighter, Point } from "./rules";
import { isRecord, nums } from "./wire";

const AIM = {
  burst: [3, 6],
  /** Seconds between shots in a burst (the rifle's is 0.083). */
  cadence: 0.14,
  /** Radians off target it will still fire at. */
  cone: 0.15,
  damage: 16,
  falloff: 0.011,
  headChance: 0.06,
  /** Hit chance up close, and how much each metre takes off it. */
  hit: 0.62,
  minHit: 0.12,
  /** Seconds between bursts. */
  pause: [0.45, 0.9],
  /** Seconds from first sight to the first shot. */
  reaction: [0.45, 0.8],
} as const;

const MOVE = {
  /** Closer than this a bot stops advancing on its target. */
  hold: 22,
  roam: 30,
  run: 4.5,
  sight: 60,
  strafe: 2.4,
  /** How often a bot looks around for a target, in seconds. */
  think: 0.2,
  /** Radians per second. */
  turn: 6,
} as const;

const EYE = 1.55;
const CHEST = 1.15;
const CROUCH_CHEST = 0.8;

const chestOf = (t: Target, out: Vector3): Vector3 =>
  out.set(t.pos.x, t.pos.y + (t.crouch ? CROUCH_CHEST : CHEST), t.pos.z);

const between = ([lo, hi]: readonly [number, number]): number => lo + Math.random() * (hi - lo);

/** Turn `from` towards `to` by at most `step` radians, the short way round. */
const turnTowards = (from: number, to: number, step: number): number => {
  const diff = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  const yaw = from + Math.max(-step, Math.min(step, diff));
  return Math.atan2(Math.sin(yaw), Math.cos(yaw));
};

/** The yaw that faces from `a` towards `b` (the camera looks down -Z at yaw 0). */
const yawTo = (a: Point, b: Point): number => Math.atan2(-(b.x - a.x), -(b.z - a.z));

/** Someone a bot may shoot. */
export interface Target {
  id: string;
  /** Feet. */
  pos: Point;
  crouch: boolean;
}

/** A shot a bot fired: the host applies it and shows the tracer to everyone. */
export interface BotShot {
  bot: string;
  /** Who it hit, if anyone. */
  victim: string | null;
  damage: number;
  head: boolean;
  muzzle: Vector3;
  end: Vector3;
}

interface Brain {
  readonly id: string;
  readonly pos: Vector3;
  yaw: number;
  pitch: number;
  /** The life (rules.ts) this bot was last placed as. */
  life: number;
  path: Vector3[];
  target: string | null;
  /** Seconds before it may fire at the current target. */
  react: number;
  cooldown: number;
  burst: number;
  think: number;
  strafe: number;
  strafeT: number;
  stuck: number;
}

const brain = (id: string, from: Point | undefined): Brain => ({
  burst: 0,
  cooldown: 0,
  id,
  life: -1,
  path: [],
  pitch: 0,
  pos: new Vector3(from?.x ?? 0, from?.y ?? 0, from?.z ?? 0),
  react: 0,
  strafe: Math.random() < 0.5 ? -1 : 1,
  strafeT: 0,
  stuck: 0,
  target: null,
  think: Math.random() * MOVE.think,
  yaw: 0,
});

export class Bots {
  private readonly brains = new Map<string, Brain>();
  private readonly game: StrikeforceGame;
  private readonly spawns: readonly Spawn[];
  private readonly eye = new Vector3();
  private readonly aim = new Vector3();
  private readonly step = new Vector3();

  constructor(game: StrikeforceGame, spawns: readonly Spawn[]) {
    this.game = game;
    this.spawns = spawns;
  }

  /**
   * Think and move every bot seated in `roster`. `people` are the other
   * fighters still standing; `seed` is where a bot was last seen, for a host
   * that inherits bots it did not place. `live`: shots count.
   */
  update(
    dt: number,
    roster: ReadonlyMap<string, Fighter>,
    people: readonly Target[],
    seed: (id: string) => Point | undefined,
    live: boolean,
    fire: (shot: BotShot) => void,
  ): void {
    for (const id of this.brains.keys()) {
      if (!roster.has(id)) {
        this.brains.delete(id);
      }
    }
    for (const [id, fighter] of roster) {
      if (!id.startsWith(BOTS.prefix)) {
        continue;
      }
      let b = this.brains.get(id);
      if (!b) {
        b = brain(id, seed(id));
        // Inherited mid-life: carry on from where it stood.
        if (seed(id)) {
          b.life = fighter.life;
        }
        this.brains.set(id, b);
      }
      if (!fighter.alive) {
        b.target = null;
        continue;
      }
      const targets = [...people, ...this.targetsBesides(id, roster)];
      if (b.life !== fighter.life) {
        this.place(b, fighter.life, targets);
      }
      this.think(b, dt, targets, live, fire);
    }
  }

  /** A bot was shot from `from`: it turns to deal with it. */
  alert(id: string, from: Point | undefined): void {
    const b = this.brains.get(id);
    if (!b || !from || b.target) {
      return;
    }
    b.yaw = yawTo(b.pos, from);
    b.path = this.game.physics.nav.findPath(b.pos, new Vector3(from.x, 0, from.z)) ?? [];
  }

  /** Every bot's body, for BOTS_KEY: `{ [id]: [t, x, y, z, yaw, pitch] }`. */
  encode(now: number): JsonRecord {
    const out: JsonRecord = {};
    for (const b of this.brains.values()) {
      out[b.id] = [Math.round(now), q3(b.pos.x), q3(b.pos.y), q3(b.pos.z), q3(b.yaw), q3(b.pitch)];
    }
    return out;
  }

  private targetsBesides(id: string, roster: ReadonlyMap<string, Fighter>): Target[] {
    const out: Target[] = [];
    for (const b of this.brains.values()) {
      if (b.id !== id && roster.get(b.id)?.alive) {
        out.push({ crouch: false, id: b.id, pos: b.pos });
      }
    }
    return out;
  }

  private place(b: Brain, life: number, targets: readonly Target[]): void {
    const spawn = safestSpawn(
      this.spawns,
      targets.map((t) => t.pos),
    );
    if (spawn) {
      b.pos.copy(spawn.pos);
      b.yaw = spawn.yaw;
    }
    b.life = life;
    b.path = [];
    b.target = null;
    b.pitch = 0;
  }

  private eyeOf(b: Brain): Vector3 {
    return this.eye.set(b.pos.x, b.pos.y + EYE, b.pos.z);
  }

  private sees(b: Brain, t: Target): boolean {
    const d = Math.hypot(t.pos.x - b.pos.x, t.pos.z - b.pos.z);
    return d < MOVE.sight && this.game.physics.lineOfSight(this.eyeOf(b), chestOf(t, this.aim));
  }

  private think(
    b: Brain,
    dt: number,
    targets: readonly Target[],
    live: boolean,
    fire: (shot: BotShot) => void,
  ): void {
    b.think -= dt;
    let target = targets.find((t) => t.id === b.target) ?? null;
    if (b.think <= 0) {
      b.think = MOVE.think;
      if (!target || !this.sees(b, target)) {
        target = this.nearestSeen(b, targets);
        if (target && target.id !== b.target) {
          b.react = between(AIM.reaction);
        }
        b.target = target?.id ?? null;
      }
    }
    if (target) {
      this.engage(b, target, dt, live, fire);
    } else {
      this.roam(b, dt, targets);
    }
    b.pos.y = this.game.physics.groundHeight(b.pos.x, b.pos.z, b.pos.y + 0.6);
  }

  private nearestSeen(b: Brain, targets: readonly Target[]): Target | null {
    let best: Target | null = null;
    let bestD = Infinity;
    for (const t of targets) {
      const d = Math.hypot(t.pos.x - b.pos.x, t.pos.z - b.pos.z);
      if (d < bestD && this.sees(b, t)) {
        bestD = d;
        best = t;
      }
    }
    return best;
  }

  private engage(
    b: Brain,
    t: Target,
    dt: number,
    live: boolean,
    fire: (shot: BotShot) => void,
  ): void {
    b.path = [];
    const want = yawTo(b.pos, t.pos);
    b.yaw = turnTowards(b.yaw, want, MOVE.turn * dt);
    const dist = Math.hypot(t.pos.x - b.pos.x, t.pos.z - b.pos.z);
    const chest = chestOf(t, this.aim);
    b.pitch = Math.atan2(chest.y - (b.pos.y + EYE), dist);

    b.strafeT -= dt;
    if (b.strafeT <= 0) {
      b.strafeT = between([0.6, 1.4]);
      b.strafe = -b.strafe;
    }
    const advance = dist > MOVE.hold ? 0.6 : 0;
    const fx = -Math.sin(b.yaw);
    const fz = -Math.cos(b.yaw);
    // Right of facing is (-fz, fx).
    const vx = (fx * advance - fz * b.strafe) * MOVE.strafe;
    const vz = (fz * advance + fx * b.strafe) * MOVE.strafe;
    if (!this.walk(b, vx * dt, vz * dt)) {
      b.strafe = -b.strafe;
    }

    b.react -= dt;
    b.cooldown -= dt;
    const onTarget =
      Math.abs(Math.atan2(Math.sin(want - b.yaw), Math.cos(want - b.yaw))) < AIM.cone;
    if (!live || b.react > 0 || b.cooldown > 0 || !onTarget) {
      return;
    }
    if (b.burst <= 0) {
      b.burst = Math.round(between(AIM.burst));
    }
    b.burst -= 1;
    b.cooldown = b.burst > 0 ? AIM.cadence : between(AIM.pause);
    this.shoot(b, t, dist, fire);
  }

  private shoot(b: Brain, t: Target, dist: number, fire: (shot: BotShot) => void): void {
    const muzzle = this.eyeOf(b).clone();
    muzzle.y -= 0.2;
    const end = chestOf(t, new Vector3());
    // The shot is real only if the target is still in the open.
    const clear = this.game.physics.lineOfSight(muzzle, end);
    const hit = clear && Math.random() < Math.max(AIM.minHit, AIM.hit - dist * AIM.falloff);
    const head = hit && Math.random() < AIM.headChance;
    if (head) {
      end.y += t.crouch ? 0.35 : 0.47;
    }
    if (!hit) {
      // A near miss: past the target, by a body's width or so.
      end.add(this.step.set(between([-1.2, 1.2]), between([-0.5, 0.9]), between([-1.2, 1.2])));
    }
    fire({
      bot: b.id,
      damage: head ? AIM.damage * 2 : AIM.damage,
      end,
      head,
      muzzle,
      victim: hit ? t.id : null,
    });
  }

  private roam(b: Brain, dt: number, targets: readonly Target[]): void {
    const { nav } = this.game.physics;
    if (b.path.length === 0) {
      // Drift towards somebody, so a big dock still finds its fights.
      const near = targets[Math.floor(Math.random() * targets.length)];
      const around = near ? new Vector3(near.pos.x, 0, near.pos.z) : b.pos;
      b.path = nav.findPath(b.pos, nav.randomPoint(around, MOVE.roam)) ?? [];
      if (b.path.length === 0) {
        return;
      }
    }
    const [next] = b.path;
    if (!next) {
      return;
    }
    const dx = next.x - b.pos.x;
    const dz = next.z - b.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.6) {
      b.path.shift();
      return;
    }
    b.yaw = turnTowards(b.yaw, Math.atan2(-dx, -dz), MOVE.turn * dt);
    b.pitch *= 1 - Math.min(1, dt * 4);
    const stride = Math.min(d, MOVE.run * dt);
    if (this.walk(b, (dx / d) * stride, (dz / d) * stride)) {
      b.stuck = 0;
    } else {
      b.stuck += dt;
      if (b.stuck > 0.6) {
        b.stuck = 0;
        b.path = [];
      }
    }
  }

  /** Step on the walkable grid, sliding along an edge. False if it went nowhere. */
  private walk(b: Brain, dx: number, dz: number): boolean {
    const { nav } = this.game.physics;
    const { x, z } = b.pos;
    if (nav.isWalkable(x + dx, z + dz)) {
      b.pos.x += dx;
      b.pos.z += dz;
    } else if (nav.isWalkable(x + dx, z)) {
      b.pos.x += dx;
    } else if (nav.isWalkable(x, z + dz)) {
      b.pos.z += dz;
    } else {
      return false;
    }
    return Math.abs(dx) + Math.abs(dz) > 0;
  }
}

/**
 * The bots in a BOTS_KEY record as player reports, alive and life from the
 * match roster, so `Players` treats them like anyone else.
 */
export const botPlayers = (
  raw: JsonValue | undefined,
  roster: ReadonlyMap<string, Fighter> | undefined,
): PlayerMap => {
  const out: PlayerMap = {};
  if (!isRecord(raw) || !roster) {
    return out;
  }
  for (const [id, body] of Object.entries(raw)) {
    const v = nums(body, 6);
    const fighter = roster.get(id);
    if (!v || !fighter) {
      continue;
    }
    const [t = 0, x = 0, y = 0, z = 0, yaw = 0, pitch = 0] = v;
    out[id] = {
      id,
      state: {
        a: fighter.alive ? 1 : 0,
        c: 0,
        d: 1,
        hp: fighter.hp,
        l: fighter.life,
        pitch,
        t,
        x,
        y,
        yaw,
        z,
      },
    };
  }
  return out;
};
