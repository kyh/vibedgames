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

  /** True until the first user gesture creates + resumes the context. */
  get locked(): boolean {
    return this.ctx === null || this.ctx.state !== "running";
  }

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.master.connect(ctx.destination);
    this.duckBus = ctx.createGain();
    this.duckBus.connect(this.master);
    for (const name of SFX_NAMES) {
      this.buffers.set(name, renderBuffer(ctx, RECIPES[name]));
    }
  }

  play(name: SfxName, opts: PlayOpts = {}): void {
    const ctx = this.ctx;
    const duckBus = this.duckBus;
    const master = this.master;
    if (!ctx || !duckBus || !master || ctx.state !== "running") return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const jitter = PITCH_JITTER_BASE + Math.random() * PITCH_JITTER_SPAN;
    src.playbackRate.value = (opts.rate ?? 1) * jitter;
    const gain = ctx.createGain();
    gain.gain.value = opts.gain ?? 1;
    src.connect(gain);
    gain.connect(name === "caught" ? master : duckBus);
    src.addEventListener("ended", () => {
      src.disconnect();
      gain.disconnect();
    });
    src.start();
    if (name === "caught") this.duck();
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

/**
 * Looping ambient track (vg-generated music-box lullaby). Degrades silently
 * if the file is missing or autoplay is blocked; `start()` is only called
 * after the same gesture that unlocks the Sfx context.
 */
export class Music {
  private audio: HTMLAudioElement | null = null;
  private enabled = true;
  private duckUntil = 0;
  /** Latched on load/play failure so repeated gestures don't re-request a 404. */
  private failed = false;

  start(url: string): void {
    if (this.audio || this.failed) return;
    const audio = new Audio(url);
    audio.loop = true;
    // Respect a mute toggled before the first unlocking gesture (M can be
    // the very first key pressed — GameScene's handler runs before unlock).
    audio.volume = this.enabled ? MUSIC_VOLUME : 0;
    audio.addEventListener("error", () => {
      this.audio = null;
      this.failed = true;
    });
    this.audio = audio;
    void audio.play().catch(() => {
      this.audio = null;
      this.failed = true;
    });
  }

  /** M key. Returns the new enabled state for HUD feedback. */
  toggle(): boolean {
    this.enabled = !this.enabled;
    if (this.audio) this.audio.volume = this.enabled ? MUSIC_VOLUME : 0;
    return this.enabled;
  }

  setPowerMode(on: boolean): void {
    if (this.audio) this.audio.playbackRate = on ? MUSIC_POWER_RATE : 1;
  }

  /** Dip under the `caught` sting, restored by update(). */
  duck(): void {
    if (!this.audio || !this.enabled) return;
    this.duckUntil = performance.now() + MUSIC_DUCK_MS;
    this.audio.volume = MUSIC_DUCK_VOLUME;
  }

  update(): void {
    if (!this.audio || !this.enabled) return;
    if (this.duckUntil > 0 && performance.now() >= this.duckUntil) {
      this.duckUntil = 0;
      this.audio.volume = MUSIC_VOLUME;
    }
  }
}

export const music = new Music();

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
function step(t: number, dur: number, notes: ReadonlyArray<number>): { f: number; local: number } {
  const slice = dur / notes.length;
  const idx = Math.min(notes.length - 1, Math.floor(t / slice));
  return { f: notes[idx] ?? 440, local: t - idx * slice };
}

// ---- the 8 sounds -----------------------------------------------------------------

const RECIPES: Record<SfxName, Recipe> = {
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
};
