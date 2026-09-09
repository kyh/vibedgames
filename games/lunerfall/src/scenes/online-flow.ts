import type { Scene } from "phaser";

import { BASE_H, BASE_W } from "../config";
import type { HeroName } from "../data/animations";
import { HEROES } from "../data/heroes";
import { loadMeta, runBonuses } from "../data/meta";
import { baseMods } from "../data/relics";
import { parseRoomType } from "../data/rooms";
import type { ExpeditionCheckpoint } from "../net/checkpoint";
import { parseHero } from "../net/parse";
import { NetSession } from "../net/session";
import type { NetInput, NetRoom } from "../net/snapshot";
import { Grid } from "../sys/grid";
import { NEUTRAL_INPUT } from "../sys/input";
import type { InputState } from "../sys/input";
import { checkpointRng } from "../sys/rng";
import { RunManager } from "../sys/run";
import { VersusMatch } from "../sys/versus";
import type { GameScene } from "./game-scene";
import { REVIVE_HOLD } from "./last-stand";

type OnlineCtx = Scene &
  Pick<
    GameScene,
    | "acc"
    | "authority"
    | "banners"
    | "checkpoint"
    | "combo"
    | "comboT"
    | "controls"
    | "controlsPaused"
    | "deadT"
    | "demo"
    | "demoInput"
    | "enemies"
    | "fadeRect"
    | "freeze"
    | "gold"
    | "grid"
    | "guest"
    | "guestIn"
    | "hearts"
    | "heroName"
    | "hostNet"
    | "lastStand"
    | "livePlayers"
    | "maxHearts"
    | "mode"
    | "mods"
    | "neutralOnAdmission"
    | "ownedRelics"
    | "pendingOffer"
    | "player"
    | "progress"
    | "remote"
    | "remoteId"
    | "requestedHero"
    | "role"
    | "roomSpawn"
    | "rooms"
    | "run"
    | "runRecap"
    | "score"
    | "seats"
    | "session"
    | "spawnPlayer"
    | "state"
    | "transBuilt"
    | "transT"
    | "updateHud"
    | "versus"
  >;

// Connection lifecycle and authority: joins the party room, drains the frame's
// input up the wire, resolves who is host or guest (initial election, takeover,
// (re)admission), and begins or restarts the shared expedition.
export class OnlineFlow {
  private readonly scene: OnlineCtx;
  // my press counters (sent to host)
  outSeq = { a: 0, d: 0, j: 0, s: 0 };
  wasConnected = false;
  seenDisconnect = 0;
  restartRequested = false;
  restartSentFor: string | null = null;

  constructor(scene: OnlineCtx) {
    this.scene = scene;
  }

  // Co-op: connect, then let update() resolve host vs guest. The player spawns
  // on an empty grid so it's always defined; the real room arrives once the
  // host begins the run (host) or the first room snapshot lands (guest).
  beginConnecting(party: string) {
    // provisional until the connection reports host
    this.scene.role = "guest";
    this.scene.state = "connecting";
    this.scene.player = this.scene.spawnPlayer(
      HEROES[this.scene.heroName],
      new Grid(),
      BASE_W / 2,
      BASE_H / 2,
    );
    this.scene.player.sprite.setVisible(false);
    this.scene.fadeRect.setAlpha(1);
    this.scene.banners.show("CONNECTING…", 100_000, "connecting");
    this.scene.session = new NetSession({
      fallbackMs: 6000,
      maxPlayers: 2,
      room: `lunerfall-${this.scene.mode === "versus" ? "vs" : "coop"}-${party}`,
    });
  }

  // Online: tick the socket, drain this frame's input and resolve authority.
  // Returns false when the frame must stop here (room full, session not ready).
  updateSession(): boolean {
    if (!this.scene.session) {
      return true;
    }
    this.scene.session.tick();
    if (this.scene.session.roomFull) {
      this.scene.scene.start("select", { roomFull: true });
      return false;
    }
    // Drain input even while disconnected. A single sample serves authority,
    // prediction and uplink; old presses never queue behind reconnection.
    const sample = this.scene.demo ? this.scene.demoInput() : this.scene.controls.sample();
    const priorRun = this.scene.authority.kind === "ready" ? this.scene.authority.runId : null;
    const ready = this.prepareSession();
    const sameRun =
      this.scene.authority.kind === "ready" && this.scene.authority.runId === priorRun;
    this.scene.guestIn = ready && sameRun && !this.scene.controlsPaused ? sample : NEUTRAL_INPUT;
    if (ready) {
      this.sendInput(this.scene.guestIn);
    }
    if (!ready) {
      return false;
    }
    this.handleRestart();
    this.publishProbe(this.scene.session);
    return true;
  }

  // Headless co-op probe (no casts): read via globalThis.__lf in tests.
  private publishProbe(session: NetSession) {
    const guest = this.scene.role === "guest";
    const myId = session.playerId;
    const vsProbe = guest ? this.scene.versus.net : (this.scene.versus.match?.encode() ?? null);
    let ax: number | null = null;
    if (guest) {
      ax = Math.round(this.scene.guest.players.find((p) => p.id === myId)?.x ?? -1);
    }
    const rSwing = guest
      ? (this.scene.guest.players.find((p) => p.id !== myId)?.swingId ?? null)
      : (this.scene.remote?.body.swingId ?? null);
    Reflect.set(globalThis, "__lf", {
      ax,
      conn: session.connectionStatus,
      dead: this.scene.livePlayers().filter((p) => p.body.dead).length,
      downed: this.scene.livePlayers().filter((p) => p.body.downed).length,
      entities: this.scene.enemies.length + this.scene.guest.enemyPuppets.size,
      hearts: this.scene.hearts,
      ls: guest ? this.scene.lastStand.net !== null : this.scene.lastStand.live !== null,
      mode: this.scene.mode,
      paused: this.scene.controlsPaused,
      players: this.scene.livePlayers().length,
      px: Math.round(this.scene.player.x),
      rSwing,
      role: this.scene.role,
      rx: this.scene.remote ? Math.round(this.scene.remote.x) : null,
      state: this.scene.state,
      swing: this.scene.player.body.swingId,
      vs: vsProbe,
    });
  }

  // Stream my held input + monotonic press counters up to the host. The caller
  // passes the frame's single input sample (also fed to local prediction).
  sendInput(s: InputState) {
    if (!this.scene.session?.live) {
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
    this.scene.session.updateMyState({
      hero: this.scene.requestedHero,
      input,
      paused: this.scene.controlsPaused,
    });
  }

  private finishConnecting() {
    this.scene.player.sprite.setVisible(true);
    this.scene.fadeRect.setAlpha(0);
    this.scene.state = "active";
  }

  prepareSession(): boolean {
    const sess = this.scene.session;
    if (!sess) {
      return true;
    }
    if (this.seenDisconnect !== sess.disconnectRevision) {
      this.seenDisconnect = sess.disconnectRevision;
      this.scene.neutralOnAdmission = true;
    }
    if (!sess.live) {
      if (this.wasConnected) {
        this.scene.controls.reset();
        this.scene.player.body.clearInput();
        this.scene.remote?.body.clearInput();
        this.scene.neutralOnAdmission = true;
      }
      this.wasConnected = false;
      return false;
    }
    this.wasConnected = true;
    if (sess.offline) {
      if (this.scene.state === "connecting") {
        this.beginExpedition();
      }
      return true;
    }
    if (this.authorityCurrent(sess)) {
      return true;
    }
    const read = this.scene.checkpoint.accepted();
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
    const a = this.scene.authority;
    if (a.kind !== "ready" || a.revision !== sess.authorityRevision) {
      return false;
    }
    if (sess.isHost) {
      return this.scene.role === "host";
    }
    const read = this.scene.checkpoint.accepted();
    return (
      read.kind === "ready" &&
      a.runId === read.value.runId &&
      a.term === read.value.term &&
      this.scene.role === "guest"
    );
  }

  // Newly elected host: adopt the checkpoint under a fresh term and broadcast.
  private takeOverAsHost(sess: NetSession, c: ExpeditionCheckpoint, room: NetRoom) {
    this.scene.role = "host";
    this.scene.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: c.runId,
      term: c.term + 1,
    };
    this.scene.checkpoint.adopt(c, room);
    this.scene.hostNet.syncRemotePresence();
    this.scene.hostNet.roomDirty = true;
    this.scene.hostNet.broadcast(0, true);
  }

  // Guest (re)admission: rebuild the room and both bodies from the checkpoint.
  private adoptAsGuest(sess: NetSession, c: ExpeditionCheckpoint, room: NetRoom) {
    this.scene.role = "guest";
    this.scene.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: c.runId,
      term: c.term,
    };
    this.scene.mode = c.mode;
    this.scene.seats = { ...c.seats };
    this.scene.guest.biome = c.run.biome;
    this.scene.guest.depth = c.run.depth;
    this.scene.run.type = c.run.type;
    this.scene.rooms.buildFromNet(room);
    const me = c.players.find((p) => p.id === sess.playerId);
    if (me && me.hero !== this.scene.heroName) {
      this.scene.player.destroy();
      this.scene.heroName = me.hero;
      this.scene.player = this.scene.spawnPlayer(
        HEROES[me.hero],
        this.scene.grid,
        me.body.x,
        me.body.y,
      );
      this.scene.rooms.setupCamera();
    }
    if (me) {
      this.scene.player.body.restore(me.body);
    }
    if (this.scene.controlsPaused || this.scene.neutralOnAdmission) {
      this.scene.player.body.clearInput();
    }
    this.scene.neutralOnAdmission = false;
    this.scene.guest.selfHurting = this.scene.player.body.hurting;
    const other = c.players.find((p) => p.id !== sess.playerId);
    if (other) {
      this.scene.guest.ensureRemote(other.hero);
      this.scene.remoteId = other.id;
      this.scene.remote?.body.restore(other.body);
    }
    this.scene.banners.clear();
    this.scene.progress.bossAnnounced = true;
    this.scene.guest.snapT = -1;
    this.scene.guest.payoff = {
      bossAlive: c.boss !== null && !c.boss.dead,
      cleared: c.cleared,
      room: c.room,
      t: c.tick,
    };
    this.scene.lastStand.net = c.lastStand
      ? { bleed: c.lastStand.bleed, rev: c.lastStand.revive / REVIVE_HOLD }
      : null;
    if (c.mode === "versus") {
      const match = new VersusMatch();
      match.restore(c.versus);
      this.scene.versus.net = match.encode();
    }
    this.scene.guest.syncProgress(c);
    this.scene.checkpoint.syncRoomFeatures(c, true);
    this.finishConnecting();
    this.scene.updateHud();
    if (c.phase.kind === "dead") {
      this.scene.checkpoint.observeTerminal(c);
    }
    this.scene.versus.showAdoptedResult();
  }

  /** Empty room or an explicit request for the exact terminal expedition. */
  private beginExpedition(): void {
    const sess = this.scene.session;
    const myId = sess?.playerId;
    if (!sess?.isHost || !myId) {
      return;
    }
    if (!sess.offline) {
      checkpointRng();
    }
    this.scene.role = "host";
    this.scene.authority = {
      kind: "ready",
      revision: sess.authorityRevision,
      runId: `${myId}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      term: 0,
    };
    const other = sess.otherPlayer();
    const otherHero = parseHero(other?.state?.hero);
    this.assignSeats(myId, other && otherHero ? other.id : null);
    this.resetExpedition();
    const selfHero = parseHero(sess.players[myId]?.state?.hero) ?? this.scene.heroName;
    this.respawnBodies(selfHero, other && otherHero ? { hero: otherHero, id: other.id } : null);
    if (this.scene.mode === "versus") {
      this.scene.versus.match = new VersusMatch();
      this.scene.rooms.buildVersus();
      if (this.scene.remote) {
        this.scene.versus.match.beginMatch();
      }
      this.scene.versus.respawn();
    } else {
      this.scene.versus.match = null;
      const param = new URLSearchParams(location.search).get("room");
      const rt = param ? parseRoomType(param) : null;
      this.scene.rooms.build(rt ? this.scene.run.debugEnter(rt) : this.scene.run.begin());
    }
    this.finishConnecting();
    this.scene.controls.reset();
    this.scene.guestIn = NEUTRAL_INPUT;
    this.restartRequested = false;
    this.scene.hostNet.roomDirty = true;
    this.scene.hostNet.broadcast(0, true);
    this.scene.updateHud();
  }

  // Both bodies are rebuilt from the hub picks at the run's spawn.
  private respawnBodies(selfHero: HeroName, other: { hero: HeroName; id: string } | null) {
    this.scene.player.destroy();
    this.scene.heroName = selfHero;
    this.scene.player = this.scene.spawnPlayer(
      HEROES[selfHero],
      this.scene.grid ?? new Grid(),
      this.scene.roomSpawn.x,
      this.scene.roomSpawn.y,
    );
    this.scene.remote?.destroy();
    this.scene.remote = undefined;
    this.scene.remoteId = null;
    if (other) {
      this.scene.remote = this.scene.spawnPlayer(
        HEROES[other.hero],
        this.scene.grid ?? new Grid(),
        this.scene.roomSpawn.x,
        this.scene.roomSpawn.y,
      );
      this.scene.remoteId = other.id;
    }
  }

  // Reuse existing side identities when their seats are still held; the other
  // seat goes to the peer (if it has picked a hero) or is vacated.
  private assignSeats(myId: string, otherId: string | null) {
    if (this.scene.seats.host !== myId && this.scene.seats.guest !== myId) {
      this.scene.seats.host = myId;
    }
    if (this.scene.seats.host === myId) {
      this.scene.seats.guest = otherId;
    } else {
      this.scene.seats.host = otherId;
    }
  }

  // Fresh expedition state for a new online run (the scene itself persists).
  private resetExpedition() {
    this.scene.run = new RunManager();
    this.scene.checkpoint.adoptedTerminal = null;
    this.scene.mods = baseMods();
    const bonus = runBonuses(loadMeta());
    this.scene.mods.dmg += bonus.dmg;
    this.scene.mods.armor += bonus.armor;
    this.scene.mods.maxHearts += bonus.hearts;
    this.scene.ownedRelics = new Set();
    this.scene.maxHearts = this.scene.mods.maxHearts;
    this.scene.hearts = this.scene.maxHearts;
    this.scene.gold = 0;
    this.scene.score = 0;
    this.scene.combo = 0;
    this.scene.comboT = 0;
    this.scene.freeze = 0;
    this.scene.acc = 0;
    this.scene.deadT = 0;
    this.scene.lastStand.live = null;
    this.scene.lastStand.net = null;
    this.scene.runRecap = null;
    this.scene.pendingOffer = null;
    this.scene.transBuilt = false;
    this.scene.transT = 0;
    this.scene.hostNet.roomSeq = 0;
    this.scene.hostNet.tick = 0;
    this.scene.hostNet.acc = 0;
    this.scene.hostNet.checkpointAcc = 0;
    this.scene.hostNet.checkpointMark = null;
    this.scene.hostNet.enemyId = new WeakMap();
    this.scene.hostNet.enemyIdNext = 1;
    this.scene.versus.hitSeq = new WeakMap();
    this.scene.hostNet.remoteInputOwner = null;
    this.scene.banners.clear();
    this.scene.rooms.flashedBiome = 0;
  }

  private handleRestart(): void {
    const sess = this.scene.session;
    const auth = this.scene.authority;
    if (!sess?.live || auth.kind !== "ready" || this.scene.mode !== "coop") {
      return;
    }
    // The hub's restart targets the terminal run it showed; adopting a live
    // run makes it moot, and a stale request would silently skip the next
    // death's recap and restart the expedition under both players.
    if (this.restartRequested && this.scene.state !== "dead") {
      this.restartRequested = false;
    }
    if (
      this.restartRequested &&
      this.scene.state === "dead" &&
      this.restartSentFor !== auth.runId
    ) {
      this.restartSentFor = auth.runId;
      this.restartRequested = false;
      sess.updateMyState({ restartFor: auth.runId });
    }
    if (!sess.isHost || this.scene.state !== "dead") {
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
