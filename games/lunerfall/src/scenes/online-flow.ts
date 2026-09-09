import type { Scene } from "phaser";

import type { HeroName } from "../data/animations";
import { HEROES } from "../data/heroes";
import { parseRoomType } from "../data/rooms";
import type { ExpeditionCheckpoint } from "../net/checkpoint";
import { parseHero } from "../net/parse";
import { NetSession } from "../net/session";
import type { NetInput, NetRoom } from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import { newRunState } from "../state/run-state";
import type { RunState } from "../state/run-state";
import { livePlayers } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { NEUTRAL_INPUT } from "../sys/input";
import type { Input, InputState } from "../sys/input";
import { checkpointRng } from "../sys/rng";
import { VersusMatch } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { CheckpointSync } from "./checkpoint-sync";
import type { GuestSync } from "./guest-sync";
import type { HostNet } from "./host-net";
import { REVIVE_HOLD } from "./last-stand";
import type { RoomBuilder } from "./room-builder";
import type { SceneChrome, SceneHooks } from "./scene-hooks";
import type { VersusFlow } from "./versus-flow";

export interface OnlineFlowDeps {
  scene: Scene;
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  checkpoint: CheckpointSync;
  guest: GuestSync;
  hostNet: HostNet;
  rooms: RoomBuilder;
  versus: VersusFlow;
  chrome: SceneChrome;
  controls: Input;
  hooks: SceneHooks;
  // the hub asked to restart the terminal expedition it showed
  restartRequested: boolean;
}

// Connection lifecycle and authority: joins the party room, drains the frame's
// input up the wire, resolves who is host or guest (initial election, takeover,
// (re)admission), and begins or restarts the shared expedition.
export class OnlineFlow {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly checkpoint: CheckpointSync;
  private readonly guest: GuestSync;
  private readonly hostNet: HostNet;
  private readonly rooms: RoomBuilder;
  private readonly versus: VersusFlow;
  private readonly chrome: SceneChrome;
  private readonly controls: Input;
  private readonly hooks: SceneHooks;
  // my press counters (sent to host)
  private readonly outSeq = { a: 0, d: 0, j: 0, s: 0 };
  private wasConnected = false;
  private seenDisconnect = 0;
  private restartRequested: boolean;
  private restartSentFor: string | null = null;

  constructor(deps: OnlineFlowDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.checkpoint = deps.checkpoint;
    this.guest = deps.guest;
    this.hostNet = deps.hostNet;
    this.rooms = deps.rooms;
    this.versus = deps.versus;
    this.chrome = deps.chrome;
    this.controls = deps.controls;
    this.hooks = deps.hooks;
    this.restartRequested = deps.restartRequested;
  }

  // Co-op: connect, then let update() resolve host vs guest. The placeholder
  // body stays hidden until the real room arrives — once the host begins the
  // run (host) or the first room snapshot lands (guest).
  beginConnecting(party: string) {
    // provisional until the connection reports host
    this.seat.role = "guest";
    this.run.state = "connecting";
    this.seat.player.sprite.setVisible(false);
    this.chrome.fadeRect.setAlpha(1);
    this.banners.show("CONNECTING…", 100_000, "connecting");
    this.seat.session = new NetSession({
      fallbackMs: 6000,
      maxPlayers: 2,
      room: `lunerfall-${this.seat.mode === "versus" ? "vs" : "coop"}-${party}`,
    });
  }

  // Online: tick the socket, drain this frame's input and resolve authority.
  // Returns false when the frame must stop here (room full, session not ready).
  updateSession(): boolean {
    if (!this.seat.session) {
      return true;
    }
    this.seat.session.tick();
    if (this.seat.session.roomFull) {
      this.scene.scene.start("select", { roomFull: true });
      return false;
    }
    // Drain input even while disconnected. A single sample serves authority,
    // prediction and uplink; old presses never queue behind reconnection.
    const sample = this.hooks.sampleInput();
    const priorRun = this.seat.authority.kind === "ready" ? this.seat.authority.runId : null;
    const ready = this.prepareSession();
    const sameRun = this.seat.authority.kind === "ready" && this.seat.authority.runId === priorRun;
    this.seat.guestIn = ready && sameRun && !this.seat.controlsPaused ? sample : NEUTRAL_INPUT;
    if (ready) {
      this.sendInput(this.seat.guestIn);
    }
    if (!ready) {
      return false;
    }
    this.handleRestart();
    this.publishProbe(this.seat.session);
    return true;
  }

  // Headless co-op probe (no casts): read via globalThis.__lf in tests.
  private publishProbe(session: NetSession) {
    const guest = this.seat.role === "guest";
    const myId = session.playerId;
    const vsProbe = guest ? this.run.matchNet : (this.run.match?.encode() ?? null);
    let ax: number | null = null;
    if (guest) {
      ax = Math.round(this.room.guest.players.find((p) => p.id === myId)?.x ?? -1);
    }
    const rSwing = guest
      ? (this.room.guest.players.find((p) => p.id !== myId)?.swingId ?? null)
      : (this.seat.remote?.body.swingId ?? null);
    Reflect.set(globalThis, "__lf", {
      ax,
      conn: session.connectionStatus,
      dead: livePlayers(this.seat).filter((p) => p.body.dead).length,
      downed: livePlayers(this.seat).filter((p) => p.body.downed).length,
      entities: this.room.enemies.length + this.room.guest.enemyPuppets.size,
      hearts: this.run.hearts,
      ls: guest ? this.run.downedNet !== null : this.run.downed !== null,
      mode: this.seat.mode,
      paused: this.seat.controlsPaused,
      players: livePlayers(this.seat).length,
      px: Math.round(this.seat.player.x),
      rSwing,
      role: this.seat.role,
      rx: this.seat.remote ? Math.round(this.seat.remote.x) : null,
      state: this.run.state,
      swing: this.seat.player.body.swingId,
      vs: vsProbe,
    });
  }

  // Stream my held input + monotonic press counters up to the host. The caller
  // passes the frame's single input sample (also fed to local prediction).
  sendInput(s: InputState) {
    if (!this.seat.session?.live) {
      return;
    }
    if (s.jumpPressed) {
      this.outSeq.j += 1;
    }
    if (s.dashPressed) {
      this.outSeq.d += 1;
    }
    if (s.attackPressed) {
      this.outSeq.a += 1;
    }
    if (s.specialPressed) {
      this.outSeq.s += 1;
    }
    const input: NetInput = {
      a: this.outSeq.a,
      d: this.outSeq.d,
      down: s.down,
      j: this.outSeq.j,
      jumpHeld: s.jumpHeld,
      left: s.left,
      right: s.right,
      s: this.outSeq.s,
      up: s.up,
    };
    this.seat.session.updateMyState({
      hero: this.seat.requestedHero,
      input,
      paused: this.seat.controlsPaused,
    });
  }

  private finishConnecting() {
    this.seat.player.sprite.setVisible(true);
    this.chrome.fadeRect.setAlpha(0);
    this.run.state = "active";
  }

  prepareSession(): boolean {
    const sess = this.seat.session;
    if (!sess) {
      return true;
    }
    if (this.seenDisconnect !== sess.disconnectRevision) {
      this.seenDisconnect = sess.disconnectRevision;
      this.seat.neutralOnAdmission = true;
    }
    if (!sess.live) {
      if (this.wasConnected) {
        this.controls.reset();
        this.seat.player.body.clearInput();
        this.seat.remote?.body.clearInput();
        this.seat.neutralOnAdmission = true;
      }
      this.wasConnected = false;
      return false;
    }
    this.wasConnected = true;
    if (sess.offline) {
      if (this.run.state === "connecting") {
        this.beginExpedition();
      }
      return true;
    }
    if (this.authorityCurrent(sess)) {
      return true;
    }
    const read = this.checkpoint.accepted();
    if (read.kind === "absent" && sess.isHost) {
      this.beginExpedition();
      return true;
    }
    if (read.kind !== "ready") {
      return false;
    }
    if (sess.isHost) {
      this.takeOverAsHost(sess, read.value, read.room);
    } else {
      this.adoptAsGuest(sess, read.value, read.room);
    }
    return true;
  }

  // Already following the current authority revision in the role it implies.
  private authorityCurrent(sess: NetSession): boolean {
    const a = this.seat.authority;
    if (a.kind !== "ready" || a.revision !== sess.authorityRevision) {
      return false;
    }
    if (sess.isHost) {
      return this.seat.role === "host";
    }
    const read = this.checkpoint.accepted();
    return (
      read.kind === "ready" &&
      a.runId === read.value.runId &&
      a.term === read.value.term &&
      this.seat.role === "guest"
    );
  }

  // Newly elected host: adopt the checkpoint under a fresh term and broadcast.
  private takeOverAsHost(sess: NetSession, c: ExpeditionCheckpoint, room: NetRoom) {
    this.seat.role = "host";
    this.seat.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: c.runId,
      term: c.term + 1,
    };
    this.checkpoint.adopt(c, room);
    this.hostNet.syncRemotePresence();
    this.room.dirty = true;
    this.hostNet.broadcast(0, true);
  }

  // Guest (re)admission: rebuild the room and both bodies from the checkpoint.
  private adoptAsGuest(sess: NetSession, c: ExpeditionCheckpoint, room: NetRoom) {
    this.seat.role = "guest";
    this.seat.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: c.runId,
      term: c.term,
    };
    this.seat.mode = c.mode;
    this.seat.seats = { ...c.seats };
    this.expedition.biome = c.run.biome;
    this.expedition.depth = c.run.depth;
    this.expedition.type = c.run.type;
    this.rooms.buildFromNet(room, c.run.biome);
    const me = c.players.find((p) => p.id === sess.playerId);
    if (me && me.hero !== this.seat.heroName) {
      this.seat.player.destroy();
      this.seat.heroName = me.hero;
      this.seat.player = this.hooks.spawnPlayer(
        HEROES[me.hero],
        this.room.grid,
        me.body.x,
        me.body.y,
      );
      this.rooms.setupCamera();
    }
    if (me) {
      this.seat.player.body.restore(me.body);
    }
    if (this.seat.controlsPaused || this.seat.neutralOnAdmission) {
      this.seat.player.body.clearInput();
    }
    this.seat.neutralOnAdmission = false;
    this.room.guest.selfHurting = this.seat.player.body.hurting;
    const other = c.players.find((p) => p.id !== sess.playerId);
    if (other) {
      this.guest.ensureRemote(other.hero);
      this.seat.remoteId = other.id;
      this.seat.remote?.body.restore(other.body);
    }
    this.banners.clear();
    this.room.bossAnnounced = true;
    this.room.guest.snapT = -1;
    this.room.guest.payoff = {
      bossAlive: c.boss !== null && !c.boss.dead,
      cleared: c.cleared,
      room: c.room,
      t: c.tick,
    };
    this.run.downedNet = c.lastStand
      ? { bleed: c.lastStand.bleed, rev: c.lastStand.revive / REVIVE_HOLD }
      : null;
    if (c.mode === "versus") {
      const match = new VersusMatch();
      match.restore(c.versus);
      this.run.matchNet = match.encode();
    }
    this.guest.syncProgress(c);
    this.checkpoint.syncRoomFeatures(c, true);
    this.finishConnecting();
    this.hooks.updateHud();
    if (c.phase.kind === "dead") {
      this.checkpoint.observeTerminal(c);
    }
    this.versus.showAdoptedResult();
  }

  /** Empty room or an explicit request for the exact terminal expedition. */
  private beginExpedition(): void {
    const sess = this.seat.session;
    const myId = sess?.playerId;
    if (!sess?.isHost || !myId) {
      return;
    }
    if (!sess.offline) {
      checkpointRng();
    }
    this.seat.role = "host";
    this.seat.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: `${myId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      term: 0,
    };
    const other = sess.otherPlayer();
    const otherHero = parseHero(other?.state?.hero);
    this.assignSeats(myId, other && otherHero ? other.id : null);
    this.resetExpedition();
    const selfHero = parseHero(sess.players[myId]?.state?.hero) ?? this.seat.heroName;
    this.respawnBodies(selfHero, other && otherHero ? { hero: otherHero, id: other.id } : null);
    if (this.seat.mode === "versus") {
      this.run.match = new VersusMatch();
      this.rooms.buildVersus();
      if (this.seat.remote) {
        this.run.match.beginMatch();
      }
      this.versus.respawn();
    } else {
      this.run.match = null;
      const param = new URLSearchParams(location.search).get("room");
      const rt = param ? parseRoomType(param) : null;
      this.rooms.build(rt ? this.expedition.debugEnter(rt) : this.expedition.begin());
    }
    this.finishConnecting();
    this.controls.reset();
    this.seat.guestIn = NEUTRAL_INPUT;
    this.restartRequested = false;
    this.room.dirty = true;
    this.hostNet.broadcast(0, true);
    this.hooks.updateHud();
  }

  // Both bodies are rebuilt from the hub picks at the run's spawn.
  private respawnBodies(selfHero: HeroName, other: { hero: HeroName; id: string } | null) {
    this.seat.player.destroy();
    this.seat.heroName = selfHero;
    this.seat.player = this.hooks.spawnPlayer(
      HEROES[selfHero],
      this.room.grid,
      this.room.roomSpawn.x,
      this.room.roomSpawn.y,
    );
    this.seat.remote?.destroy();
    this.seat.remote = undefined;
    this.seat.remoteId = null;
    if (other) {
      this.seat.remote = this.hooks.spawnPlayer(
        HEROES[other.hero],
        this.room.grid,
        this.room.roomSpawn.x,
        this.room.roomSpawn.y,
      );
      this.seat.remoteId = other.id;
    }
  }

  // Reuse existing side identities when their seats are still held; the other
  // seat goes to the peer (if it has picked a hero) or is vacated.
  private assignSeats(myId: string, otherId: string | null) {
    if (this.seat.seats.host !== myId && this.seat.seats.guest !== myId) {
      this.seat.seats.host = myId;
    }
    if (this.seat.seats.host === myId) {
      this.seat.seats.guest = otherId;
    } else {
      this.seat.seats.host = otherId;
    }
  }

  // Fresh expedition state for a new online run (the scene itself persists).
  // The phase is kept: it flips to active once the first room is built.
  private resetExpedition() {
    this.checkpoint.adoptedTerminal = null;
    Object.assign(this.run, newRunState(), { state: this.run.state });
    this.room.seq = 0;
    this.room.enemyIds = new WeakMap();
    this.room.nextEnemyId = 1;
    this.seat.duelHits = new WeakMap();
    this.seat.remoteInputOwner = null;
    this.banners.clear();
  }

  private handleRestart(): void {
    const sess = this.seat.session;
    const auth = this.seat.authority;
    if (!sess?.live || auth.kind !== "ready" || this.seat.mode !== "coop") {
      return;
    }
    // The hub's restart targets the terminal run it showed; adopting a live
    // run makes it moot, and a stale request would silently skip the next
    // death's recap and restart the expedition under both players.
    if (this.restartRequested && this.run.state !== "dead") {
      this.restartRequested = false;
    }
    if (this.restartRequested && this.run.state === "dead" && this.restartSentFor !== auth.runId) {
      this.restartSentFor = auth.runId;
      this.restartRequested = false;
      sess.updateMyState({ restartFor: auth.runId });
    }
    if (!sess.isHost || this.run.state !== "dead") {
      return;
    }
    if (
      Object.values(sess.players).some(
        (p) => p.connected !== false && p.state?.restartFor === auth.runId,
      )
    ) {
      this.beginExpedition();
    }
  }
}
