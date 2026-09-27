// WebAudio synth for all game sound. The context is created lazily on the
// first user gesture (`unlock`), everything routes through one master gain and
// a compressor, and positional sounds fade with distance from the camera focus.

import type { SoundName, Synth } from "./audio-recipes";
import { SOUND_RECIPES } from "./audio-recipes";
import type { SfxRecorder } from "./net/presentation";

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

const MASTER_GAIN = 0.34;
/** Envelopes ramp exponentially, which cannot reach zero, so they land here instead. */
const SILENCE = 8e-4;
/** Distance from the listener at which a positional sound is inaudible. */
const HEARING_RANGE = 22;
/** Identical sounds closer together than this are collapsed into one. */
const MIN_REPEAT_GAP = 0.035;

export class GameAudio implements Synth {
  ctx: AudioContext | null = null;
  master: GainNode | null = null;
  muted = false;
  listener = { x: 0, z: 0 };
  noiseBuffer: AudioBuffer | null = null;
  lastPlayed = new Map<SoundName, number>();
  /** While hosting online, every play request is also written here for guests. */
  recorder: SfxRecorder | null = null;

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") {
        this.ctx.resume();
      }
      return;
    }
    const Context = window.AudioContext ?? window.webkitAudioContext;
    if (Context) {
      this.attach(new Context());
    }
  }

  private attach(ctx: AudioContext): void {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    const compressor = ctx.createDynamicsCompressor();
    this.master.connect(compressor);
    compressor.connect(ctx.destination);
    const length = ctx.sampleRate;
    this.noiseBuffer = ctx.createBuffer(1, length, length);
    const samples = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) {
      samples[i] = Math.random() * 2 - 1;
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) {
      this.master.gain.value = muted ? 0 : MASTER_GAIN;
    }
  }

  tone(
    wave: OscillatorType,
    fromHz: number,
    toHz: number,
    duration: number,
    gain: number,
    delay = 0,
  ): void {
    const { ctx, master } = this;
    if (!ctx || !master) {
      return;
    }
    const at = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = wave;
    osc.frequency.setValueAtTime(fromHz, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), at + duration);
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(SILENCE, at + duration);
    osc.connect(env);
    env.connect(master);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  noise(
    filter: BiquadFilterType,
    fromHz: number,
    toHz: number,
    duration: number,
    gain: number,
    q = 1,
    delay = 0,
  ): void {
    const { ctx, master } = this;
    if (!ctx || !master) {
      return;
    }
    const at = ctx.currentTime + delay;
    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.playbackRate.value = 0.8 + Math.random() * 0.4;
    const band = ctx.createBiquadFilter();
    band.type = filter;
    band.Q.value = q;
    band.frequency.setValueAtTime(fromHz, at);
    band.frequency.exponentialRampToValueAtTime(Math.max(30, toHz), at + duration);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, at);
    env.gain.exponentialRampToValueAtTime(SILENCE, at + duration);
    source.connect(band);
    band.connect(env);
    env.connect(master);
    source.start(at, Math.random() * 0.5);
    source.stop(at + duration + 0.02);
  }

  /** 1 for non-positional sounds, else a squared falloff to silence at the hearing range. */
  loudness(x: number | undefined, z: number | undefined): number {
    if (x === undefined || z === undefined) {
      return 1;
    }
    const range = Math.hypot(x - this.listener.x, z - this.listener.z);
    const near = Math.max(0, 1 - range / HEARING_RANGE);
    return near * near;
  }

  play(name: SoundName, x?: number, z?: number): void {
    this.recorder?.(name, x ?? null, z ?? null);
    if (this.ctx && !this.muted) {
      this.emit(name, this.loudness(x, z));
    }
  }

  emit(name: SoundName, loudness: number): void {
    if (loudness < 0.02 || !this.ctx) {
      return;
    }
    const now = this.ctx.currentTime;
    if (now - (this.lastPlayed.get(name) ?? -1) < MIN_REPEAT_GAP) {
      return;
    }
    this.lastPlayed.set(name, now);
    SOUND_RECIPES[name](this, loudness);
  }
}
