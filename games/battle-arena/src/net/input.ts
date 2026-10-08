// Guest input on the wire. A guest samples its controls once per sim tick and
// sends a packet only when they change (plus a slow keepalive); every press —
// hop, dash, cast, item, an attack click shorter than a tick — rides the packet
// of the tick it happened in, so it reaches the host on the same tick boundary
// the guest predicted it on. The host replays each guest's packets on that
// guest's own tick schedule (InputBuffer), held a couple of ticks behind the
// fastest arrival, so network jitter neither drops a tap nor stretches a hold.
import { INPUT_JITTER_TICKS } from "../data/config";
import { HALF } from "../data/map";
import { isJsonNumber } from "../data/json";
import type { JsonObject, JsonValue } from "../data/json";
import { activateItem, requestCast } from "../sim/abilities";
import type { Vec2 } from "../sim/math";
import { ALL_ABILITY_KEYS } from "../sim/types";
import type { AbilityKey, Unit, World } from "../sim/types";
import { setHeroInput, tryJump } from "../sim/world";
import type { CastWire, Intent, ItemWire } from "./protocol";

export interface CastAction {
  key: AbilityKey;
  dir: Vec2;
  point: Vec2;
}

export interface ItemAction {
  slot: number;
  point: Vec2;
}

export interface InputPacket {
  seq: number;
  tick: number;
  mx: number;
  my: number;
  ax: number;
  ay: number;
  atk: boolean;
  jump: boolean;
  dash: Vec2 | null;
  casts: CastAction[];
  items: ItemAction[];
}

/** More presses than this in one 33 ms tick is not a person. */
const MAX_ACTIONS = 8;

const clamp1 = (n: number): number => Math.min(1, Math.max(-1, n));
const clampArena = (n: number): number => Math.min(HALF, Math.max(-HALF, n));
const num = (v: JsonValue | undefined): number => (isJsonNumber(v) ? v : 0);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const isCount = (v: JsonValue | undefined): v is number =>
  isJsonNumber(v) && Number.isSafeInteger(v) && v >= 0;

const parseCast = (v: JsonValue): CastAction | null => {
  if (!Array.isArray(v)) {
    return null;
  }
  const [key, ax, ay, px, py] = v;
  const known = ALL_ABILITY_KEYS.find((k) => k === key);
  return known
    ? {
        dir: { x: clamp1(num(ax)), y: clamp1(num(ay)) },
        key: known,
        point: { x: clampArena(num(px)), y: clampArena(num(py)) },
      }
    : null;
};

const parseItem = (v: JsonValue): ItemAction | null => {
  if (!Array.isArray(v)) {
    return null;
  }
  const [slot, px, py] = v;
  return isCount(slot) && slot < MAX_ACTIONS
    ? { point: { x: clampArena(num(px)), y: clampArena(num(py)) }, slot }
    : null;
};

const parseList = <T>(v: JsonValue | undefined, parse: (item: JsonValue) => T | null): T[] => {
  const out: T[] = [];
  if (Array.isArray(v)) {
    for (const item of v.slice(0, MAX_ACTIONS)) {
      const parsed = parse(item);
      if (parsed) {
        out.push(parsed);
      }
    }
  }
  return out;
};

/** Parse a wire input field by field — a malformed or malicious client must
 *  not inject NaN/Inf or spoofed shapes into the authoritative sim. */
export const parseInput = (wire: JsonObject): InputPacket | null => {
  const { seq, tick, dash } = wire;
  if (!isCount(seq) || !isCount(tick)) {
    return null;
  }
  const dashDir =
    Array.isArray(dash) && dash.length === 2
      ? { x: clamp1(num(dash[0])), y: clamp1(num(dash[1])) }
      : null;
  return {
    atk: wire["atk"] === true,
    ax: clamp1(num(wire["ax"])),
    ay: clamp1(num(wire["ay"])),
    casts: parseList(wire["casts"], parseCast),
    dash: dashDir,
    items: parseList(wire["items"], parseItem),
    jump: wire["jump"] === true,
    mx: clamp1(num(wire["mx"])),
    my: clamp1(num(wire["my"])),
    seq,
    tick,
  };
};

/** The wire form: directions to 0.001, points to 0.01, empty fields omitted. */
export const inputWire = (p: InputPacket): Intent => {
  const wire: Extract<Intent, { kind: "input" }> = {
    atk: p.atk,
    ax: round3(p.ax),
    ay: round3(p.ay),
    kind: "input",
    mx: round3(p.mx),
    my: round3(p.my),
    seq: p.seq,
    tick: p.tick,
  };
  if (p.jump) {
    wire.jump = true;
  }
  if (p.dash) {
    wire.dash = [round3(p.dash.x), round3(p.dash.y)];
  }
  if (p.casts.length > 0) {
    wire.casts = p.casts.map((c): CastWire => [
      c.key,
      round3(c.dir.x),
      round3(c.dir.y),
      round2(c.point.x),
      round2(c.point.y),
    ]);
  }
  if (p.items.length > 0) {
    wire.items = p.items.map((i): ItemWire => [i.slot, round2(i.point.x), round2(i.point.y)]);
  }
  return wire;
};

/** Same held controls, nothing pressed: the keepalive would be the only reason to send. */
export const sameHeld = (a: InputPacket, b: InputPacket): boolean =>
  a.mx === b.mx && a.my === b.my && a.ax === b.ax && a.ay === b.ay && a.atk === b.atk;

export const hasActions = (p: InputPacket): boolean =>
  p.jump || p.dash !== null || p.casts.length > 0 || p.items.length > 0;

/** Apply one guest packet to its hero, in the order the local controls apply
 *  them (a guest predicts the same order): casts, held input, hop, dash, items. */
export const applyInput = (w: World, u: Unit, p: InputPacket): void => {
  for (const c of p.casts) {
    requestCast(w, u, c.key, { dir: c.dir, point: c.point });
  }
  setHeroInput(u, p.mx, p.my, p.ax, p.ay, p.atk);
  if (p.jump) {
    tryJump(w, u);
  }
  if (p.dash) {
    requestCast(w, u, "DASH", { dir: p.dash });
  }
  for (const item of p.items) {
    activateItem(w, u, item.slot, item.point);
  }
};

/** Ticks of arrival history one bucket covers, and the window kept. */
const SLACK_BUCKET_TICKS = 30;
const SLACK_WINDOW_TICKS = 90;
/** How far past the headroom the delay may grow to cover a slow route. */
const MAX_EXTRA_TICKS = 2;

/** No held movement or press: replaying it a tick sooner or later changes nothing. */
const idle = (p: InputPacket): boolean => p.mx === 0 && p.my === 0 && !hasActions(p);

/**
 * One guest's inputs on the host. Each packet carries the guest's tick; the
 * host plays it at `tick + offset`, so every input is held for exactly as many
 * ticks as the guest predicted it — whatever the network did to the packets in
 * between. The offset is the fastest recent arrival (host tick it could first
 * apply it − guest tick) plus INPUT_JITTER_TICKS of headroom, grown to cover
 * the slowest recent arrival but never more than MAX_EXTRA_TICKS further, so
 * one lag spike cannot buy a second of delay (a packet slower still is applied
 * on arrival). It rises at once only when a packet would otherwise be late —
 * stretching the input being held, the one correction a slower route costs;
 * every other move is a tick a second while the hero stands idle, where
 * shifting the schedule is invisible.
 */
export class InputBuffer {
  /** Newest seq applied, and World.now when it was (the snapshot reports both). */
  ack = 0;
  ackAt = 0;
  private readonly queue: InputPacket[] = [];
  private readonly buckets: { start: number; min: number; max: number }[] = [];
  private offset: number | null = null;
  private movedAt = 0;
  private applied: InputPacket | null = null;

  /** Queue a packet whose first chance to be applied is host tick `hostTick`. */
  push(p: InputPacket, hostTick: number): void {
    if (p.seq <= this.ack || this.queue.some((q) => q.seq === p.seq)) {
      return;
    }
    this.observe(hostTick - p.tick, hostTick);
    const at = this.queue.findIndex((q) => q.seq > p.seq);
    if (at === -1) {
      this.queue.push(p);
    } else {
      this.queue.splice(at, 0, p);
    }
  }

  /** Hand each packet due at `hostTick` to `apply`, oldest first; `now` is
   *  World.now before the tick's step — when the hero starts acting on it. */
  drain(hostTick: number, now: number, apply: (p: InputPacket) => void): void {
    this.retarget(hostTick);
    const offset = this.offset ?? 0;
    let [head] = this.queue;
    while (head && head.tick + offset <= hostTick) {
      this.queue.shift();
      this.ack = head.seq;
      this.ackAt = now;
      this.applied = head;
      apply(head);
      [head] = this.queue;
    }
  }

  private observe(slack: number, hostTick: number): void {
    const last = this.buckets.at(-1);
    if (last && hostTick - last.start < SLACK_BUCKET_TICKS) {
      last.min = Math.min(last.min, slack);
      last.max = Math.max(last.max, slack);
    } else {
      this.buckets.push({ max: slack, min: slack, start: hostTick });
    }
    while (
      this.buckets.length > 1 &&
      hostTick - (this.buckets[0]?.start ?? hostTick) > SLACK_WINDOW_TICKS
    ) {
      this.buckets.shift();
    }
  }

  private retarget(hostTick: number): void {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const bucket of this.buckets) {
      min = Math.min(min, bucket.min);
      max = Math.max(max, bucket.max);
    }
    if (!Number.isFinite(min)) {
      return;
    }
    const cap = min + INPUT_JITTER_TICKS + MAX_EXTRA_TICKS;
    // what keeps every recent packet on time, and that plus headroom
    const needed = Math.min(max, cap);
    const wanted = Math.min(Math.max(max, min + INPUT_JITTER_TICKS), cap);
    if (this.offset === null || needed > this.offset) {
      this.offset = this.offset === null ? wanted : needed;
      this.movedAt = hostTick;
      return;
    }
    // Any other change of schedule stretches or cuts a hold: make it a tick a
    // second, and only while the hero is idle, where it is invisible.
    const settled =
      hostTick - this.movedAt >= SLACK_BUCKET_TICKS &&
      (!this.applied || idle(this.applied)) &&
      this.queue.every(idle);
    if (settled && wanted !== this.offset) {
      this.offset += wanted > this.offset ? 1 : -1;
      this.movedAt = hostTick;
    }
  }
}
