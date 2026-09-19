// The match orchestrator: owns the scene, renderer pipeline, lighting, world,
// roster and every subsystem, drives the frame loop, and runs the menu →
// countdown → playing → ended state machine. Subsystems reach each other
// through this object, so its public fields are the game's internal API.

import * as THREE from "three";

import { Bot } from "./ai/bot";
import { AimGuide } from "./aim-guide";
import { GameAudio } from "./audio";
import { updateCamera, CAMERA_FOV } from "./camera";
import { Combat } from "./combat/combat";
import { Gas } from "./combat/gas";
import { BOT_NAMES, BRAWLERS, DIFFICULTIES, TUNING, isBrawlerId } from "./config";
import type { BrawlerId, Difficulty, DifficultyName, QualityName } from "./config";
import { Brawler } from "./entities/brawler";
import { Effects } from "./fx/effects";
import { mustGet } from "./dom";
import { Hud } from "./hud";
import { Input, keyCode } from "./input";
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

export interface GameOptions {
  /** Called whenever a match begins (the embed wrapper uses it to clear its chrome). */
  onMatchStart?: () => void;
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

interface PendingResult {
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

const randomSeed = (): number => Math.trunc(Math.random() * 1e9);

/** A numeric query param; NaN when absent or blank, so callers can `||` a default. */
const numberParam = (params: URLSearchParams, name: string): number => {
  const raw = params.get(name);
  return raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
};

/** Kill-feed class hook: the player's own name is highlighted. */
const feedTag = (b: Brawler | null): string => (b?.isPlayer ? "you" : "");

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
    const auto = this.params.get("auto");
    if (auto && isBrawlerId(auto)) {
      this.startMatch(auto);
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

  /** Freeze the simulation; `announce` shows the P-key hint toast. */
  setPaused(paused: boolean, announce = true): void {
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

  private clearEntities(): void {
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

  private newWorld(): void {
    this.world.dispose();
    this.nextSeed = this.fixedSeed === null ? randomSeed() : this.fixedSeed;
    this.fixedSeed = null;
    this.world = new World(this.scene, this.nextSeed, this.maxAniso);
    this.lighting.setLamps(this.world.lanterns, this.world.lampGlass);
    this.effects.rebuildFireflies();
  }

  /** Fill every spawn: the player (if any) first, then bots with random kits and names. */
  private spawnRoster(playerId: BrawlerId | null): void {
    this.clearEntities();
    const { world } = this;
    const spawns = shuffle([...world.spawns]);
    const names = shuffle([...BOT_NAMES]);
    const kits = Object.keys(BRAWLERS).filter(isBrawlerId);
    const count = TUNING.bots + 1;
    for (let i = 0; i < count; i += 1) {
      const spawn = spawns[i % spawns.length];
      if (!spawn) {
        break;
      }
      const [tx, ty] = spawn;
      const isPlayer = i === 0 && playerId !== null;
      const kitId = isPlayer ? playerId : kits[(i + Math.floor(Math.random() * 4)) % 4];
      const def = BRAWLERS[kitId ?? "dusty"];
      const brawler = new Brawler(this, def, {
        hueShift: isPlayer ? 0 : rand(-0.07, 0.07),
        isPlayer,
        name: isPlayer ? "YOU" : (names[i % names.length] ?? "Bot"),
        x: world.center(tx),
        z: world.center(ty),
      });
      this.brawlers.push(brawler);
      this.hud.addBrawler(brawler);
      if (isPlayer) {
        this.player = brawler;
      } else {
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
    this.onMatchStart?.();
  }

  onPlayerHurt(amount: number): void {
    this.hud.flashHurt(amount);
    this.shakeAmp = Math.max(this.shakeAmp, 0.07);
  }

  /** Decide the match once the player falls or is the last one standing. */
  private resolveDown(downed: Brawler, killer: Brawler | null, left: number): void {
    const { player } = this;
    if (downed === player) {
      this.state = "ended";
      this.spectate = killer?.alive ? killer : null;
      this.pendingResult = { rank: downed.rank, t: 1.5, won: false };
      this.audio.play("lose");
    } else if (left === 1 && player?.alive) {
      this.state = "ended";
      player.rank = 1;
      this.pendingResult = { rank: 1, t: 1.3, won: true };
      this.audio.play("win");
    } else if (left === 2 && player?.alive) {
      this.hud.banner("SHOWDOWN!", 1.5, true);
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
    if (killer && killer !== downed) {
      this.hud.feed(
        `<span class="k ${feedTag(killer)}">${killer.name}</span> ⚔ <span class="v ${feedTag(downed)}">${downed.name}</span>`,
      );
    } else {
      this.hud.feed(`<span class="v ${feedTag(downed)}">${downed.name}</span> ☠ poison gas`);
    }
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

  private updateCountdown(dt: number): void {
    this.countdownT -= dt;
    const count = Math.ceil(this.countdownT - COUNTDOWN_GO_S);
    if (count !== this.lastCount && count >= 1 && count <= 3) {
      this.lastCount = count;
      this.hud.banner(String(count), 0.8);
      this.audio.play("count");
    }
    if (this.countdownT <= COUNTDOWN_GO_S && this.lastCount !== 0) {
      this.lastCount = 0;
      this.state = "playing";
      this.lighting.resetShadowFit();
      this.hud.banner("BRAWL!", 0.9);
      this.audio.play("go");
    }
  }

  private updateGas(dt: number): void {
    const wasActive = this.gas.active;
    this.gas.update(dt, this.matchTime);
    if (!wasActive && this.gas.active) {
      this.hud.banner("POISON GAS IS CLOSING IN!", 2.2, true);
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
      );
    }
  }

  private updatePaused(dt: number): void {
    updateCamera(this, 0);
    this.world.update(dt, this.elapsed);
    this.lighting.update(dt, this.elapsed, this.camera, this.focus, true);
    this.hud.update(0);
  }

  update(dt: number): void {
    this.pipeline.resize();
    if (this.paused) {
      this.updatePaused(dt);
      return;
    }
    this.elapsed += dt;
    if (this.state === "countdown") {
      this.updateCountdown(dt);
    } else if (this.state !== "menu") {
      this.matchTime += dt;
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
    this.effects.update(dt);
    updateVisibility(this);
    this.updateTime(dt);
    updateCamera(this, dt);
    this.world.update(dt, this.elapsed);
    this.addDynamicLights();
    this.audio.listener.x = this.focus.x;
    this.audio.listener.z = this.focus.z;
    this.lighting.update(dt, this.elapsed, this.camera, this.focus);
    if (this.state === "menu") {
      this.updateAttract(dt);
    }
    this.updateResult(dt);
    this.hud.update(dt);
  }

  private readonly frame = (now: number): void => {
    const raw = (now - this.last) / 1000;
    const dt = Math.min(0.05, Math.max(1e-4, raw));
    this.last = now;
    const { info } = this.pipeline.renderer;
    this.frameStats.calls = info.render.calls;
    this.frameStats.triangles = info.render.triangles;
    info.reset();
    for (let i = 0; i < this.simSteps; i += 1) {
      this.update(dt);
    }
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
