import { SoundBank } from "./sfx-bank";
import type { SoundName } from "./sfx-bank";

// Cozy kart mix: quiet sampled motion under short musical/foley cues. No saws,
// square waves, synthetic gear shifts, or stacked crash/glass layers.
// motion + one-shots → gameplay bus ┐
// music / ambience / UI buses ──────┴→ master → compressor → destination
const MASTER_LEVEL = 0.65;
// Music sits behind the continuous motor; plucks must not read as engine ticks.
const MUSIC_LEVEL = 0.08;
const MAX_VOICES = 12;
const EIGHTH = 60 / 108 / 2;
const MELODY: readonly (number | null)[] = [
  523.25,
  null,
  659.25,
  783.99,
  null,
  659.25,
  587.33,
  null,
];
const BASS: readonly number[] = [130.81, 110, 87.31, 98];

export interface AmbienceEnv {
  readonly exposure: number;
  readonly shore: number;
  readonly night: number;
  readonly gatePan: number;
}

type LoopName =
  | "engine-loop"
  | "road-loop"
  | "drift-loop"
  | "boost-loop"
  | "scrape-loop"
  | "water-loop";
const LOOP_NAMES: readonly LoopName[] = [
  "engine-loop",
  "road-loop",
  "drift-loop",
  "boost-loop",
  "scrape-loop",
  "water-loop",
];
interface LoopVoice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  sampled: boolean;
  rate: number;
  level: number;
}
type Bus = "gameplay" | "ui" | "ambient";
interface CueOptions {
  volume?: number;
  rate?: number;
  pan?: number;
  cooldown?: number;
  bus?: Bus;
}
interface Voice {
  source: AudioScheduledSourceNode;
  bus: Bus | "music";
}

// AudioContext resume()/suspend() reject when the tab flips again mid-
// transition; the next visibility change reissues the call, so the rejection
// is deliberately dropped.
const settleAudio = async (transition: Promise<void>): Promise<void> => {
  try {
    await transition;
  } catch {
    // the next visibility change reissues it
  }
};

const uiSound = (kind: "open" | "move" | "select" | "back"): SoundName => {
  if (kind === "move") {
    return "ui-move";
  }
  return kind === "back" ? "ui-back" : "ui-select";
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

/** A rounded, quiet fallback until the generated loop is decoded. */
const fallbackLoop = (ctx: AudioContext, name: LoopName): AudioBuffer => {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  if (name === "engine-loop") {
    for (let i = 0; i < data.length; i += 1) {
      const phase = (i / ctx.sampleRate) * Math.PI * 2;
      data[i] =
        Math.sin(phase * 140) * 0.146 +
        Math.sin(phase * 280) * 0.0292 +
        Math.sin(phase * 420) * 0.0052;
    }
    return buffer;
  }

  // Equal-power overlap keeps the noise continuous at the wrap. Fading each
  // buffer edge to zero would repeat a small dropout on every fallback lap.
  const overlap = Math.round(ctx.sampleRate * 0.02);
  const noise = new Float32Array(data.length + overlap);
  let smooth = 0;
  for (let i = -512; i < noise.length; i += 1) {
    smooth += (Math.random() * 2 - 1 - smooth) * 0.09;
    if (i >= 0) {
      noise[i] = smooth * 0.25;
    }
  }
  data.set(noise.subarray(overlap, data.length));
  for (let i = 0; i < overlap; i += 1) {
    const angle = (i / (overlap - 1)) * Math.PI * 0.5;
    data[data.length - overlap + i] =
      (noise[data.length + i] ?? 0) * Math.cos(angle) + (noise[i] ?? 0) * Math.sin(angle);
  }
  return buffer;
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private gameplayBus: GainNode | null = null;
  private uiBus: GainNode | null = null;
  private ambientBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private readonly bank = new SoundBank();
  private readonly loops = new Map<LoopName, LoopVoice>();
  private readonly voices = new Set<Voice>();
  private readonly lastCue = new Map<SoundName, number>();
  private paused = false;
  private hidden = false;
  private boostLoopOn = false;
  private ambience: AmbienceEnv = { exposure: 0, gatePan: 0, night: 0, shore: 0 };
  private ambientTimer: number | null = null;
  private ambientDue = { "ambient-bell": 24, "ambient-foghorn": 32, "ambient-gulls": 9 };
  private musicOn = false;
  private musicTimer: number | null = null;
  private musicStep = 0;
  private nextNoteTime = 0;
  private countdownStep = 3;
  muted = true;

  /** Call on a user gesture; all other methods remain safe before audio exists. */
  ensure(): void {
    if (this.ctx) {
      if (!this.hidden && this.ctx.state === "suspended") {
        void settleAudio(this.ctx.resume());
      }
      this.startMusicScheduler();
      return;
    }
    if (!window.AudioContext) {
      return;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.hidden = document.hidden;
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.18;
    compressor.connect(ctx.destination);
    this.master = ctx.createGain();
    this.master.gain.value = this.muted || this.hidden ? 0 : MASTER_LEVEL;
    this.master.connect(compressor);
    const bus = (level: number): GainNode => {
      const node = ctx.createGain();
      node.gain.value = level;
      if (this.master) {
        node.connect(this.master);
      }
      return node;
    };
    this.gameplayBus = bus(this.paused ? 0 : 1);
    this.uiBus = bus(1);
    this.ambientBus = bus(this.paused ? 0 : 0.3);
    this.musicBus = bus(this.paused || !this.musicOn ? 0 : MUSIC_LEVEL);
    for (const name of LOOP_NAMES) {
      this.createLoop(ctx, name);
    }
    void this.bank.load(ctx, () => this.upgradeLoops());
    document.addEventListener("visibilitychange", () => {
      this.hidden = document.hidden;
      if (this.hidden) {
        this.clearVoices();
        void settleAudio(ctx.suspend());
      } else {
        this.nextNoteTime = ctx.currentTime + 0.05;
        void settleAudio(ctx.resume());
      }
      this.updateGates();
    });
    this.ambientTimer = window.setInterval(() => this.tickAmbience(), 1000);
    this.startMusicScheduler();
    if (this.hidden) {
      void settleAudio(ctx.suspend());
    }
  }

  private createLoop(ctx: AudioContext, name: LoopName): void {
    const out = this.gameplayBus;
    if (!out) {
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = fallbackLoop(ctx, name);
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(out);
    source.start();
    this.loops.set(name, { gain, level: 0, rate: 1, sampled: false, source });
  }

  /** Late downloads inherit current gain/rate. They cannot revive stopped motion. */
  private upgradeLoops(): void {
    const { ctx } = this;
    if (!ctx) {
      return;
    }
    for (const [name, loop] of this.loops) {
      const buffer = this.bank.get(name);
      if (!buffer || loop.sampled) {
        continue;
      }
      const old = loop.source;
      const oldGain = loop.gain;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.playbackRate.value = loop.rate;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(gain);
      if (this.gameplayBus) {
        gain.connect(this.gameplayBus);
      }
      source.start();
      gain.gain.setTargetAtTime(loop.level, ctx.currentTime, 0.08);
      oldGain.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
      old.addEventListener(
        "ended",
        () => {
          old.disconnect();
          oldGain.disconnect();
        },
        { once: true },
      );
      old.stop(ctx.currentTime + 0.25);
      loop.source = source;
      loop.gain = gain;
      loop.sampled = true;
    }
  }

  private loop(name: LoopName, level: number, rate = 1): void {
    const { ctx } = this;
    const loop = this.loops.get(name);
    if (!ctx || !loop) {
      return;
    }
    loop.level = clamp(level, 0, 0.5);
    loop.rate = clamp(rate, 0.65, 1.65);
    loop.gain.gain.setTargetAtTime(loop.level, ctx.currentTime, 0.09);
    loop.source.playbackRate.setTargetAtTime(loop.rate, ctx.currentTime, 0.14);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.clearVoices();
    }
    this.updateGates();
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) {
      this.stopEngine();
      this.clearVoices();
    }
    this.nextNoteTime = (this.ctx?.currentTime ?? 0) + 0.05;
    this.updateGates();
  }

  private updateGates(): void {
    const { ctx } = this;
    if (!ctx) {
      return;
    }
    const t = ctx.currentTime;
    this.master?.gain.setTargetAtTime(this.muted || this.hidden ? 0 : MASTER_LEVEL, t, 0.025);
    this.gameplayBus?.gain.setTargetAtTime(this.paused ? 0 : 1, t, 0.025);
    this.ambientBus?.gain.setTargetAtTime(this.paused ? 0 : 0.3, t, 0.025);
    const music = this.paused || !this.musicOn ? 0 : MUSIC_LEVEL;
    this.musicBus?.gain.cancelScheduledValues(t);
    this.musicBus?.gain.setTargetAtTime(music, t, 0.04);
  }

  setEngine(speedFrac: number, throttle: number, boosting: boolean, airborne = false): void {
    const speed = clamp(speedFrac, 0, 1);
    const load = clamp(throttle, 0, 1);
    this.loop(
      "engine-loop",
      0.1 + load * 0.075 + speed * 0.06,
      0.78 + speed * 0.48 + load * 0.07 + (boosting ? 0.12 : 0) + (airborne ? 0.07 : 0),
    );
    this.loop("road-loop", airborne ? 0 : speed * speed * 0.08, 0.85 + speed * 0.3);
  }

  /** Stops every motion layer; restart/countdown must never inherit a drift or boost. */
  stopEngine(): void {
    for (const name of LOOP_NAMES) {
      this.loop(name, 0);
    }
    this.boostLoopOn = false;
  }

  setWaterMotion(speed: number): void {
    this.loop("water-loop", clamp(speed / 18, 0, 1) * 0.3, 0.85 + clamp(speed / 35, 0, 0.4));
  }

  setScreech(slip: number, speedFrac: number): void {
    const amount = clamp(slip, 0, 1);
    this.loop("drift-loop", amount * clamp(speedFrac * 2, 0, 1) * 0.22, 0.9 + amount * 0.15);
  }

  setScrape(on: boolean): void {
    this.loop("scrape-loop", on ? 0.2 : 0);
  }
  setBoostLoop(on: boolean): void {
    this.boostLoopOn = on;
    this.loop("boost-loop", on ? 0.2 : 0);
  }

  setAmbience(env: AmbienceEnv): void {
    this.ambience = env;
  }

  private tickAmbience(): void {
    if (!this.ctx || this.muted || this.paused || this.hidden) {
      return;
    }
    const env = this.ambience;
    for (const name of ["ambient-gulls", "ambient-bell", "ambient-foghorn"] satisfies SoundName[]) {
      this.ambientDue[name] -= 1;
      if (this.ambientDue[name] > 0) {
        continue;
      }
      this.ambientDue[name] =
        name === "ambient-gulls" ? 12 + Math.random() * 16 : 35 + Math.random() * 45;
      if (name === "ambient-gulls" && (env.shore < 0.15 || env.night > 0.6)) {
        continue;
      }
      if (name === "ambient-foghorn" && env.shore < 0.2) {
        continue;
      }
      this.cue(name, {
        bus: "ambient",
        pan: name === "ambient-foghorn" ? env.gatePan : Math.random() * 1.4 - 0.7,
        volume: name === "ambient-bell" ? 0.18 : 0.15 + env.shore * 0.12,
      });
    }
  }

  private output(bus: Bus): GainNode | null {
    if (bus === "ui") {
      return this.uiBus;
    }
    return bus === "ambient" ? this.ambientBus : this.gameplayBus;
  }

  /** One voice per event, bounded polyphony and cooldowns keep traffic from piling up. */
  private cue(name: SoundName, options: CueOptions = {}): void {
    const { ctx } = this;
    const { bus = "gameplay", volume = 0.48, rate = 1, pan = 0, cooldown = 0.1 } = options;
    const out = this.output(bus);
    if (!ctx || !out || this.muted || this.hidden || (this.paused && bus !== "ui")) {
      return;
    }
    if (ctx.currentTime - (this.lastCue.get(name) ?? -Infinity) < cooldown) {
      return;
    }
    if (this.voices.size >= MAX_VOICES) {
      return;
    }
    this.lastCue.set(name, ctx.currentTime);
    const buffer = this.bank.get(name);
    if (!buffer) {
      this.tone(523.25 * rate, ctx.currentTime, 0.16, volume * 0.13, out, bus);
      return;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = clamp(rate, 0.65, 1.8);
    const gain = ctx.createGain();
    gain.gain.value = clamp(volume, 0, 0.85);
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    source.connect(gain);
    gain.connect(panner);
    panner.connect(out);
    const voice: Voice = { bus, source };
    this.voices.add(voice);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        gain.disconnect();
        panner.disconnect();
        this.voices.delete(voice);
      },
      { once: true },
    );
    source.start();
  }

  private clearVoices(bus?: Voice["bus"]): void {
    for (const voice of this.voices) {
      if (bus !== undefined && voice.bus !== bus) {
        continue;
      }
      voice.source.stop();
      this.voices.delete(voice);
    }
  }

  boost(): void {
    this.cue("boost", { volume: 0.5 });
    this.duck();
  }
  miniTurbo(tier: 1 | 2): void {
    this.cue("boost", { rate: tier === 2 ? 1.25 : 1.1, volume: 0.55 });
    this.duck();
  }
  boostReady(): void {
    this.cue("boost-ready", { cooldown: 2, volume: 0.42 });
  }
  boostEnd(): void {
    this.cue("near-miss", { rate: 0.75, volume: 0.2 });
  }
  driftArm(tier: 1 | 2 = 1): void {
    this.cue("drift-ready", { rate: tier === 2 ? 1.25 : 1, volume: 0.46 });
  }
  crash(power: number): void {
    this.cue(power > 12 ? "impact-hard" : "impact-soft", {
      cooldown: 0.22,
      volume: clamp(0.32 + power * 0.012, 0.32, 0.65),
    });
    this.duck();
  }
  thud(): void {
    this.cue("impact-soft", { cooldown: 0.15, volume: 0.3 });
  }
  jump(): void {
    this.cue("jump", { cooldown: 0.5, volume: 0.34 });
  }
  landThud(power: number): void {
    this.cue("landing", { cooldown: 0.25, volume: 0.3 + clamp(power, 0, 1) * 0.26 });
  }
  waterSplash(speed: number, verticalSpeed: number): void {
    this.cue("splash", {
      cooldown: 0.35,
      volume: 0.3 + clamp((Math.abs(speed) + Math.abs(verticalSpeed)) / 35, 0, 1) * 0.3,
    });
  }
  honk(pan: number): void {
    this.cue("horn", { cooldown: 0.7, pan, volume: 0.3 });
  }
  nearMiss(pan = 0): void {
    this.cue("near-miss", { cooldown: 0.3, pan, volume: 0.4 });
  }
  pickup(): void {
    this.cue("pickup", { volume: 0.58 });
    this.duck();
  }
  dropoff(combo: number): void {
    this.cue("dropoff", { rate: 1 + Math.min(10, Math.max(0, combo)) * 0.015, volume: 0.62 });
    this.duck();
  }
  passengerWarning(): void {
    this.cue("warning", { cooldown: 3, volume: 0.42 });
  }
  passengerBail(): void {
    this.cue("fare-lost", { volume: 0.52 });
    this.duck();
  }
  beep(): void {
    this.cue("warning", { cooldown: 0.8, volume: 0.36 });
  }
  denied(): void {
    this.cue("denied", { bus: "ui", cooldown: 0.4, volume: 0.34 });
  }
  countdown(step?: number): void {
    const n = clamp(step ?? this.countdownStep, 1, 3);
    this.countdownStep = n > 1 ? n - 1 : 3;
    this.cue("countdown", { rate: 1 + (3 - n) * 0.12, volume: 0.5 });
  }
  go(): void {
    this.countdownStep = 3;
    this.cue("go", { volume: 0.62 });
    this.duck();
  }
  gameOver(): void {
    this.clearVoices("gameplay");
    this.cue("finish", { volume: 0.55 });
    this.countdownStep = 3;
  }
  fanfare(): void {
    this.clearVoices("gameplay");
    this.cue("record", { volume: 0.6 });
    this.duck();
  }
  ui(kind: "open" | "move" | "select" | "back"): void {
    this.ensure();
    this.cue(uiSound(kind), {
      bus: "ui",
      cooldown: 0.065,
      rate: kind === "open" ? 0.9 : 1,
      volume: kind === "move" ? 0.25 : 0.38,
    });
  }
  pause(): void {
    this.setPaused(true);
    this.ui("back");
  }
  resume(): void {
    this.setPaused(false);
    this.ui("open");
  }
  reset(): void {
    this.clearVoices();
    this.stopEngine();
    this.setPaused(false);
    this.cue("reset", { bus: "ui", volume: 0.46 });
  }
  unlock(): void {
    this.cue("record", { bus: "ui", rate: 1.15, volume: 0.52 });
  }

  startMusic(): void {
    this.musicOn = true;
    this.updateGates();
    this.startMusicScheduler();
  }
  stopMusic(): void {
    this.musicOn = false;
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
    }
    this.musicTimer = null;
    this.clearVoices("music");
    this.updateGates();
  }
  private startMusicScheduler(): void {
    if (!this.ctx || !this.musicOn || this.musicTimer !== null) {
      return;
    }
    this.nextNoteTime = this.ctx.currentTime + 0.05;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 25);
  }
  /** Sparse rounded plucks replace the relentless square bass and noisy hats. */
  private scheduleMusic(): void {
    const { ctx } = this;
    const out = this.musicBus;
    if (!ctx || !out || this.muted || this.paused || this.hidden) {
      return;
    }
    if (this.nextNoteTime < ctx.currentTime - 0.2) {
      this.nextNoteTime = ctx.currentTime + 0.05;
    }
    while (this.nextNoteTime < ctx.currentTime + 0.1) {
      const t = this.nextNoteTime;
      const step = this.musicStep;
      const bass = BASS[Math.floor(step / 8) % BASS.length] ?? 130.81;
      if (step % 4 === 0) {
        this.tone(bass, t, 0.45, 0.18, out, "music");
      }
      const melody = MELODY[step % MELODY.length];
      if (melody && Math.floor(step / 8) % 2 === 0) {
        this.tone(melody, t, 0.25, 0.08, out, "music");
      }
      this.musicStep += 1;
      this.nextNoteTime += EIGHTH;
    }
  }
  private tone(
    freq: number,
    at: number,
    duration: number,
    volume: number,
    out: AudioNode,
    bus: Voice["bus"],
  ): void {
    const { ctx } = this;
    if (!ctx || this.voices.size >= MAX_VOICES) {
      return;
    }
    const source = ctx.createOscillator();
    source.type = "sine";
    source.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(volume, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
    source.connect(gain);
    gain.connect(out);
    const voice: Voice = { bus, source };
    this.voices.add(voice);
    source.addEventListener(
      "ended",
      () => {
        source.disconnect();
        gain.disconnect();
        this.voices.delete(voice);
      },
      { once: true },
    );
    source.start(at);
    source.stop(at + duration + 0.02);
  }
  private duck(): void {
    const { ctx } = this;
    const out = this.musicBus;
    if (!ctx || !out || !this.musicOn || this.paused) {
      return;
    }
    out.gain.cancelScheduledValues(ctx.currentTime);
    out.gain.setTargetAtTime(MUSIC_LEVEL * 0.35, ctx.currentTime, 0.02);
    out.gain.setTargetAtTime(MUSIC_LEVEL, ctx.currentTime + 0.5, 0.18);
  }

  /** Read-only browser QA: no buffers or engine objects escape. */
  diagnostics() {
    return {
      activeOneShots: this.voices.size,
      ambientScheduler: this.ambientTimer !== null,
      bank: this.bank.diagnostics(),
      boostLoopOn: this.boostLoopOn,
      context: this.ctx?.state ?? "uninitialized",
      hidden: this.hidden,
      loops: [...this.loops].map(([name, voice]) => ({
        level: voice.level,
        name,
        rate: voice.rate,
        sampled: voice.sampled,
      })),
      muted: this.muted,
      paused: this.paused,
    };
  }
}
