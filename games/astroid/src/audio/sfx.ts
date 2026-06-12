// Synthesized WebAudio SFX (zzfx-style): every sound is rendered once into an
// AudioBuffer at init and replayed via pooled BufferSource nodes with ±8%
// pitch jitter. No audio files. Unlocked on the first user gesture.

const SAMPLE_RATE = 44_100;
/** Per-play pitch jitter: rate = 0.92 + rand·0.16 (±8%). */
const PITCH_JITTER_BASE = 0.92;
const PITCH_JITTER_SPAN = 0.16;
/** player_death ducks everything else to this gain for DUCK_MS. */
const DUCK_GAIN = 0.25;
const DUCK_MS = 300;
const MASTER_GAIN = 0.5;

export type SfxName =
  | "fire_pulse"
  | "fire_heavy"
  | "fire_laser"
  | "fire_scatter"
  | "arc_zap"
  | "hit_spark"
  | "enemy_death"
  | "shield_hit"
  | "shield_break"
  | "pickup"
  | "pickup_shield"
  | "combo_up"
  | "player_death"
  | "telegraph_warn"
  | "respawn";

export type PlayOpts = { gain?: number; rate?: number };

/**
 * `Sfx.play(name)` — fire-and-forget synth playback. Call `unlock()` from a
 * pointerdown handler; everything before that is silently dropped.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  /** Routine sfx route through this (duckable); player_death bypasses it. */
  private duckBus: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();

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
    for (const [name, build] of Object.entries(RECIPES) as Array<[SfxName, Recipe]>) {
      this.buffers.set(name, renderBuffer(ctx, build));
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
    gain.connect(name === "player_death" ? master : duckBus);
    src.addEventListener("ended", () => {
      src.disconnect();
      gain.disconnect();
    });
    src.start();
    if (name === "player_death") this.duck();
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

// ---- the 14 sounds (§10) ----------------------------------------------------------

const RECIPES: Record<SfxName, Recipe> = {
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
};
