import { abilityReadiness } from "../render/hud-readability";
import { readPreference } from "../data/preferences";
import { AbilityGuide } from "../render/ability-guide";
// Game scene — runs local (vs bots) or online (host-authoritative). The sim is
// identical in both; only authority + transport differ. The host simulates and
// broadcasts a frame per tick (net/host-net.ts); a guest predicts its own hero
// on the same movement code, draws everyone else interpolated slightly in the
// past (net/mirror.ts), and sends its input to the host once per tick when it
// changes. Only the server elects a host.
import { MultiplayerClient } from "@vibedgames/multiplayer";
import {
  ARENA_BOT_FILL,
  KILL_GOAL_FFA,
  MAX_CATCH_UP_TICKS,
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
import { humanRoster, reconcileHostHeroes, restoreHostState } from "../net/host-state";
import type { HeroPick, OnlineSeat } from "../net/host-state";
import { HostNet } from "../net/host-net";
import type { HostLink } from "../net/host-net";
import { inputWire, parseInput } from "../net/input";
import { NetMirror, parseFrame } from "../net/mirror";
import { OwnHeroPredictor } from "../net/own-hero";
import type { HeldInput } from "../net/own-hero";
import type { Vec2 } from "../sim/math";
import { isJsonNumber, isJsonObject, isJsonString } from "../data/json";
import type { JsonValue } from "../data/json";
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
import { sensePlaytest } from "../playtest/sense";

// camera fly-in length; solo holds the sim this long (NEVER online)
const INTRO_S = 2.4;
// visual layers never step more than this per frame (the sim catches up on
// the real elapsed time instead, so a slow frame never slows the match)
const MAX_VISUAL_DT = 1 / 30;
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
  /** Playtest staging (offline only): the solo world's RNG seed, and whether
   *  to drop the 3-2-1 hold so the first input lands on a live sim. */
  seed?: number;
  skipIntro?: boolean;
}

const SOLO_SEED = 0x1_23_4a_bc;

/** Connection-derived authority. */
type Online =
  | { kind: "offline" }
  | { kind: "connecting" }
  | { kind: "guest"; id: string }
  | { kind: "host"; id: string };
type Seated = Extract<Online, { kind: "guest" | "host" }>;

const sharedCounter = (value: JsonValue | undefined): number =>
  isJsonNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;

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
  private matchGeneration: number | null = null;
  // host: the fixed-step loop, frame stream and guest input buffers
  private hostNet = new HostNet();
  // guest: the host's world as received, and the own hero's prediction
  private readonly mirror = new NetMirror();
  private readonly predictor = new OwnHeroPredictor();
  // guest: controls held this frame (the predictor samples them per tick)
  private held: HeldInput = { attack: false, ax: 0, ay: 1, mx: 0, my: 0 };
  // guest: the last shared snapshot adopted, and the host it came from
  private lastSnap: JsonValue | undefined = undefined;
  private mirrorHost: string | null = null;
  // guest: a new host's first snapshot restarts the prediction from its world
  private ownResync = false;
  private controlsPaused = false;
  private neutralPending = false;
  // enemies (creeps + champions) the local player has slain this match
  private takedowns = 0;
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
      this.world = this.createSoloWorld(opts.seed ?? SOLO_SEED);
      if (opts.skipIntro) {
        this.introTime = INTRO_S;
      }
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
    // Observe short transport gaps even when no render frame falls inside them,
    // and adopt each shared snapshot in arrival order with the frames.
    this.net?.subscribe(() => {
      this.syncConnection();
      this.ingestShared();
    });
  }

  private createSoloWorld(seed: number): World {
    // soloMercy: hidden bot-damage softening for struggling humans — OFFLINE
    // ONLY (never set online; it must not shift the shared sim's balance)
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
  restartSolo(seed: number): void {
    if (this.net) {
      return;
    }
    this.world = this.createSoloWorld(seed);
    this.acc = 0;
    this.takedowns = 0;
    this.introTime = INTRO_S;
    this.resetMatchPresentation();
  }

  get isOffline(): boolean {
    return this.net === null;
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
  /** `elapsed` is the real time since the last frame (s, main.ts caps it at a
   *  quarter second): the sim advances by it, visuals by at most a 30 fps step. */
  update(elapsed: number): void {
    const frameDt = Math.min(elapsed, MAX_VISUAL_DT);
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
      this.tickOnline(elapsed, frameDt);
    } else {
      this.tickLocal(elapsed, frameDt);
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
    this.countTakedowns();
    // FX drains events first (it may arm a hit-stop), then the visual layer runs
    // on the slowed render-dt while the SIM already stepped on the real frameDt.
    this.fx.update(this.world, frameDt);
    const rdt = frameDt * this.fx.scaleNow();
    this.worldView.smoothUnits = this.online.kind !== "guest";
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
  private tickLocal(elapsed: number, frameDt: number): void {
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
    this.acc += elapsed;
    let n = 0;
    while (this.acc >= SIM_DT && n < MAX_CATCH_UP_TICKS && this.world.phase === "playing") {
      step(this.world);
      this.acc -= SIM_DT;
      n += 1;
    }
    // a stall past the step cap is skipped, not replayed over the next frames
    this.acc = Math.min(this.acc, SIM_DT);
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
      this.acc = 0;
      return null;
    }
    const current = this.online;
    let seat: Seated | null = current.kind === "guest" || current.kind === "host" ? current : null;
    if (seat?.id !== id) {
      seat = { id, kind: "guest" };
      this.joinResendAt = -Infinity;
      this.neutralPending = true;
      // Keep fresh movement pressed during the gap; queued actions never replay.
      this.drainActionInput();
      // a new connection missed frames: interpolate and predict afresh
      this.mirrorHost = null;
    } else if (seat.kind === "host" && !net.isHost) {
      seat = { id, kind: "guest" };
      this.acc = 0;
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

  /** Every admission path prepares authority first, including events arriving
   * between render frames and direct HUD purchases. */
  private prepareOnline(): Seated | null {
    const { net } = this;
    let seat = this.syncConnection();
    if (!net || !seat) {
      return null;
    }
    if (seat.kind === "guest" && net.isHost) {
      const { snap } = net.sharedState;
      // Malformed room state is not permission to overwrite a live match.
      if (snap !== undefined && snap !== null && !isSnapshot(snap)) {
        return null;
      }
      const roster = restoreHostState(this.world, isSnapshot(snap) ? snap : null);
      this.picks = { ...this.picks, ...roster.picks };
      this.assign = roster.seats;
      this.acc = 0;
      // carry the old host's frame clock on, and send the restored world whole
      this.hostNet = new HostNet(this.mirror.latestT);
      this.mirror.reset();
      this.predictor.reset();
      seat = { id: seat.id, kind: "host" };
      this.online = seat;
    }
    if (seat.kind === "host") {
      // Guests learn of a new match from its snapshot (ingestShared).
      const generation = sharedCounter(net.sharedState["matchGeneration"]);
      if (this.matchGeneration !== null && generation !== this.matchGeneration) {
        this.resetMatchPresentation();
      }
      this.matchGeneration = generation;
    }
    return seat;
  }

  /** Guest: adopt a new shared snapshot the moment it lands, in order with the
   *  frames around it (the ~1 Hz resync, a new match, a new host's world). */
  private ingestShared(): void {
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
    const generation = sharedCounter(net.sharedState["matchGeneration"]);
    const newMatch = this.matchGeneration !== null && generation !== this.matchGeneration;
    if (newMatch || this.ownResync) {
      // positions restart: nothing may blend from the old world into this one
      this.mirror.reset();
      this.predictor.reset();
      this.ownResync = false;
    }
    const { snapT } = net.sharedState;
    this.mirror.applySnapshot(
      this.world,
      snap,
      isJsonNumber(snapT) ? snapT : null,
      performance.now(),
    );
    if (newMatch) {
      this.resetMatchPresentation();
    }
    this.matchGeneration = generation;
  }

  /** Guest: a new host is a new clock and a new world. Interpolation and
   *  prediction restart, and the new host learns the held input at once. */
  private trackHost(net: MultiplayerClient): void {
    if (net.hostId === this.mirrorHost) {
      return;
    }
    this.mirrorHost = net.hostId;
    this.mirror.resetClock();
    this.predictor.reset();
    this.predictor.resend();
    this.ownResync = true;
  }

  /** Guest: one host frame, applied on arrival. */
  private onFrame(net: MultiplayerClient, payload: JsonValue, from: string): void {
    const seat = this.prepareOnline();
    if (seat?.kind !== "guest" || from !== net.hostId) {
      return;
    }
    const frame = parseFrame(payload);
    if (!frame) {
      return;
    }
    this.trackHost(net);
    const own = this.mirror.applyFrame(this.world, frame, performance.now());
    if (own) {
      this.predictor.hostUpdate(own);
    }
  }

  private announcePick(net: MultiplayerClient): void {
    const id = net.playerId;
    const host = net.hostId;
    if (!id || !host) {
      return;
    }
    const now = performance.now();
    if (now - this.joinResendAt < 3000) {
      return;
    }
    const pick = { champId: this.champId, name: this.name };
    this.picks[id] ??= pick;
    net.sendEvent(INTENT_EVENT, { kind: "join", ...pick } satisfies Intent, { to: host });
    this.joinResendAt = now;
  }

  private tickOnline(elapsed: number, frameDt: number): void {
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
      // the sim clock and every remote body for this frame, before input reads them
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
      const target = net.hostId;
      // a host in its reconnect grace hears nothing: stand still until it is back
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
          if (target) {
            net.sendEvent(INTENT_EVENT, inputWire(p), { to: target });
          }
        },
      );
      this.predictor.render(me, this.world.units, this.held);
    }
  }

  /** Host: how the frame loop reaches the room. */
  private hostLink(net: MultiplayerClient, id: string): HostLink {
    return {
      inputHero: (ownerId) => (ownerId === id ? null : this.intentUnit(net, ownerId)),
      publish: (snap, t) =>
        net.updateSharedState({ matchGeneration: this.matchGeneration ?? 0, snap, snapT: t }),
      sendFrame: (frame) => net.sendEvent(FRAME_EVENT, frame, { except: id }),
    };
  }

  /** Compose forward/strafe into a world-space vector relative to the aim
   *  ((-aimY, aimX) is screen-right when looking along the aim). */
  private rotateToAim(fwd: number, strafe: number): Vec2 {
    return {
      x: this.aimX * fwd - this.aimY * strafe,
      y: this.aimY * fwd + this.aimX * strafe,
    };
  }

  /** Read controls → apply locally (host) or hand to the next predicted tick
   *  (guest — the predictor moves the body at once and sends the tick's input). */
  private readInput(me: Unit, host: boolean, dt: number): void {
    // MOUSE mode while a menu owns the cursor (shop, end screen); ACTION mode
    // (locked pointer) the rest of the match. Controls no-ops when unchanged.
    this.controls.setMouseMode(
      this.controlsPaused || this.guide.open || this.hud.isShopOpen || this.world.phase === "ended",
    );
    if (this.controlsPaused || this.world.phase === "ended") {
      // Results own input. Drain edges so a new round cannot inherit a cast.
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

    // JUMP ability: while AIRBORNE an LMB-edge casts the leaping strike and
    // suppresses that frame's basic (a grounded click stays a normal attack).
    // Touch fires it directly via its JUMP button — dispatch self-leaps if
    // grounded, so the ability works uniformly for touch/bots/guests. The LMB
    // edge is drained every frame so a grounded click never lingers into a hop.
    const airborne = this.world.now < me.jumpUntil;
    const attackEdge = this.controls.consumeAttackEdge();
    const lmbJump = attackEdge && airborne;
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
      this.held = { attack, ax: this.aimX, ay: this.aimY, mx: mv.x, my: mv.y };
      // a click shorter than a tick still swings once on the host
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

  /** Guest: hold still (aim kept) until input is live again. */
  private holdNeutral(me: Unit | null): void {
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

  /** Host casts through the sim's input buffer; a guest's cast rides its next
   *  tick's input (a DASH/JUMP is also predicted there). */
  private dispatchCast(host: boolean, me: Unit, key: AbilityKey, dir: Vec2, point: Vec2): void {
    if (host) {
      requestCast(this.world, me, key, { dir, point });
    } else if (key === "DASH") {
      this.predictor.pending.dash = dir;
    } else {
      this.predictor.pending.casts.push({ dir, key, point });
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
        this.predictor.pending.jump = true;
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
        this.predictor.pending.items.push({ point: castPoint, slot });
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
    const host = this.net?.hostId;
    if (this.amHost) {
      buyItem(this.world, me, itemId);
    } else if (host) {
      this.net?.sendEvent(INTENT_EVENT, { itemId, kind: "buy" } satisfies Intent, { to: host });
    }
  }

  // ── network events ──
  private onNetEvent(event: string, payload: JsonValue, from: string): void {
    const { net } = this;
    if (!net) {
      return;
    }
    if (event === FRAME_EVENT) {
      this.onFrame(net, payload, from);
      return;
    }
    // Intents are for the host alone: a guest has nothing to prepare for them.
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
    // Parse the wire intent field-by-field — a malformed/malicious client must
    // not inject NaN/Inf or spoofed shapes into the authoritative sim.
    switch (payload["kind"]) {
      case "join": {
        const { champId, name } = payload;
        if (isJsonString(champId) && CHAMP_BY_ID[champId] && isJsonString(name)) {
          this.picks[from] = { champId, name: name.slice(0, 14) };
        }
        break;
      }
      case "input": {
        const packet = parseInput(payload);
        // the host's own hero never rides packets — it reads its controls
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

  // ── host: spawn/maintain hero set ──
  private reconcileHeroes(net: MultiplayerClient): void {
    reconcileHostHeroes(this.world, net.players, this.picks, this.assign);
    this.hostNet.forget((ownerId) => net.players[ownerId] !== undefined);
  }

  private canRematch(): boolean {
    return !this.controlsPaused && this.online.kind === "host" && this.world.phase === "ended";
  }

  private rematch(): void {
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
    // This explicit host action is the only way an accepted round is replaced.
    restoreHostState(this.world, null);
    this.reconcileHeroes(net);
    this.matchGeneration = (this.matchGeneration ?? 0) + 1;
    this.world.fx.length = 0;
    this.acc = 0;
    this.resetMatchPresentation();
    // the new generation and its world go out together, now; frames follow whole
    this.hostNet.resync();
    this.hostNet.publishNow(this.world, this.hostLink(net, seat.id));
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
      // the next predicted tick sends it
      this.holdNeutral(me);
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

  private countTakedowns(): void {
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
            // own-hero prediction error still being eased out (world units)
            correction: this.online.kind === "guest" ? this.predictor.correction : 0,
            hostId: this.net.hostId,
            matchGeneration: this.matchGeneration,
            playerId: this.net.playerId,
          }
        : null,
      phase: this.world.phase,
      player: me ? { alive: me.alive, hp: me.hp, x: me.x, y: me.y } : undefined,
      score: this.takedowns,
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
