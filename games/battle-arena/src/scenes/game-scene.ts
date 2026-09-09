import { abilityReadiness } from "../render/hud-readability";
import { readPreference } from "../data/preferences";
import { AbilityGuide } from "../render/ability-guide";
// Game scene — runs local (vs bots) or online (host-authoritative). The sim is
// identical in both; only authority + transport differ. Mirrors games/moba:
// guests send INTENT events and render snapshots; the host simulates and
// broadcasts under sharedState.snap. Only the server elects a host.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import { ARENA_BOT_FILL, KILL_GOAL_FFA, SHOP_RADIUS, SIM_DT, SNAPSHOT_HZ } from "../data/config";
import { CHAMP_BY_ID, DEFAULT_CHAMP, valAt } from "../data/champions";
import { HALF, isInThrone, SPAWNS } from "../data/map";
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
import { INTENT_EVENT, MULTIPLAYER_HOST, PARTY } from "../net/protocol";
import type { Intent } from "../net/protocol";
import { applySnapshot, emptyGuestWorld, encodeWorld, isSnapshot } from "../net/snapshot";
import { humanRoster, reconcileHostHeroes, restoreHostState } from "../net/host-state";
import type { HeroPick, OnlineSeat } from "../net/host-state";
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
import type { Audio } from "../render/audio";
import { Hud } from "../render/hud";
import { Hints } from "../render/hints";

// camera fly-in length; solo holds the sim this long (NEVER online)
const INTRO_S = 2.4;
// mirror of the sim's cast-buffer window — deny-feedback only
const CAST_BUFFER_MS = 350;
// intensity driver runs at 4Hz
const MUSIC_SAMPLE_S = 0.25;
// intensity only drops after 4s of sustained calm
const MUSIC_DROP_HYST_S = 4;
// online intro banner
const JOINING_TEXT = `JOINING — FIRST TO ${KILL_GOAL_FFA} KILLS`;

export interface SceneOpts {
  champId: string;
  name: string;
  online: boolean;
  room: string;
}

/** Connection-derived authority. `lastFxSeq: null` means the next prepare takes
 * a fresh FX baseline, so nothing broadcast before it can replay. */
type Online =
  | { kind: "offline" }
  | { kind: "connecting" }
  | { kind: "guest"; id: string; lastFxSeq: number | null }
  | { kind: "host"; id: string; lastFxSeq: number | null; fxSeqOut: number };
type Seated = Extract<Online, { kind: "guest" | "host" }>;

const sharedCounter = (value: JsonValue | undefined): number =>
  isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;

const clamp1 = (n: number): number => (n < -1 ? -1 : Math.min(1, n));
const clampArena = (n: number): number => Math.min(HALF, Math.max(-HALF, n));
const num = (n: JsonValue | undefined): number => (isJsonNumber(n) ? n : 0);
const numArena = (n: JsonValue | undefined): number => clampArena(num(n));

const countdownAt = (t: number): number => {
  if (t < 0.8) {
    return 3;
  }
  if (t < 1.6) {
    return 2;
  }
  return t < INTRO_S ? 1 : 0;
};

const leaderUnit = (w: World): Unit | null => {
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

/** Which side of the result the local player is on (spectators are unassigned). */
const matchOutcome = (me: Unit | null, winner: string | null): "won" | "lost" | "unassigned" => {
  if (!me || !winner) {
    return "unassigned";
  }
  return winner === me.team ? "won" : "lost";
};

/** Champion for quick-start boots: ?champ → localStorage["ba-champ"] → default.
 *  Both sources are validated against the roster so a stale/typo'd id can never
 *  crash the boot. The menu's START writes the localStorage key. */
export const chosenChamp = (): string => {
  const fromUrl = new URLSearchParams(location.search).get("champ");
  if (fromUrl && CHAMP_BY_ID[fromUrl]) {
    return fromUrl;
  }
  const stored = readPreference("ba-champ");
  if (stored && CHAMP_BY_ID[stored]) {
    return stored;
  }
  return DEFAULT_CHAMP;
};

interface MoveInput {
  mv: Vec2;
  attack: boolean;
}

export class GameScene {
  world: World;
  private net: MultiplayerClient | null = null;
  private worldView: WorldView;
  private environment: Environment;
  private fx: Fx;
  private hud: Hud;
  private guide: AbilityGuide;
  private acc = 0;
  private aimX = 0;
  private aimY = 1;
  // seed the heading from spawn facing once
  private aimInit = false;
  private champId: string;
  private name: string;
  private localId = "h-local";
  private statusEl: HTMLDivElement;
  private hints: Hints;
  // intro fly-in + countdown (solo: 3-2-1-FIGHT; online: camera sweep only)
  private introTime = 0;
  // change-gate for count()/fight() one-shots
  private lastCount = -1;
  // music intensity driver (4Hz sample, 4s drop hysteresis)
  private musicClock = 0;
  private musicAcc = 0;
  private musicIntensity: 0 | 1 | 2 | 3 = 0;
  private musicLowSince = -1;
  private musicPhase: World["phase"] = "playing";
  // touch integration (change-gated per-frame feeds)
  private boundChamp = "";
  private readonly touchCdLast = {
    DASH: -1,
    E: -1,
    JUMP: -1,
    Q: -1,
    R: -1,
    W: -1,
  } satisfies Record<AbilityKey, number>;

  // online state
  private online: Online;
  private picks: Record<string, HeroPick> = {};
  private assign: Record<string, OnlineSeat> = {};
  private joinResendAt = -Infinity;
  private snapAcc = 0;
  private netFx: World["fx"] = [];
  private matchGeneration: number | null = null;
  private controlsPaused = false;
  private neutralPending = false;
  /** A closed tab must vacate its seat now: an un-destroyed socket parks the
   * host in the server's reconnect grace and guests stare at a frozen world. */
  private readonly onPageHide = (event: PageTransitionEvent): void => {
    if (!event.persisted) {
      this.net?.destroy();
    }
  };

  private view: View;
  private controls: Controls;
  private touch: TouchControls | null;

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
      window.addEventListener("pagehide", this.onPageHide);
      this.net = new MultiplayerClient({
        host: MULTIPLAYER_HOST,
        maxPlayers: ARENA_BOT_FILL,
        onEvent: (e, p, from) => this.onNetEvent(e, p, from),
        party: PARTY,
        room: opts.room,
      });
    } else {
      // soloMercy: hidden bot-damage softening for struggling humans — OFFLINE
      // ONLY (never set online; it must not shift the shared sim's balance)
      this.world = createWorld(0x1_23_4a_bc, { soloMercy: true });
      spawnHero(this.world, {
        champId: this.champId,
        id: this.localId,
        isBot: false,
        name: this.name,
        ownerId: "local",
        slot: 0,
        team: "local",
      });
      ensureBots(this.world);
    }

    this.worldView = new WorldView(view.scene, lib);
    this.worldView.localId = this.localId;
    this.worldView.setupBoss();
    this.environment = new Environment(view.scene, lib);
    this.environment.setup();
    // scenery is final — bake the static shadow map once
    view.refreshShadows();
    this.fx = new Fx(view.scene, view);
    // compile the FX programs before the first cast
    this.fx.warm(view.renderer, view.camera);
    this.fx.localId = this.localId;
    // ownerId flavor of the local identity ("local" offline, connId online —
    // refreshed per-frame in tickOnline once the connection knows itself)
    if (!opts.online) {
      this.fx.localOwnerId = "local";
    }
    this.worldView.fx = this.fx;
    this.hud = new Hud(
      view,
      this.fx,
      { buy: (id) => this.requestBuy(id), canShop: () => this.canShop() },
      opts.online
        ? { canRematch: () => this.canRematch(), kind: "online", rematch: () => this.rematch() }
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
    this.hud.setKitAction(() => this.guide.show(this.champId, this.localUnit()));
    // contextual hint engine — DOM-free; the HUD renders via showHint("" hides)
    this.hints = new Hints(
      () => this.touch?.active ?? false,
      (t) => this.hud.showHint(t),
    );

    this.statusEl = document.createElement("div");
    this.statusEl.style.cssText =
      "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font:800 22px ui-monospace,monospace;color:#9fd0ff;text-shadow:0 2px 6px #000;z-index:9;pointer-events:none";
    document.body.append(this.statusEl);

    // NB: the old fixed-center crosshair div lived here; superseded by the
    // HUD's #ba-reticle (hit-confirm ticks, fed by fx.localHits).

    // cinematic fly-in (both modes; only solo holds the sim)
    view.startIntro();
    // Observe short transport gaps even when no render frame falls inside them.
    this.net?.subscribe(() => this.syncConnection());
  }

  private get amHost(): boolean {
    return this.online.kind === "offline" || this.online.kind === "host";
  }

  private get hostDropped(): boolean {
    const { net } = this;
    return !!net && net.hostId !== null && net.players[net.hostId]?.connected === false;
  }

  private localUnit(): Unit | null {
    return this.world.units.get(this.localId) ?? null;
  }

  get isGuideOpen(): boolean {
    return this.guide.open;
  }

  // ── per-frame ──
  update(frameDt: number): void {
    this.guide.update(this.localUnit());
    // poll before any reads
    this.controls.update(this.controlsPaused || this.guide.open ? 0 : frameDt);
    const inspect = this.controls.consumeGuide();
    if (inspect && !this.controlsPaused && !this.guide.open && this.world.phase === "playing") {
      this.guide.show(this.champId, this.localUnit());
    }
    // real-time clock for the fly-in/countdown
    this.introTime += frameDt;
    if (this.net) {
      this.tickOnline(frameDt);
    } else {
      this.tickLocal(frameDt);
    }
    if (this.world.phase === "ended") {
      this.guide.close();
    }

    // adaptive resolution (real, unscaled dt)
    this.view.samplePerf(frameDt);
    const me = this.localUnit();
    // Surviving guests can receive a fresh world after the host restarts. Clear
    // the old match's presentation before its first new FX batch is consumed.
    if (this.musicPhase === "ended" && this.world.phase === "playing") {
      this.resetMusicDriver();
      this.fx.bestStreak = 0;
      this.fx.lastDeath = null;
    }
    // FX drains events first (it may arm a hit-stop), then the visual layer runs
    // on the slowed render-dt while the SIM already stepped on the real frameDt.
    this.fx.update(this.world, frameDt);
    const rdt = frameDt * this.fx.scaleNow();
    this.worldView.sync(this.world, rdt);
    if (me) {
      this.statusEl.textContent = this.hostDropped ? "Host reconnecting…" : "";
      this.hud.update(this.world, me, this.controls.scoreHeld(), frameDt);
      // listener facing must match the CAMERA frame so stereo pan tracks the
      // screen — the camera chases the aim on every input source
      this.fx.audio.setListener(me.x, me.y, this.aimX, this.aimY);
      if (this.touch && me.champId !== this.boundChamp) {
        this.boundChamp = me.champId;
        // icon backgrounds + keycaps, once
        this.touch.bindChamp(me.champId);
      }
      this.feedTouchCooldowns(me);
    } else if (this.world.phase === "ended") {
      this.statusEl.textContent = "";
      this.hud.updateUnassigned(this.world, frameDt);
    } else {
      this.statusEl.textContent =
        this.online.kind === "connecting" ? "Connecting…" : "Joining the arena…";
    }
    this.hints.update(this.world, me);
    this.driveIntro();
    this.driveMusic(frameDt, me);
    const cx = me ? me.x : 0;
    const cy = me ? me.y : 0;
    // Every input source is FPS-framed: the camera chases behind the aim with
    // the crosshair dead center (touch turns the view via the right stick, so
    // both sticks stay camera-relative and never flip under the thumbs).
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
    // proximity-driven decor (fountain rims)
    this.environment.setLocalPos(cx, cy);
    if (me) {
      this.environment.setHomeSlot(me.slot);
      // own fountain never warns
    }
    this.environment.update(this.world.gameTime);
    this.view.render();
  }

  // ── local mode ──
  private tickLocal(frameDt: number): void {
    if (this.controlsPaused || this.world.phase === "ended") {
      this.controls.setMouseMode(true);
      this.drainActionInput();
      this.acc = 0;
      return;
    }
    // Intro fly-in (SOLO ONLY): the world literally waits for you — hold the
    // fixed-step accumulator and suppress input until the countdown ends.
    // NEVER hold online: guests join a live match (camera sweep only there).
    if (this.introTime < INTRO_S) {
      this.acc = 0;
      // seed the heading from spawn facing NOW so the fly-in lands on the same
      // chase pose readInput will use (no camera snap at FIGHT)
      const me = this.localUnit();
      if (me && !this.aimInit) {
        this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
        this.aimInit = true;
      }
      const yaw = this.controls.aimYaw();
      this.aimX = Math.sin(yaw);
      this.aimY = Math.cos(yaw);
      // discard buffered edges so a stray click/keypress during the fly-in
      // doesn't fire the moment the countdown hits FIGHT
      this.drainActionInput();
      return;
    }
    const me = this.localUnit();
    if (me) {
      this.readInput(me, true, frameDt);
    }
    this.acc += frameDt;
    let n = 0;
    while (this.acc >= SIM_DT && n < 5 && this.world.phase === "playing") {
      step(this.world);
      this.acc -= SIM_DT;
      n += 1;
    }
  }

  /** Drive the HUD countdown + count/fight one-shots off the intro clock.
   *  hud.showIntro renders the text (change-gated; "" hides; "FIGHT!" pops). */
  private driveIntro(): void {
    const t = this.introTime;
    if (t > INTRO_S + 1.2) {
      return;
      // countdown + FIGHT flash fully done
    }
    if (this.net) {
      // online: the sim is live — no numerals, just the goal during the sweep
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

  // ── music intensity driver (result-05 A5) ──
  private driveMusic(frameDt: number, me: Unit | null): void {
    // Audio retains terminal intent even before its first unlock. Unmuting on
    // the result must not start combat layers or replay an old victory phrase.
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
    // null until the audio unlock gesture — don't track state the music system
    // never heard, or it would come up out of sync after unlock
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
      // escalate immediately
      this.musicIntensity = desired;
      this.musicLowSince = -1;
      music.setIntensity(desired);
    } else if (desired < this.musicIntensity) {
      // de-escalate only after sustained calm (drop hysteresis)
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

  private musicDesired(w: World, me: Unit): 0 | 1 | 2 | 3 {
    if (!me.alive) {
      return 0;
    }
    // 3: endgame stakes or a contested throne
    if (w.suddenDeath || w.matchTime - w.gameTime < 60) {
      return 3;
    }
    if (isInThrone(me.x, me.y) && this.enemyHeroNear(me, 0, 0, 11)) {
      return 3;
    }
    // 2: you lead, or you're close to the leader
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
    // 1: enemies near or recent combat
    if (this.enemyHeroNear(me, me.x, me.y, 14)) {
      return 1;
    }
    if (w.now - me.lastHitAt < 3000 || w.now - me.lastAttackAt < 3000) {
      return 1;
    }
    return 0;
  }

  private enemyHeroNear(me: Unit, x: number, y: number, r: number): boolean {
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

  /** Feed QWER cooldown sweeps to the touch buttons (int-percent change-gated). */
  private feedTouchCooldowns(me: Unit): void {
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
        // locked reads as a full sweep (dimmed)
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

  // ── online mode ──
  private syncConnection(): Seated | null {
    const { net } = this;
    if (!net) {
      return null;
    }
    const id = net.connectionStatus === "connected" ? net.playerId : null;
    if (!id) {
      if (this.online.kind !== "connecting") {
        this.resetHeldInput();
        this.neutralPending = true;
      }
      this.online = { kind: "connecting" };
      this.netFx = [];
      this.acc = 0;
      return null;
    }
    const current = this.online;
    let seat: Seated | null = current.kind === "guest" || current.kind === "host" ? current : null;
    if (seat?.id !== id) {
      seat = { id, kind: "guest", lastFxSeq: null };
      this.joinResendAt = -Infinity;
      this.neutralPending = true;
      // Keep fresh movement pressed during the gap; queued actions never replay.
      this.drainActionInput();
    } else if (seat.kind === "host" && !net.isHost) {
      seat = { id, kind: "guest", lastFxSeq: null };
      this.netFx = [];
      this.acc = 0;
    }
    this.online = seat;
    this.localId = `h-${id}`;
    this.worldView.localId = this.localId;
    this.fx.localId = this.localId;
    this.fx.localOwnerId = id;
    return seat;
  }

  /** Every admission path prepares authority first, including events arriving
   * between render frames and direct HUD purchases. */
  private prepareOnline(): Seated | null {
    const { net } = this;
    let seat = this.syncConnection();
    if (!net || !seat) {
      return null;
    }
    const { snap } = net.sharedState;
    if (seat.kind === "guest" && net.isHost) {
      // Malformed room state is not permission to overwrite a live match.
      if (snap !== undefined && snap !== null && !isSnapshot(snap)) {
        return null;
      }
      const roster = restoreHostState(this.world, isSnapshot(snap) ? snap : null);
      this.picks = { ...this.picks, ...roster.picks };
      this.assign = roster.seats;
      this.netFx = [];
      this.acc = 0;
      this.snapAcc = 0;
      seat = {
        fxSeqOut: sharedCounter(net.sharedState["fxSeq"]),
        id: seat.id,
        kind: "host",
        lastFxSeq: null,
      };
      this.online = seat;
    } else if (seat.kind === "guest") {
      if (!isSnapshot(snap)) {
        return null;
      }
      applySnapshot(this.world, snap);
    }
    const generation = sharedCounter(net.sharedState["matchGeneration"]);
    if (this.matchGeneration !== null && generation !== this.matchGeneration) {
      this.resetMatchPresentation();
    }
    this.matchGeneration = generation;
    if (seat.lastFxSeq === null) {
      seat.lastFxSeq = sharedCounter(net.sharedState["fxSeq"]);
      this.world.fx.length = 0;
    }
    return seat;
  }

  private announcePick(net: MultiplayerClient): void {
    const id = net.playerId;
    if (!id) {
      return;
    }
    const now = performance.now();
    if (now - this.joinResendAt < 3000) {
      return;
    }
    const pick = { champId: this.champId, name: this.name };
    this.picks[id] ??= pick;
    net.sendEvent(INTENT_EVENT, { kind: "join", ...pick } satisfies Intent);
    this.joinResendAt = now;
  }

  private tickOnline(frameDt: number): void {
    const { net } = this;
    const seat = this.prepareOnline();
    if (!net || !seat) {
      this.drainActionInput();
      return;
    }
    this.announcePick(net);
    if (seat.kind === "host") {
      this.reconcileHeroes(net);
    }
    this.flushNeutralInput();
    if (this.controlsPaused || this.world.phase === "ended") {
      this.controls.setMouseMode(true);
      this.drainActionInput();
    } else {
      const me = this.localUnit();
      if (me) {
        this.readInput(me, seat.kind === "host", frameDt);
      } else {
        this.drainActionInput();
      }
    }
    if (seat.kind === "host") {
      this.acc = this.world.phase === "playing" ? this.acc + frameDt : 0;
      let n = 0;
      while (this.acc >= SIM_DT && n < 5 && this.world.phase === "playing") {
        step(this.world);
        this.acc -= SIM_DT;
        n += 1;
      }
      if (this.world.fx.length) {
        this.netFx.push(...this.world.fx);
      }
      this.broadcast(frameDt);
    } else {
      const { fxSeq } = net.sharedState;
      if (isJsonNumber(fxSeq) && fxSeq !== seat.lastFxSeq) {
        seat.lastFxSeq = fxSeq;
        const { fx } = net.sharedState;
        if (Array.isArray(fx)) {
          // SAFETY: sharedState.fx is written only by the host's broadcast
          // (this same build serializing this.netFx), so its entries are FX
          // events; they are render-only and never feed back into the sim.
          this.world.fx.push(...(fx as World["fx"]));
        }
      }
    }
  }

  /** Compose forward/strafe into a world-space vector relative to the aim
   *  ((-aimY, aimX) is screen-right when looking along the aim). */
  private rotateToAim(fwd: number, strafe: number): Vec2 {
    return {
      x: this.aimX * fwd - this.aimY * strafe,
      y: this.aimY * fwd + this.aimX * strafe,
    };
  }

  /** Read controls → apply locally (host) or send as an intent (guest). */
  private readInput(me: Unit, host: boolean, dt: number): void {
    // MOUSE mode while a menu owns the cursor (shop, end screen); ACTION mode
    // (locked pointer) the rest of the match. Controls no-ops when unchanged.
    this.controls.setMouseMode(
      this.controlsPaused || this.guide.open || this.hud.isShopOpen || this.world.phase === "ended",
    );
    if (this.controlsPaused || this.world.phase === "ended") {
      // Results own input. Drain edges so a new round cannot inherit a cast.
      this.drainActionInput();
      return;
    }
    if (this.guide.open) {
      this.drainActionInput();
      if (host) {
        setHeroInput(me, 0, 0, this.aimX, this.aimY, false);
      }
      return;
    }
    if (!me.alive) {
      if (host) {
        setHeroInput(me, 0, 0, this.aimX, this.aimY, false);
      }
      return;
    }
    this.readAim(me, dt);
    const { mv, attack: attackHeld } = this.readMove();
    let attack = attackHeld;
    const castPoint: Vec2 = { x: me.x + this.aimX * 8, y: me.y + this.aimY * 8 };

    // JUMP ability: while AIRBORNE an LMB-edge casts the leaping strike and
    // suppresses that frame's basic (a grounded click stays a normal attack).
    // Touch fires it directly via its JUMP button — dispatch self-leaps if
    // grounded, so the ability works uniformly for touch/bots/guests. The LMB
    // edge is drained every frame so a grounded click never lingers into a hop.
    const airborne = this.world.now < me.jumpUntil;
    const lmbJump = this.controls.consumeAttackEdge() && airborne;
    const touchJump = this.touch?.consumeJumpAttack() ?? false;
    if (lmbJump || touchJump) {
      if (lmbJump) {
        attack = false;
        // resolve the ambiguous airborne LMB toward JUMP
      }
      this.dispatchCast(host, me, "JUMP", { x: this.aimX, y: this.aimY }, castPoint);
    }

    if (host) {
      setHeroInput(me, mv.x, mv.y, this.aimX, this.aimY, attack);
    } else {
      this.net?.sendEvent(INTENT_EVENT, {
        attack,
        ax: this.aimX,
        ay: this.aimY,
        kind: "input",
        mx: mv.x,
        my: mv.y,
      } satisfies Intent);
    }

    this.readAbilities(me, host, castPoint);
    this.readHop(me, host);
    this.readDash(me, host, mv, castPoint);
    this.readItems(me, host, castPoint);
    this.readBuy();
  }

  /** FPS-centered aim for EVERY input source: heading comes from mouse turn,
   *  pad stick, or the touch look stick; the crosshair is dead center. The
   *  character faces the crosshair; camera trails behind. */
  private readAim(me: Unit, dt: number): void {
    if (!this.aimInit) {
      this.controls.setYaw(Math.atan2(me.aimX, me.aimY));
      this.aimInit = true;
    }
    if (this.touch?.active) {
      // the right stick TURNS the view (pad-rate mapping into yaw/pitch)
      // instead of aiming in screen space — so the camera tracks the aim
      const look = this.touch.lookVec();
      if (look) {
        this.controls.applyStickLook(look.x, look.y, dt);
      }
    }
    const yaw = this.controls.aimYaw();
    this.aimX = Math.sin(yaw);
    this.aimY = Math.cos(yaw);
  }

  private readMove(): MoveInput {
    if (this.touch?.active) {
      // stick axes are y-down; up = forward
      const m = this.touch.moveVec();
      // analog magnitude carries through
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

  /** Host casts through the sim's input buffer; a guest sends the intent. */
  private dispatchCast(host: boolean, me: Unit, key: AbilityKey, dir: Vec2, point: Vec2): void {
    if (host) {
      requestCast(this.world, me, key, { dir, point });
    } else {
      this.net?.sendEvent(INTENT_EVENT, {
        ax: dir.x,
        ay: dir.y,
        key,
        kind: "cast",
        px: point.x,
        py: point.y,
      } satisfies Intent);
    }
  }

  private readAbilities(me: Unit, host: boolean, castPoint: Vec2): void {
    const keys = [...this.controls.consumeAbilities(), ...(this.touch?.consumeAbilities() ?? [])];
    for (const key of keys) {
      // deny feedback is a pre-check (locked / beyond the buffer window) — a
      // requestCast returning false may just mean "buffered", which is not a
      // deny. The cast/intent is ALWAYS issued; the host stays authoritative.
      if (this.wouldDeny(me, key)) {
        this.fx.audio.castDeny();
      }
      this.dispatchCast(host, me, key, { x: this.aimX, y: this.aimY }, castPoint);
    }
  }

  /** Space / touch HOP: evasive hop (drain both edges every frame). */
  private readHop(me: Unit, host: boolean): void {
    const kbJump = this.controls.consumeJump();
    const tJump = this.touch?.consumeJump() ?? false;
    if (kbJump || tJump) {
      if (host) {
        tryJump(this.world, me);
      } else {
        this.net?.sendEvent(INTENT_EVENT, { kind: "jump" } satisfies Intent);
      }
    }
  }

  /** Shift / touch DASH: cast the hero's DASH ability (mobility + i-frames).
   *  It goes in the MOVEMENT (arrow) direction — where you're steering — and
   *  only falls back to the aim direction when standing still. */
  private readDash(me: Unit, host: boolean, mv: Vec2, castPoint: Vec2): void {
    const dash = this.controls.consumeDash() || (this.touch?.consumeDash() ?? false);
    if (dash) {
      const dashDir = mv.x !== 0 || mv.y !== 0 ? mv : { x: this.aimX, y: this.aimY };
      this.dispatchCast(host, me, "DASH", dashDir, castPoint);
    }
  }

  /** Item actives: 5–0 keys + belt-chip taps (the only touch path to items). */
  private readItems(me: Unit, host: boolean, castPoint: Vec2): void {
    for (const slot of [...this.controls.consumeItems(), ...this.hud.consumeItemTaps()]) {
      if (host) {
        activateItem(this.world, me, slot, castPoint);
      } else {
        this.net?.sendEvent(INTENT_EVENT, {
          kind: "useItem",
          px: castPoint.x,
          py: castPoint.y,
          slot,
        } satisfies Intent);
      }
    }
  }

  private readBuy(): void {
    const buy = this.controls.consumeBuy() || (this.touch?.consumeBuy() ?? false);
    if (buy && (this.canShop() || this.hud.isShopOpen)) {
      this.hud.toggleShop();
      if (this.hud.isShopOpen) {
        this.hints.notifyShopOpened();
        // early-dismiss the shop hint
      }
    }
  }

  /** Locked, or on cooldown past the sim's buffer window → the press is a deny. */
  private wouldDeny(me: Unit, key: AbilityKey): boolean {
    const slot = me.abilities[key];
    return slot.rank < 1 || slot.readyAt - this.world.now > CAST_BUFFER_MS;
  }

  private requestBuy(itemId: string): void {
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
      this.net?.sendEvent(INTENT_EVENT, { itemId, kind: "buy" } satisfies Intent);
    }
  }

  // ── host: receive intents ──
  private onNetEvent(event: string, payload: JsonValue, from: string): void {
    if (event !== INTENT_EVENT) {
      return;
    }
    // Parse the wire intent field-by-field — a malformed/malicious client must
    // not inject NaN/Inf or spoofed shapes into the authoritative sim.
    if (!isJsonObject(payload)) {
      return;
    }
    const { net } = this;
    if (!net || !this.prepareOnline()) {
      return;
    }
    const sender = net.players[from];
    if (!sender || sender.connected === false) {
      return;
    }
    const intent = payload;
    if (intent["kind"] === "join") {
      const { champId } = intent;
      const { name } = intent;
      if (isJsonString(champId) && CHAMP_BY_ID[champId] && isJsonString(name)) {
        this.picks[from] = { champId, name: name.slice(0, 14) };
      }
      return;
    }
    const u = this.intentUnit(net, from);
    if (u) {
      this.applyIntent(u, intent);
    }
  }

  /** The hero a sender's gameplay intent may drive right now: only while this
   *  client hosts a live round, the hero is alive, and (for the host's own
   *  seat) the pause tablet is not up. */
  private intentUnit(net: MultiplayerClient, from: string): Unit | null {
    if (!this.amHost || this.world.phase !== "playing") {
      return null;
    }
    if (from === net.playerId && this.controlsPaused) {
      return null;
    }
    const u = this.world.units.get(`h-${from}`);
    return u && u.alive ? u : null;
  }

  private applyIntent(u: Unit, intent: JsonObject): void {
    switch (intent["kind"]) {
      case "input": {
        setHeroInput(
          u,
          clamp1(num(intent["mx"])),
          clamp1(num(intent["my"])),
          clamp1(num(intent["ax"])),
          clamp1(num(intent["ay"])),
          intent["attack"] === true,
        );
        break;
      }
      case "cast": {
        // reject a bad/spoofed key before it reaches the sim; requestCast so
        // guests get the same host-side input buffer as locals
        const key = ALL_ABILITY_KEYS.find((k) => k === intent["key"]);
        if (!key) {
          break;
        }
        requestCast(this.world, u, key, {
          dir: { x: clamp1(num(intent["ax"])), y: clamp1(num(intent["ay"])) },
          point: { x: numArena(intent["px"]), y: numArena(intent["py"]) },
        });
        break;
      }
      case "buy": {
        const { itemId } = intent;
        if (isJsonString(itemId)) {
          buyItem(this.world, u, itemId);
        }
        break;
      }
      case "useItem": {
        activateItem(this.world, u, num(intent["slot"]), {
          x: numArena(intent["px"]),
          y: numArena(intent["py"]),
        });
        break;
      }
      case "jump": {
        tryJump(this.world, u);
        break;
      }
      default: {
        break;
      }
    }
  }

  // ── host: spawn/maintain hero set ──
  private reconcileHeroes(net: MultiplayerClient): void {
    reconcileHostHeroes(this.world, net.players, this.picks, this.assign);
  }

  private broadcast(dt: number): void {
    const { net } = this;
    const seat = this.online;
    if (!net || seat.kind !== "host") {
      return;
    }
    this.snapAcc += dt;
    if (this.snapAcc < 1 / SNAPSHOT_HZ) {
      return;
    }
    this.snapAcc = 0;
    seat.fxSeqOut += 1;
    // our own rendered batch must never echo on reconnect
    seat.lastFxSeq = seat.fxSeqOut;
    net.updateSharedState({
      fx: this.netFx,
      fxSeq: seat.fxSeqOut,
      matchGeneration: this.matchGeneration ?? 0,
      snap: structuredClone(encodeWorld(this.world)),
    });
    this.netFx = [];
  }

  private canRematch(): boolean {
    return !this.controlsPaused && this.online.kind === "host" && this.world.phase === "ended";
  }

  private rematch(): void {
    if (!this.prepareOnline() || !this.canRematch()) {
      return;
    }
    const { net } = this;
    if (!net) {
      return;
    }
    const roster = humanRoster(this.world);
    this.picks = { ...this.picks, ...roster.picks };
    this.assign = roster.seats;
    // This explicit host action is the only way an accepted round is replaced.
    restoreHostState(this.world, null);
    this.reconcileHeroes(net);
    this.matchGeneration = (this.matchGeneration ?? 0) + 1;
    this.netFx = [];
    this.world.fx.length = 0;
    this.acc = 0;
    this.resetMatchPresentation();
    this.broadcast(1 / SNAPSHOT_HZ);
  }

  private resetMatchPresentation(): void {
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
    if (this.online.kind === "guest" || this.online.kind === "host") {
      this.online.lastFxSeq = null;
    }
  }

  private resetMusicDriver(): void {
    this.musicPhase = "playing";
    this.musicClock = 0;
    this.musicAcc = 0;
    this.musicIntensity = 0;
    this.musicLowSince = -1;
    this.fx.audio.beginMatch();
  }

  private drainActionInput(): void {
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

  private resetHeldInput(): void {
    this.controls.resetInput();
    this.touch?.resetInput();
    this.hud.consumeItemTaps();
  }

  /** Pause/transport loss releases a persistent attack/move without stopping
   * an online host. If disconnected, defer the release until identity is valid. */
  private flushNeutralInput(): void {
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
      this.net?.sendEvent(INTENT_EVENT, {
        attack: false,
        ax: me.aimX,
        ay: me.aimY,
        kind: "input",
        mx: 0,
        my: 0,
      } satisfies Intent);
    }
    this.neutralPending = false;
  }

  private canShop(): boolean {
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
  get audio(): Audio {
    return this.fx.audio;
  }

  diagnostics() {
    const me = this.localUnit();
    return {
      audio: this.fx.audio.diagnostics(),
      complete: this.world.phase === "ended",
      online: this.net
        ? {
            authority: this.amHost,
            connection: this.net.connectionStatus,
            hostId: this.net.hostId,
            matchGeneration: this.matchGeneration,
            playerId: this.net.playerId,
          }
        : null,
      phase: this.world.phase,
      player: me ? { alive: me.alive, hp: me.hp, x: me.x, y: me.y } : null,
      score: me?.kills ?? 0,
    };
  }

  /** Wrapper-requested pause/resume (see main.ts's setPauseHandlers wiring) —
   *  offline only, the sim itself is frozen by simply not calling update(). */
  pauseAudio(): void {
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

  resumeAudio(): void {
    this.resetHeldInput();
    this.controlsPaused = false;
    this.controls.setMouseMode(this.hud.isShopOpen || this.world.phase === "ended");
    this.hud.setPaused(false);
    this.fx.audio.resume();
  }
}

/** Player name for quick-start boots: ?name → localStorage["ba-name"] → "Player". */
export const chosenName = (): string => {
  const fromUrl = new URLSearchParams(location.search).get("name")?.trim();
  if (fromUrl) {
    return fromUrl.slice(0, 14);
  }
  const stored = readPreference("ba-name")?.trim();
  return stored ? stored.slice(0, 14) : "Player";
};
