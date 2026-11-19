import type { BattleBeat } from "../render/battle-beat";
import { battlePhrase, scoreLeadIn } from "./battle-score";
import type { MusicMode, MusicScore } from "./battle-score";

export type { MusicMode } from "./battle-score";

const SAMPLE_RATE = 44_100;
const PITCH_JITTER_BASE = 0.92;
const PITCH_JITTER_SPAN = 0.16;
const DUCK_GAIN = 0.25;
const DUCK_MS = 300;
const MASTER_GAIN = 0.5;
const SOUND_KEY = "starfall:sound";

const storageGet = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storageSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

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

export interface PlayOpts {
  gain?: number;
  rate?: number;
  priority?: "local";
}

type VoiceRole = "routine" | "local" | "important" | "music";

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  role: VoiceRole;
  onEnded: () => void;
}

const VOICE_LIMIT = 32;
const ROUTINE_LIMIT = 24;
const MUSIC_GAIN = 0.075;

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

const RANK = { important: 2, local: 1, music: 0, routine: 0 } satisfies Record<VoiceRole, number>;

const playRole: (name: SfxName, opts: PlayOpts) => VoiceRole = (name, opts) => {
  if (IMPORTANT.has(name)) {
    return "important";
  }

  return opts.priority === "local" ? "local" : "routine";
};

interface Recipe {
  durMs: number;
  render: (t: number, dur: number, rng: () => number) => number;
}

const clampSample = (v: number) => (v > 1 ? 1 : Math.max(-1, v));

const makeNoise = () => () => Math.random() * 2 - 1;

const renderBuffer = (ctx: AudioContext, recipe: Recipe) => {
  const frames = Math.max(1, Math.round((recipe.durMs / 1000) * SAMPLE_RATE));
  const buffer = ctx.createBuffer(1, frames, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  const dur = recipe.durMs / 1000;
  const rng = makeNoise();

  for (let i = 0; i < frames; i += 1) {
    data[i] = clampSample(recipe.render(i / SAMPLE_RATE, dur, rng));
  }

  return buffer;
};

const TAU = Math.PI * 2;

const square = (phase: number) => (Math.sin(phase) >= 0 ? 1 : -1);

const saw = (phase: number) => ((phase / TAU) % 1) * 2 - 1;

const triangle = (phase: number) => Math.asin(Math.sin(phase)) * (2 / Math.PI);

const slidePhase = (t: number, dur: number, f0: number, f1: number) => {
  const k = (f1 - f0) / dur;

  return TAU * (f0 * t + 0.5 * k * t * t);
};

const env = (t: number, dur: number, attack = 0.005, curve = 1.5) => {
  if (t < attack) {
    return t / attack;
  }

  const rel = (t - attack) / Math.max(0.001, dur - attack);

  return Math.max(0, 1 - rel) ** curve;
};

const threeStep = (t: number, third: number, a: number, b: number, c: number) => {
  if (t < third) {
    return a;
  }

  if (t < 2 * third) {
    return b;
  }

  return c;
};

const makeFilteredNoise = (rng: () => number) => {
  let lpA = 0;
  let lpB = 0;

  return (cutoff01: number) => {
    const a = Math.min(1, Math.max(0.01, cutoff01));
    lpA += a * (rng() - lpA);
    lpB += a * (lpA - lpB);

    return lpA - lpB;
  };
};

const RECIPES = {
  arc_zap: {
    durMs: 90,
    render: (() => {
      let bp: ((c: number) => number) | null = null;

      return (t: number, dur: number, rng: () => number) => {
        if (t === 0 || !bp) {
          bp = makeFilteredNoise(rng);
        }

        const cutoff = 0.4 - 0.3 * (t / dur);

        return 1.6 * bp(cutoff) * env(t, dur, 0.001, 2.5);
      };
    })(),
  },
  beacon_active: {
    durMs: 550,
    render: (t, dur) => {
      const mod = Math.sin(TAU * 660 * 2 * t) * 4 * env(t, dur, 0.001, 3);
      const bell = Math.sin(TAU * 660 * t + mod) + 0.4 * Math.sin(TAU * 990 * t);

      return 0.35 * bell * env(t, dur, 0.002, 1.6);
    },
  },
  beacon_charge: {
    durMs: 110,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 440, 660)) * env(t, dur, 0.004, 1.8),
  },
  beacon_clash: {
    durMs: 140,
    render: (t, dur) =>
      0.22 * (square(TAU * 520 * t) + square(TAU * 551 * t)) * env(t, dur, 0.003, 2),
  },
  boss_arrival: {
    durMs: 650,
    render: (t, dur) =>
      (0.38 * Math.sin(slidePhase(t, dur, 130, 65)) + 0.16 * triangle(TAU * 195 * t)) *
      env(t, dur, 0.018, 1.2),
  },
  boss_defeat: {
    durMs: 900,
    render: (t, dur) =>
      (0.36 * Math.sin(slidePhase(t, dur, 130, 45)) +
        0.1 * (Math.sin(TAU * 220 * t) + Math.sin(TAU * 277 * t) + Math.sin(TAU * 330 * t))) *
      env(t, dur, 0.012, 1.6),
  },
  boss_phase: {
    durMs: 420,
    render: (t, dur) => {
      const half = dur / 2;
      const note = t < half ? 220 : 277;

      return 0.34 * triangle(TAU * note * t) * env(t % half, half, 0.01, 1.3);
    },
  },
  combo_up: {
    durMs: 180,
    render: (t, dur) => {
      const third = dur / 3;
      const note = threeStep(t, third, 520, 660, 780);
      const local = t % third;

      return 0.32 * triangle(TAU * note * t) * env(local, third, 0.003);
    },
  },
  enemy_death: {
    durMs: 250,
    render: (t, dur, rng) =>
      0.35 * rng() * env(t, dur, 0.002, 2.5) +
      0.45 * Math.sin(slidePhase(t, dur, 300, 60)) * env(t, dur, 0.002, 1.5),
  },
  fire_heavy: {
    durMs: 120,
    render: (t, dur, rng) => {
      const click = t < 0.006 ? 0.6 * rng() : 0;

      return (0.5 * saw(slidePhase(t, dur, 220, 90)) * env(t, dur, 0.002, 2) + click) * 0.9;
    },
  },
  fire_laser: {
    durMs: 150,
    render: (t, dur) => {
      const carrier = Math.sin(slidePhase(t, dur, 1400, 300));
      const shimmer = 0.75 + 0.25 * Math.sin(TAU * 90 * t);

      return 0.4 * carrier * shimmer * env(t, dur, 0.003);
    },
  },
  fire_pulse: {
    durMs: 60,
    render: (t, dur) => 0.35 * square(slidePhase(t, dur, 880, 660)) * env(t, dur, 0.002),
  },
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
  hit_spark: {
    durMs: 30,
    render: (t, dur) => 0.3 * square(TAU * 1200 * t) * env(t, dur, 0.001, 3),
  },
  pickup: {
    durMs: 120,
    render: (t, dur) => {
      const note = t < dur / 2 ? 660 : 990;
      const local = t % (dur / 2);

      return 0.35 * Math.sin(TAU * note * t) * env(local, dur / 2, 0.004);
    },
  },
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
  pickup_shield: {
    durMs: 180,
    render: (t, dur) => {
      const third = dur / 3;
      const note = threeStep(t, third, 660, 880, 1100);
      const local = t % third;

      return 0.35 * Math.sin(TAU * note * t) * env(local, third, 0.004);
    },
  },
  player_death: {
    durMs: 600,
    render: (() => {
      let brown = 0;

      return (t: number, dur: number, rng: () => number) => {
        if (t === 0) {
          brown = 0;
        }

        brown = (brown + 0.06 * rng()) / 1.012;

        return (
          2.4 * brown * env(t, dur, 0.002, 1.8) +
          0.5 * Math.sin(slidePhase(t, dur, 55, 30)) * env(t, dur, 0.005, 1.2)
        );
      };
    })(),
  },
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
  respawn: {
    durMs: 250,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 220, 440)) * env(t, dur, 0.12, 1.2),
  },
  sentry_place: {
    durMs: 110,
    render: (t, dur, rng) => {
      const click = t < 0.008 ? 0.5 * rng() : 0;
      const note = t < dur * 0.45 ? 520 : 340;

      return 0.38 * square(TAU * note * t) * env(t, dur, 0.002, 2) + click;
    },
  },
  shield_break: {
    durMs: 300,
    render: (t, dur, rng) => {
      const note = threeStep(t, dur / 3, 900, 600, 400);
      const local = t % (dur / 3);

      return (
        0.3 * square(TAU * note * t) * env(local, dur / 3, 0.002) +
        0.15 * rng() * Math.max(0, t / dur - 0.5) * env(t, dur, 0.001, 1)
      );
    },
  },
  shield_hit: {
    durMs: 100,
    render: (t, dur) => {
      const mod = Math.sin(TAU * 900 * 1.4 * t) * 6 * env(t, dur, 0.001, 3);

      return 0.4 * Math.sin(TAU * 900 * t + mod) * env(t, dur, 0.001, 2);
    },
  },
  shield_low: {
    durMs: 350,
    render: (t, dur) => {
      const note = t < dur / 2 ? 620 : 585;
      const local = t % (dur / 2);

      return 0.28 * triangle(TAU * note * t) * env(local, dur / 2, 0.012, 1.2);
    },
  },
  shield_regen: {
    durMs: 400,
    render: (t, dur) => 0.3 * Math.sin(slidePhase(t, dur, 300, 900)) * env(t, dur, 0.08, 1.2),
  },
  telegraph_warn: {
    durMs: 140,
    render: (t, dur) => {
      const note = t < dur / 2 ? 520 : 390;
      const local = t % (dur / 2);

      return 0.25 * triangle(TAU * note * t) * env(local, dur / 2, 0.01, 1.2);
    },
  },
} satisfies Record<SfxName, Recipe>;

const MUSIC_RECIPES = {
  boss: {
    durMs: 1300,
    render: (t, dur) =>
      (0.42 * triangle(TAU * 110 * t) + 0.16 * Math.sin(TAU * 55 * t)) * env(t, dur, 0.08, 1.4),
  },
  flight: {
    durMs: 1800,
    render: (t, dur) =>
      (0.5 * Math.sin(TAU * 220 * t) + 0.15 * Math.sin(TAU * 440 * t)) * env(t, dur, 0.18, 1.2),
  },
} satisfies Record<MusicScore, Recipe>;

/**
 * `Sfx.play(name)` — fire-and-forget synth playback. Call `unlock()` from a
 * pointerdown handler; everything before that is silently dropped.
 */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private duckBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private musicBuffers = new Map<MusicScore, AudioBuffer>();
  private voices = new Set<Voice>();
  /** Muted by default — returning players who opted into sound stay unmuted. */
  muted = storageGet(SOUND_KEY) !== "1";
  private paused = false;
  private musicMode: MusicMode = "silent";
  private battleBeat: BattleBeat = "quiet";
  private musicTimer: number | null = null;
  private nextMusicAt = 0;
  private musicStep = 0;

  private get ready() {
    return this.ctx?.state === "running" && !this.muted && !this.paused;
  }

  unlock() {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      this.master.connect(ctx.destination);
      this.duckBus = ctx.createGain();
      this.duckBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = MUSIC_GAIN;
      this.musicBus.connect(this.duckBus);

      for (const name of SFX_NAMES) {
        this.buffers.set(name, renderBuffer(ctx, RECIPES[name]));
      }

      this.musicBuffers.set("flight", renderBuffer(ctx, MUSIC_RECIPES.flight));
      this.musicBuffers.set("boss", renderBuffer(ctx, MUSIC_RECIPES.boss));
    }

    this.syncContext();
  }

  play(name: SfxName, opts: PlayOpts = {}) {
    if (!this.ready) {
      return;
    }

    const buffer = this.buffers.get(name);

    if (!buffer) {
      return;
    }

    const role = playRole(name, opts);

    if (!this.admit(role, 1)) {
      return;
    }

    const jitter = PITCH_JITTER_BASE + Math.random() * PITCH_JITTER_SPAN;
    const bus = name === "player_death" ? this.master : this.duckBus;
    this.start(buffer, opts.gain ?? 1, (opts.rate ?? 1) * jitter, 0, role, bus);

    if (name === "player_death") {
      this.duck();
    }
  }

  /**
   * Set mute, persist the choice, and return the new state. Call from a user
   * gesture: turning sound ON creates/resumes the AudioContext via `unlock()`.
   */
  setMuted(next: boolean) {
    this.muted = next;
    storageSet(SOUND_KEY, next ? "0" : "1");

    if (next) {
      this.syncContext();
    } else {
      this.unlock();
    }

    return this.muted;
  }

  /** Flip mute (the M key); returns the new state. */
  toggleMute() {
    return this.setMuted(!this.muted);
  }

  /**
   * Pause/resume ALL audio without touching the persisted mute choice — used by
   * the wrapper pause overlay. Suspends the AudioContext (play() no-ops while
   * suspended); resume only wakes it when the player hasn't muted.
   */
  setSuspended(on: boolean) {
    this.paused = on;
    this.syncContext();
  }

  setMusicMode(mode: MusicMode) {
    if (mode === this.musicMode) {
      return;
    }

    this.musicMode = mode;
    this.restartMusic();
  }

  /** Current mood, not an announcement: only the music phrase changes. */
  setBattleBeat(beat: BattleBeat) {
    if (beat === this.battleBeat) {
      return;
    }

    this.battleBeat = beat;
    this.musicStep = 0;
    this.restartMusic();
  }

  /** Trailer cut: no old cue, duck ramp or music mode crosses it. */
  stopAll() {
    this.musicMode = "silent";
    this.battleBeat = "quiet";
    this.musicStep = 0;
    this.stopMusic();

    for (const voice of this.voices) {
      this.release(voice, true);
    }

    const { ctx } = this;
    const bus = this.duckBus;

    if (!ctx || !bus) {
      return;
    }

    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setValueAtTime(1, ctx.currentTime);
  }

  private syncContext() {
    const { ctx } = this;
    const { master } = this;

    if (!ctx || !master) {
      return;
    }

    master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.02);

    if (this.paused) {
      if (ctx.state === "running") {
        void ctx.suspend();
      }

      this.stopMusic();
    } else if (ctx.state === "suspended" && !this.muted) {
      void this.resumeThenStartMusic(ctx);
    } else {
      this.startMusic();
    }
  }

  private async resumeThenStartMusic(ctx: AudioContext) {
    await ctx.resume();
    this.startMusic();
  }

  private admit(role: VoiceRole, count: number) {
    const limit = RANK[role] === 0 ? ROUTINE_LIMIT : VOICE_LIMIT;

    while (this.voices.size + count > limit) {
      let victim: Voice | null = null;

      for (const voice of this.voices) {
        if (RANK[voice.role] < RANK[role]) {
          victim = voice;
          break;
        }
      }

      if (!victim && role === "important") {
        victim = this.voices.values().next().value ?? null;
      }

      if (!victim) {
        return false;
      }

      this.release(victim, true);
    }

    return true;
  }

  private start(
    buffer: AudioBuffer,
    volume: number,
    rate: number,
    at: number,
    role: VoiceRole,
    bus: GainNode | null,
  ) {
    const { ctx } = this;

    if (!ctx || !bus) {
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    src.connect(gain).connect(bus);
    const voice: Voice = { gain, onEnded: () => this.release(voice, false), role, source: src };
    this.voices.add(voice);
    src.addEventListener("ended", voice.onEnded, { once: true });
    src.start(at);
  }

  private release(voice: Voice, cut: boolean) {
    if (!this.voices.delete(voice)) {
      return;
    }

    voice.source.removeEventListener("ended", voice.onEnded);

    if (cut) {
      voice.source.stop();
    }

    voice.source.disconnect();
    voice.gain.disconnect();
  }

  private musicPlaying() {
    for (const voice of this.voices) {
      if (voice.role === "music") {
        return true;
      }
    }

    return false;
  }

  private stopMusic() {
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
    }

    this.musicTimer = null;

    for (const voice of this.voices) {
      if (voice.role === "music") {
        this.release(voice, true);
      }
    }
  }

  private startMusic() {
    const { ctx } = this;

    if (!ctx || !this.ready || this.musicMode === "silent" || this.musicTimer !== null) {
      return;
    }

    this.nextMusicAt = ctx.currentTime + scoreLeadIn(this.battleBeat);
    this.musicTimer = window.setInterval(() => this.tickMusic(), 200);
  }

  private restartMusic() {
    this.stopMusic();
    this.startMusic();
  }

  private tickMusic() {
    const { ctx } = this;
    const mode = this.musicMode;

    if (!ctx || !this.ready || mode === "silent") {
      this.stopMusic();

      return;
    }

    const now = ctx.currentTime;

    if (this.nextMusicAt < now - 0.25) {
      this.nextMusicAt = now + 0.12;
    }

    if (this.nextMusicAt > now + 0.25) {
      return;
    }

    const at = Math.max(now + 0.025, this.nextMusicAt);
    const phrase = battlePhrase(mode, this.battleBeat, this.musicStep);
    this.musicStep += 1;
    this.nextMusicAt = at + phrase.waitSeconds;
    const buffer = this.musicBuffers.get(mode);

    if (!buffer || phrase.notes.length === 0 || this.musicPlaying()) {
      return;
    }

    if (!this.admit("music", phrase.notes.length)) {
      return;
    }

    for (const note of phrase.notes) {
      this.start(buffer, note.gain, note.rate, at + note.delay, "music", this.musicBus);
    }
  }

  private duck() {
    const { ctx } = this;
    const bus = this.duckBus;

    if (!ctx || !bus) {
      return;
    }

    const t = ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(DUCK_GAIN, t);
    bus.gain.linearRampToValueAtTime(1, t + DUCK_MS / 1000);
  }
}

export const sfx = new Sfx();
