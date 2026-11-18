// The bots, on both sides of the wire. The host simulates them with the same
// kart physics a player gets and publishes their rows in shared state; a guest
// plays those rows back on one clock (they all come from the host). The rows
// are the whole truth: a client promoted to host rebuilds its karts from them
// and carries on, so a host leaving mid-race costs the bots nothing.

import { FixedRate, RemoteClock } from "@vibedgames/multiplayer";
import type { JsonRecord } from "@vibedgames/multiplayer";

import { BOTS, BOT_SEND_HZ, CHASSIS, KART_RADIUS, LAUNCH_SECONDS } from "../shared/constants";
import { botInput, makeBrain } from "../sim/bot";
import type { BotBrain } from "../sim/bot";
import { raceLength, spawnKart, stepKart } from "../sim/kart";
import type { Kart } from "../sim/kart";
import { locate } from "../sim/track";
import type { Track } from "../sim/track";
import { RemoteTrack, encodePose, poseOf, readPose } from "./pose";
import type { KartPose } from "./pose";
import { isJsonObject } from "./wire";
import type { WireField } from "./wire";

interface HostBot {
  kart: Kart;
  brain: BotBrain;
}

/** What the host needs to drive one frame of bots. */
export interface BotFrame {
  track: Track;
  dt: number;
  /** Room clock, ms. */
  now: number;
  /** Seconds since boot, for the weave. */
  time: number;
  /** False during the countdown: bots hold the grid. */
  racing: boolean;
  /** How many bots are on the grid this frame. */
  count: number;
  /** The leading human's progress, or null with no human racing. */
  leaderProg: number | null;
  /** Everyone a bot can bump into, by racer key (its own included). */
  others: ReadonlyMap<string, KartPose>;
  /** Paint slot under (x, z), and the slot a bot key paints in. */
  ownerAt: (x: number, z: number) => number;
  slotOf: (key: string) => number;
}

/** Seconds of boost a bot keeps across a host change, when its row had one burning. */
const HANDOVER_BOOST = 0.4;

export const botKey = (index: number): string => `b${index}`;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Nudge the kart `key` out of anyone else it overlaps. */
const separate = (kart: Kart, key: string, others: ReadonlyMap<string, KartPose>): void => {
  for (const [otherKey, other] of others) {
    const dx = kart.x - other.x;
    const dz = kart.z - other.z;
    const d = Math.hypot(dx, dz);
    // Its own entry is last frame's pose: skipping by key, not by position.
    if (otherKey !== key && d > 0.01 && d < KART_RADIUS * 2) {
      const push = (KART_RADIUS * 2 - d) * 0.5;
      kart.x += (dx / d) * push;
      kart.z += (dz / d) * push;
    }
  }
};

export class BotField {
  private readonly hosted = new Map<string, HostBot>();
  private readonly remote = new Map<string, RemoteTrack>();
  private readonly clock = new RemoteClock();
  private readonly send = new FixedRate(BOT_SEND_HZ);

  /** Host, new round: every bot back on the grid behind the humans. */
  reset(track: Track, firstSlot: number): void {
    this.hosted.clear();
    for (const [index] of BOTS.entries()) {
      this.hosted.set(botKey(index), {
        brain: makeBrain(index),
        kart: spawnKart(track, firstSlot + index, index % CHASSIS.length),
      });
      // Some bots nail the lights: the boost only burns once the race is on.
      const bot = this.hosted.get(botKey(index));
      if (bot && (index * 7 + track.n) % 3 === 0) {
        bot.kart.boost = LAUNCH_SECONDS;
      }
    }
  }

  /** Just became host: pick every bot up where the last host's rows left it. */
  adopt(track: Track, rows: WireField, firstSlot: number): void {
    this.reset(track, firstSlot);
    if (!isJsonObject(rows)) {
      return;
    }
    for (const [key, bot] of this.hosted) {
      const report = readPose(rows[key]);
      if (report) {
        const where = locate(track, report.x, report.z, -1);
        Object.assign(bot.kart, {
          a: report.a,
          // The row says only that a boost is burning, not how much is left.
          boost: report.boosting ? HANDOVER_BOOST : 0,
          charge: report.charge,
          chassis: report.chassis,
          drift: report.drift,
          finishMs: report.finishMs,
          h: where.h,
          idx: where.i,
          lat: where.lat,
          orbs: report.orbs,
          prog: report.prog,
          s: where.s,
          spin: report.spin,
          vx: Math.cos(report.a) * report.speed,
          vz: Math.sin(report.a) * report.speed,
          x: report.x,
          z: report.z,
        });
      }
    }
  }

  /** Host: advance the first `count` bots one frame. */
  step(frame: BotFrame): void {
    if (!frame.racing) {
      return;
    }
    const { track } = frame;
    for (let index = 0; index < frame.count; index += 1) {
      const key = botKey(index);
      const bot = this.hosted.get(key);
      if (bot) {
        const { kart } = bot;
        // Rubber band on the leading human: push when behind, ease off when clear ahead.
        const gap = frame.leaderProg === null ? 0 : (frame.leaderProg - kart.prog) / track.n;
        const pace = kart.finishMs > 0 ? 0.55 : clamp(1 + gap * 0.9, 0.88, 1.06);
        const input = botInput(kart, track, bot.brain, frame.time, pace);
        stepKart(kart, input, track, frame.dt, frame.ownerAt(kart.x, kart.z), frame.slotOf(key));
        separate(kart, key, frame.others);
        if (kart.finishMs === 0 && kart.prog >= raceLength(track)) {
          kart.finishMs = Math.round(frame.now);
        }
      }
    }
  }

  /** Host: the kart behind a bot key, for whatever else acts on it (items, spins). */
  kart(key: string): Kart | null {
    return this.hosted.get(key)?.kart ?? null;
  }

  /** Host: true when it is time to publish the rows again. */
  due(deltaMs: number): boolean {
    return this.send.due(deltaMs);
  }

  /** Host: the first `count` bots as fresh wire rows. */
  rows(count: number, now: number, round: number, holding: (key: string) => boolean): JsonRecord {
    const rows: JsonRecord = {};
    for (let index = 0; index < count; index += 1) {
      const bot = this.hosted.get(botKey(index));
      if (bot) {
        rows[botKey(index)] = encodePose(bot.kart, now, round, holding(botKey(index)));
      }
    }
    return rows;
  }

  /** Every bot on the grid and where to draw it: simulated here, or played back. */
  poses(
    isHost: boolean,
    rows: WireField,
    count: number,
    round: number,
    holding: (key: string) => boolean,
  ): [string, KartPose][] {
    const out: [string, KartPose][] = [];
    if (isHost) {
      for (let index = 0; index < count; index += 1) {
        const bot = this.hosted.get(botKey(index));
        if (bot) {
          out.push([botKey(index), poseOf(bot.kart, holding(botKey(index)))]);
        }
      }
      return out;
    }
    if (!isJsonObject(rows)) {
      return out;
    }
    for (const [key, row] of Object.entries(rows)) {
      const report = readPose(row);
      if (report && report.round === round) {
        let track = this.remote.get(key);
        if (!track) {
          track = new RemoteTrack(this.clock);
          this.remote.set(key, track);
        }
        track.push(report);
        const pose = track.sample();
        if (pose) {
          out.push([key, pose]);
        }
      }
    }
    return out;
  }

  /** The host changed, or our connection came back: the rows take a new route. */
  relearn(): void {
    this.clock.relearn();
  }
}
