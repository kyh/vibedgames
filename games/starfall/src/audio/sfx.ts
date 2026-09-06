// Synthesized WebAudio SFX (zzfx-style): every sound is rendered once into an
// AudioBuffer at init and replayed via disposable BufferSource nodes with ±8%
// pitch jitter. No audio files. Unlocked on the first user gesture.
// Muted by default — the player opts into sound (M) and the choice persists.

import type { BattleBeat } from "../render/battle-beat";
import { battlePhrase, scoreLeadIn, type MusicMode, type MusicScore } from "./battle-score";

export type { MusicMode } from "./battle-score";

const SAMPLE_RATE = 44_100;
/** Per-play pitch jitter: rate = 0.92 + rand·0.16 (±8%). */
const PITCH_JITTER_BASE = 0.92;
const PITCH_JITTER_SPAN = 0.16;
/** player_death ducks everything else to this gain for DUCK_MS. */
const DUCK_GAIN = 0.25;
const DUCK_MS = 300;
const MASTER_GAIN = 0.5;
const SOUND_KEY = "starfall:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). The game must boot and run without persistence.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the run.
  }
}

/** Every sfx name — the single source of truth: `SfxName` derives from this
 *  list, and RECIPES' `Record<SfxName, Recipe>` type enforces full coverage. */
const SFX_NAMES = [
  "fire_pulse",
  "fire_heavy",
  "fire_laser",
  "fire_scatter",
  "arc_zap",
  "hit_spark",
  "enemy_death",
  "shield_hit",
  "shield_break",
  "shield_low",
  "shield_regen",
  "rail",
  "pickup",
  "pickup_shield",
  "pickup_booster",
  "combo_up",
  "player_death",
  "telegraph_warn",
  "respawn",
  "sentry_place",
  "beacon_charge",
  "beacon_active",
  "beacon_clash",
  "boss_arrival",
  "boss_phase",
  "boss_defeat",
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

export type PlayOpts = { gain?: number; rate?: number };

type VoiceRole = "routine" | "important" | "music";
type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  startsAt: number;
  role: VoiceRole;
  onEnded: () => void;
};

const VOICE_LIMIT = 32;
const ROUTINE_LIMIT = 24;
const MUSIC_LIMIT = 2;
const IMPORTANT = new Set<SfxName>([
  "shield_hit",
  "shield_break",
  "shield_low",
  "shield_regen",
  "player_death",
  "respawn",
  "telegraph_warn",
  "beacon_charge",
  "beacon_active",
  "beacon_clash",
  "boss_arrival",
  "boss_phase",
  "boss_defeat",
]);

/** Cached synth buffers; this game owns each disposable source and gain. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Routine SFX and music duck; player_death retains its direct master route. */
  private duckBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private musicBuffers = new Map<MusicScore, AudioBuffer>();
  private voices = new Map<AudioBufferSourceNode, Voice>();
  private preference = storageGet(SOUND_KEY) !== "1";
  private paused = false;
  private disposed = false;
  private hasRun = false;
  private priming = false;
  private transition: Promise<void> | null = null;
  private masterTarget: number | null = null;
  private musicMode: MusicMode = "silent";
  private battleBeat: BattleBeat = "quiet";
  private musicTimer: number | null = null;
  private musicGeneration = 0;
  private nextMusicAt = 0;
  private musicStep = 0;
  private counts = { accepted: 0, dropped: 0, stopped: 0, ended: 0, peak: 0 };

  get muted(): boolean {
    return this.preference;
  }

  /** Trailer's direct assignment stays temporary and cannot unlock a context. */
  set muted(next: boolean) {
    this.preference = next;
    this.applyIntent();
  }

  private get blocked(): boolean {
    return this.disposed || this.paused || this.preference;
  }

  private ready(): boolean {
    return !this.blocked && this.ctx?.state === "running" && this.transition === null;
  }

  /** Explicit Play/canvas gesture. Inactive programmatic calls build nothing. */
  unlock(): void {
    if (this.disposed || window.navigator?.userActivation?.isActive === false) return;
    if (!this.ctx) {
      if (!("AudioContext" in window)) return;
      let ctx: AudioContext;
      try {
        ctx = new AudioContext();
      } catch {
        return;
      }
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.masterTarget = this.blocked ? 0 : MASTER_GAIN;
      this.master.gain.value = this.masterTarget;
      this.master.connect(ctx.destination);
      this.duckBus = ctx.createGain();
      this.duckBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = 0.075;
      this.musicBus.connect(this.duckBus);
      // Original recipes/order stay intact; additions never draw their noise RNG.
      for (const name of SFX_NAMES) this.buffers.set(name, renderBuffer(ctx, RECIPES[name]));
      this.musicBuffers.set("flight", renderBuffer(ctx, MUSIC_RECIPES.flight));
      this.musicBuffers.set("boss", renderBuffer(ctx, MUSIC_RECIPES.boss));
    }
    // A paused sound tap may prime an EMPTY context, then suspend it again.
    this.priming = !this.hasRun && this.ctx.state === "suspended";
    this.applyIntent();
  }

  play(name: SfxName, opts: PlayOpts = {}): void {
    if (!this.ready()) return;
    const buffer = this.buffers.get(name);
    const gain = opts.gain ?? 1;
    const rate = opts.rate ?? 1;
    if (!buffer || !Number.isFinite(gain) || gain < 0 || !Number.isFinite(rate) || rate <= 0)
      return;
    const role = IMPORTANT.has(name) ? "important" : "routine";
    if (!this.admit(1, role)) return;
    const jitter = PITCH_JITTER_BASE + Math.random() * PITCH_JITTER_SPAN;
    this.source(
      buffer,
      gain,
      rate * jitter,
      this.ctx?.currentTime ?? 0,
      role,
      name === "player_death",
    );
    if (name === "player_death") this.duck();
  }

  setMuted(next: boolean): boolean {
    this.preference = next;
    storageSet(SOUND_KEY, next ? "0" : "1");
    // Native embed buttons seal pointer events: their setter owns the gesture.
    if (!next && window.navigator?.userActivation?.isActive === true) this.unlock();
    else this.applyIntent();
    return this.muted;
  }

  toggleMute(): boolean {
    return this.setMuted(!this.muted);
  }

  /** Store pause before unlock and gate playback before async suspension. */
  setSuspended(on: boolean): void {
    this.paused = on;
    this.applyIntent();
  }

  setMusicMode(mode: MusicMode): void {
    if (this.disposed || mode === this.musicMode) return;
    this.stopMusic();
    this.musicMode = mode;
    // Recovery and boss-mode changes retain the motif position. In particular,
    // a consumed aftermath must not resolve again when the player returns.
    this.startMusic();
  }

  /** Current presentation beat, not an announcement. Old SFX remain owned and
   * audible; only the music phrase changes. Repeated frame calls are inert. */
  setBattleBeat(beat: BattleBeat): void {
    if (this.disposed || beat === this.battleBeat) return;
    this.stopMusic();
    this.battleBeat = beat;
    this.musicStep = 0;
    this.startMusic();
  }

  /** Trailer/scene cut: no old cue, duck ramp or music mode crosses the cut. */
  clearTransient(): void {
    this.musicMode = "silent";
    this.battleBeat = "quiet";
    this.musicStep = 0;
    this.stopMusic();
    this.clearVoices();
    this.resetDuck();
  }

  /** Final app owner only; ordinary scene cuts retain buffers and context. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setMaster();
    this.clearTransient();
    this.priming = false;
    this.master?.disconnect();
    this.duckBus?.disconnect();
    this.musicBus?.disconnect();
    this.buffers.clear();
    this.musicBuffers.clear();
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => undefined);
  }

  private setMaster(): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const target = this.blocked ? 0 : MASTER_GAIN;
    if (target === this.masterTarget) return;
    this.masterTarget = target;
    master.gain.cancelScheduledValues(ctx.currentTime);
    if (this.blocked) master.gain.setValueAtTime(0, ctx.currentTime);
    else master.gain.setTargetAtTime(MASTER_GAIN, ctx.currentTime, 0.02);
  }

  private applyIntent(): void {
    this.setMaster();
    if (this.blocked) {
      this.stopMusic();
      this.clearVoices();
      this.resetDuck();
    }
    this.reconcileContext();
  }

  private reconcileContext(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || ctx.state === "closed" || this.transition) return;
    if (ctx.state === "running") {
      this.hasRun = true;
      this.priming = false;
    }
    const run = this.priming || !this.blocked;
    if (ctx.state === (run ? "running" : "suspended")) {
      this.startMusic();
      return;
    }
    if (run && !this.hasRun && !this.priming) return;
    const operation = run ? ctx.resume() : ctx.suspend();
    this.transition = operation;
    const finish = (): void => {
      this.transition = null;
      if (this.disposed) return;
      if (run) this.priming = false;
      if (ctx.state === "running") this.hasRun = true;
      // Retry only for a changed intent or a completed transition, never rejection alone.
      if (ctx.state === (run ? "running" : "suspended") || run !== !this.blocked)
        this.reconcileContext();
    };
    void operation.then(finish, finish);
  }

  private release(voice: Voice, forced: boolean): void {
    if (!this.voices.delete(voice.source)) return;
    voice.source.removeEventListener("ended", voice.onEnded);
    if (forced) {
      voice.source.stop();
      this.counts.stopped++;
    } else this.counts.ended++;
    voice.source.disconnect();
    voice.gain.disconnect();
  }

  private clearVoices(): void {
    for (const voice of this.voices.values()) this.release(voice, true);
  }

  private musicVoices(): number {
    let count = 0;
    for (const voice of this.voices.values()) if (voice.role === "music") count++;
    return count;
  }

  private admit(count: number, role: VoiceRole): boolean {
    if (!this.ready()) return false;
    if (role !== "important") {
      let routine = 0;
      for (const voice of this.voices.values()) if (voice.role !== "important") routine++;
      if (
        routine + count > ROUTINE_LIMIT ||
        this.voices.size + count > VOICE_LIMIT ||
        (role === "music" && this.musicVoices() + count > MUSIC_LIMIT)
      ) {
        this.counts.dropped += count;
        return false;
      }
    } else {
      while (this.voices.size + count > VOICE_LIMIT) {
        if (this.musicVoices() > 0) {
          this.clearMusicVoices();
          continue;
        }
        let oldest: Voice | undefined;
        for (const voice of this.voices.values()) {
          oldest ??= voice;
          if (voice.role === "routine") {
            oldest = voice;
            break;
          }
        }
        if (!oldest) return false;
        this.release(oldest, true);
      }
    }
    return true;
  }

  private source(
    buffer: AudioBuffer,
    volume: number,
    rate: number,
    at: number,
    role: VoiceRole,
    bypass = false,
  ): void {
    const ctx = this.ctx;
    const bus = role === "music" ? this.musicBus : bypass ? this.master : this.duckBus;
    if (!ctx || !bus) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(bus);
    const voice: Voice = {
      source: src,
      gain,
      startsAt: at,
      role,
      onEnded: () => this.release(voice, false),
    };
    this.voices.set(src, voice);
    src.addEventListener("ended", voice.onEnded, { once: true });
    this.counts.accepted++;
    this.counts.peak = Math.max(this.counts.peak, this.voices.size);
    if (role === "music") src.start(at);
    else src.start();
  }

  private clearMusicVoices(): void {
    for (const voice of this.voices.values()) if (voice.role === "music") this.release(voice, true);
  }

  private stopMusic(): void {
    this.musicGeneration++;
    if (this.musicTimer !== null) window.clearInterval(this.musicTimer);
    this.musicTimer = null;
    this.nextMusicAt = 0;
    this.clearMusicVoices();
  }

  private startMusic(): void {
    if (!this.ready() || this.musicMode === "silent" || this.musicTimer !== null || !this.ctx)
      return;
    this.nextMusicAt = this.ctx.currentTime + scoreLeadIn(this.battleBeat);
    const generation = ++this.musicGeneration;
    this.musicTimer = window.setInterval(() => this.tickMusic(generation), 200);
  }

  private tickMusic(generation: number): void {
    const ctx = this.ctx;
    const mode = this.musicMode;
    if (generation !== this.musicGeneration || !this.ready() || !ctx || mode === "silent") return;
    const now = ctx.currentTime;
    if (this.nextMusicAt < now - 0.25) this.nextMusicAt = now + 0.12;
    if (this.nextMusicAt > now + 0.25) return;
    const at = Math.max(now + 0.025, this.nextMusicAt);
    const phrase = battlePhrase(mode, this.battleBeat, this.musicStep);
    this.musicStep++;
    this.nextMusicAt = at + phrase.waitSeconds;
    if (phrase.notes.length === 0) return;
    const buffer = this.musicBuffers.get(mode);
    if (!buffer || this.musicVoices() > 0 || !this.admit(phrase.notes.length, "music")) return;
    for (const note of phrase.notes)
      this.source(buffer, note.gain, note.rate, at + note.delay, "music");
  }

  /** Duck every routine sound while the death boom plays. */
  private duck(): void {
    const ctx = this.ctx;
    const bus = this.duckBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(DUCK_GAIN, t);
    bus.gain.linearRampToValueAtTime(1, t + DUCK_MS / 1000);
  }

  private resetDuck(): void {
    if (!this.ctx || !this.duckBus) return;
    this.duckBus.gain.cancelScheduledValues(this.ctx.currentTime);
    this.duckBus.gain.setValueAtTime(1, this.ctx.currentTime);
  }

  diagnostics() {
    let scheduledSources = 0;
    let routineSources = 0;
    let essentialSources = 0;
    let musicVoices = 0;
    const now = this.ctx?.currentTime ?? 0;
    for (const voice of this.voices.values()) {
      if (voice.startsAt > now) scheduledSources++;
      if (voice.role === "important") essentialSources++;
      else routineSources++;
      if (voice.role === "music") musicVoices++;
    }
    return Object.freeze({
      contextState: this.ctx?.state ?? "locked",
      muted: this.muted,
      paused: this.paused,
      disposed: this.disposed,
      contextTransition: this.transition !== null,
      ownedSources: this.voices.size,
      scheduledSources,
      routineSources,
      essentialSources,
      musicVoices,
      graphNodes: this.voices.size,
      cachedBuffers: this.buffers.size + this.musicBuffers.size,
      musicMode: this.musicMode,
      battleBeat: this.battleBeat,
      musicStep: this.musicStep,
      schedulerCount: this.musicTimer === null ? 0 : 1,
      limit: VOICE_LIMIT,
      routineLimit: ROUTINE_LIMIT,
      musicLimit: MUSIC_LIMIT,
      // Raw AudioParam values may lag while the renderer is suspended.
      masterGain: this.master?.gain.value ?? 0,
      duckGain: this.duckBus?.gain.value ?? 1,
      ...this.counts,
    });
  }
}

export const sfx = new Sfx();

// ---- synth engine (pure) --------------------------------------------------------

type Recipe = { durMs: number; render: (t: number, dur: number, rng: () => number) => number };

function renderBuffer(ctx: AudioContext, recipe: Recipe): AudioBuffer {
  const frames = Math.max(1, Math.round((recipe.durMs / 1000) * SAMPLE_RATE));
  const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  const dur = recipe.durMs / 1000;
  const rng = makeNoise();
  for (let i = 0; i < frames; i++) {
    data[i] = clampSample(recipe.render(i / SAMPLE_RATE, dur, rng));
  }
  return buffer;
}

function clampSample(v: number): number {
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

/** Deterministic-enough white noise (no seeding needs here). */
function makeNoise(): () => number {
  return () => Math.random() * 2 - 1;
}

const TAU = Math.PI * 2;

function square(phase: number): number {
  return Math.sin(phase) >= 0 ? 1 : -1;
}

function saw(phase: number): number {
  return ((phase / TAU) % 1) * 2 - 1;
}

function triangle(phase: number): number {
  return Math.asin(Math.sin(phase)) * (2 / Math.PI);
}

/** Linear frequency slide f0→f1 over dur; returns integrated phase at t. */
function slidePhase(t: number, dur: number, f0: number, f1: number): number {
  const k = (f1 - f0) / dur;
  return TAU * (f0 * t + 0.5 * k * t * t);
}

/** Simple decay envelope: 1 → 0 with optional attack. */
function env(t: number, dur: number, attack = 0.005, curve = 1.5): number {
  if (t < attack) return t / attack;
  const rel = (t - attack) / Math.max(0.001, dur - attack);
  return Math.pow(Math.max(0, 1 - rel), curve);
}

/** One-pole lowpass over the noise source — cheap "bandpass-ish" coloring. */
function makeFilteredNoise(rng: () => number): (cutoff01: number) => number {
  let lpA = 0;
  let lpB = 0;
  return (cutoff01: number) => {
    const a = Math.min(1, Math.max(0.01, cutoff01));
    lpA += a * (rng() - lpA);
    lpB += a * (lpA - lpB);
    return lpA - lpB; // difference of two lowpasses ≈ bandpass
  };
}

// ---- sound recipes ---------------------------------------------------------------

const RECIPES = {
  // 60ms square blip, 880→660Hz slide, light
  fire_pulse: {
    durMs: 60,
    render: (t, dur) => 0.35 * square(slidePhase(t, dur, 880, 660)) * env(t, dur, 0.002),
  },
  // 120ms saw thump, 220→90Hz drop + click transient
  fire_heavy: {
    durMs: 120,
    render: (t, dur, rng) => {
      const click = t < 0.006 ? 0.6 * rng() : 0;
      return (0.5 * saw(slidePhase(t, dur, 220, 90)) * env(t, dur, 0.002, 2) + click) * 0.9;
    },
  },
  // 150ms descending sine zap 1400→300Hz with slight ring-mod shimmer
  fire_laser: {
    durMs: 150,
    render: (t, dur) => {
      const carrier = Math.sin(slidePhase(t, dur, 1400, 300));
      const shimmer = 0.75 + 0.25 * Math.sin(TAU * 90 * t);
      return 0.4 * carrier * shimmer * env(t, dur, 0.003);
    },
  },
  // 80ms filtered noise burst + 3 stacked detuned square blips (crunchy)
  fire_scatter: {
    durMs: 80,
    render: (t, dur, rng) => {
      const noise = 0.4 * rng() * env(t, dur, 0.001, 2);
      const blips =
        (square(slidePhase(t, dur, 720, 540)) +
          square(slidePhase(t, dur, 780, 590)) +
          square(slidePhase(t, dur, 660, 500))) /
        3;
      return noise + 0.25 * blips * env(t, dur, 0.002);
    },
  },
  // 90ms white-noise crackle, bandpass sweep 3kHz→800Hz, sharp attack
  arc_zap: {
    durMs: 90,
    render: (() => {
      let bp: ((c: number) => number) | null = null;
      return (t: number, dur: number, rng: () => number) => {
        if (t === 0 || !bp) bp = makeFilteredNoise(rng);
        const cutoff = 0.4 - 0.3 * (t / dur); // sweep down
        return 1.6 * bp(cutoff) * env(t, dur, 0.001, 2.5);
      };
    })(),
  },
  // 30ms tick: square 1200Hz, instant decay
  hit_spark: {
    durMs: 30,
    render: (t, dur) => 0.3 * square(TAU * 1200 * t) * env(t, dur, 0.001, 3),
  },
  // 250ms noise burst + sine drop 300→60Hz
  enemy_death: {
    durMs: 250,
    render: (t, dur, rng) =>
      0.35 * rng() * env(t, dur, 0.002, 2.5) +
      0.45 * Math.sin(slidePhase(t, dur, 300, 60)) * env(t, dur, 0.002, 1.5),
  },
  // 100ms FM metallic ping (carrier 900Hz, mod 1.4× ratio), bell-like
  shield_hit: {
    durMs: 100,
    render: (t, dur) => {
      const mod = Math.sin(TAU * 900 * 1.4 * t) * 6 * env(t, dur, 0.001, 3);
      return 0.4 * Math.sin(TAU * 900 * t + mod) * env(t, dur, 0.001, 2);
    },
  },
  // 300ms descending 3-note arpeggio (900/600/400Hz squares) + noise tail
  shield_break: {
    durMs: 300,
    render: (t, dur, rng) => {
      const note = t < dur / 3 ? 900 : t < (2 * dur) / 3 ? 600 : 400;
      const local = t % (dur / 3);
      return (
        0.3 * square(TAU * note * t) * env(local, dur / 3, 0.002) +
        0.15 * rng() * Math.max(0, t / dur - 0.5) * env(t, dur, 0.001, 1)
      );
    },
  },
  // 350ms two-tone descending minor 2nd (620→585Hz triangle), anxious —
  // the low-shield warning (gated to once per 1.2s by the caller)
  shield_low: {
    durMs: 350,
    render: (t, dur) => {
      const note = t < dur / 2 ? 620 : 585;
      const local = t % (dur / 2);
      return 0.28 * triangle(TAU * note * t) * env(local, dur / 2, 0.012, 1.2);
    },
  },
  // 400ms rising sweep 300→900Hz sine, soft attack — the Halo recharge whine
  shield_regen: {
    durMs: 400,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 300, 900)) * env(t, dur, 0.08, 1.2),
  },
  // 200ms: 60ms rising whine into a 140ms saw crack 180→70Hz (RAILGUN release)
  rail: {
    durMs: 200,
    render: (t, dur, rng) => {
      const whineDur = 0.06;
      if (t < whineDur) {
        return 0.22 * Math.sin(slidePhase(t, whineDur, 500, 1500)) * (t / whineDur);
      }
      const t2 = t - whineDur;
      const d2 = dur - whineDur;
      const click = t2 < 0.005 ? 0.5 * rng() : 0;
      return 0.55 * saw(slidePhase(t2, d2, 180, 70)) * env(t2, d2, 0.001, 2) + click;
    },
  },
  // 120ms rising two-note chirp (660→990Hz sine)
  pickup: {
    durMs: 120,
    render: (t, dur) => {
      const note = t < dur / 2 ? 660 : 990;
      const local = t % (dur / 2);
      return 0.35 * Math.sin(TAU * note * t) * env(local, dur / 2, 0.004);
    },
  },
  // shield pickup: 3-note rising variant
  pickup_shield: {
    durMs: 180,
    render: (t, dur) => {
      const third = dur / 3;
      const note = t < third ? 660 : t < 2 * third ? 880 : 1100;
      const local = t % third;
      return 0.35 * Math.sin(TAU * note * t) * env(local, third, 0.004);
    },
  },
  // booster pickup: bright octave-jump chirp with a sparkle overtone —
  // distinct from the weapon two-note and the shield three-note
  pickup_booster: {
    durMs: 160,
    render: (t, dur) => {
      const half = dur / 2;
      const note = t < half ? 740 : 1180;
      const local = t % half;
      const body = 0.7 * Math.sin(TAU * note * t) + 0.3 * triangle(TAU * note * 2 * t);
      return 0.32 * body * env(local, half, 0.003);
    },
  },
  // 180ms rising arpeggio; caller pitches root +2 semitones per tier via rate
  combo_up: {
    durMs: 180,
    render: (t, dur) => {
      const third = dur / 3;
      const note = t < third ? 520 : t < 2 * third ? 660 : 780;
      const local = t % third;
      return 0.32 * triangle(TAU * note * t) * env(local, third, 0.003);
    },
  },
  // 600ms boom: brown-noise burst + sub sine 55→30Hz
  player_death: {
    durMs: 600,
    render: (() => {
      let brown = 0;
      return (t: number, dur: number, rng: () => number) => {
        if (t === 0) brown = 0;
        brown = (brown + 0.06 * rng()) / 1.012;
        return (
          2.4 * brown * env(t, dur, 0.002, 1.8) +
          0.5 * Math.sin(slidePhase(t, dur, 55, 30)) * env(t, dur, 0.005, 1.2)
        );
      };
    })(),
  },
  // 140ms soft two-tone (520/390Hz triangle)
  telegraph_warn: {
    durMs: 140,
    render: (t, dur) => {
      const note = t < dur / 2 ? 520 : 390;
      const local = t % (dur / 2);
      return 0.25 * triangle(TAU * note * t) * env(local, dur / 2, 0.01, 1.2);
    },
  },
  // 250ms soft swell (sine 220→440Hz, slow attack)
  respawn: {
    durMs: 250,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 220, 440)) * env(t, dur, 0.12, 1.2),
  },
  // 110ms mechanical clack: noise click + two-step square clunk 520->340Hz
  // (the SENTRY turret locking onto its post)
  sentry_place: {
    durMs: 110,
    render: (t, dur, rng) => {
      const click = t < 0.008 ? 0.5 * rng() : 0;
      const note = t < dur * 0.45 ? 520 : 340;
      return 0.38 * square(TAU * note * t) * env(t, dur, 0.002, 2) + click;
    },
  },
  // 110ms rising sine blip 440→660Hz — the caller ratchets `rate` up each
  // second of the BEACON charge so the 8s telegraph climbs in pitch.
  beacon_charge: {
    durMs: 110,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 440, 660)) * env(t, dur, 0.004, 1.8),
  },
  // 550ms FM bell chime (660Hz carrier + fifth overtone) — arena-audible
  // "the zone is live" cue at the CHARGE→ACTIVE flip.
  beacon_active: {
    durMs: 550,
    render: (t, dur) => {
      const mod = Math.sin(TAU * 660 * 2 * t) * 4 * env(t, dur, 0.001, 3);
      const bell = Math.sin(TAU * 660 * t + mod) + 0.4 * Math.sin(TAU * 990 * t);
      return 0.35 * bell * env(t, dur, 0.002, 1.6);
    },
  },
  // 140ms dissonant dual-square buzz (minor-second 520/551Hz) — CONTESTED clash.
  beacon_clash: {
    durMs: 140,
    render: (t, dur) =>
      0.22 * (square(TAU * 520 * t) + square(TAU * 551 * t)) * env(t, dur, 0.003, 2),
  },
  // New buffers use pure harmonics; initialization preserves the original RNG stream.
  boss_arrival: {
    durMs: 650,
    render: (t, dur) =>
      (0.38 * Math.sin(slidePhase(t, dur, 130, 65)) + 0.16 * triangle(TAU * 195 * t)) *
      env(t, dur, 0.018, 1.2),
  },
  boss_phase: {
    durMs: 420,
    render: (t, dur) => {
      const half = dur / 2;
      const note = t < half ? 220 : 277;
      return 0.34 * triangle(TAU * note * t) * env(t % half, half, 0.01, 1.3);
    },
  },
  boss_defeat: {
    durMs: 900,
    render: (t, dur) =>
      (0.36 * Math.sin(slidePhase(t, dur, 130, 45)) +
        0.1 * (Math.sin(TAU * 220 * t) + Math.sin(TAU * 277 * t) + Math.sin(TAU * 330 * t))) *
      env(t, dur, 0.012, 1.6),
  },
} satisfies Record<SfxName, Recipe>;

const MUSIC_RECIPES = {
  flight: {
    durMs: 1800,
    render: (t, dur) =>
      (0.5 * Math.sin(TAU * 220 * t) + 0.15 * Math.sin(TAU * 440 * t)) * env(t, dur, 0.18, 1.2),
  },
  boss: {
    durMs: 1300,
    render: (t, dur) =>
      (0.42 * triangle(TAU * 110 * t) + 0.16 * Math.sin(TAU * 55 * t)) * env(t, dur, 0.08, 1.4),
  },
} satisfies Record<MusicScore, Recipe>;
