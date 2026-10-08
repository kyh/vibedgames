// A simulated network for the headless netcode checks: deterministic noise,
// and one direction of a WebSocket with latency and jitter.
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
