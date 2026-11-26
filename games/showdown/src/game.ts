import * as THREE from "three";

import { isOfflineRequested, pauseGame } from "@repo/embed";
import { FixedRate } from "@vibedgames/multiplayer";

import { Bot } from "./ai/bot";
import { AimGuide } from "./aim-guide";
import { GameAudio } from "./audio";
import { updateCamera, CAMERA_FOV } from "./camera";
import { Combat } from "./combat/combat";
import { Gas } from "./combat/gas";
import { BOT_NAMES, BRAWLERS, DIFFICULTIES, RESTART_DELAY_S, TUNING, isBrawlerId } from "./config";
import type { BrawlerId, Difficulty, DifficultyName, QualityName } from "./config";
import { Brawler } from "./entities/brawler";
import { Effects } from "./fx/effects";
import { mustGet } from "./dom";
import { Hud } from "./hud";
import { setNetStatus, setResultMode, setResultWait, setSpectateCopy } from "./hud-lobby";
import { Input, isFormField, keyCode } from "./input";
import { MenuPad } from "./menu-pad";
import { tick as tickDiagnostics } from "./diagnostics";
import { Mercy } from "./polish/mercy";
import { recordRun } from "./polish/best-run";
import { GuestView } from "./net/guest";
import { applyRemoteIntents, onlineSeats, reconcileSeats, restoreFromWorld } from "./net/host";
import type { Pick } from "./net/host";
import { setRecorders } from "./net/presentation";
import type { FxRecord } from "./net/presentation";
import { SNAPSHOT_HZ, seatId } from "./net/protocol";
import { Session } from "./net/session";
import { encodeBoxes, encodeCubes, encodeFrame, encodeMatch } from "./net/snapshot";
import { controlPlayer } from "./player-control";
import { adaptQuality, benchmarkQuality } from "./quality-auto";
import { Lighting } from "./render/lighting";
import { Pipeline } from "./render/pipeline";
import { separateBrawlers, updateVisibility } from "./roster-sim";
import { loadSettings, resolveDifficulty, resolveQuality, storeSettings } from "./settings-store";
import type { SavedSettings } from "./settings-store";
import { clamp, dist, lerp, rand, seededRandom } from "./utils";
import type { Rng } from "./utils";
import { saltedSeed } from "./world/grid";
import { World } from "./world/world";

export type GameState = "menu" | "countdown" | "playing" | "ended";

/** Who advances the world: this client alone, this client for the room, or the room's host. */
export type GameMode = "solo" | "connecting" | "host" | "guest";

export interface OnlineOptions {
  name: string;
  room: string;
}

export interface GameOptions {
  onLoadProgress?: (progress: number, label: string) => void;
  /** Called whenever a match begins (the embed wrapper uses it to clear its chrome). */
  onMatchStart?: () => void;
  /** Join a room straight away instead of showing the menu. */
  online?: OnlineOptions;
  /** Pre-select a brawler card on the menu. */
  selected?: BrawlerId;
}

export interface PerfState {
  /** Median night-frame time from the startup benchmark, when it ran. */
  benchMs?: number;
  done: boolean;
  frames: number;
  t: number;
}

export interface PendingResult {
  rank: number;
  t: number;
  won: boolean;
}

const TIME_PRESETS: readonly (number | null)[] = [null, 12.5, 17.6, 18.6, 19.4, 21.5];

const SUPER_GLOW = new THREE.Color(0xff_c9_3a);
const PLAYER_GLOW = new THREE.Color(0xff_e0_a0);

const WARMUP_FRAMES = 3;
const COUNTDOWN_S = 3.4;
const COUNTDOWN_GO_S = 0.4;
const ATTRACT_RESTART_S = 2.5;
const MAX_STEP_S = 0.05;
const MAX_CATCH_UP_S = 0.25;
const OFFLINE_TOAST = "Couldn't reach the party server — playing vs bots";
const GUEST_WAIT = "Waiting for the next brawl…";
const MAX_PENDING_FX = 400;

const MATCH_SALT = 0x6d_61_74_63;

const randomSeed = () => Math.trunc(Math.random() * 1e9);

const numberParam = (params: URLSearchParams, name: string) => {
  const raw = params.get(name);

  return raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
};

const shuffle = <T>(items: T[], rng: Rng) => {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const a = items[i];
    const b = items[j];

    if (a !== undefined && b !== undefined) {
      items[i] = b;
      items[j] = a;
    }
  }

  return items;
};

const mustGetCanvas = (id: string) => {
  const el = mustGet(id);

  if (!(el instanceof HTMLCanvasElement)) {
    throw new TypeError(`#${id} is not a <canvas>`);
  }

  return el;
};

const formatHour = (hour: number) =>
  `${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.round((hour % 1) * 60)).padStart(2, "0")}`;

const aliveCount = (brawlers: readonly Brawler[]) =>
  brawlers.reduce((count, b) => count + (b.alive ? 1 : 0), 0);

export class Game {
  readonly params = new URLSearchParams(location.search);
  readonly saved: SavedSettings;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly pipeline: Pipeline;
  userPickedQuality: boolean;
  difficultyName: DifficultyName;
  difficulty: Difficulty;
  readonly lighting: Lighting;
  readonly audio: GameAudio;
  readonly input: Input;
  elapsed = 0;
  matchTime = 0;
  state: GameState = "menu";
  brawlers: Brawler[] = [];
  brains: Bot[] = [];
  player: Brawler | null = null;
  /** Who the camera follows once the player is down. */
  spectate: Brawler | null = null;
  readonly focus = new THREE.Vector3(0, 0, 0);
  /** World point under the cursor / stick, shared by aiming and the camera lean. */
  readonly aimPoint = new THREE.Vector3();
  shakeAmp = 0;
  leanX = 0;
  leanZ = 0;
  menuAngle = 0.6;
  attractT = 0;
  endT = 0;
  pendingResult: PendingResult | null = null;
  countdownT = 0;
  lastCount = 0;
  camZoom: number;
  paused = false;
  /** Simulation steps per rendered frame (`?speed=`), for fast-forwarding tests. */
  simSteps: number;
  timePreset = 0;
  autoTime: boolean;
  readonly perf: PerfState = { done: false, frames: 0, t: 0 };
  readonly frameStats = { calls: 0, triangles: 0 };
  nextSeed: number;
  /** A `?seed=` value is honoured for the first world only. */
  fixedSeed: number | null;
  readonly maxAniso: number;
  world: World;
  /**
   * Every draw the sim makes (spawns, kits, bot brains, weapon spread, cube
   * scatter), reseeded with each world so a seed replays the same brawl.
   * Cosmetic draws stay on Math.random so they never shift this stream.
   */
  rng: Rng;
  readonly effects: Effects;
  readonly combat: Combat;
  readonly gas: Gas;
  readonly hud: Hud;
  readonly guide: AimGuide;
  readonly onMatchStart: (() => void) | null;
  /** Pad navigation for the DOM screens. */
  readonly menuPad: MenuPad;
  /** Solo-only softening after a losing streak. */
  readonly mercy = new Mercy();
  mode: GameMode = "solo";
  session: Session | null = null;
  /** `p:<playerId>` once connected; the brawler with this net id is ours. */
  localSeatId: string | null = null;
  /** Bumps on every online restart so guests rebuild their mirror. */
  generation = 0;
  winner: string | null = null;
  /** Every human's kit and name, keyed by player id, as announced by `join`. */
  readonly picks = new Map<string, Pick>();
  /**
   * The brawler presenting its own action right now (a shot, an evade, a
   * swing). Hosting, fx recorded meanwhile name it, so the guest who controls
   * it — and already showed the action when it predicted it — skips the copy.
   */
  fxActor: Brawler | null = null;
  private knownHostId: string | null = null;
  private onlineKit: BrawlerId = "dusty";
  private onlineName = "Player";
  private guest: GuestView | null = null;
  private netFx: FxRecord[] = [];
  private readonly netRate = new FixedRate(SNAPSHOT_HZ);
  private seqOut = 0;
  private rosterKey = "";
  private rosterVersion = 0;
  private last: number;
  private warmup = WARMUP_FRAMES;
  private readonly onLoadProgress: ((progress: number, label: string) => void) | undefined;

  constructor(options: GameOptions = {}) {
    this.onLoadProgress = options.onLoadProgress;
    this.onLoadProgress?.(0.08, "Opening the gates");
    this.onMatchStart = options.onMatchStart ?? null;
    const saved = loadSettings();
    this.saved = saved;
    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      window.innerWidth / window.innerHeight,
      1,
      260,
    );
    this.pipeline = new Pipeline(mustGetCanvas("game"), this.scene, this.camera);
    this.pipeline.renderer.info.autoReset = false;
    this.onLoadProgress?.(0.2, "Preparing the light");

    if (saved.ao === false) {
      this.pipeline.toggles.ao = false;
    }

    if (saved.bloom === false) {
      this.pipeline.toggles.bloom = false;
    }

    const coarse = window.matchMedia("(pointer: coarse)").matches;
    const quality = resolveQuality(this.params.get("q"), saved, coarse);
    this.userPickedQuality = quality.userPicked;
    this.pipeline.superSample = clamp(numberParam(this.params, "ss") || 0, 0, 3);
    this.pipeline.setQuality(quality.name);
    this.difficultyName = resolveDifficulty(this.params.get("bots"), saved);
    this.difficulty = DIFFICULTIES[this.difficultyName];
    this.lighting = new Lighting(this.scene, this.pipeline);
    this.lighting.applyQuality(this.pipeline.quality);
    this.audio = new GameAudio();
    this.audio.muted = Boolean(saved.muted);
    this.input = new Input(this.pipeline.renderer.domElement, mustGet("super"), mustGet("evade"));
    this.input.onTouchMode = (on) => {
      this.hud.setTouchMode(on);
    };

    this.camZoom = numberParam(this.params, "zoom") || 1;
    this.simSteps = clamp(Math.trunc(numberParam(this.params, "speed")) || 1, 1, 16);
    this.autoTime = saved.autoTime !== false;
    const seedParam = Math.trunc(numberParam(this.params, "seed"));
    this.nextSeed = Number.isFinite(seedParam) ? seedParam : randomSeed();
    this.fixedSeed = Number.isFinite(seedParam) ? seedParam : null;
    this.maxAniso = this.pipeline.renderer.capabilities.getMaxAnisotropy();
    this.world = new World(this.scene, this.nextSeed, this.maxAniso);
    this.rng = seededRandom(saltedSeed(this.world.seed, MATCH_SALT));
    this.onLoadProgress?.(0.5, "Raising the courtyard");
    this.lighting.setLamps(this.world.lanterns, this.world.lampGlass);
    this.effects = new Effects(this);
    this.combat = new Combat(this);
    this.gas = new Gas(this);
    this.hud = new Hud(this);
    this.guide = new AimGuide(this.scene);
    this.menuPad = new MenuPad(this);

    if (options.selected) {
      this.hud.select(options.selected);
    }

    if (coarse) {
      this.input.setTouchMode(true);
    }

    this.applyInitialTime(saved);
    window.addEventListener("keydown", (event) => {
      this.onHotkey(event);
    });
    this.hud.syncSettings();
    this.toMenu();

    if (options.online) {
      this.startOnline(options.online);
    }

    this.last = performance.now();
    this.onLoadProgress?.(0.7, "Calling the champions");
    requestAnimationFrame(this.frame);
  }

  private applyInitialTime(saved: SavedSettings) {
    const hour = numberParam(this.params, "time");

    if (Number.isFinite(hour)) {
      this.autoTime = false;
      this.lighting.setTime(hour);
    } else if (!this.autoTime && saved.time !== undefined) {
      this.lighting.setTime(saved.time);
    }
  }

  private onHotkey(event: KeyboardEvent) {
    if (event.repeat || isFormField(event.target)) {
      return;
    }

    const code = keyCode(event);

    if (code === "KeyT") {
      this.cycleTime();
    }

    if (code === "KeyM") {
      this.setMuted(!this.audio.muted);
    }

    if (code === "Escape") {
      mustGet("settings").classList.remove("open");
    }
  }

  /** Online pause releases local controls while the shared arena keeps running. */
  setPaused(paused: boolean) {
    this.paused = paused && this.mode === "solo";
    this.input.setEnabled(!paused);
    this.guide.hide();

    if (this.player) {
      this.player.moveX = 0;
      this.player.moveZ = 0;
      this.player.lookAngle = null;
    }

    this.netGuest?.link.steer(this.player, 0, 0, null);
  }

  /** The guest view while this client is a guest: how its own controls reach the host. */
  get netGuest() {
    return this.mode === "guest" ? this.guest : null;
  }

  /** Run `present` as `actor`'s own doing (see `fxActor`). */
  asActor(actor: Brawler, present: () => void) {
    const outer = this.fxActor;
    this.fxActor = actor;
    present();
    this.fxActor = outer;
  }

  /** Seconds of countdown left before the brawl is on. */
  get countdownLeft() {
    return this.countdownT - COUNTDOWN_GO_S;
  }

  save() {
    storeSettings({
      ao: this.pipeline.toggles.ao,
      autoTime: this.autoTime,
      bloom: this.pipeline.toggles.bloom,
      difficulty: this.difficultyName,
      muted: this.audio.muted,
      quality: this.userPickedQuality ? this.pipeline.qualityName : undefined,
      time: this.lighting.time,
    });
  }

  setQuality(name: QualityName, userPicked = false) {
    if (userPicked) {
      this.userPickedQuality = true;
    }

    this.pipeline.setQuality(name);
    this.lighting.applyQuality(this.pipeline.quality);
    this.hud.syncSettings();
    this.save();
  }

  setToggle(key: "ao" | "bloom", on: boolean) {
    this.pipeline.setToggle(key, on);
    this.save();
  }

  setDifficulty(name: DifficultyName) {
    this.difficultyName = name;
    this.difficulty = DIFFICULTIES[name];
    this.hud.syncSettings();
    this.save();
  }

  setAutoTime(on: boolean) {
    this.autoTime = on;
    this.hud.syncSettings();
    this.save();
  }

  setMuted(muted: boolean) {
    this.audio.setMuted(muted);
    this.hud.syncSettings();
    this.save();
  }

  cycleTime() {
    this.timePreset = (this.timePreset + 1) % TIME_PRESETS.length;
    const hour = TIME_PRESETS[this.timePreset];

    if (hour === null || hour === undefined) {
      this.setAutoTime(true);
      this.hud.toast("Time of day: following the match");

      return;
    }

    this.setAutoTime(false);
    this.lighting.setTime(hour);
    this.hud.toast(`Time of day locked to ${formatHour(hour)}`);
  }

  /** Dispose every brawler, projectile and loot item; the world itself stays. */
  clearEntities() {
    for (const b of this.brawlers) {
      b.dispose();
    }

    this.brawlers = [];
    this.brains = [];
    this.player = null;
    this.spectate = null;
    this.combat.clear();
    this.gas.reset();
    this.hud.reset();
  }

  /** Replace the arena: a fresh random layout, or exactly the host's when `seed` is given. */
  rebuildWorld(seed: number | null) {
    this.world.dispose();

    if (seed === null) {
      this.nextSeed = this.fixedSeed ?? randomSeed();
      this.fixedSeed = null;
    } else {
      this.nextSeed = seed;
    }

    this.world = new World(this.scene, this.nextSeed, this.maxAniso);
    this.rng = seededRandom(saltedSeed(this.world.seed, MATCH_SALT));
    this.lighting.setLamps(this.world.lanterns, this.world.lampGlass);
    this.effects.rebuildFireflies();
  }

  private newWorld() {
    this.rebuildWorld(null);
  }

  private rosterSeats(playerId: BrawlerId | null) {
    if (this.mode === "host") {
      return onlineSeats(this);
    }

    if (playerId === null) {
      return [];
    }

    return [{ isLocal: true, kit: playerId, name: "YOU", owner: "" }];
  }

  private spawnRoster(playerId: BrawlerId | null) {
    this.clearEntities();
    const { world } = this;
    const { rng } = this;
    const spawns = shuffle([...world.spawns], rng);
    const names = shuffle([...BOT_NAMES], rng);
    const kits = Object.keys(BRAWLERS).filter(isBrawlerId);
    const seats = this.rosterSeats(playerId);
    const count = TUNING.bots + 1;

    for (let i = 0; i < count; i += 1) {
      const spawn = spawns[i % spawns.length];

      if (!spawn) {
        break;
      }

      const [tx, ty] = spawn;
      const seat = seats[i];
      const isPlayer = seat?.isLocal ?? false;
      const kitId = seat ? seat.kit : kits[(i + Math.floor(rng() * kits.length)) % kits.length];
      const def = BRAWLERS[kitId ?? "dusty"];
      const owner = seat && seat.owner !== "" ? seat.owner : null;

      const brawler = new Brawler(this, def, {
        hueShift: seat ? 0 : rand(-0.07, 0.07),
        isPlayer,
        name: seat ? seat.name : (names[i % names.length] ?? "Bot"),
        netId: owner === null ? `bot:${i}` : seatId(owner),
        owner,
        x: world.center(tx),
        z: world.center(ty),
      });

      this.brawlers.push(brawler);
      this.hud.addBrawler(brawler);

      if (isPlayer) {
        this.player = brawler;
      } else if (!seat) {
        this.brains.push(new Bot(this, brawler, this.rng));
      }
    }

    for (const [tx, ty] of world.boxSpots) {
      this.combat.addBox(tx, ty);
    }

    world.aoDirty = true;
    world.aoTimer = 0;
  }

  toMenu() {
    this.leaveSession();
    this.state = "menu";
    this.hud.showMenu(true);
    this.spawnRoster(null);
    this.attractT = 0;
  }

  startMatch(id: BrawlerId) {
    this.audio.unlock();
    this.audio.play("click");
    this.newWorld();
    this.spawnRoster(id);
    this.hud.showMenu(false);
    this.hud.hideResult();
    this.state = "countdown";
    this.countdownT = COUNTDOWN_S;
    this.lastCount = 4;
    this.elapsed = 0;
    this.leanX = 0;
    this.leanZ = 0;
    this.matchTime = 0;
    this.pendingResult = null;
    this.shakeAmp = 0;
    const { player } = this;

    if (player) {
      this.focus.set(player.x, this.world.heightAt(player.x, player.z), player.z);
      this.guide.setupFor(player.def);
    }

    updateCamera(this, 0);
    this.camera.updateMatrixWorld();

    if (this.autoTime) {
      this.lighting.setTime(TUNING.startHour);
    }

    if (this.mode === "host") {
      this.generation += 1;
      this.winner = null;
      this.endT = 0;
      this.world.broken = [];
      this.netFx = [];
      setSpectateCopy(player ? null : "SPECTATING · you are in this brawl's next round");
    }

    setResultMode(this.mode === "host" ? "host" : "solo");
    this.onMatchStart?.();
  }

  /** A solo brawl on exactly this map, leaving any room first (the playtest hooks' restart). */
  startSeeded(seed: number) {
    this.toMenu();
    this.fixedSeed = seed;
    this.startMatch(this.hud.selected);
  }

  /** Cut the 3-2-1 short: the next sim step calls GO. */
  skipCountdown() {
    if (this.state === "countdown") {
      this.countdownT = COUNTDOWN_GO_S;
    }
  }

  /** Join a room; `?offline=1` turns this into a plain solo brawl. */
  startOnline(options: OnlineOptions) {
    if (isOfflineRequested()) {
      this.startMatch(this.hud.selected);

      return;
    }

    this.leaveSession();
    this.audio.unlock();
    this.audio.play("click");
    this.onlineKit = this.hud.selected;
    this.onlineName = options.name;
    this.session = new Session({ name: options.name, room: options.room });
    this.mode = "connecting";
    this.hud.showMenu(false);
    this.hud.hideResult();
    setNetStatus("Connecting…");
    this.onMatchStart?.();
  }

  /** The result screen's button: solo restarts, the host restarts the room's brawl now. */
  playAgain() {
    if (this.mode === "solo") {
      this.startMatch(this.hud.selected);
    } else if (this.mode === "host") {
      this.startMatch(this.onlineKit);
    }
  }

  private leaveSession() {
    if (!this.session) {
      return;
    }

    setRecorders(this.effects, this.hud, this.combat, null);
    this.guest?.reset();
    this.guest = null;
    this.combat.ghosts = null;
    this.session.destroy();
    this.session = null;
    this.mode = "solo";
    this.localSeatId = null;
    this.knownHostId = null;
    this.picks.clear();
    this.netFx = [];
    setNetStatus(null);
    setSpectateCopy(null);
    setResultMode("solo");
  }

  private fallBackOffline() {
    this.leaveSession();
    this.hud.toast(OFFLINE_TOAST);
    this.startMatch(this.onlineKit);
  }

  /** A brawler is ours: the camera, the aim guide and the HUD follow it. */
  adoptLocalSeat(b: Brawler) {
    this.player = b;
    this.spectate = null;
    this.focus.set(b.x, this.world.heightAt(b.x, b.z), b.z);
    this.guide.setupFor(b.def);
    setSpectateCopy(null);
  }

  addBrawler(b: Brawler, withBrain: boolean) {
    this.brawlers.push(b);
    this.hud.addBrawler(b);

    if (withBrain) {
      this.brains.push(new Bot(this, b, this.rng));
    }
  }

  removeBrawler(b: Brawler, dropCubes: boolean) {
    if (dropCubes && b.alive) {
      this.combat.dropCubes(b.x, b.z, 1 + Math.floor(b.cubes / 2));
    }

    this.hud.overheads.get(b.id)?.root.remove();
    this.hud.overheads.delete(b.id);
    b.dispose();
    this.brawlers = this.brawlers.filter((other) => other !== b);
    this.brains = this.brains.filter((brain) => brain.b !== b);

    if (this.player === b) {
      this.player = null;
    }

    if (this.spectate === b) {
      this.spectate = null;
    }
  }

  /** A leaver may have been the last opponent standing. */
  afterRosterChange() {
    if (this.state !== "playing") {
      return;
    }

    const left = aliveCount(this.brawlers);

    if (left === 1 && this.player?.alive === true) {
      this.localWin();
    }

    if (this.mode === "host" && left <= 1) {
      this.endOnlineMatch();
    }
  }

  private becomeHost(departed: string | null) {
    const { session } = this;

    if (!session) {
      return;
    }

    const own = this.guest?.ownPose ?? null;
    this.guest?.reset();
    this.guest = null;
    this.combat.ghosts = null;
    this.mode = "host";
    setRecorders(
      this.effects,
      this.hud,
      this.combat,
      (row) => {
        this.netFx.push(row);
      },
      {
        actor: () => (this.fxActor ? this.brawlers.indexOf(this.fxActor) : -1),
        indexOf: (b) => this.brawlers.indexOf(b),
      },
    );
    this.netFx = [];
    session.drainIntents();
    const world = session.readWorld();

    if (world) {
      this.hud.showMenu(false);
      this.hud.hideResult();
      this.seqOut = world.frame.seq;
      this.rosterVersion = world.match.rosterVersion;
      this.rosterKey = "";
      restoreFromWorld(this, world, departed, own);
      setResultMode("host");
      setSpectateCopy(this.player ? null : "SPECTATING · you are in the next brawl");
    } else {
      this.startMatch(this.onlineKit);
    }

    this.netRate.reset();
    this.broadcast();
  }

  private becomeGuest() {
    const { session } = this;

    if (!session) {
      return;
    }

    setRecorders(this.effects, this.hud, this.combat, null);
    this.clearEntities();
    this.mode = "guest";
    this.guest = new GuestView(this);
    this.combat.ghosts = this.guest;
    this.guest.ingest(session.baseline());
    this.hud.hideResult();
    setResultMode("guest");
    setResultWait(GUEST_WAIT);
  }

  onPlayerHurt(amount: number) {
    this.hud.flashHurt(amount);
    this.shakeAmp = Math.max(this.shakeAmp, 0.07);
  }

  /** The local player fell: solo ends the match; online the brawl goes on without us. */
  localDown(rank: number, killer: Brawler | null) {
    if (this.mode === "solo") {
      this.state = "ended";
    }

    this.spectate = killer?.alive === true ? killer : null;
    this.pendingResult = { rank, t: 1.5, won: false };

    if (this.mode === "solo") {
      this.mercy.record(rank);
    }

    this.audio.play("lose");
  }

  /** The local player is the last one standing. */
  localWin() {
    this.state = "ended";

    if (this.player) {
      this.player.rank = 1;
    }

    this.pendingResult = { rank: 1, t: 1.3, won: true };
    this.mercy.record(1);
    this.audio.play("win");
  }

  private endOnlineMatch() {
    this.state = "ended";
    this.endT = 0;
    this.winner = this.brawlers.find((b) => b.alive)?.name ?? null;
  }

  private resolveDown(downed: Brawler, killer: Brawler | null, left: number) {
    const { player } = this;

    if (downed === player) {
      this.localDown(downed.rank, killer);
    } else if (left === 1 && player?.alive === true) {
      this.localWin();
    } else if (left === 2 && player?.alive === true) {
      this.hud.banner("SHOWDOWN!", 1.5, true);
    }

    if (this.mode === "host" && left <= 1) {
      this.endOnlineMatch();
    }
  }

  onBrawlerDown(downed: Brawler, killer: Brawler | null) {
    const left = aliveCount(this.brawlers);
    downed.rank = left + 1;
    this.effects.defeat(downed.x, downed.z, downed.lightColor);
    this.audio.play("down", downed.x, downed.z);
    this.combat.dropCubes(downed.x, downed.z, 1 + Math.floor(downed.cubes / 2));

    if (this.state === "menu") {
      return;
    }

    this.hud.announceKill(killer, downed);

    if (this.state !== "playing") {
      return;
    }

    this.resolveDown(downed, killer, left);
  }

  /** Screen shake that fades with distance from the camera focus. */
  shake(amount: number, x: number, z: number) {
    const d = dist(x, z, this.focus.x, this.focus.z);
    this.shakeAmp = Math.max(this.shakeAmp, amount * clamp(1 - d / 8, 0, 1));
  }

  private updateTime(dt: number) {
    if (!this.autoTime) {
      return;
    }

    if (this.state === "menu") {
      this.lighting.setTime(this.lighting.time + dt * 0.4);

      return;
    }

    const progress = clamp(this.matchTime / TUNING.dayLength, 0, 1);
    this.lighting.setTime(lerp(TUNING.startHour, TUNING.endHour, progress));
  }

  /** The 3-2-1 numerals, once each, as `countdownT` crosses them. */
  announceCount() {
    const count = Math.ceil(this.countdownT - COUNTDOWN_GO_S);

    if (count !== this.lastCount && count >= 1 && count <= 3) {
      this.lastCount = count;
      this.hud.banner(String(count), 0.8);
      this.audio.play("count");
    }
  }

  /** The countdown is over: the brawl is on. */
  announceGo() {
    this.lastCount = 0;
    this.lighting.resetShadowFit();
    this.hud.banner("BRAWL!", 0.9);
    this.audio.play("go");
  }

  announceGas() {
    this.hud.banner("POISON GAS IS CLOSING IN!", 2.2, true);
  }

  private updateCountdown(dt: number) {
    this.countdownT -= dt;
    this.announceCount();

    if (this.countdownT <= COUNTDOWN_GO_S && this.lastCount !== 0) {
      this.state = "playing";
      this.announceGo();
    }
  }

  private updateGas(dt: number) {
    const wasActive = this.gas.active;
    this.gas.update(dt, this.matchTime);

    if (!wasActive && this.gas.active) {
      this.announceGas();
    }
  }

  private addDynamicLights() {
    const { lighting } = this;

    for (const b of this.brawlers) {
      if (b.alive && !b.hidden && b.superReady) {
        lighting.addLight(
          b.x,
          b.root.position.y + 0.9,
          b.z,
          SUPER_GLOW,
          1.5 + Math.sin(this.elapsed * 6) * 0.4,
          3.6,
        );
      }
    }

    const { player } = this;

    if (player?.alive === true && lighting.night > 0.02) {
      lighting.addLight(
        player.x,
        player.root.position.y + 1.9,
        player.z,
        PLAYER_GLOW,
        2.4 * lighting.night,
        6.5,
      );
    }
  }

  private updateAttract(dt: number) {
    this.attractT = aliveCount(this.brawlers) <= 1 ? this.attractT + dt : 0;

    if (this.attractT > ATTRACT_RESTART_S) {
      this.toMenu();
    }
  }

  private updateResult(dt: number) {
    const result = this.pendingResult;

    if (!result) {
      return;
    }

    result.t -= dt;

    if (result.t > 0) {
      return;
    }

    this.pendingResult = null;
    const { player } = this;

    if (player) {
      this.hud.showResult(
        result.won,
        result.rank,
        this.brawlers.length,
        player.kills,
        player.cubes,
        recordRun({ cubes: player.cubes, kills: player.kills, rank: result.rank }),
      );
    }
  }

  private updatePaused(dt: number) {
    updateCamera(this, 0);
    this.world.update(dt, this.elapsed);
    this.lighting.update(dt, this.elapsed, this.camera, this.focus, true);
    this.hud.update(0);
  }

  private present(dt: number) {
    this.effects.update(dt);
    updateVisibility(this);
    this.updateTime(dt);
    updateCamera(this, dt);
    this.world.update(dt, this.elapsed);
    this.addDynamicLights();
    this.audio.listener.x = this.focus.x;
    this.audio.listener.z = this.focus.z;
    this.lighting.update(dt, this.elapsed, this.camera, this.focus);

    if (this.state === "menu" && this.mode === "solo") {
      this.updateAttract(dt);
    }

    this.updateResult(dt);
    this.hud.update(dt);
  }

  private stepSim(dt: number) {
    const stepStart = this.elapsed;
    this.elapsed += dt;

    if (this.state === "countdown") {
      this.updateCountdown(dt);
    } else if (this.state !== "menu") {
      this.matchTime += dt;
    }

    if (this.mode === "host") {
      reconcileSeats(this);
      applyRemoteIntents(this, stepStart * 1000);
    }

    controlPlayer(this);

    for (const brain of this.brains) {
      brain.update(dt);
    }

    for (const b of this.brawlers) {
      b.update(dt);
    }

    separateBrawlers(this.brawlers);
    this.combat.update(dt);

    if (this.state !== "menu") {
      this.updateGas(dt);
    }

    this.present(dt);
  }

  private pollSession() {
    const { session } = this;

    if (!session) {
      return false;
    }

    const id = session.playerId;

    if (id === null) {
      setNetStatus(session.status === "reconnecting" ? "Reconnecting…" : "Connecting…");

      return true;
    }

    this.localSeatId = seatId(id);
    this.picks.set(id, { kit: this.onlineKit, name: this.onlineName });
    session.announce({ kind: "join", kit: this.onlineKit, name: this.onlineName });
    setNetStatus(session.hostDropped ? "Host reconnecting…" : null);
    const previousHost = this.knownHostId;
    this.knownHostId = session.hostId;

    if (this.mode === "host" && !session.isHost) {
      this.becomeGuest();
    } else if (this.mode === "guest" && session.isHost && !session.hasMalformedSnapshot) {
      this.becomeHost(previousHost === id ? null : previousHost);
    } else if (this.mode === "guest" && previousHost !== null && session.hostId !== previousHost) {
      this.guest?.hostChanged();
    }

    return true;
  }

  private updateConnecting(dt: number) {
    const { session } = this;

    if (!session) {
      this.mode = "solo";

      return;
    }

    if (session.status === "offline") {
      this.fallBackOffline();

      return;
    }

    if (session.playerId !== null) {
      this.pollSession();

      if (session.isHost) {
        if (!session.hasMalformedSnapshot) {
          this.becomeHost(null);
        }
      } else {
        this.becomeGuest();
      }

      return;
    }

    setNetStatus("Connecting…");
    this.elapsed += dt;
    this.present(dt);
  }

  private broadcast() {
    const { session } = this;
    const now = session?.serverTime() ?? null;

    if (!session || now === null) {
      return;
    }

    const key = `${this.generation}|${this.brawlers.map((b) => b.netId).join(",")}`;

    if (key !== this.rosterKey) {
      this.rosterKey = key;
      this.rosterVersion += 1;
    }

    this.seqOut += 1;
    const frame = encodeFrame(this, this.seqOut, this.rosterVersion, now, this.elapsed * 1000);
    const { world } = this;

    const match = encodeMatch(
      this.brawlers,
      this.generation,
      world.seed,
      this.winner,
      this.rosterVersion,
    );

    const boxes = encodeBoxes(world.boxSpots, this.combat.boxes);
    const cubes = encodeCubes(this.combat.cubes);
    session.publish({ boxes, broken: world.broken, cubes, frame, match }, this.netFx);
    this.netFx = [];
  }

  private updateHost(dt: number) {
    if (!this.pollSession() || this.mode !== "host") {
      return;
    }

    this.stepSim(dt);

    if (this.state === "ended") {
      this.endT += dt;
      setResultWait(`Next brawl in ${Math.max(1, Math.ceil(RESTART_DELAY_S - this.endT))}`);

      if (this.endT >= RESTART_DELAY_S) {
        this.startMatch(this.onlineKit);
      }
    }

    if (this.netFx.length > MAX_PENDING_FX) {
      this.netFx.splice(0, this.netFx.length - MAX_PENDING_FX);
    }
  }

  private updateGuest(dt: number) {
    const { session, guest } = this;

    if (!this.pollSession() || this.mode !== "guest" || !session || !guest) {
      return;
    }

    this.elapsed += dt;
    applyRemoteIntents(this, 0);
    guest.prediction.beginStep(dt * 1000);

    for (const arrival of session.takeArrivals()) {
      guest.ingest(arrival);
    }

    if (!guest.hasWorld) {
      setNetStatus("Waiting for the host…");
      this.present(dt);

      return;
    }

    guest.update(dt, performance.now());
    controlPlayer(this);

    for (const b of this.brawlers) {
      b.update(dt);
    }

    guest.settle(dt);
    guest.updateProjectiles(dt);
    const gasWas = this.gas.active;
    this.gas.update(dt, this.matchTime, false);

    if (this.gas.active && !gasWas && this.state === "playing") {
      this.announceGas();
    }

    this.present(dt);
  }

  update(dt: number) {
    this.pipeline.resize();

    if (this.paused) {
      this.updatePaused(dt);

      return;
    }

    switch (this.mode) {
      case "host": {
        this.updateHost(dt);
        break;
      }

      case "guest": {
        this.updateGuest(dt);
        break;
      }

      case "connecting": {
        this.updateConnecting(dt);
        break;
      }

      case "solo": {
        this.stepSim(dt);
        break;
      }

      default: {
        const unhandled: never = this.mode;
        throw new Error("unhandled case", { cause: unhandled });
      }
    }
  }

  private stepFrame(raw: number) {
    if (this.mode !== "host" && this.mode !== "guest") {
      const dt = Math.min(MAX_STEP_S, Math.max(1e-4, raw));

      for (let i = 0; i < this.simSteps; i += 1) {
        this.update(dt);
      }

      return;
    }

    let remaining = Math.min(MAX_CATCH_UP_S, Math.max(1e-4, raw));

    while (remaining > 0) {
      const step = Math.min(MAX_STEP_S, remaining);
      remaining -= step;
      this.update(step);
    }
  }

  private readonly frame = (now: number) => {
    const raw = (now - this.last) / 1000;
    const dt = Math.min(MAX_STEP_S, Math.max(1e-4, raw));
    this.last = now;
    this.input.poll();

    if (
      (this.state === "countdown" || this.state === "playing") &&
      this.input.padJustPressed("start")
    ) {
      pauseGame();
    }

    this.menuPad.update();
    tickDiagnostics();
    const { info } = this.pipeline.renderer;
    this.frameStats.calls = info.render.calls;
    this.frameStats.triangles = info.render.triangles;
    info.reset();
    this.stepFrame(raw);

    if (this.mode === "host" && this.netRate.due(raw * 1000)) {
      this.broadcast();
    }

    this.pipeline.render(dt);

    if (this.warmup > 0) {
      this.warmup -= 1;
      this.onLoadProgress?.(
        0.7 + 0.25 * (1 - this.warmup / WARMUP_FRAMES),
        "Preparing the tournament",
      );

      if (this.warmup === 0) {
        benchmarkQuality(this);
        this.last = performance.now();
        this.onLoadProgress?.(1, "Ready");
        mustGet("loading").classList.add("done");
      }
    }

    adaptQuality(this, raw);
    requestAnimationFrame(this.frame);
  };
}
