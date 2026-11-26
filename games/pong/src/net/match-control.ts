import type { JsonValue, MultiplayerConnectionStatus, TickInfo } from "@vibedgames/multiplayer";

import { MP_MAX_PLAYERS, OFFLINE_FALLBACK_MS, TICK_RATE } from "../shared/constants";
import type { SlotInput } from "../shared/input";
import { cloneSim, newMatch, paddleOf } from "../shared/sim";
import type { SimState, Slot } from "../shared/sim";
import { LocalDriver } from "./local-driver";
import { RECORD_KEY, readRecord, recordJson, rivalOf, seatOf, seatPair } from "./match-record";
import type { MatchRecord } from "./match-record";
import { NetSession, isJsonNumber, isJsonObject } from "./session";
import { TickDriver } from "./tick-driver";

const START_LEAD_TICKS = 30;

export type Driver = TickDriver | LocalDriver;

/** What the HUD says about the connection. */
export type Link = "connecting" | "reconnecting" | "solo" | "open" | "live";

const randomSeed = () => 1 + Math.floor(Math.random() * 2_147_483_645);

const soloOpening: (slot: Slot, held: SlotInput) => SimState = (slot, held) => {
  const state = newMatch({ autoServe: false, scoreA: 0, scoreB: 0, seed: randomSeed(), tick: 0 });
  const paddle = paddleOf(state, slot);
  paddle.c = held.c;
  paddle.k = held.k;

  return state;
};

export class MatchControl {
  private readonly net: NetSession;
  private current: Driver;
  private scopeName: string;
  private soloGames = 0;
  private shownTick = 0;
  private resyncAsked = -1;
  private rebaseWanted = -1;
  private lastStatus: MultiplayerConnectionStatus;

  constructor(room: string, held: SlotInput) {
    this.net = new NetSession({
      fallbackMs: OFFLINE_FALLBACK_MS,
      maxPlayers: MP_MAX_PLAYERS,
      onEvent: (event, payload, from) => {
        this.handleEvent(event, payload, from);
      },
      onTick: (tick) => {
        this.handleTick(tick);
      },
      room,
      tickRate: TICK_RATE,
    });
    this.scopeName = this.nextSoloScope();
    this.current = new LocalDriver(soloOpening(0, held), 0);
    this.lastStatus = this.net.connectionStatus;
    this.net.client.subscribe(() => {
      this.noteStatus();
    });
  }

  get driver() {
    return this.current;
  }

  get session() {
    return this.net;
  }

  /** The effects namespace of the match on screen. */
  get scope() {
    return this.scopeName;
  }

  /** A rival shares this match's clock: the sim cannot be paused. */
  get ticking() {
    return this.current.kind === "tick";
  }

  get link() {
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

  /** Each frame: settle which match runs, then run it. Returns the horizon:
   *  the fractional tick this player's input lands at. */
  frame(input: SlotInput, dtMs: number, running: boolean) {
    this.hostDuties();
    this.syncMatch();
    const { current } = this;

    return current.kind === "tick" ? current.frame(input) : current.frame(input, dtMs, running);
  }

  /** The scene draws the match at tick `tick` — behind the horizon while the
   *  ball is on the rival's half. A match the rival leaves carries on from it. */
  show(tick: number) {
    this.shownTick = tick;
  }

  /** Leave the room for a solo game against the AI — from `base`, or a fresh
   *  opening. The room frees the seat at once; this client plays on offline. */
  goOffline(held: SlotInput, base?: SimState) {
    this.net.client.goOffline();
    this.scopeName = this.nextSoloScope();
    this.current = new LocalDriver(base ?? soloOpening(0, held), 0);
  }

  destroy() {
    this.net.client.destroy();
  }

  private noteStatus() {
    const status = this.net.connectionStatus;
    const { current } = this;

    if (current.kind === "tick" && status === "connected" && this.lastStatus === "reconnecting") {
      current.relearn();
    }

    this.lastStatus = status;
  }

  private nextSoloScope() {
    this.soloGames += 1;

    return `solo:${this.soloGames}`;
  }

  private handleTick(tick: TickInfo) {
    this.syncMatch();
    const { current } = this;

    if (current.kind === "tick") {
      current.onTick(tick.n, tick.inputs);
    }
  }

  private handleEvent(event: string, payload: JsonValue, from: string) {
    if (event !== "resync" || !this.net.isHost || !isJsonObject(payload)) {
      return;
    }

    const record = readRecord(this.net.sharedState);
    const { id } = payload;

    if (record !== null && isJsonNumber(id) && id === record.id && seatOf(record, from) !== null) {
      this.rebaseWanted = id;
    }
  }

  private seatIn(record: MatchRecord) {
    const slot = seatOf(record, this.net.playerId);

    if (slot === null || this.net.players[rivalOf(record, slot)] === undefined) {
      return null;
    }

    return slot;
  }

  private syncMatch() {
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
      const shown = current.engine.stateAt(this.shownTick) ?? current.engine.confirmed;
      this.current = new LocalDriver(cloneSim(shown), current.mySlot);
    }
  }

  private askResync(driver: TickDriver) {
    const { id } = driver.record;

    if (!driver.broken || this.resyncAsked === id || this.net.isHost) {
      return;
    }

    this.resyncAsked = id;
    this.net.client.sendToHost("resync", { id });
  }

  private hostDuties() {
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

  private hostPair() {
    const { net } = this;

    if (net.connectionStatus !== "connected" || !net.isHost || !net.clockSynced) {
      return null satisfies [string, string] | null;
    }

    const [first, second, ...more] = Object.keys(net.players);

    return (
      first === undefined || second === undefined || more.length > 0 ? null : [first, second]
    ) satisfies [string, string] | null;
  }

  private driverFor(record: MatchRecord | null) {
    const { current } = this;

    return current.kind === "tick" && current.record.id === record?.id ? current : null;
  }

  private needsRebase(record: MatchRecord, epoch: number, driver: TickDriver | null) {
    return record.epoch !== epoch || this.rebaseWanted === record.id || driver?.broken === true;
  }
}
