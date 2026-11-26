import type { Scene } from "phaser";

import type { HeroName } from "../data/animations";
import { HEROES } from "../data/heroes";
import { parseRoomType } from "../data/rooms";
import type { ExpeditionCheckpoint } from "../net/checkpoint";
import { parseHero } from "../net/parse";
import { NetSession } from "../net/session";
import { WIRE_VERSION } from "../net/snapshot";
import type { NetRoom } from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import { newRunState } from "../state/run-state";
import type { RunState } from "../state/run-state";
import { livePlayers } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { NEUTRAL_INPUT } from "../sys/input";
import type { Input } from "../sys/input";
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

const RECONNECTING = "RECONNECTING…";

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
  restartRequested: boolean;
}

/** What tools/two-client.mts reads of an online run, published each frame. */
export interface OnlineProbe {
  ax: number | null;
  conn: NetSession["connectionStatus"];
  dead: number;
  downed: number;
  entities: number;
  hearts: number;
  ls: boolean;
  mode: SeatState["mode"];
  paused: boolean;
  players: number;
  px: number;
  rSwing: number | null;
  role: SeatState["role"];
  rx: number | null;
  state: RunState["state"];
  swing: number;
  vs: RunState["matchNet"];
}

declare global {
  interface Window {
    __lf?: OnlineProbe;
  }
}

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
  private publishedHero: string | null = null;
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

  beginConnecting(party: string) {
    this.seat.role = "guest";
    this.run.state = "connecting";
    this.seat.player.sprite.setVisible(false);
    this.chrome.fadeRect.setAlpha(1);
    this.banners.show("CONNECTING…", 100_000, "connecting");
    this.seat.session = new NetSession({
      fallbackMs: 6000,
      maxPlayers: 2,
      onEvent: (event, payload, from) => {
        this.hostNet.receive(event, payload, from);
      },
      onShared: (state) => {
        this.guest.receive(state);
      },
      room: `lunerfall-v${WIRE_VERSION}-${this.seat.mode === "versus" ? "vs" : "coop"}-${party}`,
    });
  }

  updateSession() {
    if (!this.seat.session) {
      return true;
    }

    if (this.seat.session.roomFull) {
      this.scene.scene.start("select", { roomFull: true });

      return false;
    }

    const sample = this.hooks.sampleInput();
    const priorRun = this.seat.authority.kind === "ready" ? this.seat.authority.runId : null;
    const ready = this.prepareSession();
    const sameRun = this.seat.authority.kind === "ready" && this.seat.authority.runId === priorRun;
    this.seat.guestIn = ready && sameRun && !this.seat.controlsPaused ? sample : NEUTRAL_INPUT;

    if (!ready) {
      return false;
    }

    this.publishHero(this.seat.session);
    this.handleRestart();
    this.publishProbe(this.seat.session);

    return true;
  }

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

    window.__lf = {
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
    };
  }

  private publishHero(session: NetSession) {
    if (this.publishedHero === this.seat.requestedHero) {
      return;
    }

    this.publishedHero = this.seat.requestedHero;
    session.updateMyState({ hero: this.seat.requestedHero });
  }

  private finishConnecting() {
    this.seat.player.sprite.setVisible(true);
    this.chrome.fadeRect.setAlpha(0);
    this.run.state = "active";
  }

  prepareSession() {
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

        if (this.seat.role === "guest") {
          this.guest.dropQueued();
        } else {
          this.seat.player.body.clearInput();
        }

        this.seat.neutralOnAdmission = true;
      }

      this.wasConnected = false;

      if (sess.connectionStatus === "reconnecting") {
        this.banners.show(RECONNECTING, 100_000, "connecting");
      }

      return false;
    }

    this.wasConnected = true;
    this.banners.dismiss(RECONNECTING);

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

  private authorityCurrent(sess: NetSession) {
    const a = this.seat.authority;

    if (a.kind !== "ready" || a.revision !== sess.authorityRevision) {
      return false;
    }

    if (sess.isHost) {
      return this.seat.role === "host";
    }

    const read = this.checkpoint.accepted();

    return (
      this.seat.role === "guest" &&
      (read.kind !== "ready" || (a.runId === read.value.runId && a.term === read.value.term))
    );
  }

  private takeOverAsHost(sess: NetSession, c: ExpeditionCheckpoint, room: NetRoom) {
    const own =
      this.seat.role === "guest" && this.room.seq === c.room
        ? this.seat.player.body.checkpoint()
        : null;

    this.seat.role = "host";
    this.seat.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: c.runId,
      term: c.term + 1,
    };
    this.checkpoint.adopt(c, room, own);
    this.hostNet.admit();
    this.hostNet.syncRemotePresence();
    this.room.dirty = true;
    this.hostNet.broadcast(0, true);
  }

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
    this.guest.admit();
    const other = c.players.find((p) => p.id !== sess.playerId);

    if (other) {
      this.guest.ensureRemote(other.hero);
      this.seat.remoteId = other.id;
      this.seat.remote?.body.restore(other.body);
    }

    this.banners.clear();
    this.room.bossAnnounced = true;
    this.room.guest.snapT = c.t - 1;
    this.room.guest.payoff = { clearAt: null, cleared: c.cleared, room: c.room };
    this.run.downedNet = c.lastStand
      ? { bleed: c.lastStand.bleed, rev: c.lastStand.revive / REVIVE_HOLD }
      : null;

    if (c.mode === "versus") {
      const match = new VersusMatch();
      match.restore(c.versus);
      this.run.matchNet = match.encode();
    }

    this.run.score = c.score;
    this.guest.syncProgress(c);
    this.checkpoint.syncRoomFeatures(c, true);
    this.finishConnecting();
    this.hooks.updateHud();

    if (c.phase.kind === "dead") {
      this.checkpoint.observeTerminal(c);
    }

    this.versus.showAdoptedResult();
  }

  private beginExpedition() {
    const sess = this.seat.session;
    const myId = sess?.playerId;

    if (sess?.isHost !== true || myId === undefined || myId === null || myId === "") {
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

    this.buildOpeningRoom();
    this.finishConnecting();
    this.controls.reset();
    this.seat.guestIn = NEUTRAL_INPUT;
    this.restartRequested = false;
    this.room.dirty = true;
    this.hostNet.broadcast(0, true);
    this.hooks.updateHud();
  }

  private buildOpeningRoom() {
    if (this.seat.mode === "versus") {
      this.run.match = new VersusMatch();
      this.rooms.buildVersus();

      if (this.seat.remote) {
        this.run.match.beginMatch();
      }

      this.versus.respawn();

      return;
    }

    this.run.match = null;
    const param = new URLSearchParams(location.search).get("room");
    const rt = param !== null && param !== "" ? parseRoomType(param) : null;
    this.rooms.build(rt ? this.expedition.debugEnter(rt) : this.expedition.begin());
  }

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

  private resetExpedition() {
    this.checkpoint.adoptedTerminal = null;
    Object.assign(this.run, newRunState(), { state: this.run.state });
    this.room.seq = 0;
    this.room.enemyIds = new WeakMap();
    this.room.nextEnemyId = 1;
    this.seat.duelHits = new WeakMap();
    this.banners.clear();
  }

  private handleRestart() {
    const sess = this.seat.session;
    const auth = this.seat.authority;

    if (sess?.live !== true || auth.kind !== "ready" || this.seat.mode !== "coop") {
      return;
    }

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
