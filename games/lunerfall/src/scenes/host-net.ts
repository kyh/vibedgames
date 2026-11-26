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

const NET_HZ = 30;
const CHECKPOINT_MS = 1000;

interface CheckpointMark {
  phase: CheckpointPhase["kind"] | "transition-built";
  versus: NetVersus["phase"] | null;
  progress: string;
}

const projRow: (
  id: number,
  kind: ProjKind,
  p: { x: number; y: number; vx: number; vy: number },
) => NetProjRow = (id, kind, p) => [
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

  private guestCopy() {
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

  /** This tab took the authority, or got it back after its own connection
   * dropped: the guest's input reaches it by a new route. */
  admit() {
    this.copy?.relearn();
  }

  /** A peer's event, as it lands. Only the remote player's `in` (input
   * ticks) concerns the host. */
  receive(event: string, payload: JsonValue, from: string) {
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
  stepGuest(now: number) {
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
  drainGuest() {
    const { remote } = this.seat;

    if (remote) {
      this.guestCopy()?.drain(remote.body);
    }
  }

  /** The guest pressed attack since the last frame (versus rematch). Ask every
   * frame so a press from mid-fight never lingers into the match end. */
  takeRematch() {
    return this.guestCopy()?.takeRematch() ?? false;
  }

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

  syncRemotePresence() {
    const sess = this.seat.session;
    const myId = sess?.playerId;

    if (
      sess?.isHost !== true ||
      myId === undefined ||
      myId === null ||
      myId === "" ||
      this.run.state === "dead"
    ) {
      return;
    }

    const live = (id: string | null) => {
      const p = id === null ? undefined : sess.players[id];

      return p !== undefined && p.connected !== false;
    };

    const other = sess.otherPlayer();

    this.vacateSeat("host", live);
    this.vacateSeat("guest", live);

    this.claimSeat(myId);

    if (this.seat.remote && (!other || other.id !== this.seat.remoteId || !live(other.id))) {
      this.despawnRemote();
    }

    if (other && live(other.id) && !this.seat.remote) {
      const hero = parseHero(other.state?.hero);

      if (!hero) {
        return;
      }

      this.claimSeat(other.id);
      this.spawnRemote(other.id, hero);
    }
  }

  private vacateSeat(seat: "host" | "guest", live: (id: string) => boolean) {
    const id = this.seat.seats[seat];

    if (id !== null && id !== "" && !live(id)) {
      this.seat.seats[seat] = null;
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
    this.guestCopy()?.relearn();

    if (this.run.match) {
      this.run.match.beginMatch();
      this.versus.respawn();
      this.banners.show("ROUND 1", 1100, "critical");
      sfx.door("local");
    } else {
      this.banners.show("PLAYER 2 JOINED", 1000, "status");
    }
  }

  broadcast(dts: number, force = false) {
    const sess = this.seat.session;

    if (
      sess?.isHost !== true ||
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
    const t = Math.max(this.lastStamp + 1, Math.round(sess.serverNow()));
    this.lastStamp = t;
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

  private currentCheckpointMark() {
    const phase = this.checkpoint.phase();
    const bought = this.room.merchantItems.filter((m) => m.bought).length;

    return {
      phase: phase.kind === "transition" && phase.built ? "transition-built" : phase.kind,
      progress: `${this.run.ownedRelics.size}:${bought}:${this.room.feature?.used ?? "-"}:${this.run.downed !== null}`,
      versus: this.run.match?.phase ?? null,
    } satisfies CheckpointMark;
  }

  private encodeSnapshot(t: number) {
    const auth = this.seat.authority;
    const players = [encodePlayer(this.seat.player.body)];
    const acks: NetAck[] = [];
    const { remote } = this.seat;
    const copy = this.guestCopy();

    if (remote && this.seat.remoteId !== null && this.seat.remoteId !== "") {
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
    } satisfies Snapshot;
  }

  private encodeStatus() {
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

  private encodeCast() {
    const players: NetCast["players"] = [
      [this.seat.session?.playerId ?? "host", this.seat.player.name],
    ];

    if (this.seat.remote && this.seat.remoteId !== null && this.seat.remoteId !== "") {
      players.push([this.seat.remoteId, this.seat.remote.name]);
    }

    return {
      enemies: this.room.enemies.map((e) => [enemyId(this.room, e), e.body.kind.name, e.baseTint]),
      players,
    } satisfies NetCast;
  }

  private encodeRoom() {
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
