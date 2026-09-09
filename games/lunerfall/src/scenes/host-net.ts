import type { Scene } from "phaser";

import { sfx } from "../audio/sfx";
import type { HeroName } from "../data/animations";
import { HEROES } from "../data/heroes";
import { ROOM_LABEL } from "../data/rooms";
import type { Enemy } from "../entities/enemy";
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
import { NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";
import { VS_BIOME } from "../sys/versus";
import type { GameScene } from "./game-scene";
import { REVIVE_HOLD } from "./last-stand";
import { ROOM_PROPS } from "./room-builder";

// host snapshot broadcast rate
const NET_HZ = 30;
// full private state; takeover rewinds at most one 100 ms interval
const CHECKPOINT_HZ = 10;
interface CheckpointMark {
  phase: CheckpointPhase["kind"] | "transition-built";
  versus: NetVersus["phase"] | null;
}

type HostNetCtx = Scene &
  Pick<
    GameScene,
    | "arrows"
    | "authority"
    | "banners"
    | "boss"
    | "checkpoint"
    | "cleared"
    | "doors"
    | "enemies"
    | "gold"
    | "grid"
    | "hazards"
    | "hearts"
    | "lastStand"
    | "maxHearts"
    | "mode"
    | "mustClear"
    | "player"
    | "remote"
    | "remoteId"
    | "role"
    | "roomSpawn"
    | "run"
    | "seats"
    | "session"
    | "shots"
    | "spawnPlayer"
    | "state"
    | "updateHud"
    | "versus"
  >;

// Host side of the wire: broadcasts snapshots (and the checkpoint + room at
// the slower rates), turns the guest's wire input into an edge-triggered
// InputState, and spawns/despawns the remote player as the peer comes and goes.
export class HostNet {
  private readonly scene: HostNetCtx;
  // bumped per room, drives guest room rebuilds
  roomSeq = 0;
  roomDirty = false;
  // snapshot counter
  tick = 0;
  // broadcast throttle
  acc = 0;
  checkpointAcc = 0;
  checkpointMark: CheckpointMark | null = null;
  // stable wire id per enemy
  enemyId = new WeakMap<Enemy, number>();
  enemyIdNext = 1;
  // last-seen remote press counters
  private inSeq = { a: 0, d: 0, j: 0, s: 0 };
  remoteInputOwner: { id: string; active: boolean } | null = null;

  constructor(scene: HostNetCtx) {
    this.scene = scene;
  }

  // Host: turn the guest's latest wire input into an edge-triggered InputState.
  readRemoteInput(): InputState {
    const other = this.scene.session?.otherPlayer() ?? null;
    const ni = readNetInput(other?.state?.input);
    const active =
      other !== null && other.connected !== false && other.state?.paused !== true && ni !== null;
    if (!other || !ni || !active) {
      this.dropRemoteInput(other);
      return NEUTRAL_INPUT;
    }
    const first = !this.remoteInputOwner?.active || this.remoteInputOwner.id !== other.id;
    const previous: InputSequence = first ? ni : this.inSeq;
    this.inSeq = { a: ni.a, d: ni.d, j: ni.j, s: ni.s };
    this.remoteInputOwner = { active: true, id: other.id };
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
    if (this.remoteInputOwner?.active !== false || this.remoteInputOwner?.id !== other?.id) {
      this.scene.remote?.body.clearInput();
    }
    this.remoteInputOwner = other ? { active: false, id: other.id } : null;
  }

  // Seats are the ORIGINAL left/right slots and survive authority changes; a
  // newcomer takes the first free one.
  private claimSeat(id: string) {
    if (this.scene.seats.host === id || this.scene.seats.guest === id) {
      return;
    }
    if (this.scene.seats.host === null) {
      this.scene.seats.host = id;
    } else {
      this.scene.seats.guest = id;
    }
  }

  // Host: spawn / despawn the remote player as the other client joins or leaves.
  syncRemotePresence() {
    const sess = this.scene.session;
    const myId = sess?.playerId;
    if (!sess?.isHost || !myId || this.scene.state === "dead") {
      return;
    }
    // A peer parked in the reconnect grace window is listed but not playing:
    // treated as present it would hold a seat and freeze a duel against a
    // ghost until the server reaps it.
    const live = (id: string | null): boolean => sess.players[id ?? ""]?.connected !== false;
    const other = sess.otherPlayer();
    if (this.scene.seats.host && !live(this.scene.seats.host)) {
      this.scene.seats.host = null;
    }
    if (this.scene.seats.guest && !live(this.scene.seats.guest)) {
      this.scene.seats.guest = null;
    }
    this.claimSeat(myId);
    if (this.scene.remote && (!other || other.id !== this.scene.remoteId || !live(other.id))) {
      this.despawnRemote();
    }
    if (other && live(other.id) && !this.scene.remote) {
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
    if (this.scene.versus.match) {
      this.scene.versus.match.reset();
    } else if (this.scene.lastStand.live) {
      this.scene.lastStand.live = null;
      this.scene.lastStand.destroyUi();
      if (this.scene.player.body.downed) {
        this.scene.player.body.revive();
      }
      this.scene.hearts = Math.max(this.scene.hearts, 1);
    }
    this.scene.remote?.destroy();
    this.scene.remote = undefined;
    this.scene.remoteId = null;
    this.remoteInputOwner = null;
    if (this.scene.versus.match) {
      this.scene.versus.respawn();
    }
    this.scene.banners.show(
      this.scene.versus.match ? "CHALLENGER LEFT" : "PLAYER 2 LEFT",
      1600,
      "critical",
    );
    this.scene.updateHud();
  }

  private spawnRemote(id: string, hero: HeroName) {
    const index = this.scene.seats.host === id ? 0 : 1;
    const spawn =
      (this.scene.versus.match ? this.scene.versus.spawns[index] : undefined) ??
      this.scene.roomSpawn;
    this.scene.remote = this.scene.spawnPlayer(HEROES[hero], this.scene.grid, spawn.x, spawn.y);
    this.scene.remoteId = id;
    this.remoteInputOwner = null;
    if (this.scene.versus.match) {
      this.scene.versus.match.beginMatch();
      this.scene.versus.respawn();
      this.scene.banners.show("ROUND 1", 1100, "critical");
      sfx.door("local");
    } else {
      this.scene.banners.show("PLAYER 2 JOINED", 1000, "status");
    }
  }

  // Host: broadcast a snapshot at the network rate.
  broadcast(dts: number, force = false) {
    const sess = this.scene.session;
    if (
      !sess?.isHost ||
      sess.offline ||
      this.scene.role !== "host" ||
      this.scene.authority.kind !== "ready"
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
      force || this.roomDirty || changed || this.checkpointAcc + 1e-9 >= 1 / CHECKPOINT_HZ;
    const snap = this.encodeSnapshot();
    if (complete) {
      const checkpoint = this.scene.checkpoint.encode();
      if (!checkpoint) {
        return;
      }
      if (this.roomDirty) {
        sess.patchShared({ checkpoint, room: this.encodeRoom(), snap });
      } else {
        sess.patchShared({ checkpoint, snap });
      }
      this.checkpointAcc = 0;
      this.checkpointMark = mark;
    } else {
      sess.patchShared({ snap });
    }
    this.roomDirty = false;
  }

  // Phase edges force a full checkpoint so a takeover never lands mid-transition.
  private currentCheckpointMark(): CheckpointMark {
    const phase = this.scene.checkpoint.phase();
    return {
      phase: phase.kind === "transition" && phase.built ? "transition-built" : phase.kind,
      versus: this.scene.versus.match?.phase ?? null,
    };
  }

  private encodeSnapshot(): Snapshot {
    this.tick += 1;
    const players: NetPlayer[] = [this.scene.player.encode(this.scene.session?.playerId ?? "host")];
    if (this.scene.remote && this.scene.remoteId) {
      players.push(this.scene.remote.encode(this.scene.remoteId));
    }
    const enemies: NetEnemy[] = this.scene.enemies.map((e) => {
      let id = this.enemyId.get(e);
      if (!id) {
        id = this.enemyIdNext;
        this.enemyIdNext += 1;
        this.enemyId.set(e, id);
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
    const boss: NetBoss | null = this.scene.boss
      ? {
          action: this.scene.boss.action(),
          clip: this.scene.boss.sprite.anims.currentAnim?.key ?? "salamander:idle",
          dead: this.scene.boss.body.dead,
          flash: this.scene.boss.body.hitFlash > 0,
          flip: this.scene.boss.sprite.flipX,
          hpFrac: this.scene.boss.body.hpFrac,
          telegraph: this.scene.boss.body.telegraphing,
          x: Math.round(this.scene.boss.body.x),
          y: Math.round(this.scene.boss.body.y),
        }
      : null;
    const proj: NetProj[] = [];
    for (const a of this.scene.arrows) {
      proj.push({ k: "arrow", vx: a.vx, x: Math.round(a.x), y: Math.round(a.y) });
    }
    for (const s of this.scene.shots) {
      proj.push({ k: "shot", vx: s.vx, x: Math.round(s.x), y: Math.round(s.y) });
    }
    for (const h of this.scene.hazards) {
      proj.push({ k: "hazard", vx: h.vx, x: Math.round(h.x), y: Math.round(h.y) });
    }
    return {
      banner: "",
      biome: this.scene.versus.match ? VS_BIOME : this.scene.run.biome,
      boss,
      cleared: this.scene.cleared,
      depth: this.scene.run.depth,
      enemies,
      gold: this.scene.gold,
      hearts: this.scene.hearts,
      lastStand: this.scene.lastStand.live
        ? {
            bleed: Math.round(this.scene.lastStand.live.bleedT * 10) / 10,
            rev: Math.round((this.scene.lastStand.live.reviveT / REVIVE_HOLD) * 100) / 100,
          }
        : null,
      maxHearts: this.scene.maxHearts,
      players,
      proj,
      room: this.roomSeq,
      runId: this.scene.authority.kind === "ready" ? this.scene.authority.runId : "",
      t: this.tick,
      term: this.scene.authority.kind === "ready" ? this.scene.authority.term : 0,
      vs: this.scene.versus.match ? this.scene.versus.match.encode() : null,
    };
  }

  private encodeRoom(): NetRoom {
    const doors: NetDoor[] = this.scene.doors.map((d) => ({
      danger: false,
      index: d.index,
      label: ROOM_LABEL[d.type],
      type: d.type,
      x: d.x,
      y: d.y,
    }));
    const room: NetRoom = {
      cells: [...this.scene.grid.cells],
      cols: this.scene.grid.cols,
      doors,
      mode: this.scene.mode === "versus" ? "vs" : "coop",
      mustClear: this.scene.mustClear,
      propKey: this.scene.mode === "versus" ? "" : (ROOM_PROPS.get(this.scene.run.type)?.key ?? ""),
      rows: this.scene.grid.rows,
      seq: this.roomSeq,
      spawnX: this.scene.roomSpawn.x,
      spawnY: this.scene.roomSpawn.y,
      type: this.scene.mode === "versus" ? "combat" : this.scene.run.type,
    };
    return room;
  }
}
