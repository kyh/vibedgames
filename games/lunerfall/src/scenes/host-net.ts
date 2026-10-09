import { FixedRate } from "@vibedgames/multiplayer";

import { sfx } from "../audio/sfx";
import type { HeroName } from "../data/animations";
import { HEROES } from "../data/heroes";
import { ROOM_LABEL } from "../data/rooms";
import type { CheckpointPhase } from "../net/checkpoint";
import { GuestCopy } from "../net/guest-copy";
import type { JsonValue } from "../net/json";
import { parseHero, readNetInputs } from "../net/parse";
import { encodeBoss, encodeEnemy, encodePlayer, PROJ_KINDS, runTag } from "../net/snapshot";
import type {
  NetAck,
  NetCast,
  NetDoor,
  NetProjRow,
  NetRoom,
  NetStatus,
  NetVersus,
  ProjKind,
  Snapshot,
} from "../net/snapshot";
import { enemyId } from "../state/room-state";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { VS_BIOME } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { CheckpointSync } from "./checkpoint-sync";
import type { Combat } from "./combat";
import { REVIVE_HOLD } from "./last-stand";
import type { LastStand } from "./last-stand";
import { ROOM_PROPS } from "./room-builder";
import type { SceneHooks } from "./scene-hooks";
import type { VersusFlow } from "./versus-flow";

// snapshot rate: 30 Hz on a steady clock, under the guests' 100 ms render delay
const NET_HZ = 30;
// full private state for a takeover — about once a second, plus at every
// phase, progress or room edge so a promoted guest never adopts a stale one
const CHECKPOINT_MS = 1000;
interface CheckpointMark {
  phase: CheckpointPhase["kind"] | "transition-built";
  versus: NetVersus["phase"] | null;
  // relics, merchant stock, the room feature and the last stand: what a
  // guest's HUD and room dressing read from the checkpoint
  progress: string;
}

const projRow = (
  id: number,
  kind: ProjKind,
  p: { x: number; y: number; vx: number; vy: number },
): NetProjRow => [
  id,
  PROJ_KINDS.indexOf(kind),
  Math.round(p.x),
  Math.round(p.y),
  Math.round(p.vx),
  Math.round(p.vy),
];

export interface HostNetDeps {
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  lastStand: LastStand;
  versus: VersusFlow;
  checkpoint: CheckpointSync;
  combat: Combat;
  hooks: SceneHooks;
}

// Host side of the wire: drives the guest's body from its input ticks,
// broadcasts snapshots (and the cast, status, checkpoint and room when they
// change),
// and spawns/despawns the remote player as the peer comes and goes.
export class HostNet {
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly lastStand: LastStand;
  private readonly versus: VersusFlow;
  private readonly checkpoint: CheckpointSync;
  private readonly combat: Combat;
  private readonly hooks: SceneHooks;
  private readonly rate = new FixedRate(NET_HZ);
  private sinceCheckpoint = 0;
  private checkpointMark: CheckpointMark | null = null;
  private lastStamp = -1;
  // the guest body's input stream, for the remote player it was opened for
  private copy: GuestCopy | null = null;
  private copyOf: string | null = null;

  constructor(deps: HostNetDeps) {
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.lastStand = deps.lastStand;
    this.versus = deps.versus;
    this.checkpoint = deps.checkpoint;
    this.combat = deps.combat;
    this.hooks = deps.hooks;
  }

  // The remote player's input stream; a different player gets a fresh one.
  private guestCopy(): GuestCopy | null {
    const id = this.seat.remoteId;
    if (this.seat.role !== "host" || !this.seat.remote || id === null) {
      return null;
    }
    if (this.copyOf !== id || !this.copy) {
      this.copy = new GuestCopy();
      this.copyOf = id;
    }
    return this.copy;
  }

  /** A peer's event, as it lands. Only the remote player's `in` (input
   * ticks) concerns the host. */
  receive(event: string, payload: JsonValue, from: string): void {
    if (event !== "in" || from !== this.seat.remoteId) {
      return;
    }
    const msg = readNetInputs(payload);
    if (msg) {
      this.guestCopy()?.receive(msg, this.room.seq, performance.now());
    }
  }

  /** One host sim step of the guest's body, hit-stop or not — the guest never
   * freezes its own prediction. Runs before the step's combat; the step ends
   * at `now` on this tab's clock. */
  stepGuest(now: number): boolean {
    const copy = this.guestCopy();
    const { remote } = this.seat;
    if (!copy || !remote) {
      return false;
    }
    copy.enter(this.room.seq);
    const moved = copy.step(remote.body, this.run.match?.frozen ?? false, now);
    while (copy.takeStomp()) {
      this.combat.claimedStomp(remote);
    }
    return moved;
  }

  /** After the host's sim step: log what combat did to the guest's body. */
  drainGuest(): void {
    const { remote } = this.seat;
    if (remote) {
      this.guestCopy()?.drain(remote.body);
    }
  }

  /** The guest pressed attack since the last frame (versus rematch). Ask every
   * frame so a press from mid-fight never lingers into the match end. */
  takeRematch(): boolean {
    return this.guestCopy()?.takeRematch() ?? false;
  }

  // Seats are the ORIGINAL left/right slots and survive authority changes; a
  // newcomer takes the first free one.
  private claimSeat(id: string) {
    if (this.seat.seats.host === id || this.seat.seats.guest === id) {
      return;
    }
    if (this.seat.seats.host === null) {
      this.seat.seats.host = id;
    } else {
      this.seat.seats.guest = id;
    }
  }

  // Host: spawn / despawn the remote player as the other client joins or leaves.
  syncRemotePresence() {
    const sess = this.seat.session;
    const myId = sess?.playerId;
    if (!sess?.isHost || !myId || this.run.state === "dead") {
      return;
    }
    // A peer parked in the reconnect grace window is listed but not playing:
    // treated as present it would hold a seat and freeze a duel against a
    // ghost until the server reaps it. One who left (a closed tab leaves at
    // once) is not listed at all, and its seat is free too: a checkpoint
    // seating a player it does not carry is refused by every reader.
    const live = (id: string | null): boolean => {
      const p = id === null ? undefined : sess.players[id];
      return p !== undefined && p.connected !== false;
    };
    const other = sess.otherPlayer();
    if (this.seat.seats.host && !live(this.seat.seats.host)) {
      this.seat.seats.host = null;
    }
    if (this.seat.seats.guest && !live(this.seat.seats.guest)) {
      this.seat.seats.guest = null;
    }
    this.claimSeat(myId);
    if (this.seat.remote && (!other || other.id !== this.seat.remoteId || !live(other.id))) {
      this.despawnRemote();
    }
    if (other && live(other.id) && !this.seat.remote) {
      // Presence can arrive before the peer publishes its hub selection.
      const hero = parseHero(other.state?.hero);
      if (!hero) {
        return;
      }
      this.claimSeat(other.id);
      this.spawnRemote(other.id, hero);
    }
  }

  private despawnRemote() {
    if (this.run.match) {
      this.run.match.reset();
    } else if (this.run.downed) {
      this.run.downed = null;
      this.lastStand.destroyUi();
      if (this.seat.player.body.downed) {
        this.seat.player.body.revive();
      }
      this.run.hearts = Math.max(this.run.hearts, 1);
    }
    this.seat.remote?.destroy();
    this.seat.remote = undefined;
    this.seat.remoteId = null;
    if (this.run.match) {
      this.versus.respawn();
    }
    this.banners.show(this.run.match ? "CHALLENGER LEFT" : "PLAYER 2 LEFT", 1600, "critical");
    this.hooks.updateHud();
  }

  private spawnRemote(id: string, hero: HeroName) {
    const index = this.seat.seats.host === id ? 0 : 1;
    const spawn = (this.run.match ? this.room.vsSpawns[index] : undefined) ?? this.room.roomSpawn;
    this.seat.remote = this.hooks.spawnPlayer(HEROES[hero], this.room.grid, spawn.x, spawn.y);
    this.seat.remoteId = id;
    if (this.run.match) {
      this.run.match.beginMatch();
      this.versus.respawn();
      this.banners.show("ROUND 1", 1100, "critical");
      sfx.door("local");
    } else {
      this.banners.show("PLAYER 2 JOINED", 1000, "status");
    }
  }

  // Host: a snapshot each 1/30 s of the frame clock (FixedRate keeps the
  // remainder, so the cadence holds at any refresh rate), with the cast and
  // status beside it, and the room and checkpoint when they changed or fell
  // due. Each is stamped with the room's server time as it goes out — not sim
  // time, which hit-stop and a throttled tab bend — so a frozen host stamps a
  // world standing still, and a new host's stamps carry straight on from the
  // old one's.
  broadcast(dts: number, force = false) {
    const sess = this.seat.session;
    if (
      !sess?.isHost ||
      sess.offline ||
      this.seat.role !== "host" ||
      this.seat.authority.kind !== "ready"
    ) {
      return;
    }
    const due = this.rate.due(dts * 1000);
    this.sinceCheckpoint += dts * 1000;
    if (!force && !due) {
      return;
    }
    const mark = this.currentCheckpointMark();
    const last = this.checkpointMark;
    const changed =
      !last ||
      mark.phase !== last.phase ||
      mark.versus !== last.versus ||
      mark.progress !== last.progress;
    const complete = force || this.room.dirty || changed || this.sinceCheckpoint >= CHECKPOINT_MS;
    // Strictly increasing, even for two forced sends in one frame.
    const t = Math.max(this.lastStamp + 1, Math.round(sess.serverNow()));
    this.lastStamp = t;
    // One message, so a guest always reads a snapshot with the cast, status,
    // room and checkpoint it was sent beside. The SDK sends only the leaves
    // that changed, so a cast or status written unchanged costs nothing.
    const patch: Record<string, JsonValue> = {};
    patch.snap = this.encodeSnapshot(t);
    patch.cast = this.encodeCast();
    patch.status = this.encodeStatus();
    if (complete) {
      const checkpoint = this.checkpoint.encode(t);
      if (!checkpoint) {
        return;
      }
      patch.checkpoint = checkpoint;
      if (this.room.dirty) {
        patch.room = this.encodeRoom();
      }
      this.sinceCheckpoint = 0;
      this.checkpointMark = mark;
    }
    sess.patchShared(patch);
    this.room.dirty = false;
  }

  // Phase edges force a full checkpoint so a takeover never lands mid-transition.
  private currentCheckpointMark(): CheckpointMark {
    const phase = this.checkpoint.phase();
    const bought = this.room.merchantItems.filter((m) => m.bought).length;
    return {
      phase: phase.kind === "transition" && phase.built ? "transition-built" : phase.kind,
      progress: `${this.run.ownedRelics.size}:${bought}:${this.room.feature?.used ?? "-"}:${this.run.downed !== null}`,
      versus: this.run.match?.phase ?? null,
    };
  }

  private encodeSnapshot(t: number): Snapshot {
    const auth = this.seat.authority;
    const players = [encodePlayer(this.seat.player.body)];
    const acks: NetAck[] = [];
    const { remote } = this.seat;
    const copy = this.guestCopy();
    if (remote && this.seat.remoteId) {
      players.push(encodePlayer(remote.body));
      if (copy) {
        copy.enter(this.room.seq);
        acks.push(copy.report(1));
      }
    }
    const enemies = this.room.enemies.map((e) =>
      encodeEnemy(enemyId(this.room, e), {
        elapsed: e.body.stateT,
        flash: e.body.hitFlash > 0,
        flip: e.body.facing < 0,
        moving: Math.abs(e.body.vx) > 10,
        state: e.body.state,
        x: e.body.x,
        y: e.body.y,
      }),
    );
    const b = this.room.boss?.body;
    const proj: NetProjRow[] = [
      ...this.room.arrows.map((a) => projRow(a.id, "arrow", a)),
      ...this.room.shots.map((s) => projRow(s.id, "shot", s)),
      ...this.room.hazards.map((h) => projRow(h.id, "hazard", { ...h, vy: 0 })),
    ];
    return {
      acks,
      boss: b
        ? encodeBoss({
            elapsed: b.stateT,
            flash: b.hitFlash > 0,
            flip: b.facing < 0,
            hpFrac: b.hpFrac,
            moving: Math.abs(b.vx) > 12,
            state: b.state,
            telegraph: b.telegraphing,
            x: b.x,
            y: b.y,
          })
        : null,
      enemies,
      lastStand: this.run.downed
        ? {
            bleed: Math.round(this.run.downed.bleedT * 10) / 10,
            rev: Math.round((this.run.downed.reviveT / REVIVE_HOLD) * 100) / 100,
          }
        : null,
      players,
      proj,
      room: this.room.seq,
      run: auth.kind === "ready" ? runTag(auth.runId) : 0,
      t,
      term: auth.kind === "ready" ? auth.term : 0,
      vs: this.run.match ? this.run.match.encode() : null,
    };
  }

  // The HUD numbers: they move on kills, pickups and room changes, not ticks.
  private encodeStatus(): NetStatus {
    return {
      biome: this.run.match ? VS_BIOME : this.expedition.biome,
      cleared: this.run.cleared,
      depth: this.expedition.depth,
      gold: this.run.gold,
      hearts: this.run.hearts,
      maxHearts: this.run.maxHearts,
      over: this.run.state === "dead",
      score: this.run.score,
    };
  }

  // Who the snapshot rows are: changes only on a join, a hero pick or a spawn.
  private encodeCast(): NetCast {
    const players: NetCast["players"] = [
      [this.seat.session?.playerId ?? "host", this.seat.player.name],
    ];
    if (this.seat.remote && this.seat.remoteId) {
      players.push([this.seat.remoteId, this.seat.remote.name]);
    }
    return {
      enemies: this.room.enemies.map((e) => [enemyId(this.room, e), e.body.kind.name, e.baseTint]),
      players,
    };
  }

  private encodeRoom(): NetRoom {
    const doors: NetDoor[] = this.room.doors.map((d) => ({
      danger: false,
      index: d.index,
      label: ROOM_LABEL[d.type],
      type: d.type,
      x: d.x,
      y: d.y,
    }));
    const room: NetRoom = {
      cells: [...this.room.grid.cells],
      cols: this.room.grid.cols,
      doors,
      mode: this.seat.mode === "versus" ? "vs" : "coop",
      mustClear: this.run.mustClear,
      propKey: this.seat.mode === "versus" ? "" : (ROOM_PROPS.get(this.expedition.type)?.key ?? ""),
      rows: this.room.grid.rows,
      seq: this.room.seq,
      spawnX: this.room.roomSpawn.x,
      spawnY: this.room.roomSpawn.y,
      type: this.seat.mode === "versus" ? "combat" : this.expedition.type,
    };
    return room;
  }
}
