// The host's half of the netcode. It owns the sim's fixed-step loop while
// online: each tick applies the guest inputs due on it (InputBuffer), steps
// the world, and sends that tick's frame; every FULL_SNAPSHOT_TICKS — and at
// once on a phase change or a resync — the whole world goes to shared state
// for late joiners and host handover. Frames are stamped with a net clock that
// keeps real time even when a stalled host skips sim ticks, so guests'
// interpolation clocks never see the room slow down.
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
  /** The hero a guest's input may drive this tick, or null (dead, gone, round over). */
  inputHero: (ownerId: string) => Unit | null;
  sendFrame: (frame: Frame) => void;
  /** A full snapshot, stamped with the net clock of the tick it was taken on. */
  publish: (snapshot: Snapshot, t: number) => void;
}

export class HostNet {
  private readonly encoder = new FrameEncoder();
  private readonly inputs = new Map<string, InputBuffer>();
  /** Hero id → { ack, ackAt }: the input ack each hero row carries. */
  private readonly acks = new Map<string, JsonObject>();
  private readonly outFx: FxEvent[] = [];
  private readonly fxSent = new WeakSet<FxEvent>();
  private acc = 0;
  private tick = 0;
  private fullAt = Number.NEGATIVE_INFINITY;
  private phase: World["phase"] | null = null;
  /** Host net clock (ms) — frame stamps. */
  netNow: number;

  /** `netNow` continues a previous host's stamps after a handover. */
  constructor(netNow = 0) {
    this.netNow = netNow;
  }

  /** Queue a guest's input packet for the tick it is due on. */
  receive(ownerId: string, packet: InputPacket): void {
    let buffer = this.inputs.get(ownerId);
    if (!buffer) {
      buffer = new InputBuffer();
      this.inputs.set(ownerId, buffer);
    }
    // the earliest tick it can still make is the next one
    buffer.push(packet, this.tick + 1);
  }

  /** Drop the input state of guests that left. */
  forget(present: (ownerId: string) => boolean): void {
    for (const ownerId of this.inputs.keys()) {
      if (!present(ownerId)) {
        this.inputs.delete(ownerId);
        this.acks.delete(`h-${ownerId}`);
      }
    }
  }

  /** Send everything again: the next tick publishes a snapshot and a frame of
   *  full rows (a new match replaced the world). */
  resync(): void {
    this.encoder.reset();
    this.fullAt = Number.NEGATIVE_INFINITY;
  }

  /** Publish the world now rather than on the next tick — a new match must
   *  reach shared state with its generation in the same patch. */
  publishNow(world: World, link: HostLink): void {
    this.phase = world.phase;
    this.fullAt = this.tick;
    link.publish(encodeWorld(world), this.netNow);
  }

  /** Advance by a frame's elapsed time: run the ticks due, at most
   *  MAX_CATCH_UP_TICKS of them; a longer stall skips sim time but not net time. */
  advance(world: World, elapsedMs: number, link: HostLink): void {
    // fx pushed outside a tick (the host's own casts between frames) go out
    // with the next frame; the renderer drains World.fx after each frame.
    this.collectFx(world);
    this.acc += elapsedMs;
    let ticks = 0;
    while (this.acc >= TICK_MS && ticks < MAX_CATCH_UP_TICKS) {
      this.acc -= TICK_MS;
      ticks += 1;
      this.runTick(world, link);
    }
    if (this.acc >= TICK_MS) {
      const skipped = Math.floor(this.acc / TICK_MS);
      this.acc -= skipped * TICK_MS;
      this.tick += skipped;
      this.netNow += skipped * TICK_MS;
    }
  }

  private collectFx(world: World): void {
    for (const e of world.fx) {
      if (!this.fxSent.has(e)) {
        this.fxSent.add(e);
        this.outFx.push(e);
      }
    }
  }

  private runTick(world: World, link: HostLink): void {
    this.tick += 1;
    this.netNow += TICK_MS;
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
      // ahead of this tick's frame: a guest adopting the snapshot then applies
      // the frame's fx on top, and a resync's full rows land on the new world
      this.phase = world.phase;
      this.fullAt = this.tick;
      link.publish(encodeWorld(world), this.netNow);
    }
    link.sendFrame(this.encoder.frame(world, this.netNow, this.outFx, this.acks));
    this.outFx.length = 0;
  }
}
