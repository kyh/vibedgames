import type { JsonObject } from "../data/json";
import { FULL_SNAPSHOT_TICKS, MAX_CATCH_UP_TICKS, SIM_DT } from "../data/config";
import type { FxEvent, Unit, World } from "../sim/types";
import { step } from "../sim/world";
import { FrameEncoder } from "./frames";
import { InputBuffer, applyInput } from "./input";
import type { InputPacket } from "./input";
import { encodeWorld } from "./snapshot";
import type { Frame, Snapshot } from "./snapshot";

const TICK_MS = SIM_DT * 1000;

export interface HostLink {
  /** The room's server time (ms) — every stamp on the wire. */
  now: () => number;
  /** The hero a guest's input may drive this tick, or null (dead, gone, round over). */
  inputHero: (ownerId: string) => Unit | null;
  sendFrame: (frame: Frame) => void;
  /** A full snapshot, stamped with the server time of the tick it was taken on. */
  publish: (snapshot: Snapshot, t: number) => void;
}

export class HostNet {
  private readonly encoder = new FrameEncoder();
  private readonly inputs = new Map<string, InputBuffer>();
  private readonly acks = new Map<string, JsonObject>();
  private readonly outFx: FxEvent[] = [];
  private readonly fxSent = new WeakSet<FxEvent>();
  private acc = 0;
  private tick = 0;
  private fullAt = Number.NEGATIVE_INFINITY;
  private phase: World["phase"] | null = null;
  private lastStamp = Number.NEGATIVE_INFINITY;

  /** Queue a guest's input packet for the tick it is due on. */
  receive(ownerId: string, packet: InputPacket) {
    let buffer = this.inputs.get(ownerId);

    if (!buffer) {
      buffer = new InputBuffer();
      this.inputs.set(ownerId, buffer);
    }

    buffer.push(packet, this.tick + 1);
  }

  /** fx already in the world when this host took over came from the old
   *  host's frames: they are drawn here, never broadcast again. */
  alreadySent(fx: readonly FxEvent[]) {
    for (const e of fx) {
      this.fxSent.add(e);
    }
  }

  /** Drop the input state of guests that left. */
  forget(present: (ownerId: string) => boolean) {
    for (const ownerId of this.inputs.keys()) {
      if (!present(ownerId)) {
        this.inputs.delete(ownerId);
        this.acks.delete(`h-${ownerId}`);
      }
    }
  }

  /** Send everything again: the next tick publishes a snapshot and a frame of
   *  full rows (a new match replaced the world). */
  resync() {
    this.encoder.reset();
    this.fullAt = Number.NEGATIVE_INFINITY;
  }

  /** Publish the world now rather than on the next tick — a new match must
   *  reach shared state with its generation in the same patch. */
  publishNow(world: World, link: HostLink) {
    this.phase = world.phase;
    this.fullAt = this.tick;
    link.publish(encodeWorld(world), this.stamp(link.now()));
  }

  /** Advance by a frame's elapsed time: run the ticks due, at most
   *  MAX_CATCH_UP_TICKS of them; a longer stall skips sim time, and its frames
   *  leave a gap in the stamps rather than squeezing into less of it. */
  advance(world: World, elapsedMs: number, link: HostLink) {
    this.collectFx(world);
    this.acc += elapsedMs;
    const now = link.now();
    let ticks = 0;

    while (this.acc >= TICK_MS && ticks < MAX_CATCH_UP_TICKS) {
      this.acc -= TICK_MS;
      ticks += 1;
      this.runTick(world, link, this.stamp(now - this.acc));
    }

    if (this.acc >= TICK_MS) {
      const skipped = Math.floor(this.acc / TICK_MS);
      this.acc -= skipped * TICK_MS;
      this.tick += skipped;
    }
  }

  private stamp(at: number) {
    this.lastStamp = Math.max(Math.round(at), this.lastStamp + 1);

    return this.lastStamp;
  }

  private collectFx(world: World) {
    for (const e of world.fx) {
      if (!this.fxSent.has(e)) {
        this.fxSent.add(e);
        this.outFx.push(e);
      }
    }
  }

  private runTick(world: World, link: HostLink, t: number) {
    this.tick += 1;
    const playing = world.phase === "playing";

    for (const [ownerId, buffer] of this.inputs) {
      const hero = playing ? link.inputHero(ownerId) : null;
      const before = buffer.ack;
      buffer.drain(this.tick, world.now, (p) => {
        if (hero) {
          applyInput(world, hero, p);
        }
      });

      if (hero && buffer.ack !== before) {
        this.acks.set(hero.id, { ack: buffer.ack, ackAt: buffer.ackAt });
      }
    }

    if (playing) {
      step(world);
    }

    this.collectFx(world);

    if (world.phase !== this.phase || this.tick - this.fullAt >= FULL_SNAPSHOT_TICKS) {
      this.phase = world.phase;
      this.fullAt = this.tick;
      link.publish(encodeWorld(world), t);
    }

    link.sendFrame(this.encoder.frame(world, t, this.outFx, this.acks));
    this.outFx.length = 0;
  }
}
