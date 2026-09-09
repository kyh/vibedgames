import { sfx } from "../audio/sfx";
import type { HeroName } from "../data/animations";
import { HEROES } from "../data/heroes";
import { ROOM_LABEL } from "../data/rooms";
import type { CheckpointPhase, InputSequence } from "../net/checkpoint";
import { parseHero, readNetInput } from "../net/parse";
import type {
  NetBoss,
  NetDoor,
  NetEnemy,
  NetPlayer,
  NetProj,
  NetRoom,
  NetVersus,
  Snapshot,
} from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";
import { VS_BIOME } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { CheckpointSync } from "./checkpoint-sync";
import { REVIVE_HOLD } from "./last-stand";
import type { LastStand } from "./last-stand";
import { ROOM_PROPS } from "./room-builder";
import type { SceneHooks } from "./scene-hooks";
import type { VersusFlow } from "./versus-flow";

// host snapshot broadcast rate
const NET_HZ = 30;
// full private state; takeover rewinds at most one 100 ms interval
const CHECKPOINT_HZ = 10;
interface CheckpointMark {
  phase: CheckpointPhase["kind"] | "transition-built";
  versus: NetVersus["phase"] | null;
}

export interface HostNetDeps {
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  lastStand: LastStand;
  versus: VersusFlow;
  checkpoint: CheckpointSync;
  hooks: SceneHooks;
}

// Host side of the wire: broadcasts snapshots (and the checkpoint + room at
// the slower rates), turns the guest's wire input into an edge-triggered
// InputState, and spawns/despawns the remote player as the peer comes and goes.
export class HostNet {
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly lastStand: LastStand;
  private readonly versus: VersusFlow;
  private readonly checkpoint: CheckpointSync;
  private readonly hooks: SceneHooks;
  // broadcast throttle
  private acc = 0;
  private checkpointAcc = 0;
  private checkpointMark: CheckpointMark | null = null;
  // last-seen remote press counters
  private inSeq = { a: 0, d: 0, j: 0, s: 0 };

  constructor(deps: HostNetDeps) {
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.lastStand = deps.lastStand;
    this.versus = deps.versus;
    this.checkpoint = deps.checkpoint;
    this.hooks = deps.hooks;
  }

  // Host: turn the guest's latest wire input into an edge-triggered InputState.
  readRemoteInput(): InputState {
    const other = this.seat.session?.otherPlayer() ?? null;
    const ni = readNetInput(other?.state?.input);
    const active =
      other !== null && other.connected !== false && other.state?.paused !== true && ni !== null;
    if (!other || !ni || !active) {
      this.dropRemoteInput(other);
      return NEUTRAL_INPUT;
    }
    const first = !this.seat.remoteInputOwner?.active || this.seat.remoteInputOwner.id !== other.id;
    const previous: InputSequence = first ? ni : this.inSeq;
    this.inSeq = { a: ni.a, d: ni.d, j: ni.j, s: ni.s };
    this.seat.remoteInputOwner = { active: true, id: other.id };
    return {
      attackPressed: ni.a > previous.a,
      dashPressed: ni.d > previous.d,
      down: ni.down,
      jumpHeld: ni.jumpHeld,
      jumpPressed: ni.j > previous.j,
      left: ni.left,
      right: ni.right,
      specialPressed: ni.s > previous.s,
      up: ni.up,
    };
  }

  // The guest is absent, paused or silent: release its held keys once, on the
  // edge, so a paused peer stops running rather than sliding on stale input.
  private dropRemoteInput(other: { id: string } | null) {
    if (
      this.seat.remoteInputOwner?.active !== false ||
      this.seat.remoteInputOwner?.id !== other?.id
    ) {
      this.seat.remote?.body.clearInput();
    }
    this.seat.remoteInputOwner = other ? { active: false, id: other.id } : null;
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
    // ghost until the server reaps it.
    const live = (id: string | null): boolean => sess.players[id ?? ""]?.connected !== false;
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
    this.seat.remoteInputOwner = null;
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
    this.seat.remoteInputOwner = null;
    if (this.run.match) {
      this.run.match.beginMatch();
      this.versus.respawn();
      this.banners.show("ROUND 1", 1100, "critical");
      sfx.door("local");
    } else {
      this.banners.show("PLAYER 2 JOINED", 1000, "status");
    }
  }

  // Host: broadcast a snapshot at the network rate.
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
    this.acc += dts;
    this.checkpointAcc += dts;
    if (!force && this.acc < 1 / NET_HZ) {
      return;
    }
    this.acc = 0;
    const mark = this.currentCheckpointMark();
    const changed =
      mark.phase !== this.checkpointMark?.phase || mark.versus !== this.checkpointMark?.versus;
    const complete =
      force || this.room.dirty || changed || this.checkpointAcc + 1e-9 >= 1 / CHECKPOINT_HZ;
    const snap = this.encodeSnapshot();
    if (complete) {
      const checkpoint = this.checkpoint.encode();
      if (!checkpoint) {
        return;
      }
      if (this.room.dirty) {
        sess.patchShared({ checkpoint, room: this.encodeRoom(), snap });
      } else {
        sess.patchShared({ checkpoint, snap });
      }
      this.checkpointAcc = 0;
      this.checkpointMark = mark;
    } else {
      sess.patchShared({ snap });
    }
    this.room.dirty = false;
  }

  // Phase edges force a full checkpoint so a takeover never lands mid-transition.
  private currentCheckpointMark(): CheckpointMark {
    const phase = this.checkpoint.phase();
    return {
      phase: phase.kind === "transition" && phase.built ? "transition-built" : phase.kind,
      versus: this.run.match?.phase ?? null,
    };
  }

  private encodeSnapshot(): Snapshot {
    this.run.tick += 1;
    const players: NetPlayer[] = [this.seat.player.encode(this.seat.session?.playerId ?? "host")];
    if (this.seat.remote && this.seat.remoteId) {
      players.push(this.seat.remote.encode(this.seat.remoteId));
    }
    const enemies: NetEnemy[] = this.room.enemies.map((e) => {
      let id = this.room.enemyIds.get(e);
      if (!id) {
        id = this.room.nextEnemyId;
        this.room.nextEnemyId += 1;
        this.room.enemyIds.set(e, id);
      }
      const { name } = e.body.kind;
      return {
        action: e.action(),
        clip: e.sprite.anims.currentAnim?.key ?? `${name}:idle`,
        dead: e.body.dead,
        flash: e.body.hitFlash > 0,
        flip: e.sprite.flipX,
        id,
        name,
        tint: e.baseTint,
        x: Math.round(e.body.x),
        y: Math.round(e.body.y),
      };
    });
    const boss: NetBoss | null = this.room.boss
      ? {
          action: this.room.boss.action(),
          clip: this.room.boss.sprite.anims.currentAnim?.key ?? "salamander:idle",
          dead: this.room.boss.body.dead,
          flash: this.room.boss.body.hitFlash > 0,
          flip: this.room.boss.sprite.flipX,
          hpFrac: this.room.boss.body.hpFrac,
          telegraph: this.room.boss.body.telegraphing,
          x: Math.round(this.room.boss.body.x),
          y: Math.round(this.room.boss.body.y),
        }
      : null;
    const proj: NetProj[] = [];
    for (const a of this.room.arrows) {
      proj.push({ k: "arrow", vx: a.vx, x: Math.round(a.x), y: Math.round(a.y) });
    }
    for (const s of this.room.shots) {
      proj.push({ k: "shot", vx: s.vx, x: Math.round(s.x), y: Math.round(s.y) });
    }
    for (const h of this.room.hazards) {
      proj.push({ k: "hazard", vx: h.vx, x: Math.round(h.x), y: Math.round(h.y) });
    }
    return {
      banner: "",
      biome: this.run.match ? VS_BIOME : this.expedition.biome,
      boss,
      cleared: this.run.cleared,
      depth: this.expedition.depth,
      enemies,
      gold: this.run.gold,
      hearts: this.run.hearts,
      lastStand: this.run.downed
        ? {
            bleed: Math.round(this.run.downed.bleedT * 10) / 10,
            rev: Math.round((this.run.downed.reviveT / REVIVE_HOLD) * 100) / 100,
          }
        : null,
      maxHearts: this.run.maxHearts,
      players,
      proj,
      room: this.room.seq,
      runId: this.seat.authority.kind === "ready" ? this.seat.authority.runId : "",
      t: this.run.tick,
      term: this.seat.authority.kind === "ready" ? this.seat.authority.term : 0,
      vs: this.run.match ? this.run.match.encode() : null,
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
