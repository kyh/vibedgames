// A simulated network for the headless netcode checks: deterministic noise,
// one direction of a WebSocket with latency and jitter, and a copy of the
// room's shared state kept the way the SDK keeps it.
import { applyPatch, diffState, readPatch } from "@vibedgames/multiplayer";
import type { JsonRecord, PatchOp } from "@vibedgames/multiplayer";
import type { JsonValue } from "../src/data/json.ts";

/** Deterministic noise in [0, 1). */
export const noise = (i: number): number => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43_758.5453;
  return s - Math.floor(s);
};

/** One direction of a WebSocket: every message is delayed `oneWayMs` plus up
 *  to `jitterMs`, never overtakes the one before it (TCP bunches instead), and
 *  crosses as JSON. */
export class Pipe {
  private readonly queue: { at: number; text: string }[] = [];
  private last = 0;
  private count = 0;
  private readonly oneWayMs: number;
  private readonly jitterMs: number;
  private readonly salt: number;
  bytes = 0;

  constructor(oneWayMs: number, jitterMs: number, salt: number) {
    this.oneWayMs = oneWayMs;
    this.jitterMs = jitterMs;
    this.salt = salt;
  }

  send(now: number, message: JsonValue): void {
    this.count += 1;
    const at = Math.max(
      this.last,
      now + this.oneWayMs + noise(this.count * 7 + this.salt) * this.jitterMs,
    );
    this.last = at;
    const text = JSON.stringify(message);
    this.bytes += text.length;
    this.queue.push({ at, text });
  }

  receive(now: number): JsonValue[] {
    const out: JsonValue[] = [];
    while (this.queue[0] && this.queue[0].at <= now) {
      const next = this.queue.shift();
      if (next) {
        out.push(JSON.parse(next.text));
      }
    }
    return out;
  }
}

/** One client's copy of the room's shared state, kept as the SDK keeps it: a
 *  write is diffed against the copy into path ops (the leaves that changed),
 *  and ops apply copy-on-write, so whatever they leave untouched is the very
 *  object the copy held before — `state` is what `client.sharedState` reads. */
export const sharedCopy = () => {
  let state: JsonRecord = {};
  /** Ops off the wire. */
  const apply = (data: JsonValue): void => {
    const ops = readPatch(data);
    if (Array.isArray(ops)) {
      state = applyPatch(state, ops);
    }
  };
  return {
    apply,
    get state() {
      return state;
    },
    /** The host's write: the ops it puts on the wire, applied to this copy. */
    write: (patch: JsonRecord): PatchOp[] => {
      const ops = diffState(state, { ...state, ...patch }, Object.keys(patch));
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- the copy holds what JSON carries: structuredClone would keep keys set to undefined, which the wire and the SDK drop
      apply(JSON.parse(JSON.stringify(ops)));
      return ops;
    },
  };
};
