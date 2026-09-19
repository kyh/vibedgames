// The match orchestrator: owns the scene, renderer pipeline, lighting, world,
// roster and every subsystem, drives the frame loop, and runs the menu →
// countdown → playing → ended state machine. Subsystems reach each other
// through this object, so its public fields are the game's internal API.
//
// Online, the same object runs in one of three modes: the host steps the sim
// exactly as solo does and broadcasts snapshots; a guest mirrors those
// snapshots onto puppets and sends intents; "connecting" bridges the two.

import * as THREE from "three";

import { isOfflineRequested } from "@repo/embed";

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
import { Input, keyCode } from "./input";
import { MenuPad } from "./menu-pad";
import { tick as tickDiagnostics } from "./diagnostics";
import { Mercy } from "./polish/mercy";
import { recordRun } from "./polish/best-run";
import { GuestView } from "./net/guest";
import { applyRemoteIntents, onlineSeats, reconcileSeats, restoreFromSnapshot } from "./net/host";
import type { Pick, Seat } from "./net/host";
import { replayBatch, setRecorders } from "./net/presentation";
import type { FxRecord } from "./net/presentation";
import { SNAPSHOT_HZ, seatId } from "./net/protocol";
import { Session } from "./net/session";
import { encodeSnapshot } from "./net/snapshot";
import { controlPlayer } from "./player-control";
import { adaptQuality, benchmarkQuality } from "./quality-auto";
import { Lighting } from "./render/lighting";
import { Pipeline } from "./render/pipeline";
import { separateBrawlers, updateVisibility } from "./roster-sim";
import { loadSettings, resolveDifficulty, resolveQuality, storeSettings } from "./settings-store";
import type { SavedSettings } from "./settings-store";
import { clamp, dist, lerp, rand } from "./utils";
import { World } from "./world/world";

export { SETTINGS_KEY } from "./settings-store";

export type GameState = "menu" | "countdown" | "playing" | "ended";

/** Who advances the world: this client alone, this client for the room, or the room's host. */
export type GameMode = "solo" | "connecting" | "host" | "guest";

export interface OnlineOptions {
  name: string;
  room: string;
}

export interface GameOptions {
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

/** `T` cycles through these hours; `null` hands the clock back to the match. */
const TIME_PRESETS: readonly (number | null)[] = [null, 12.5, 17.6, 18.6, 19.4, 21.5];

/** Glow colours: a charged super's pulse, and the player's lantern at night. */
const SUPER_GLOW = new THREE.Color(0xff_c9_3a);
const PLAYER_GLOW = new THREE.Color(0xff_e0_a0);

/** Frames rendered before the quality benchmark, so shader compiles are out of the way. */
const WARMUP_FRAMES = 3;
const COUNTDOWN_S = 3.4;
/** The countdown's final "GO" lands with this much time left on the clock. */
const COUNTDOWN_GO_S = 0.4;
/** On the menu, a finished attract-mode brawl restarts after this many seconds. */
const ATTRACT_RESTART_S = 2.5;
/** Longest frame the sim steps at once; a longer frame is split into sub-steps. */
const MAX_STEP_S = 0.05;
/** A hosting tab that stalled catches up at most this far in one frame. */
const MAX_CATCH_UP_S = 0.25;
const OFFLINE_TOAST = "Couldn't reach the party server — playing vs bots";
const GUEST_WAIT = "Waiting for the next brawl…";

const randomSeed = (): number => Math.trunc(Math.random() * 1e9);

/** A numeric query param; NaN when absent or blank, so callers can `||` a default. */
const numberParam = (params: URLSearchParams, name: string): number => {
  const raw = params.get(name);
  return raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
};

const shuffle = <T>(items: T[]): T[] => {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = items[i];
    const b = items[j];
    if (a !== undefined && b !== undefined) {
      items[i] = b;
      items[j] = a;
    }
  }
  return items;
};

const mustGetCanvas = (id: string): HTMLCanvasElement => {
  const el = mustGet(id);
  if (!(el instanceof HTMLCanvasElement)) {
    throw new Error(`#${id} is not a <canvas>`);
  }
  return el;
};

const formatHour = (hour: number): string =>
  `${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.round((hour % 1) * 60)).padStart(2, "0")}`;

const aliveCount = (brawlers: readonly Brawler[]): number =>
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
  // ── online ──
  mode: GameMode = "solo";
  session: Session | null = null;
  /** `p:<playerId>` once connected; the brawler with this net id is ours. */
  localSeatId: string | null = null;
  /** Bumps on every online restart so guests rebuild their mirror. */
  generation = 0;
  winner: string | null = null;
  /** Every human's kit and name, keyed by player id, as announced by `join`. */
  readonly picks = new Map<string, Pick>();
  /** The host id last seen on the wire; the one we were following when promoted. */
  private knownHostId: string | null = null;
  private onlineKit: BrawlerId = "dusty";
  private onlineName = "Player";
  private guest: GuestView | null = null;
  private netFx: FxRecord[] = [];
  private snapAcc = 0;
  private seqOut = 0;
  private last: number;
  private warmup = WARMUP_FRAMES;

  constructor(options: GameOptions = {}) {
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
    if (saved.ao === false) {
      this.pipeline.toggles.ao = false;
    }
    if (saved.bloom === false) {
      this.pipeline.toggles.bloom = false;
    }
    const coarse = Boolean(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);
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
    this.input = new Input(this.pipeline.renderer.domElement, mustGet("super"));
    this.input.onTouchMode = (on) => this.hud.setTouchMode(on);
    this.camZoom = numberParam(this.params, "zoom") || 1;
    this.simSteps = clamp(Math.trunc(numberParam(this.params, "speed")) || 1, 1, 16);
    this.autoTime = saved.autoTime !== false;
    const seedParam = Math.trunc(numberParam(this.params, "seed"));
    this.nextSeed = Number.isFinite(seedParam) ? seedParam : randomSeed();
    this.fixedSeed = Number.isFinite(seedParam) ? seedParam : null;
    this.maxAniso = this.pipeline.renderer.capabilities.getMaxAnisotropy();
    this.world = new World(this.scene, this.nextSeed, this.maxAniso);
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
    window.addEventListener("keydown", (event) => this.onHotkey(event));
    this.hud.syncSettings();
    this.toMenu();
    if (options.online) {
      this.startOnline(options.online);
    }
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  /** `?time=` pins the clock; otherwise a saved manual time is restored. */
  private applyInitialTime(saved: SavedSettings): void {
    const hour = numberParam(this.params, "time");
    if (Number.isFinite(hour)) {
      this.autoTime = false;
      this.lighting.setTime(hour);
    } else if (!this.autoTime && saved.time !== undefined) {
      this.lighting.setTime(saved.time);
    }
  }

  private onHotkey(event: KeyboardEvent): void {
    if (event.repeat) {
      return;
    }
    const code = keyCode(event);
    if (code === "KeyT") {
      this.cycleTime();
    }
    if (code === "KeyM") {
      this.setMuted(!this.audio.muted);
    }
    if (code === "KeyP" && this.state !== "menu") {
      this.setPaused(!this.paused);
    }
    if (code === "Escape") {
      mustGet("settings").classList.remove("open");
    }
  }

  /**
   * Freeze the simulation; `announce` shows the P-key hint toast. Online the
   * world is shared, so nothing freezes and nothing is announced — the
   * wrapper's overlay is the whole pause UI; only held movement is released.
   */
  setPaused(paused: boolean, announce = true): void {
    if (this.mode !== "solo") {
      this.paused = false;
      if (paused) {
        this.input.keys.clear();
        this.input.fire = false;
      }
      return;
    }
    this.paused = paused;
    if (announce) {
      this.hud.toast(paused ? "Paused - press P to resume" : "Resumed");
    }
  }

  save(): void {
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

  setQuality(name: QualityName, userPicked = false): void {
    if (userPicked) {
      this.userPickedQuality = true;
    }
    this.pipeline.setQuality(name);
    this.lighting.applyQuality(this.pipeline.quality);
    this.hud.syncSettings();
    this.save();
  }

  setToggle(key: "ao" | "bloom", on: boolean): void {
    this.pipeline.setToggle(key, on);
    this.save();
  }

  setDifficulty(name: DifficultyName): void {
    this.difficultyName = name;
    this.difficulty = DIFFICULTIES[name];
    this.hud.syncSettings();
    this.save();
  }

  setAutoTime(on: boolean): void {
    this.autoTime = on;
    this.hud.syncSettings();
    this.save();
  }

  setMuted(muted: boolean): void {
    this.audio.setMuted(muted);
    this.hud.syncSettings();
    this.save();
  }

  cycleTime(): void {
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
  clearEntities(): void {
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
  rebuildWorld(seed: number | null): void {
    this.world.dispose();
    if (seed === null) {
      this.nextSeed = this.fixedSeed === null ? randomSeed() : this.fixedSeed;
      this.fixedSeed = null;
    } else {
      this.nextSeed = seed;
    }
    this.world = new World(this.scene, this.nextSeed, this.maxAniso);
    this.lighting.setLamps(this.world.lanterns, this.world.lampGlass);
    this.effects.rebuildFireflies();
  }

  private newWorld(): void {
    this.rebuildWorld(null);
  }

  /** The seats humans take before bots fill the rest: the solo player, or the room's roster. */
  private rosterSeats(playerId: BrawlerId | null): Seat[] {
    if (this.mode === "host") {
      return onlineSeats(this);
    }
    if (playerId === null) {
      return [];
    }
    return [{ isLocal: true, kit: playerId, name: "YOU", owner: "" }];
  }

  /** Fill every spawn: humans first, then bots with random kits and names. */
  private spawnRoster(playerId: BrawlerId | null): void {
    this.clearEntities();
    const { world } = this;
    const spawns = shuffle([...world.spawns]);
    const names = shuffle([...BOT_NAMES]);
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
      const kitId = seat ? seat.kit : kits[(i + Math.floor(Math.random() * 4)) % 4];
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
        this.brains.push(new Bot(this, brawler));
      }
    }
    for (const [tx, ty] of world.boxSpots) {
      this.combat.addBox(tx, ty);
    }
    world.aoDirty = true;
    world.aoTimer = 0;
  }

  toMenu(): void {
    this.leaveSession();
    this.state = "menu";
    this.hud.showMenu(true);
    this.spawnRoster(null);
    this.attractT = 0;
  }

  startMatch(id: BrawlerId): void {
    this.audio.unlock();
    this.audio.play("click");
    this.newWorld();
    this.spawnRoster(id);
    this.hud.showMenu(false);
    this.hud.hideResult();
    this.hud.playHints.reset();
    this.state = "countdown";
    this.countdownT = COUNTDOWN_S;
    this.lastCount = 4;
    this.matchTime = 0;
    this.pendingResult = null;
    this.shakeAmp = 0;
    const { player } = this;
    if (player) {
      this.focus.set(player.x, 0, player.z);
      this.guide.setupFor(player.def);
    }
    if (this.autoTime) {
      this.lighting.setTime(TUNING.startHour);
    }
    if (this.input.touchMode && window.innerHeight > window.innerWidth) {
      this.hud.toast("Tip: turn your phone sideways for a wider view");
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
  startSeeded(seed: number): void {
    this.toMenu();
    this.fixedSeed = seed;
    this.startMatch(this.hud.selected);
  }

  /** Cut the 3-2-1 short: the next sim step calls GO. */
  skipCountdown(): void {
    if (this.state === "countdown") {
      this.countdownT = COUNTDOWN_GO_S;
    }
  }

  // ── online lifecycle ──

  /** Join a room; `?offline=1` turns this into a plain solo brawl. */
  startOnline(options: OnlineOptions): void {
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
  playAgain(): void {
    if (this.mode === "solo") {
      this.startMatch(this.hud.selected);
    } else if (this.mode === "host") {
      this.startMatch(this.onlineKit);
    }
  }

  /** Drop the room and every online-only view; the game is solo again afterwards. */
  private leaveSession(): void {
    if (!this.session) {
      return;
    }
    setRecorders(this.effects, this.hud, null);
    this.guest?.reset();
    this.guest = null;
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

  private fallBackOffline(): void {
    this.leaveSession();
    this.hud.toast(OFFLINE_TOAST);
    this.startMatch(this.onlineKit);
  }

  /** A brawler is ours: the camera, the aim guide and the HUD follow it. */
  adoptLocalSeat(b: Brawler): void {
    this.player = b;
    this.spectate = null;
    this.focus.set(b.x, 0, b.z);
    this.guide.setupFor(b.def);
    setSpectateCopy(null);
  }

  addBrawler(b: Brawler, withBrain: boolean): void {
    this.brawlers.push(b);
    this.hud.addBrawler(b);
    if (withBrain) {
      this.brains.push(new Bot(this, b));
    }
  }

  removeBrawler(b: Brawler, dropCubes: boolean): void {
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
  afterRosterChange(): void {
    if (this.state !== "playing") {
      return;
    }
    const left = aliveCount(this.brawlers);
    if (left === 1 && this.player?.alive) {
      this.localWin();
    }
    if (this.mode === "host" && left <= 1) {
      this.endOnlineMatch();
    }
  }

  private becomeHost(departed: string | null): void {
    const { session } = this;
    if (!session) {
      return;
    }
    this.guest?.reset();
    this.guest = null;
    this.mode = "host";
    setRecorders(this.effects, this.hud, (row) => this.netFx.push(row));
    this.netFx = [];
    this.snapAcc = 0;
    session.resetFxBaseline();
    // Intents queued while we were a guest belong to the old host's brawl.
    session.drainIntents();
    const snap = session.readSnapshot();
    if (snap) {
      this.hud.showMenu(false);
      this.hud.hideResult();
      this.seqOut = snap.seq;
      restoreFromSnapshot(this, snap, departed);
      setResultMode("host");
      setSpectateCopy(this.player ? null : "SPECTATING · you are in the next brawl");
    } else {
      this.startMatch(this.onlineKit);
    }
    this.broadcast(1 / SNAPSHOT_HZ);
  }

  private becomeGuest(): void {
    const { session } = this;
    if (!session) {
      return;
    }
    setRecorders(this.effects, this.hud, null);
    this.clearEntities();
    this.mode = "guest";
    this.guest = new GuestView(this);
    session.resetFxBaseline();
    this.hud.hideResult();
    setResultMode("guest");
    setResultWait(GUEST_WAIT);
  }

  onPlayerHurt(amount: number): void {
    this.hud.flashHurt(amount);
    this.shakeAmp = Math.max(this.shakeAmp, 0.07);
  }

  /** The local player fell: solo ends the match; online the brawl goes on without us. */
  localDown(rank: number, killer: Brawler | null): void {
    if (this.mode === "solo") {
      this.state = "ended";
    }
    this.spectate = killer?.alive ? killer : null;
    this.pendingResult = { rank, t: 1.5, won: false };
    if (this.mode === "solo") {
      this.mercy.record(rank);
    }
    this.audio.play("lose");
  }

  /** The local player is the last one standing. */
  localWin(): void {
    this.state = "ended";
    if (this.player) {
      this.player.rank = 1;
    }
    this.pendingResult = { rank: 1, t: 1.3, won: true };
    this.mercy.record(1);
    this.audio.play("win");
  }

  /** Host: the brawl is decided; the room shows the result and restarts on a timer. */
  private endOnlineMatch(): void {
    this.state = "ended";
    this.endT = 0;
    this.winner = this.brawlers.find((b) => b.alive)?.name ?? null;
  }

  /** Decide the match once the player falls or is the last one standing. */
  private resolveDown(downed: Brawler, killer: Brawler | null, left: number): void {
    const { player } = this;
    if (downed === player) {
      this.localDown(downed.rank, killer);
    } else if (left === 1 && player?.alive) {
      this.localWin();
    } else if (left === 2 && player?.alive) {
      this.hud.banner("SHOWDOWN!", 1.5, true);
    }
    if (this.mode === "host" && left <= 1) {
      this.endOnlineMatch();
    }
  }

  onBrawlerDown(downed: Brawler, killer: Brawler | null): void {
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
  shake(amount: number, x: number, z: number): void {
    const d = dist(x, z, this.focus.x, this.focus.z);
    this.shakeAmp = Math.max(this.shakeAmp, amount * clamp(1 - d / 8, 0, 1));
  }

  clearBots(): void {
    for (const b of this.brawlers) {
      if (b.isPlayer) {
        continue;
      }
      this.hud.overheads.get(b.id)?.root.remove();
      this.hud.overheads.delete(b.id);
      b.dispose();
    }
    this.brawlers = this.brawlers.filter((b) => b.isPlayer);
    this.brains = [];
  }

  spawnBot(id: string, x: number, z: number, name?: string, withBrain = false): Brawler {
    const def = isBrawlerId(id) ? BRAWLERS[id] : BRAWLERS.dusty;
    const brawler = new Brawler(this, def, {
      hueShift: rand(-0.06, 0.06),
      isPlayer: false,
      name: name || (BOT_NAMES[this.brawlers.length % BOT_NAMES.length] ?? "Bot"),
      x,
      z,
    });
    this.brawlers.push(brawler);
    this.hud.addBrawler(brawler);
    if (withBrain) {
      this.brains.push(new Bot(this, brawler));
    }
    return brawler;
  }

  /** The clock idles forward on the menu and tracks match progress in play. */
  private updateTime(dt: number): void {
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
  announceCount(): void {
    const count = Math.ceil(this.countdownT - COUNTDOWN_GO_S);
    if (count !== this.lastCount && count >= 1 && count <= 3) {
      this.lastCount = count;
      this.hud.banner(String(count), 0.8);
      this.audio.play("count");
    }
  }

  /** The countdown is over: the brawl is on. */
  announceGo(): void {
    this.lastCount = 0;
    this.lighting.resetShadowFit();
    this.hud.banner("BRAWL!", 0.9);
    this.audio.play("go");
  }

  announceGas(): void {
    this.hud.banner("POISON GAS IS CLOSING IN!", 2.2, true);
  }

  private updateCountdown(dt: number): void {
    this.countdownT -= dt;
    this.announceCount();
    if (this.countdownT <= COUNTDOWN_GO_S && this.lastCount !== 0) {
      this.state = "playing";
      this.announceGo();
    }
  }

  private updateGas(dt: number): void {
    const wasActive = this.gas.active;
    this.gas.update(dt, this.matchTime);
    if (!wasActive && this.gas.active) {
      this.announceGas();
    }
  }

  /** Charged supers pulse gold; the player carries a lantern once it is dark. */
  private addDynamicLights(): void {
    const { lighting } = this;
    for (const b of this.brawlers) {
      if (b.alive && !b.hidden && b.superReady) {
        lighting.addLight(b.x, 0.9, b.z, SUPER_GLOW, 1.5 + Math.sin(this.elapsed * 6) * 0.4, 3.6);
      }
    }
    const { player } = this;
    if (player?.alive && lighting.night > 0.02) {
      lighting.addLight(player.x, 1.9, player.z, PLAYER_GLOW, 2.4 * lighting.night, 6.5);
    }
  }

  /** Menu attract mode: when the bots have fought to a finish, reset the brawl. */
  private updateAttract(dt: number): void {
    this.attractT = aliveCount(this.brawlers) <= 1 ? this.attractT + dt : 0;
    if (this.attractT > ATTRACT_RESTART_S) {
      this.toMenu();
    }
  }

  private updateResult(dt: number): void {
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

  private updatePaused(dt: number): void {
    updateCamera(this, 0);
    this.world.update(dt, this.elapsed);
    this.lighting.update(dt, this.elapsed, this.camera, this.focus, true);
    this.hud.update(0);
  }

  /** Everything after the bodies moved: effects, camera, lights, HUD — shared by every mode. */
  private present(dt: number): void {
    this.effects.update(dt);
    updateVisibility(this);
    if (this.mode !== "guest") {
      this.updateTime(dt);
    }
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

  /** One authoritative sim step, shared by solo play and the host. */
  private stepSim(dt: number): void {
    this.elapsed += dt;
    if (this.state === "countdown") {
      this.updateCountdown(dt);
    } else if (this.state !== "menu") {
      this.matchTime += dt;
    }
    if (this.mode === "host") {
      reconcileSeats(this);
      applyRemoteIntents(this);
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

  /** Connection edges shared by the host and guest paths; returns false once the room is gone. */
  private pollSession(): boolean {
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
    }
    return true;
  }

  private updateConnecting(dt: number): void {
    const { session } = this;
    if (!session) {
      this.mode = "solo";
      return;
    }
    if (session.update(dt)) {
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
    // The menu arena idles behind the pill; its brawl is not worth the CPU on a slow client.
    this.elapsed += dt;
    this.present(dt);
  }

  private broadcast(dt: number): void {
    const { session } = this;
    if (!session) {
      return;
    }
    this.snapAcc += dt;
    if (this.snapAcc < 1 / SNAPSHOT_HZ) {
      return;
    }
    this.snapAcc = 0;
    this.seqOut += 1;
    session.broadcast(encodeSnapshot(this, this.seqOut), this.netFx);
    this.netFx = [];
  }

  private updateHost(dt: number): void {
    const { session } = this;
    session?.update(dt);
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
    this.broadcast(dt);
  }

  private updateGuest(dt: number): void {
    const { session, guest } = this;
    session?.update(dt);
    if (!this.pollSession() || this.mode !== "guest" || !session || !guest) {
      return;
    }
    this.elapsed += dt;
    applyRemoteIntents(this);
    const snap = session.readSnapshot();
    if (snap && snap.seq !== guest.seq) {
      guest.apply(snap);
      session.seq = snap.seq;
    }
    if (!guest.hasWorld) {
      setNetStatus("Waiting for the host…");
      this.present(dt);
      return;
    }
    if (this.state !== "countdown") {
      this.matchTime += dt;
    }
    controlPlayer(this);
    for (const b of this.brawlers) {
      b.update(dt);
    }
    guest.update(dt);
    this.gas.update(dt, this.matchTime, false);
    replayBatch(this.effects, this.hud, session.takeFx(), this.localSeatId);
    this.present(dt);
  }

  update(dt: number): void {
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
      default: {
        this.stepSim(dt);
        break;
      }
    }
  }

  /** The host owes the room wall-clock time: a long frame becomes several fixed sub-steps. */
  private stepFrame(raw: number): void {
    if (this.mode !== "host") {
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

  private readonly frame = (now: number): void => {
    const raw = (now - this.last) / 1000;
    const dt = Math.min(MAX_STEP_S, Math.max(1e-4, raw));
    this.last = now;
    // Pad edges are published once per rendered frame, before any sim step reads them.
    this.input.poll();
    this.menuPad.update();
    tickDiagnostics();
    const { info } = this.pipeline.renderer;
    this.frameStats.calls = info.render.calls;
    this.frameStats.triangles = info.render.triangles;
    info.reset();
    this.stepFrame(raw);
    this.pipeline.render(dt);
    if (this.warmup > 0) {
      this.warmup -= 1;
      if (this.warmup === 0) {
        benchmarkQuality(this);
        // The benchmark took real time; do not let it register as one giant frame.
        this.last = performance.now();
        mustGet("loading").classList.add("done");
      }
    }
    adaptQuality(this, raw);
    requestAnimationFrame(this.frame);
  };
}
