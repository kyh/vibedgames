import { abilityReadiness } from "../render/hud-readability";
import { readPreference } from "../data/preferences";
import { AbilityGuide } from "../render/ability-guide";
import { MultiplayerClient } from "@vibedgames/multiplayer";
import {
  ARENA_BOT_FILL,
  KILL_GOAL_FFA,
  MAX_CATCH_UP_TICKS,
  ONLINE_FALLBACK_MS,
  SHOP_RADIUS,
  SIM_DT,
} from "../data/config";
import { CHAMP_BY_ID, DEFAULT_CHAMP, valAt } from "../data/champions";
import { isInThrone, SPAWNS } from "../data/map";
import { terrainHeight } from "../data/terrain";
import { ALL_ABILITY_KEYS } from "../sim/types";
import type { AbilityKey, Unit, World } from "../sim/types";
import { requestCast, activateItem } from "../sim/abilities";
import {
  buyItem,
  createWorld,
  ensureBots,
  setHeroInput,
  spawnHero,
  step,
  tryJump,
} from "../sim/world";
import { FRAME_EVENT, INTENT_EVENT, MULTIPLAYER_HOST, PARTY } from "../net/protocol";
import type { Intent } from "../net/protocol";
import { emptyGuestWorld, isSnapshot } from "../net/snapshot";
import { humanRoster, reconcileHostHeroes, restoreHostState, takeOver } from "../net/host-state";
import type { HeroPick, OnlineSeat, TakeoverSource } from "../net/host-state";
import { HostNet } from "../net/host-net";
import type { HostLink } from "../net/host-net";
import { inputWire, parseInput } from "../net/input";
import { NetMirror, parseFrame } from "../net/mirror";
import { OwnHeroPredictor } from "../net/own-hero";
import type { HeldInput } from "../net/own-hero";
import type { Vec2 } from "../sim/math";
import { isJsonNumber, isJsonObject, isJsonString } from "../data/json";
import type { JsonObject, JsonValue } from "../data/json";
import type { Controls } from "../input/controls";
import type { TouchControls } from "../input/touch";
import type { ModelLibrary } from "../render/models";
import type { View } from "../render/view";
import { WorldView } from "../render/world-view";
import { Environment } from "../render/environment";
import { Fx } from "../render/fx";
import { Hud } from "../render/hud";
import { Hints } from "../render/hints";
import { sensePlaytest } from "../playtest/sense";

const INTRO_S = 2.4;
const MAX_VISUAL_DT = 1 / 30;
const CAST_BUFFER_MS = 350;
const MUSIC_SAMPLE_S = 0.25;
const MUSIC_DROP_HYST_S = 4;
const JOINING_TEXT = `JOINING — FIRST TO ${KILL_GOAL_FFA} KILLS`;

export interface SceneOpts {
  champId: string;
  name: string;
  online: boolean;
  room: string;
  /** Playtest staging (offline only): the solo world's RNG seed, and whether
   *  to drop the 3-2-1 hold so the first input lands on a live sim. */
  seed?: number;
  skipIntro?: boolean;
}

const SOLO_SEED = 0x1_23_4a_bc;

type Online =
  | { kind: "offline" }
  | { kind: "connecting" }
  | { kind: "guest"; id: string }
  | { kind: "host"; id: string };

type Seated = Extract<Online, { kind: "guest" | "host" }>;

const intentKind = (payload: JsonObject) => (isJsonString(payload.kind) ? payload.kind : "");

const sharedCounter = (value: JsonValue | undefined) =>
  isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const countdownAt = (t: number) => {
  if (t < 0.8) {
    return 3;
  }

  if (t < 1.6) {
    return 2;
  }

  return t < INTRO_S ? 1 : 0;
};

const leaderUnit = (w: World) => {
  if (w.leaderId === null) {
    return null;
  }

  for (const u of w.units.values()) {
    if (u.kind === "hero" && u.team === w.leaderId) {
      return u;
    }
  }

  return null;
};

const matchOutcome: (me: Unit | null, winner: string | null) => "won" | "lost" | "unassigned" = (
  me,
  winner,
) => {
  if (!me || winner === null || winner === "") {
    return "unassigned";
  }

  return winner === me.team ? "won" : "lost";
};

/** Champion for quick-start boots: ?champ → localStorage["ba-champ"] → default.
 *  Both sources are validated against the roster so a stale/typo'd id can never
 *  crash the boot. The menu's START writes the localStorage key. */
export const chosenChamp = () => {
  const fromUrl = new URLSearchParams(location.search).get("champ");

  if (fromUrl !== null && fromUrl !== "" && CHAMP_BY_ID[fromUrl]) {
    return fromUrl;
  }

  const stored = readPreference("ba-champ");

  if (stored !== null && stored !== "" && CHAMP_BY_ID[stored]) {
    return stored;
  }

  return DEFAULT_CHAMP;
};

export class GameScene {
  world: World;
  /** The room; tools/two-client.mts drops and redials it. */
  net: MultiplayerClient | null = null;
  private readonly worldView: WorldView;
  private readonly environment: Environment;
  private readonly fx: Fx;
  private readonly hud: Hud;
  private readonly guide: AbilityGuide;
  private acc = 0;
  private aimX = 0;
  private aimY = 1;
  private aimInit = false;
  private readonly champId: string;
  private readonly name: string;
  /** tools/two-client.mts reads which unit is ours. */
  localId = "h-local";
  /** tools/two-client.mts reads the connection banner. */
  statusEl: HTMLDivElement;
  private readonly hints: Hints;
  private introTime = 0;
  private lastCount = -1;
  private musicClock = 0;
  private musicAcc = 0;
  private musicIntensity: 0 | 1 | 2 | 3 = 0;
  private musicLowSince = -1;
  private musicPhase: World["phase"] = "playing";
  private boundChamp = "";
  private readonly touchCdLast = {
    DASH: -1,
    E: -1,
    JUMP: -1,
    Q: -1,
    R: -1,
    W: -1,
  } satisfies Record<AbilityKey, number>;

  private online: Online;
  private picks: Record<string, HeroPick> = {};
  private assign: Record<string, OnlineSeat> = {};
  private joinResendAt = -Infinity;
  private matchGeneration: number | null = null;
  private hostNet = new HostNet();
  private readonly mirror = new NetMirror();
  private readonly predictor = new OwnHeroPredictor();
  private held: HeldInput = { attack: false, ax: 0, ay: 1, mx: 0, my: 0 };
  private lastSnap: JsonValue | undefined = undefined;
  private mirrorHost: string | null = null;
  private joining = false;
  private worldIsSim = false;
  private publishedT: number | null = null;
  private takeover: TakeoverSource | null = null;
  /** tools/two-client.mts reads whether this client is paused. */
  controlsPaused = false;
  private neutralPending = false;
  private takedowns = 0;

  private readonly view: View;
  private readonly controls: Controls;
  private readonly touch: TouchControls | null;

  constructor(
    view: View,
    lib: ModelLibrary,
    controls: Controls,
    opts: SceneOpts,
    touch: TouchControls | null = null,
  ) {
    this.view = view;
    this.controls = controls;
    this.touch = touch;
    this.champId = opts.champId;
    this.name = opts.name;

    this.online = { kind: opts.online ? "connecting" : "offline" };

    if (opts.online) {
      this.world = emptyGuestWorld();
      this.net = new MultiplayerClient({
        fallbackMs: ONLINE_FALLBACK_MS,
        host: MULTIPLAYER_HOST,
        maxPlayers: ARENA_BOT_FILL,
        onEvent: (e, p, from) => {
          this.onNetEvent(e, p, from);
        },
        party: PARTY,
        room: opts.room,
      });
    } else {
      this.world = this.createSoloWorld(opts.seed ?? SOLO_SEED);

      if (opts.skipIntro === true) {
        this.introTime = INTRO_S;
      }
    }

    this.worldView = new WorldView(view.scene, lib);
    this.worldView.localId = this.localId;
    this.worldView.setupBoss();
    this.environment = new Environment(view.scene, lib);
    this.environment.setup();
    view.refreshShadows();
    this.fx = new Fx(view.scene, view);
    this.fx.warm(view.renderer, view.camera);
    this.fx.localId = this.localId;

    if (!opts.online) {
      this.fx.localOwnerId = "local";
    }

    this.worldView.fx = this.fx;
    this.hud = new Hud(
      view,
      this.fx,
      {
        buy: (id) => {
          this.requestBuy(id);
        },
        canShop: () => this.canShop(),
      },
      opts.online
        ? {
            canRematch: () => this.canRematch(),
            kind: "online",
            rematch: () => {
              this.rematch();
            },
          }
        : { kind: "offline" },
    );
    this.hud.setPlateAnchors((id) => this.worldView.plateAnchor(id));
    this.guide = new AbilityGuide((open) => {
      this.resetHeldInput();
      this.controls.setMouseMode(
        open || this.hud.isShopOpen || this.controlsPaused || this.world.phase === "ended",
      );
      this.neutralPending = true;
      this.flushNeutralInput();
    });
    this.hud.setKitAction(() => {
      this.guide.show(this.champId, this.localUnit());
    });
    this.hints = new Hints(
      () => this.touch?.active ?? false,
      (t) => {
        this.hud.showHint(t);
      },
    );

    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:800 22px ui-monospace,monospace;color:#9fd0ff;text-shadow:0 2px 6px #000;z-index:9;pointer-events:none";
    document.body.append(this.statusEl);

    view.startIntro();
    this.net?.subscribe(() => {
      this.syncConnection();
      this.ingestShared();
    });
  }

  private createSoloWorld(seed: number) {
    const world = createWorld(seed, { soloMercy: true });
    spawnHero(world, {
      champId: this.champId,
      id: this.localId,
      isBot: false,
      name: this.name,
      ownerId: "local",
      slot: 0,
      team: "local",
    });
    ensureBots(world);

    return world;
  }

  /** Playtest hook: a fresh seeded solo match, live at once. Never online —
   *  a staged world must not be written into a shared room. */
  restartSolo(seed: number) {
    if (this.net) {
      return;
    }

    this.world = this.createSoloWorld(seed);
    this.acc = 0;
    this.takedowns = 0;
    this.introTime = INTRO_S;
    this.resetMatchPresentation();
  }

  get isOffline() {
    return this.net === null;
  }

  /** Whether other players can share this match: an online scene whose client
   *  has not fallen back to the SDK's room of one. main.ts never freezes it. */
  get isLive() {
    return this.net !== null && this.net.connectionStatus !== "offline";
  }

  private get amHost() {
    return this.online.kind === "offline" || this.online.kind === "host";
  }

  private get hostDropped() {
    const { net } = this;

    return !!net && net.hostId !== null && net.players[net.hostId]?.connected === false;
  }

  private statusLine(me: Unit | null) {
    const status = this.net?.connectionStatus;

    if (status === "connecting") {
      return "Connecting…";
    }

    if (status === "reconnecting") {
      return "Reconnecting…";
    }

    if (me) {
      return this.hostDropped ? "Host reconnecting…" : "";
    }

    return this.world.phase === "ended" ? "" : "Joining the arena…";
  }

  private localUnit() {
    return this.world.units.get(this.localId) ?? null;
  }

  get isGuideOpen() {
    return this.guide.open;
  }

  /** `elapsed` is the real time since the last frame (s, main.ts caps it at a
   *  quarter second): the sim advances by it, visuals by at most a 30 fps step. */
  update(elapsed: number) {
    const frameDt = Math.min(elapsed, MAX_VISUAL_DT);
    this.guide.update(this.localUnit());
    this.controls.update(this.controlsPaused || this.guide.open ? 0 : frameDt);
    const inspect = this.controls.consumeGuide();

    if (inspect && !this.controlsPaused && !this.guide.open && this.world.phase === "playing") {
      this.guide.show(this.champId, this.localUnit());
    }

    this.introTime += frameDt;

    if (this.net) {
      this.tickOnline(elapsed, frameDt);
    } else {
      this.tickLocal(elapsed, frameDt);
    }

    if (this.world.phase === "ended") {
      this.guide.close();
    }

    this.view.samplePerf(frameDt);
    const me = this.localUnit();

    if (this.musicPhase === "ended" && this.world.phase === "playing") {
      this.resetMusicDriver();
      this.fx.bestStreak = 0;
      this.fx.lastDeath = null;
    }

    this.countTakedowns();
    this.fx.update(this.world, frameDt);
    const rdt = frameDt * this.fx.scaleNow();
    this.worldView.smoothUnits = this.online.kind !== "guest";
    this.worldView.sync(this.world, rdt);
    this.statusEl.textContent = this.statusLine(me);

    if (me) {
      this.hud.update(this.world, me, this.controls.scoreHeld(), frameDt);
      this.fx.audio.setListener(me.x, me.y, this.aimX, this.aimY);

      if (this.touch && me.champId !== this.boundChamp) {
        this.boundChamp = me.champId;
        this.touch.bindChamp(me.champId);
      }

      this.feedTouchCooldowns(me);
    } else if (this.world.phase === "ended") {
      this.hud.updateUnassigned(this.world, frameDt);
    }

    this.hints.update(this.world, me);
    this.driveIntro();
    this.driveMusic(frameDt, me);
    const cx = me ? me.x : 0;
    const cy = me ? me.y : 0;
    this.view.follow(
      cx,
      cy,
      this.aimX,
      this.aimY,
      this.controls.aimPitch(),
      rdt,
      terrainHeight(cx, cy),
    );
    this.view.tickAura(this.world.gameTime);
    this.environment.setLocalPos(cx, cy);

    if (me) {
      this.environment.setHomeSlot(me.slot);
    }

    this.environment.update(this.world.gameTime);
    this.view.render();
  }

  private tickLocal(elapsed: number, frameDt: number) {
    if (this.controlsPaused || this.world.phase === "ended") {
      this.controls.setMouseMode(true);
      this.drainActionInput();
      this.acc = 0;

      return;
    }

    if (this.introTime < INTRO_S) {
      this.acc = 0;
      const me = this.localUnit();

      if (me && !this.aimInit) {
        this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
        this.aimInit = true;
      }

      const yaw = this.controls.aimYaw();
      this.aimX = Math.sin(yaw);
      this.aimY = Math.cos(yaw);
      this.drainActionInput();

      return;
    }

    const me = this.localUnit();

    if (me) {
      this.readInput(me, true, frameDt);
    }

    this.acc += elapsed;
    let n = 0;

    while (this.acc >= SIM_DT && n < MAX_CATCH_UP_TICKS && this.world.phase === "playing") {
      step(this.world);
      this.acc -= SIM_DT;
      n += 1;
    }

    this.acc = Math.min(this.acc, SIM_DT);
  }

  private driveIntro() {
    const t = this.introTime;

    if (t > INTRO_S + 1.2) {
      return;
    }

    if (this.net) {
      this.hud.showIntro(t < 2 ? JOINING_TEXT : "");

      return;
    }

    const n = countdownAt(t);

    if (n > 0) {
      this.hud.showIntro(String(n));
    } else {
      this.hud.showIntro(t < INTRO_S + 0.5 ? "FIGHT!" : "");
    }

    if (n !== this.lastCount) {
      this.lastCount = n;

      if (n > 0) {
        this.fx.audio.count();
      } else {
        this.fx.audio.fight();
      }
    }
  }

  private driveMusic(frameDt: number, me: Unit | null) {
    if (this.world.phase === "ended") {
      if (this.musicPhase !== "ended") {
        this.musicPhase = "ended";
        this.fx.audio.resolveMatch(matchOutcome(me, this.world.winner));
      }

      return;
    }

    this.musicClock += frameDt;
    this.musicAcc += frameDt;

    if (this.musicAcc < MUSIC_SAMPLE_S) {
      return;
    }

    this.musicAcc = 0;

    if (this.world.phase !== "playing" || !me) {
      return;
    }

    const { music } = this.fx.audio;

    if (!music) {
      return;
    }

    const desired = this.musicDesired(this.world, me);

    if (!me.alive) {
      if (this.musicIntensity !== 0) {
        music.setIntensity(0);
      }

      this.musicIntensity = 0;
      this.musicLowSince = -1;

      return;
    }

    if (desired > this.musicIntensity) {
      this.musicIntensity = desired;
      this.musicLowSince = -1;
      music.setIntensity(desired);
    } else if (desired < this.musicIntensity) {
      if (this.musicLowSince < 0) {
        this.musicLowSince = this.musicClock;
      } else if (this.musicClock - this.musicLowSince >= MUSIC_DROP_HYST_S) {
        this.musicIntensity = desired;
        this.musicLowSince = -1;
        music.setIntensity(desired);
      }
    } else {
      this.musicLowSince = -1;
    }
  }

  private musicDesired(w: World, me: Unit) {
    if (!me.alive) {
      return 0;
    }

    if (w.suddenDeath || w.matchTime - w.gameTime < 60) {
      return 3;
    }

    if (isInThrone(me.x, me.y) && this.enemyHeroNear(me, 0, 0, 11)) {
      return 3;
    }

    if (w.leaderId !== null && w.leaderId === me.team) {
      return 2;
    }

    const leader = leaderUnit(w);

    if (leader && leader.alive) {
      const dx = leader.x - me.x;
      const dy = leader.y - me.y;

      if (dx * dx + dy * dy < 400) {
        return 2;
      }
    }

    if (this.enemyHeroNear(me, me.x, me.y, 14)) {
      return 1;
    }

    if (w.now - me.lastHitAt < 3000 || w.now - me.lastAttackAt < 3000) {
      return 1;
    }

    return 0;
  }

  private enemyHeroNear(me: Unit, x: number, y: number, r: number) {
    const r2 = r * r;

    for (const u of this.world.units.values()) {
      if (u.kind !== "hero" || !u.alive || u.team === me.team) {
        continue;
      }

      const dx = u.x - x;
      const dy = u.y - y;

      if (dx * dx + dy * dy < r2) {
        return true;
      }
    }

    return false;
  }

  private feedTouchCooldowns(me: Unit) {
    const { touch } = this;

    if (!touch || !touch.active) {
      return;
    }

    const def = CHAMP_BY_ID[me.champId];

    if (!def) {
      return;
    }

    for (const key of ALL_ABILITY_KEYS) {
      const slot = me.abilities[key];
      touch.setReadiness(key, abilityReadiness(me, key, this.world.now));
      let pct = 0;

      if (slot.rank < 1) {
        pct = 1;
      } else {
        const left = Math.max(0, (slot.readyAt - this.world.now) / 1000);

        if (left > 0) {
          const total = valAt(def.abilities[key].cooldown, slot.rank);
          pct = total > 0 ? Math.min(1, left / total) : 0;
        }
      }

      const q = Math.round(pct * 100);

      if (q !== this.touchCdLast[key]) {
        this.touchCdLast[key] = q;
        touch.setCooldown(key, q / 100);
      }
    }
  }

  private syncConnection() {
    const { net } = this;

    if (!net) {
      return null;
    }

    const seated = net.connectionStatus === "connected" || net.connectionStatus === "offline";
    const id = seated ? net.playerId : null;

    if (id === null || id === "") {
      if (this.online.kind !== "connecting") {
        this.resetHeldInput();
        this.neutralPending = true;
      }

      this.online = { kind: "connecting" };
      this.acc = 0;

      return null;
    }

    const current = this.online;
    let seat: Seated | null = current.kind === "guest" || current.kind === "host" ? current : null;

    if (seat?.id !== id) {
      seat = { id, kind: "guest" };
      this.joinResendAt = -Infinity;
      this.neutralPending = true;
      this.drainActionInput();
      this.mirror.reset();
      this.predictor.reset();
      this.joining = true;
      this.mirrorHost = null;
    } else if (seat.kind === "host" && !net.isHost) {
      seat = { id, kind: "guest" };
      this.acc = 0;
      this.lastSnap = net.sharedState.snap;
      this.joining = false;
      this.mirror.reset();
      this.predictor.reset();
      this.mirrorHost = null;
    }

    this.online = seat;
    this.localId = `h-${id}`;
    this.worldView.localId = this.localId;
    this.fx.localId = this.localId;
    this.fx.localOwnerId = id;
    this.mirror.ownId = this.localId;

    return seat;
  }

  private prepareOnline() {
    const { net } = this;
    let seat = this.syncConnection();

    if (!net || !seat) {
      return null;
    }

    if (seat.kind === "guest" && net.isHost) {
      const { snap, snapT } = net.sharedState;

      if (snap !== undefined && snap !== null && !isSnapshot(snap)) {
        return null;
      }

      const roster = takeOver(this.world, {
        held: this.held,
        mirror: this.mirror,
        ours: this.worldIsSim && isJsonNumber(snapT) && snapT === this.publishedT,
        ownId: this.localId,
        predictor: this.predictor,
        snapshot: isSnapshot(snap) ? snap : null,
      });

      this.takeover = roster.source;
      this.worldIsSim = true;
      this.picks = { ...this.picks, ...roster.picks };
      this.assign = roster.seats;
      this.acc = 0;

      if (net.connectionStatus === "offline") {
        this.world.fx.push({
          kind: "notice",
          t: "notify",
          text: "SERVER UNREACHABLE — PLAYING VS BOTS",
        });
      }

      this.hostNet = new HostNet();
      this.hostNet.alreadySent(this.world.fx);
      this.mirror.reset();
      this.predictor.reset();
      seat = { id: seat.id, kind: "host" };
      this.online = seat;
    }

    if (seat.kind === "host") {
      const generation = sharedCounter(net.sharedState.matchGeneration);

      if (this.matchGeneration !== null && generation !== this.matchGeneration) {
        this.resetMatchPresentation();
      }

      this.matchGeneration = generation;
    }

    return seat;
  }

  private ingestShared() {
    const { net } = this;

    if (!net || net.isHost || this.online.kind !== "guest") {
      return;
    }

    const { snap } = net.sharedState;

    if (snap === this.lastSnap) {
      return;
    }

    this.lastSnap = snap;

    if (!isSnapshot(snap)) {
      return;
    }

    this.trackHost(net);
    const generation = sharedCounter(net.sharedState.matchGeneration);
    const newMatch = this.matchGeneration !== null && generation !== this.matchGeneration;

    if (newMatch) {
      this.mirror.reset();
      this.predictor.reset();
    }

    const { snapT } = net.sharedState;
    const live = !this.joining;
    this.joining = false;
    this.worldIsSim = false;
    this.mirror.applySnapshot(
      this.world,
      snap,
      isJsonNumber(snapT) ? snapT : null,
      performance.now(),
      live,
    );

    if (newMatch) {
      this.resetMatchPresentation();
    }

    this.matchGeneration = generation;
  }

  private trackHost(net: MultiplayerClient) {
    if (net.hostId === this.mirrorHost) {
      return;
    }

    this.mirrorHost = net.hostId;
    this.mirror.clock.relearn();
    this.predictor.resend();
  }

  private onFrame(net: MultiplayerClient, payload: JsonValue, from: string) {
    const seat = this.prepareOnline();

    if (seat?.kind !== "guest" || from !== net.hostId) {
      return;
    }

    const frame = parseFrame(payload);

    if (!frame) {
      return;
    }

    this.trackHost(net);
    this.worldIsSim = false;
    const own = this.mirror.applyFrame(this.world, frame, performance.now());

    if (own) {
      this.predictor.hostUpdate(own);
    }
  }

  private announcePick(net: MultiplayerClient) {
    const id = net.playerId;

    if (id === null || id === "" || net.hostId === null || net.hostId === "") {
      return;
    }

    const now = performance.now();

    if (now - this.joinResendAt < 3000) {
      return;
    }

    const pick = { champId: this.champId, name: this.name };
    this.picks[id] ??= pick;
    net.sendToHost(INTENT_EVENT, { kind: "join", ...pick } satisfies Intent);
    this.joinResendAt = now;
  }

  private tickOnline(elapsed: number, frameDt: number) {
    const { net } = this;
    const seat = this.prepareOnline();

    if (!net || !seat) {
      this.drainActionInput();

      return;
    }

    this.announcePick(net);
    const host = seat.kind === "host";

    if (host) {
      this.reconcileHeroes(net);
    } else {
      this.trackHost(net);
      this.mirror.render(this.world, performance.now());
    }

    this.flushNeutralInput();
    const me = this.localUnit();

    if (this.controlsPaused || this.world.phase === "ended") {
      this.controls.setMouseMode(true);
      this.drainActionInput();
      this.holdNeutral(me);
    } else if (me) {
      this.readInput(me, host, frameDt);
    } else {
      this.drainActionInput();
    }

    if (host) {
      this.hostNet.advance(this.world, elapsed * 1000, this.hostLink(net, seat.id));
    } else if (me && this.world.phase === "playing") {
      if (this.hostDropped) {
        this.holdNeutral(me);
      }

      this.predictor.advance(
        me,
        this.world.units,
        elapsed * 1000,
        performance.now(),
        this.world.now,
        this.held,
        (p) => {
          net.sendToHost(INTENT_EVENT, inputWire(p));
        },
      );
      this.predictor.render(me, this.world.units, this.held);
    }
  }

  private hostLink(net: MultiplayerClient, id: string) {
    return {
      inputHero: (ownerId) => (ownerId === id ? null : this.intentUnit(net, ownerId)),
      now: () => net.serverNow(),
      publish: (snap, t) => {
        this.publishedT = t;
        net.updateSharedState({ matchGeneration: this.matchGeneration ?? 0, snap, snapT: t });
      },
      sendFrame: (frame) => {
        net.sendEvent(FRAME_EVENT, frame, { except: id });
      },
    } satisfies HostLink;
  }

  private rotateToAim(fwd: number, strafe: number) {
    return {
      x: this.aimX * fwd - this.aimY * strafe,
      y: this.aimY * fwd + this.aimX * strafe,
    };
  }

  private readInput(me: Unit, host: boolean, dt: number) {
    this.controls.setMouseMode(
      this.controlsPaused || this.guide.open || this.hud.isShopOpen || this.world.phase === "ended",
    );

    if (this.controlsPaused || this.world.phase === "ended") {
      this.drainActionInput();
      this.holdNeutral(me);

      return;
    }

    if (this.guide.open) {
      this.drainActionInput();

      if (host) {
        setHeroInput(me, 0, 0, this.aimX, this.aimY, false);
      }

      this.holdNeutral(me);

      return;
    }

    if (!me.alive) {
      if (host) {
        setHeroInput(me, 0, 0, this.aimX, this.aimY, false);
      }

      this.holdNeutral(me);

      return;
    }

    this.readAim(me, dt);
    const { mv, attack: attackHeld } = this.readMove();
    let attack = attackHeld;
    const castPoint: Vec2 = { x: me.x + this.aimX * 8, y: me.y + this.aimY * 8 };

    const airborne = this.world.now < me.jumpUntil;
    const attackEdge = this.controls.consumeAttackEdge();
    const lmbJump = attackEdge && airborne;
    const touchJump = this.touch?.consumeJumpAttack() ?? false;

    if (lmbJump || touchJump) {
      if (lmbJump) {
        attack = false;
      }

      this.dispatchCast(host, me, "JUMP", { x: this.aimX, y: this.aimY }, castPoint);
    }

    if (host) {
      setHeroInput(me, mv.x, mv.y, this.aimX, this.aimY, attack);
    } else {
      this.held = { attack, ax: this.aimX, ay: this.aimY, mx: mv.x, my: mv.y };

      if (attackEdge && !lmbJump) {
        this.predictor.pending.attackEdge = true;
      }
    }

    this.readAbilities(me, host, castPoint);
    this.readHop(me, host);
    this.readDash(me, host, mv, castPoint);
    this.readItems(me, host, castPoint);
    this.readBuy();
  }

  private holdNeutral(me: Unit | null) {
    if (this.online.kind !== "guest") {
      return;
    }

    const aimed = this.aimX !== 0 || this.aimY !== 0;
    this.held = {
      attack: false,
      ax: aimed ? this.aimX : (me?.aimX ?? 0),
      ay: aimed ? this.aimY : (me?.aimY ?? 1),
      mx: 0,
      my: 0,
    };
  }

  private readAim(me: Unit, dt: number) {
    if (!this.aimInit) {
      this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
      this.aimInit = true;
    }

    if (this.touch?.active === true) {
      const look = this.touch.lookVec();

      if (look) {
        this.controls.applyStickLook(look.x, look.y, dt);
      }
    }

    const yaw = this.controls.aimYaw();
    this.aimX = Math.sin(yaw);
    this.aimY = Math.cos(yaw);
  }

  private readMove() {
    if (this.touch?.active === true) {
      const m = this.touch.moveVec();

      return { attack: this.touch.attackDown(), mv: this.rotateToAim(-m.y, m.x) };
    }

    const { fwd, strafe } = this.controls.moveAxes();
    const mv = this.rotateToAim(fwd, strafe);
    const l = Math.hypot(mv.x, mv.y);

    if (l > 0) {
      mv.x /= l;
      mv.y /= l;
    }

    return { attack: this.controls.attackDown(), mv };
  }

  private dispatchCast(host: boolean, me: Unit, key: AbilityKey, dir: Vec2, point: Vec2) {
    if (host) {
      requestCast(this.world, me, key, { dir, point });
    } else if (key === "DASH") {
      this.predictor.pending.dash = dir;
    } else {
      this.predictor.pending.casts.push({ dir, key, point });
    }
  }

  private readAbilities(me: Unit, host: boolean, castPoint: Vec2) {
    const keys = [...this.controls.consumeAbilities(), ...(this.touch?.consumeAbilities() ?? [])];

    for (const key of keys) {
      if (this.wouldDeny(me, key)) {
        this.fx.audio.castDeny();
      }

      this.dispatchCast(host, me, key, { x: this.aimX, y: this.aimY }, castPoint);
    }
  }

  private readHop(me: Unit, host: boolean) {
    const kbJump = this.controls.consumeJump();
    const tJump = this.touch?.consumeJump() ?? false;

    if (kbJump || tJump) {
      if (host) {
        tryJump(this.world, me);
      } else {
        this.predictor.pending.jump = true;
      }
    }
  }

  private readDash(me: Unit, host: boolean, mv: Vec2, castPoint: Vec2) {
    const dash = this.controls.consumeDash() || (this.touch?.consumeDash() ?? false);

    if (dash) {
      const dashDir = mv.x !== 0 || mv.y !== 0 ? mv : { x: this.aimX, y: this.aimY };
      this.dispatchCast(host, me, "DASH", dashDir, castPoint);
    }
  }

  private readItems(me: Unit, host: boolean, castPoint: Vec2) {
    for (const slot of [...this.controls.consumeItems(), ...this.hud.consumeItemTaps()]) {
      if (host) {
        activateItem(this.world, me, slot, castPoint);
      } else {
        this.predictor.pending.items.push({ point: castPoint, slot });
      }
    }
  }

  private readBuy() {
    const buy = this.controls.consumeBuy() || (this.touch?.consumeBuy() ?? false);

    if (buy && (this.canShop() || this.hud.isShopOpen)) {
      this.hud.toggleShop();

      if (this.hud.isShopOpen) {
        this.hints.notifyShopOpened();
      }
    }
  }

  private wouldDeny(me: Unit, key: AbilityKey) {
    const slot = me.abilities[key];

    return slot.rank < 1 || slot.readyAt - this.world.now > CAST_BUFFER_MS;
  }

  private requestBuy(itemId: string) {
    if (this.net && !this.prepareOnline()) {
      return;
    }

    if (this.controlsPaused || this.world.phase !== "playing") {
      return;
    }

    this.flushNeutralInput();
    const me = this.localUnit();

    if (!me) {
      return;
    }

    if (this.amHost) {
      buyItem(this.world, me, itemId);
    } else {
      this.net?.sendToHost(INTENT_EVENT, { itemId, kind: "buy" } satisfies Intent);
    }
  }

  private onNetEvent(event: string, payload: JsonValue, from: string) {
    const { net } = this;

    if (!net) {
      return;
    }

    if (event === FRAME_EVENT) {
      this.onFrame(net, payload, from);

      return;
    }

    if (event !== INTENT_EVENT || !net.isHost || !isJsonObject(payload)) {
      return;
    }

    const seat = this.prepareOnline();

    if (seat?.kind !== "host") {
      return;
    }

    const sender = net.players[from];

    if (!sender || sender.connected === false) {
      return;
    }

    switch (intentKind(payload)) {
      case "join": {
        const { champId, name } = payload;

        if (isJsonString(champId) && CHAMP_BY_ID[champId] && isJsonString(name)) {
          this.picks[from] = { champId, name: name.slice(0, 14) };
        }

        break;
      }

      case "input": {
        const packet = parseInput(payload);

        if (packet && from !== seat.id) {
          this.hostNet.receive(from, packet);
        }

        break;
      }

      case "buy": {
        const { itemId } = payload;
        const u = this.intentUnit(net, from);

        if (u && isJsonString(itemId)) {
          buyItem(this.world, u, itemId);
        }

        break;
      }

      default: {
        break;
      }
    }
  }

  private intentUnit(net: MultiplayerClient, from: string) {
    if (!this.amHost || this.world.phase !== "playing") {
      return null;
    }

    if (from === net.playerId && this.controlsPaused) {
      return null;
    }

    const u = this.world.units.get(`h-${from}`);

    return u && u.alive ? u : null;
  }

  private reconcileHeroes(net: MultiplayerClient) {
    reconcileHostHeroes(this.world, net.players, this.picks, this.assign);
    this.hostNet.forget((ownerId) => net.players[ownerId] !== undefined);
  }

  private canRematch() {
    return !this.controlsPaused && this.online.kind === "host" && this.world.phase === "ended";
  }

  private rematch() {
    const seat = this.prepareOnline();

    if (!seat || !this.canRematch()) {
      return;
    }

    const { net } = this;

    if (!net) {
      return;
    }

    const roster = humanRoster(this.world);
    this.picks = { ...this.picks, ...roster.picks };
    this.assign = roster.seats;
    restoreHostState(this.world, null);
    this.reconcileHeroes(net);
    this.matchGeneration = (this.matchGeneration ?? 0) + 1;
    this.world.fx.length = 0;
    this.acc = 0;
    this.resetMatchPresentation();
    this.hostNet.resync();
    this.hostNet.publishNow(this.world, this.hostLink(net, seat.id));
  }

  private resetMatchPresentation() {
    this.worldView.resetCharacters();
    this.fx.resetMatch();
    this.hud.resetMatch(this.world, this.localUnit());
    this.hints.resetMatch();
    this.resetMusicDriver();
    this.aimInit = false;
    this.boundChamp = "";

    for (const key of ALL_ABILITY_KEYS) {
      this.touchCdLast[key] = -1;
    }

    this.resetHeldInput();
    this.neutralPending = true;
  }

  private resetMusicDriver() {
    this.musicPhase = "playing";
    this.musicClock = 0;
    this.musicAcc = 0;
    this.musicIntensity = 0;
    this.musicLowSince = -1;
    this.fx.audio.beginMatch();
  }

  private drainActionInput() {
    this.controls.consumeAbilities();
    this.controls.consumeAttackEdge();
    this.controls.consumeJump();
    this.controls.consumeDash();
    this.controls.consumeItems();
    this.controls.consumeBuy();
    this.touch?.consumeAbilities();
    this.touch?.consumeJumpAttack();
    this.touch?.consumeJump();
    this.touch?.consumeDash();
    this.touch?.consumeBuy();
    this.hud.consumeItemTaps();
  }

  private resetHeldInput() {
    this.controls.resetInput();
    this.touch?.resetInput();
    this.hud.consumeItemTaps();
  }

  private flushNeutralInput() {
    if (!this.neutralPending) {
      return;
    }

    if (this.online.kind === "connecting") {
      return;
    }

    if (this.world.phase !== "playing") {
      this.neutralPending = false;

      return;
    }

    const me = this.localUnit();

    if (!me) {
      return;
    }

    if (this.amHost) {
      setHeroInput(me, 0, 0, me.aimX, me.aimY, false);
    } else {
      this.holdNeutral(me);
    }

    this.neutralPending = false;
  }

  private canShop() {
    if (this.controlsPaused || this.world.phase !== "playing") {
      return false;
    }

    if (this.online.kind === "connecting") {
      return false;
    }

    const me = this.localUnit();

    if (!me || !me.alive) {
      return false;
    }

    const sp = SPAWNS[me.slot % SPAWNS.length];

    if (!sp) {
      return false;
    }

    return (me.x - sp.x) ** 2 + (me.y - sp.y) ** 2 <= SHOP_RADIUS * SHOP_RADIUS;
  }

  /** The match's audio bus — main.ts hands its mute flag to the touch cluster. */
  get audio() {
    return this.fx.audio;
  }

  private countTakedowns() {
    const owner = this.fx.localOwnerId;

    for (const event of this.world.fx) {
      if (event.t === "death" && event.by === owner) {
        this.takedowns += 1;
      }
    }
  }

  diagnostics() {
    const me = this.localUnit();

    return {
      audio: this.fx.audio.diagnostics(),
      complete: this.world.phase === "ended",
      fight: me ? sensePlaytest(this.world, me) : null,
      kills: me?.kills ?? 0,
      online: this.net
        ? {
            authority: this.amHost,
            connection: this.net.connectionStatus,
            correction: this.online.kind === "guest" ? this.predictor.correction : 0,
            hostId: this.net.hostId,
            matchGeneration: this.matchGeneration,
            playerId: this.net.playerId,
            takeover: this.takeover,
            trip: this.online.kind === "guest" ? this.mirror.trip(this.net.serverClock) : 0,
          }
        : null,
      phase: this.world.phase,
      player: me ? { alive: me.alive, hp: me.hp, x: me.x, y: me.y } : undefined,
      score: this.takedowns,
    };
  }

  /** Wrapper-requested pause/resume (see main.ts's setPauseHandlers wiring) —
   *  offline only, the sim itself is frozen by simply not calling update(). */
  pauseAudio() {
    this.controlsPaused = true;
    this.guide.close();
    this.resetHeldInput();
    this.controls.setMouseMode(true);
    this.neutralPending = true;

    if (!this.net || this.prepareOnline()) {
      this.flushNeutralInput();
    }

    this.hud.setPaused(true);
    this.fx.audio.suspend();
  }

  resumeAudio() {
    this.resetHeldInput();
    this.controlsPaused = false;
    this.controls.setMouseMode(this.hud.isShopOpen || this.world.phase === "ended");
    this.hud.setPaused(false);
    this.fx.audio.resume();
  }
}

/** Player name for quick-start boots: ?name → localStorage["ba-name"] → "Player". */
export const chosenName = () => {
  const fromUrl = new URLSearchParams(location.search).get("name")?.trim();

  if (fromUrl !== undefined && fromUrl !== "") {
    return fromUrl.slice(0, 14);
  }

  const stored = readPreference("ba-name")?.trim();

  return stored !== undefined && stored !== "" ? stored.slice(0, 14) : "Player";
};
