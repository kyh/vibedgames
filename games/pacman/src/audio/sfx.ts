// Synthesized WebAudio SFX (zzfx-style, same engine as games/starfall): every
// sound is rendered once into an AudioBuffer at init and replayed via pooled
// BufferSource nodes with ±6% pitch jitter. Tuned CUTE — sines and triangles,
// soft attacks, music-box registers; nothing buzzes or booms. Unlocked on the
// first user gesture. Also hosts the looping background-music player.

const SAMPLE_RATE = 44_100;
/** Per-play pitch jitter: rate = 0.94 + rand·0.12 (±6%). */
const PITCH_JITTER_BASE = 0.94;
const PITCH_JITTER_SPAN = 0.12;
/** `caught` ducks everything else to this gain for DUCK_MS. */
const DUCK_GAIN = 0.25;
const DUCK_MS = 450;
const MASTER_GAIN = 0.5;

/** "1" = sound ON; anything else/absent = muted (sound is opt-in). */
const SOUND_KEY = "pacman:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). Audio prefs fall back to muted — never crash the game.
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
    // Blocked store just loses persistence — never the game.
  }
}

/** Muted by default; enabled only when the user previously opted in via M. */
function initialSoundOn(): boolean {
  return storageGet(SOUND_KEY) === "1";
}

let soundOn = initialSoundOn();

function rememberSound(on: boolean): void {
  soundOn = on;
  storageSet(SOUND_KEY, on ? "1" : "0");
}

/** The live preference remains truthful when storage is unavailable. */
export function isSoundOn(): boolean {
  return soundOn;
}

const SFX_NAMES = [
  "chomp",
  "pellet",
  "power",
  "ghost_eaten",
  "caught",
  "ready",
  "win",
  "gameover",
  "bump",
  "turn",
  "warn",
] as const;

export type SfxName = (typeof SFX_NAMES)[number];

export type PlayOpts = { gain?: number; rate?: number };

const VOICE_LIMIT = 24;
const ROUTINE_LIMIT = 16;
const ESSENTIAL = new Set<SfxName>([
  "power",
  "ghost_eaten",
  "caught",
  "ready",
  "win",
  "gameover",
  "warn",
]);
type Voice = {
  source: AudioBufferSourceNode;
  gain: GainNode;
  essential: boolean;
  name: SfxName;
  ended: () => void;
};

/**
 * `sfx.play(name)` — fire-and-forget synth playback. Call `unlock()` from a
 * pointerdown/keydown handler; everything before that is silently dropped.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Routine sfx route through this (duckable); `caught` bypasses it. */
  private duckBus: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private paused = false;
  private disposed = false;
  private unlocked = false;
  private transition: Promise<void> | null = null;
  private readonly voices = new Set<Voice>();
  private accepted = 0;
  private dropped = 0;
  private stopped = 0;
  private ended = 0;
  private peak = 0;

  unlock(): void {
    if (this.disposed) return;
    this.unlocked = true;
    if (!soundOn) return;
    if (!this.ctx && "AudioContext" in window) {
      try {
        const ctx = new AudioContext();
        this.ctx = ctx;
        this.master = ctx.createGain();
        this.master.gain.value = this.paused ? 0 : MASTER_GAIN;
        this.master.connect(ctx.destination);
        this.duckBus = ctx.createGain();
        this.duckBus.connect(this.master);
        for (const name of SFX_NAMES) this.buffers.set(name, renderBuffer(ctx, RECIPES[name]));
      } catch {
        this.releaseContext();
      }
    }
    this.reconcile();
  }

  play(name: SfxName, opts: PlayOpts = {}): void {
    const ctx = this.ctx;
    const duckBus = this.duckBus;
    const master = this.master;
    if (
      this.disposed ||
      this.paused ||
      !soundOn ||
      !ctx ||
      !duckBus ||
      !master ||
      ctx.state !== "running" ||
      this.transition
    )
      return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const volume = opts.gain ?? 1;
    const rate = opts.rate ?? 1;
    if (!Number.isFinite(volume) || volume <= 0 || !Number.isFinite(rate) || rate <= 0) return;
    const essential = ESSENTIAL.has(name);
    let routine = 0;
    for (const voice of this.voices) if (!voice.essential) routine++;
    if (!essential && (routine >= ROUTINE_LIMIT || this.voices.size >= VOICE_LIMIT)) {
      this.dropped++;
      return;
    }
    if (this.voices.size >= VOICE_LIMIT) {
      const victim =
        [...this.voices].find((voice) => !voice.essential) ?? this.voices.values().next().value;
      if (victim) this.release(victim, "stopped");
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const jitter = PITCH_JITTER_BASE + Math.random() * PITCH_JITTER_SPAN;
    src.playbackRate.value = rate * jitter;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain);
    gain.connect(name === "caught" ? master : duckBus);
    // Every authored multi-note phrase is one buffer, admitted and retired whole.
    const voice: Voice = {
      source: src,
      gain,
      essential,
      name,
      ended: () => this.release(voice, "ended"),
    };
    this.voices.add(voice);
    src.addEventListener("ended", voice.ended, { once: true });
    try {
      src.start();
    } catch {
      this.release(voice, "stopped");
      return;
    }
    this.accepted++;
    this.peak = Math.max(this.peak, this.voices.size);
    if (name === "caught") this.duck();
  }

  /** Follows the M toggle (Music.toggle persists the shared preference). */
  setEnabled(on: boolean): void {
    if (this.disposed) return;
    rememberSound(on);
    if (!on) this.reset();
    if (on && this.unlocked && !this.paused) this.unlock();
    this.reconcile();
  }

  setPaused(paused: boolean): void {
    if (this.disposed) return;
    this.paused = paused;
    if (paused) this.reset();
    this.reconcile();
  }

  reset(): void {
    for (const voice of this.voices) this.release(voice, "stopped");
    if (this.ctx && this.duckBus) {
      this.duckBus.gain.cancelScheduledValues(this.ctx.currentTime);
      this.duckBus.gain.setValueAtTime(1, this.ctx.currentTime);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.reset();
    this.releaseContext();
  }

  private releaseContext(): void {
    const ctx = this.ctx;
    this.ctx = null;
    this.master?.disconnect();
    this.master = null;
    this.duckBus?.disconnect();
    this.duckBus = null;
    this.buffers.clear();
    this.transition = null;
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  }

  private release(voice: Voice, reason: "ended" | "stopped"): void {
    if (!this.voices.delete(voice)) return;
    voice.source.removeEventListener("ended", voice.ended);
    if (reason === "stopped") {
      this.stopped++;
      try {
        voice.source.stop();
      } catch {
        /* A failed start still owns a graph. */
      }
    } else this.ended++;
    voice.source.disconnect();
    voice.gain.disconnect();
  }

  private reconcile(): void {
    const ctx = this.ctx;
    if (this.disposed || !ctx || ctx.state === "closed") return;
    const run = soundOn && !this.paused;
    if (this.master) {
      this.master.gain.cancelScheduledValues(ctx.currentTime);
      this.master.gain.setValueAtTime(run ? MASTER_GAIN : 0, ctx.currentTime);
    }
    if (this.transition || ctx.state === (run ? "running" : "suspended")) return;
    const pending = run ? ctx.resume() : ctx.suspend();
    this.transition = pending;
    const settle = (): void => {
      if (this.disposed || this.ctx !== ctx || this.transition !== pending) return;
      this.transition = null;
      if (run !== (soundOn && !this.paused)) this.reconcile();
    };
    void pending.then(settle, settle);
  }

  diagnostics() {
    let routine = 0;
    for (const voice of this.voices) if (!voice.essential) routine++;
    return Object.freeze({
      muted: !soundOn,
      paused: this.paused,
      disposed: this.disposed,
      context: this.ctx?.state ?? "uncreated",
      transition: this.transition !== null,
      // AudioParam.value may lag the last render quantum while suspended.
      masterGain: this.master?.gain.value ?? 0,
      ownedSources: this.voices.size,
      routineSources: routine,
      essentialSources: this.voices.size - routine,
      limit: VOICE_LIMIT,
      routineLimit: ROUTINE_LIMIT,
      accepted: this.accepted,
      dropped: this.dropped,
      stopped: this.stopped,
      ended: this.ended,
      peak: this.peak,
    });
  }

  /** Duck every routine sound while the "ohh no" sting plays. */
  private duck(): void {
    const ctx = this.ctx;
    const bus = this.duckBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(DUCK_GAIN, t);
    bus.gain.linearRampToValueAtTime(1, t + DUCK_MS / 1000);
  }
}

export const sfx = new Sfx();

// ---- background music -------------------------------------------------------------

const MUSIC_VOLUME = 0.32;
const MUSIC_DUCK_VOLUME = 0.1;
const MUSIC_DUCK_MS = 1_400;
/** Power mode plays the lullaby a touch faster — gentle chipmunk urgency. */
const MUSIC_POWER_RATE = 1.06;

export type MusicMix = {
  phase: "title" | "ready" | "playing" | "win" | "gameover";
  /** Maze-cell distance to a dangerous ghost; null while none can threaten. */
  nearestDanger: number | null;
};

/**
 * Looping ambient track (vg-generated music-box lullaby). Degrades silently
 * if the file is missing or autoplay is blocked; `start()` is only called
 * after the same gesture that unlocks the Sfx context.
 */
export class Music {
  private audio: HTMLAudioElement | null = null;
  private paused = false;
  private disposed = false;
  private power = false;
  private pending: Promise<void> | null = null;
  private playBlocked = false;
  private duckRemaining = 0;
  private lastTime: number | null = null;
  private mix: MusicMix = { phase: "title", nearestDanger: null };
  private chasing = false;
  private candidateMs = 0;
  private volume = 0.16;
  /** Only an actual media error is permanent; autoplay denial stays retryable. */
  private failed = false;
  private readonly onError = (): void => {
    this.failed = true;
    this.releaseMedia();
  };

  start(url: string): void {
    if (this.disposed || this.failed) return;
    if (!soundOn) return;
    if (!this.audio) {
      this.audio = new Audio(url);
      this.audio.loop = true;
      this.audio.addEventListener("error", this.onError);
    }
    this.applyMix();
    // A sound-on gesture under pause can grant playback at volume zero. Its
    // completion immediately pauses; no cue or elapsed duck clock is replayed.
    this.play();
  }

  /** M key. Persists the choice and returns the new state for HUD feedback. */
  toggle(): boolean {
    if (this.disposed) return soundOn;
    rememberSound(!soundOn);
    this.applyMix();
    if (!soundOn) {
      this.audio?.pause();
      this.duckRemaining = 0;
    }
    return soundOn;
  }

  setPowerMode(on: boolean): void {
    if (this.disposed) return;
    this.power = on;
    this.applyMix();
  }

  setMix(mix: MusicMix): void {
    if (this.disposed) return;
    this.mix = {
      phase: mix.phase,
      nearestDanger:
        mix.nearestDanger !== null && Number.isFinite(mix.nearestDanger) && mix.nearestDanger >= 0
          ? mix.nearestDanger
          : null,
    };
    if (mix.phase !== "playing") {
      this.chasing = false;
      this.candidateMs = 0;
    }
  }

  /** Wrapper-requested pause: stop the loop, resumable in place. */
  pause(): void {
    if (this.disposed) return;
    this.paused = true;
    this.lastTime = null;
    this.applyMix();
    this.audio?.pause();
  }

  /** Undo pause(). Silently no-ops if autoplay is (still) blocked. */
  resume(): void {
    if (this.disposed) return;
    this.paused = false;
    this.lastTime = null;
    this.applyMix();
    if (soundOn) this.play();
  }

  /** Dip under the `caught` sting, restored by update(). */
  duck(): void {
    if (this.disposed || this.paused || !soundOn) return;
    this.duckRemaining = MUSIC_DUCK_MS / 1000;
    this.applyMix();
  }

  update(dt?: number): void {
    if (this.disposed || this.paused) return;
    const now = performance.now();
    const delta = dt ?? (this.lastTime === null ? 0 : (now - this.lastTime) / 1000);
    const elapsed = Number.isFinite(delta) ? Math.max(0, Math.min(0.1, delta)) : 0;
    this.lastTime = now;
    const distance = this.mix.nearestDanger;
    const danger = this.mix.phase === "playing" && !this.power && distance !== null;
    const candidate = this.chasing ? danger && distance < 4.2 : danger && distance < 3;
    if (candidate === this.chasing) this.candidateMs = 0;
    else {
      this.candidateMs += elapsed * 1000;
      if (this.candidateMs >= (candidate ? 450 : 900)) {
        this.chasing = candidate;
        this.candidateMs = 0;
      }
    }
    if (this.mix.phase !== "playing" || this.power) this.chasing = false;
    this.duckRemaining = Math.max(0, this.duckRemaining - elapsed);
    const target = this.targetVolume();
    this.volume += (target - this.volume) * (1 - Math.exp(-elapsed * 3));
    this.applyMix();
  }

  reset(): void {
    if (this.disposed) return;
    this.duckRemaining = 0;
    this.power = false;
    this.chasing = false;
    this.candidateMs = 0;
    this.lastTime = null;
    this.mix = { phase: "ready", nearestDanger: null };
    this.applyMix();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseMedia();
  }

  private releaseMedia(): void {
    const audio = this.audio;
    this.audio = null;
    this.pending = null;
    if (!audio) return;
    audio.removeEventListener("error", this.onError);
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }

  private play(): void {
    const audio = this.audio;
    if (this.disposed || !audio || !soundOn || this.pending) return;
    if (!audio.paused && !audio.ended) return;
    const pending = audio.play();
    this.pending = pending;
    void pending.then(
      () => {
        if (this.audio !== audio || this.disposed) {
          audio.pause();
          return;
        }
        if (this.pending !== pending) return;
        this.pending = null;
        this.playBlocked = false;
        this.applyMix();
        if (this.paused || !soundOn) audio.pause();
        return undefined;
      },
      () => {
        if (this.audio !== audio || this.pending !== pending || this.disposed) return;
        this.pending = null;
        this.playBlocked = true;
      },
    );
  }

  private targetVolume(): number {
    if (this.mix.phase === "title") return 0.16;
    if (this.mix.phase === "win" || this.mix.phase === "gameover") return 0.12;
    return this.chasing ? MUSIC_VOLUME : this.power ? 0.3 : 0.24;
  }

  private applyMix(): void {
    const audio = this.audio;
    if (!audio) return;
    audio.volume =
      !soundOn || this.paused || this.disposed
        ? 0
        : this.duckRemaining > 0
          ? MUSIC_DUCK_VOLUME
          : this.volume;
    audio.playbackRate = this.power ? MUSIC_POWER_RATE : 1;
  }

  diagnostics() {
    return Object.freeze({
      muted: !soundOn,
      paused: this.paused,
      disposed: this.disposed,
      media: this.audio !== null,
      pending: this.pending !== null,
      playing: this.audio ? !this.audio.paused : false,
      failed: this.failed,
      playBlocked: this.playBlocked,
      phase: this.mix.phase,
      chasing: this.chasing,
      candidateMs: this.candidateMs,
      power: this.power,
      duckRemaining: this.duckRemaining,
      volume: this.audio?.volume ?? 0,
      targetVolume: this.targetVolume(),
      playbackRate: this.audio?.playbackRate ?? (this.power ? MUSIC_POWER_RATE : 1),
    });
  }
}

export const music = new Music();

/** Looping lullaby the music player starts once audio is unlocked. */
const BGM_URL = "audio/bgm.m4a";

/**
 * Browsers gate audio behind a user gesture — call this from any handler that
 * one produced (a tap anywhere, a keypress, the touch mute button, which the
 * window listeners never see because the cluster seals its own pointers).
 * Both calls are idempotent.
 */
export function unlockAudio(): void {
  sfx.unlock();
  music.start(BGM_URL);
}

export function setAudioPaused(paused: boolean): void {
  sfx.setPaused(paused);
  if (paused) music.pause();
  else music.resume();
}

export function resetAudio(): void {
  sfx.reset();
  music.reset();
}

export function disposeAudio(): void {
  sfx.dispose();
  music.dispose();
}

export function audioDiagnostics() {
  return Object.freeze({ muted: !soundOn, sfx: sfx.diagnostics(), music: music.diagnostics() });
}

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

function makeNoise(): () => number {
  return () => Math.random() * 2 - 1;
}

const TAU = Math.PI * 2;

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

/** Music-box pluck: sine + soft 3rd harmonic, fast attack, ringing decay. */
function pluck(t: number, freq: number, dur: number): number {
  const body = Math.sin(TAU * freq * t) + 0.22 * Math.sin(TAU * freq * 3 * t);
  return body * env(t, dur, 0.003, 2.2);
}

/** Evenly-spaced note sequence helper: returns the active note + local time. */
function step(t: number, dur: number, notes: ReadonlyArray<number>) {
  const slice = dur / notes.length;
  const idx = Math.min(notes.length - 1, Math.floor(t / slice));
  return { f: notes[idx] ?? 440, local: t - idx * slice };
}

// ---- the sounds -----------------------------------------------------------------

const RECIPES = {
  // 70ms soft "boop" — fires on every step, so it stays tiny and round.
  chomp: {
    durMs: 70,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 310, 240)) * env(t, dur, 0.004, 1.8),
  },
  // 110ms music-box pluck; the scene walks the rate up a pentatonic combo.
  pellet: {
    durMs: 110,
    render: (t, dur) => 0.32 * pluck(t, 740, dur),
  },
  // 360ms rising 4-note sparkle arpeggio (C5 E5 G5 C6) with shimmer.
  power: {
    durMs: 360,
    render: (t, dur) => {
      const { f, local } = step(t, dur, [523, 659, 784, 1047]);
      const shimmer = 0.85 + 0.15 * Math.sin(TAU * 12 * t);
      return 0.34 * pluck(local, f, dur / 4) * shimmer;
    },
  },
  // 240ms cute pop + chirp-up — a marshmallow being booped.
  ghost_eaten: {
    durMs: 240,
    render: (t, dur, rng) => {
      const pop = t < 0.018 ? 0.5 * rng() * (1 - t / 0.018) : 0;
      const chirp = 0.34 * Math.sin(slidePhase(t, dur, 620, 1240)) * env(t, dur, 0.004, 1.8);
      return pop * 0.4 + chirp;
    },
  },
  // 560ms gentle descending "ohh no" — triangle with slow vibrato, no boom.
  caught: {
    durMs: 560,
    render: (t, dur) => {
      const vibrato = 1 + 0.012 * Math.sin(TAU * 6 * t);
      return 0.4 * triangle(slidePhase(t, dur, 392 * vibrato, 196)) * env(t, dur, 0.01, 1.3);
    },
  },
  // 200ms two-note "ding-ding" (E5 A5).
  ready: {
    durMs: 200,
    render: (t, dur) => {
      const { f, local } = step(t, dur, [659, 880]);
      return 0.3 * pluck(local, f, dur / 2);
    },
  },
  // 850ms five-note victory jingle (C E G C6 E6), music-box register.
  win: {
    durMs: 850,
    render: (t, dur) => {
      const { f, local } = step(t, dur, [523, 659, 784, 1047, 1319]);
      return 0.36 * pluck(local, f, dur / 5);
    },
  },
  // 700ms soft three-note descent (E5 C5 G4) — sad but encouraging.
  gameover: {
    durMs: 700,
    render: (t, dur) => {
      const { f, local } = step(t, dur, [659, 523, 392]);
      return 0.34 * pluck(local, f, dur / 3);
    },
  },
  // 70ms low "bonk" — chomped into a wall; clearly not the chomp boop.
  bump: {
    durMs: 70,
    render: (t, dur) => 0.34 * Math.sin(slidePhase(t, dur, 170, 110)) * env(t, dur, 0.002, 2),
  },
  // 45ms steering tick — confirms the head-turn registered.
  turn: {
    durMs: 45,
    render: (t, dur) => 0.22 * triangle(TAU * 520 * t) * env(t, dur, 0.002, 2.5),
  },
  // 260ms soft two-note "wearing off" warning (A5 E5) near power-mode end.
  warn: {
    durMs: 260,
    render: (t, dur) => {
      const { f, local } = step(t, dur, [880, 659]);
      return 0.26 * pluck(local, f, dur / 2);
    },
  },
} satisfies Record<SfxName, Recipe>;
