// Which match this client plays, and on which clock. With a rival seated in
// the room's match record, the room's tick stream drives a TickDriver;
// otherwise — offline, or alone in the room — a LocalDriver plays a solo
// match against the AI on this client's own clock. The host publishes the
// record (seats, first tick, seed) when a pairing forms and re-bases it when
// a timeline breaks; nothing else about the match depends on who hosts, so a
// host migration changes nothing and the match plays on.

import type { JsonValue, TickInfo } from "@vibedgames/multiplayer";

import { MP_MAX_PLAYERS, OFFLINE_FALLBACK_MS, TICK_RATE } from "../shared/constants";
import type { SlotInput } from "../shared/input";
import { cloneSim, newMatch, paddleOf } from "../shared/sim";
import type { SimState, Slot } from "../shared/sim";
import { LocalDriver } from "./local-driver";
import { RECORD_KEY, readRecord, recordJson, rivalOf, seatOf, seatPair } from "./match-record";
import type { MatchRecord } from "./match-record";
import { NetSession, isJsonNumber, isJsonObject } from "./session";
import { TickDriver } from "./tick-driver";

/** A new match starts this many ticks after the record goes out (0.5 s):
 *  time for it to reach the rival before the first tick. Arriving later
 *  still works — the rival replays the ticks it missed. */
const START_LEAD_TICKS = 30;

export type Driver = TickDriver | LocalDriver;

/** What the HUD says about the connection. */
export type Link = "connecting" | "reconnecting" | "solo" | "open" | "live";

const randomSeed = (): number => 1 + Math.floor(Math.random() * 2_147_483_645);

/** A solo match's opening: waiting for a confirm, the player's counters
 *  pre-seated so the very next press serves. */
const soloOpening = (slot: Slot, held: SlotInput): SimState => {
  const state = newMatch({ autoServe: false, scoreA: 0, scoreB: 0, seed: randomSeed(), tick: 0 });
  const paddle = paddleOf(state, slot);
  paddle.c = held.c;
  paddle.k = held.k;
  return state;
};

export class MatchControl {
  private readonly net: NetSession;
  private current: Driver;
  /** Names a match's effects: a new record or a fresh solo game opens a new scope. */
  private scopeName: string;
  private soloGames = 0;
  private shownTick = 0;
  /** The record id this client last asked the host to re-base. */
  private resyncAsked = -1;
  /** Host: a seated player asked for a re-base of this record id. */
  private rebaseWanted = -1;

  constructor(room: string, held: SlotInput) {
    this.net = new NetSession({
      fallbackMs: OFFLINE_FALLBACK_MS,
      maxPlayers: MP_MAX_PLAYERS,
      onEvent: (event, payload, from) => this.handleEvent(event, payload, from),
      onTick: (tick) => this.handleTick(tick),
      room,
      tickRate: TICK_RATE,
    });
    this.scopeName = this.nextSoloScope();
    this.current = new LocalDriver(soloOpening(0, held), 0);
  }

  get driver(): Driver {
    return this.current;
  }

  get session(): NetSession {
    return this.net;
  }

  /** The effects namespace of the match on screen. */
  get scope(): string {
    return this.scopeName;
  }

  /** A rival shares this match's clock: the sim cannot be paused. */
  get ticking(): boolean {
    return this.current.kind === "tick";
  }

  get link(): Link {
    const { net } = this;
    const status = net.connectionStatus;
    if (status === "offline") {
      return "solo";
    }
    if (status !== "connected") {
      return status;
    }
    return net.otherPlayer() === null ? "open" : "live";
  }

  /** Each frame: settle which match runs, then run it. Returns the fractional tick to show. */
  frame(input: SlotInput, dtMs: number, running: boolean): number {
    this.hostDuties();
    this.syncMatch();
    const { current } = this;
    const horizon =
      current.kind === "tick" ? current.frame(input) : current.frame(input, dtMs, running);
    this.shownTick = Math.floor(horizon);
    return horizon;
  }

  /** Leave the room for a solo game against the AI — from `base`, or a fresh
   *  opening. The room frees the seat at once; this client plays on offline. */
  goOffline(held: SlotInput, base?: SimState): void {
    this.net.client.goOffline();
    this.scopeName = this.nextSoloScope();
    this.current = new LocalDriver(base ?? soloOpening(0, held), 0);
  }

  destroy(): void {
    this.net.client.destroy();
  }

  private nextSoloScope(): string {
    this.soloGames += 1;
    return `solo:${this.soloGames}`;
  }

  /** Ticks arrive even while the tab is hidden and frames are not: keep the
   *  match current (and switch to a new record) from here too. */
  private handleTick(tick: TickInfo): void {
    this.syncMatch();
    const { current } = this;
    if (current.kind === "tick") {
      current.onTick(tick.n, tick.inputs);
    }
  }

  private handleEvent(event: string, payload: JsonValue, from: string): void {
    // A seated player whose timeline broke asks the host for a re-base.
    if (event !== "resync" || !this.net.isHost || !isJsonObject(payload)) {
      return;
    }
    const record = readRecord(this.net.sharedState);
    const { id } = payload;
    if (record !== null && isJsonNumber(id) && id === record.id && seatOf(record, from) !== null) {
      this.rebaseWanted = id;
    }
  }

  /** My seat in `record` when its rival is in the room, else null. */
  private seatIn(record: MatchRecord): Slot | null {
    const slot = seatOf(record, this.net.playerId);
    if (slot === null || this.net.players[rivalOf(record, slot)] === undefined) {
      return null;
    }
    return slot;
  }

  /** Follow the room's record: start its match once seated, play on alone
   *  when the rival leaves — or when no tick clock runs (offline). */
  private syncMatch(): void {
    const { net, current } = this;
    const record = readRecord(net.sharedState);
    const clock = net.tickClock;
    const slot =
      record !== null && clock !== null && record.epoch === clock.epoch
        ? this.seatIn(record)
        : null;
    if (record !== null && slot !== null) {
      if (current.kind === "tick" && current.record.id === record.id) {
        this.askResync(current);
      } else if (net.clockSynced) {
        this.current = new TickDriver(net, record, slot);
        this.scopeName = `match:${record.epoch}:${record.id}`;
      }
      return;
    }
    if (current.kind === "tick") {
      // The rival is gone for good, or the room is: the AI takes their
      // paddle, and the match carries on from what is on screen — on this
      // client's clock now.
      const shown = current.engine.stateAt(this.shownTick) ?? current.engine.confirmed;
      this.current = new LocalDriver(cloneSim(shown), current.mySlot);
    }
  }

  private askResync(driver: TickDriver): void {
    const { id } = driver.record;
    if (!driver.broken || this.resyncAsked === id || this.net.isHost) {
      return;
    }
    this.resyncAsked = id;
    this.net.client.sendToHost("resync", { id });
  }

  /**
   * Host: publish a record when two players are in the room and no current
   * record seats them both (a new pairing starts at 0–0), or when the seated
   * match has to be re-based — a broken timeline here or at the rival, or a
   * restarted tick clock — which keeps the score and serves afresh.
   */
  private hostDuties(): void {
    const { net } = this;
    const pair = this.hostPair();
    const clock = net.tickClock;
    const host = net.playerId;
    if (pair === null || clock === null || host === null) {
      return;
    }
    const current = readRecord(net.sharedState);
    const driver = this.driverFor(current);
    const paired = current !== null && pair.includes(current.a) && pair.includes(current.b);
    if (paired && !this.needsRebase(current, clock.epoch, driver)) {
      return;
    }
    // A re-base keeps the score; a new pairing starts at 0–0.
    const carried = paired ? (driver?.engine.confirmed ?? current) : null;
    const [a, b] = seatPair(current, pair, host);
    const record: MatchRecord = {
      a,
      b,
      epoch: clock.epoch,
      id: (current?.id ?? 0) + 1,
      scoreA: carried?.scoreA ?? 0,
      scoreB: carried?.scoreB ?? 0,
      seed: randomSeed(),
      start: clock.n + START_LEAD_TICKS,
    };
    net.client.updateSharedState({ [RECORD_KEY]: recordJson(record) });
    this.rebaseWanted = -1;
  }

  /** Host: the two players in the room, when a record can go out now. */
  private hostPair(): [string, string] | null {
    const { net } = this;
    if (net.connectionStatus !== "connected" || !net.isHost || !net.clockSynced) {
      return null;
    }
    const [first, second, ...more] = Object.keys(net.players);
    return first === undefined || second === undefined || more.length > 0 ? null : [first, second];
  }

  /** The tick driver running `record` on this client, if any. */
  private driverFor(record: MatchRecord | null): TickDriver | null {
    const { current } = this;
    return current.kind === "tick" && current.record.id === record?.id ? current : null;
  }

  /** The seated match must start over from its score: its tick clock
   *  restarted, or a timeline — here or at the rival — broke. */
  private needsRebase(record: MatchRecord, epoch: number, driver: TickDriver | null): boolean {
    return record.epoch !== epoch || this.rebaseWanted === record.id || driver?.broken === true;
  }
}
