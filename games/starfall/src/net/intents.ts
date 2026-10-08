import type { Link } from "../state/link";
import { asWireRecord, wireNum, wireStr } from "./wire-read";
import type { WireRecord, WireValue } from "./wire-read";

/**
 * Everything this client asks of the host in a frame — damage it dealt,
 * shots its shield ate, pickups it claimed, SINGULARITY pulls — batched into
 * ONE `intents` event sent to the host alone. The host itself skips the
 * network entirely: its own intents run through the same handler locally.
 */

/** One reported hit. `kx`/`ky` is knockback (enemies only). */
export type HostHit =
  | { kind: "asteroid"; id: string; damage: number }
  | { kind: "enemy"; id: string; damage: number; kx: number; ky: number }
  | { kind: "ufo"; damage: number };

/** A decoded `intents` event. */
export interface IntentBatch {
  hits: HostHit[];
  shots: string[];
  items: string[];
  shards: string[];
  pulls: { x: number; y: number; ms: number }[];
}

/** 3 decimals: damage fractions (asteroid power) need more than whole HP. */
const q3 = (n: number): number => Math.round(n * 1000) / 1000;
const q1 = (n: number): number => Math.round(n * 10) / 10;

const strings = (raw: WireValue | undefined): string[] => {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const s = wireStr(v);
      if (s !== null) {
        out.push(s);
      }
    }
  }
  return out;
};

const readHit = (raw: WireValue): HostHit | null => {
  if (!Array.isArray(raw)) {
    return null;
  }
  const [kind, a, b, c, d] = raw;
  if (kind === "u") {
    const damage = wireNum(a);
    return damage === null ? null : { damage, kind: "ufo" };
  }
  const id = wireStr(a);
  const damage = wireNum(b);
  if (id === null || damage === null) {
    return null;
  }
  if (kind === "a") {
    return { damage, id, kind: "asteroid" };
  }
  if (kind === "e") {
    return { damage, id, kind: "enemy", kx: wireNum(c) ?? 0, ky: wireNum(d) ?? 0 };
  }
  return null;
};

export const readIntents = (payload: WireValue): IntentBatch | null => {
  const p = asWireRecord(payload);
  if (!p) {
    return null;
  }
  const hits: HostHit[] = [];
  const rawHits = p["h"];
  if (Array.isArray(rawHits)) {
    for (const raw of rawHits) {
      const hit = readHit(raw);
      if (hit) {
        hits.push(hit);
      }
    }
  }
  const pulls: IntentBatch["pulls"] = [];
  const rawPulls = p["g"];
  if (Array.isArray(rawPulls)) {
    for (const raw of rawPulls) {
      const [x, y, ms] = Array.isArray(raw) ? raw : [];
      const px = wireNum(x);
      const py = wireNum(y);
      const pms = wireNum(ms);
      if (px !== null && py !== null && pms !== null) {
        pulls.push({ ms: pms, x: px, y: py });
      }
    }
  }
  return { hits, items: strings(p["i"]), pulls, shards: strings(p["s"]), shots: strings(p["c"]) };
};

/** The per-frame outbox. Producers queue; the scene flushes once per frame. */
export class HostIntents {
  private hits: WireValue[] = [];
  private shots: string[] = [];
  private items: string[] = [];
  private shards: string[] = [];
  private pulls: WireValue[] = [];

  asteroidHit(id: string, damage: number): void {
    this.hits.push(["a", id, q3(damage)]);
  }

  enemyHit(id: string, damage: number, kx = 0, ky = 0): void {
    this.hits.push(
      kx === 0 && ky === 0 ? ["e", id, q3(damage)] : ["e", id, q3(damage), q1(kx), q1(ky)],
    );
  }

  ufoHit(damage: number): void {
    this.hits.push(["u", q3(damage)]);
  }

  /** An enemy shot my shield (or hull) consumed. */
  shotConsumed(id: string): void {
    this.shots.push(id);
  }

  itemClaimed(id: string): void {
    this.items.push(id);
  }

  shardClaimed(id: string): void {
    this.shards.push(id);
  }

  /** A SINGULARITY collapse: the host drags bodies toward (x,y) for `ms`. A
   *  duration, not a deadline — the two clocks share no epoch. */
  pull(x: number, y: number, ms: number): void {
    this.pulls.push([q1(x), q1(y), Math.round(ms)]);
  }

  /** Send this frame's batch (if any) and start a new one. */
  flush(link: Link): void {
    if (
      this.hits.length === 0 &&
      this.shots.length === 0 &&
      this.items.length === 0 &&
      this.shards.length === 0 &&
      this.pulls.length === 0
    ) {
      return;
    }
    const batch: WireRecord = {};
    if (this.hits.length > 0) {
      batch["h"] = this.hits;
    }
    if (this.shots.length > 0) {
      batch["c"] = this.shots;
    }
    if (this.items.length > 0) {
      batch["i"] = this.items;
    }
    if (this.shards.length > 0) {
      batch["s"] = this.shards;
    }
    if (this.pulls.length > 0) {
      batch["g"] = this.pulls;
    }
    this.hits = [];
    this.shots = [];
    this.items = [];
    this.shards = [];
    this.pulls = [];
    link.toHost("intents", batch);
  }
}
