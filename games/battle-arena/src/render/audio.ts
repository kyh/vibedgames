// Procedural audio engine — every sound synthesized with the Web Audio API, no
// assets, no fetches, no setTimeout (all sequencing rides sample-accurate `at`
// times on the AudioContext clock).
//
//   bus graph   sfx .65 / ui .50 / music .32 / amb .22
//               → compressor(−18, 12, 4, .003, .25) → master .5 → destination
//   spatializer StereoPanner: g = 1/(1 + d²/100), cull > 55u, pan ±0.8
//   voice cap   48 SFX/UI (32 routine), 24 music, 8 ambience; distant shed first
//
// Public surface (see master-plan contracts table): setListener, hit, crit,
// attack, cast, killConfirm, stinger, leaderSlain, uiOpen/uiClose/uiBuy/uiDeny,
// abilityReady, castDeny, respawnTick, respawnGo, heartbeat, count, fight,
// dodge, land, plus the legacy voices (explosion, death, coin, levelup,
// delivery, alert, victory) and the `music` getter (4-layer intensity system,
// started on the unlock gesture).
import type { DamageType } from "../data/config";
import type { AbilityKey } from "../sim/types";
import { Music } from "./music";
import { VoicePool, type VoiceGroup } from "./audio-voices";

type BusName = "sfx" | "ui" | "amb";

interface FilterOpts {
  type: BiquadFilterType;
  from: number;
  to?: number; // exponential sweep across the voice duration
  q?: number;
  lfo?: { freq: number; depth: number }; // wobbles filter.frequency (necro rasp)
}

interface VoiceOpts {
  at?: number; // absolute AudioContext time; defaults to now
  x?: number; // world position → spatialized (gain falloff + stereo pan)
  y?: number;
  pan?: number; // manual pan, or additive offset when spatialized
  bus?: BusName; // defaults to sfx
  filter?: FilterOpts;
}

interface ToneOpts extends VoiceOpts {
  freq: number;
  dur: number;
  type?: OscillatorType; // defaults to sine
  gain: number;
  slideTo?: number; // exponential pitch slide target
  detune?: number; // cents
  attack?: number; // envelope attack seconds (default 0.005)
}

interface NoiseOpts extends VoiceOpts {
  dur: number;
  gain: number;
}

const VOICE_CAP = 28; // retain early shedding of distant routine sounds

type Mix = { g: number; pan: number };
type Plan =
  | { kind: "tone"; o: ToneOpts; mix: Mix; t: number }
  | { kind: "noise"; o: NoiseOpts; mix: Mix; t: number; offset: number }
  | { kind: "stack"; freq: number; at: number; dur: number; gain: number; fallTo?: number };
function sourceCost(plan: Plan): number {
  return plan.kind === "stack" ? 3 : 1 + (plan.o.filter?.lfo ? 1 : 0);
}
function readMuted(): boolean {
  try {
    return localStorage.getItem("ba-muted") !== "0";
  } catch {
    return true;
  }
}

// D-minor stinger pitch set
const D3 = 146.83;
const F3 = 174.61;
const A3 = 220.0;
const C4 = 261.63;

/** Key modifiers applied to each champ's base cast voice (result-05 A3). DASH =
 *  short + pitched-up zip (a whoosh layer rides on top); JUMP = longer + pitched-
 *  down heave (the landing thud is the explosion fx event). */
type CastMods = { [K in AbilityKey]: { d: number; p: number; ult?: boolean } };
const CAST_MOD: CastMods = {
  Q: { d: 0.8, p: 1.0 },
  W: { d: 1.0, p: 1.15 },
  E: { d: 1.1, p: 0.85 },
  R: { d: 1.6, p: 0.7, ult: true },
  DASH: { d: 0.5, p: 1.2 },
  JUMP: { d: 0.9, p: 0.85 },
};

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ui: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private amb: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private musicInst: Music | null = null;
  private mutedOverride: boolean | null = null; // setMutedEphemeral — never persisted
  private last: Record<string, number> = {};
  private voices = new VoicePool(48, 32);
  private ambience = new VoicePool(8, 8);
  private plans: Plan[] | null = null;
  private preference = readMuted();
  private paused = false;
  private disposed = false;
  private unlocked = false;
  private hasRun = false;
  private listening = true;
  private contextTransition: Promise<void> | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private outcome: "playing" | "won" | "lost" | "unassigned" = "playing";
  private ambGeneration = 0;
  // listener position + screen-right basis (rx,ry) = (-aimY, aimX)
  private lx = 0;
  private ly = 0;
  private rx = 0;
  private ry = 1;
  private hissFlip = false; // rogue alternating dagger pan
  private ambStarted = false;
  private ambTimer: number | null = null;
  private ambNextPop = 0;
  private ambNextMoan = 0;

  private unlock = (): void => {
    if (this.disposed) return;
    this.unlocked = true;
    this.applyIntent();
  };

  constructor() {
    window.addEventListener("pointerdown", this.unlock);
    window.addEventListener("keydown", this.unlock);
  }

  get music(): Music | null {
    return this.musicInst;
  }

  /** Saved/session preference; the trailer override never rewrites it. */
  get isMuted(): boolean {
    return this.preference;
  }

  private get blocked(): boolean {
    return this.disposed || this.paused || (this.mutedOverride ?? this.preference);
  }

  private ready(): boolean {
    return (
      !this.blocked && this.unlocked && this.ctx?.state === "running" && !this.contextTransition
    );
  }

  setMuted(on: boolean): void {
    this.preference = on;
    this.mutedOverride = null;
    try {
      localStorage.setItem("ba-muted", on ? "1" : "0");
    } catch {
      /* Retain the session preference when persistence is blocked. */
    }
    // Native touch controls seal pointer events before the window unlock listener.
    if (!on && window.navigator?.userActivation?.isActive === true) this.unlocked = true;
    this.applyIntent();
  }

  setMutedEphemeral(on: boolean): void {
    this.mutedOverride = on;
    this.applyIntent();
  }

  suspend(): void {
    this.paused = true;
    this.applyIntent();
  }

  resume(): void {
    this.paused = false;
    this.applyIntent();
  }

  private setMaster(): void {
    if (!this.master || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.blocked ? 0 : 0.5, t);
  }

  private stopBeds(): void {
    this.musicInst?.silence();
    this.stopAmbience();
  }

  private applyIntent(): void {
    this.setMaster();
    if (this.blocked) {
      this.voices.clear();
      this.stopBeds();
    } else this.ensure();
    this.reconcileContext();
  }

  private removeGesture(): void {
    if (!this.listening) return;
    this.listening = false;
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
  }

  private syncBeds(): void {
    if (!this.ready()) return;
    this.hasRun = true;
    this.removeGesture();
    if (this.outcome === "playing") {
      this.musicInst?.start();
      this.startAmbience();
    }
  }

  private reconcileContext(): void {
    if (!this.ctx || this.disposed || this.ctx.state === "closed") return;
    this.setMaster();
    if (this.contextTransition) return;
    const ctx = this.ctx;
    const shouldRun = !this.blocked;
    if (ctx.state === (shouldRun ? "running" : "suspended")) {
      this.syncBeds();
      return;
    }
    if (shouldRun && !this.hasRun && window.navigator?.userActivation?.isActive === false) return;
    const operation = shouldRun ? ctx.resume() : ctx.suspend();
    this.contextTransition = operation;
    const finish = (): void => {
      this.contextTransition = null;
      if (this.disposed) return;
      if (ctx.state === "running") this.hasRun = true;
      if (shouldRun !== !this.blocked) this.reconcileContext();
      else this.syncBeds();
    };
    void operation.then(finish, finish);
  }

  /** Store completion before unlock too; no delayed combat bed or fanfare. */
  resolveMatch(outcome: "won" | "lost" | "unassigned"): void {
    if (this.disposed || this.outcome !== "playing") return;
    this.outcome = outcome;
    this.stopAmbience();
    if (this.ready() && outcome !== "unassigned") this.musicInst?.resolve(outcome === "won");
    else this.musicInst?.silence();
  }

  /** Explicit ended→playing snapshot edge: fresh transport, same owned context. */
  beginMatch(): void {
    if (this.disposed || this.outcome === "playing") return;
    this.voices.clear();
    this.stopAmbience();
    this.musicInst?.dispose();
    this.musicInst = this.ctx && this.musicBus ? new Music(this.ctx, this.musicBus) : null;
    this.last = {};
    this.hissFlip = false;
    this.outcome = "playing";
    this.applyIntent();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.setMaster();
    this.removeGesture();
    this.voices.clear();
    this.stopAmbience();
    this.musicInst?.dispose();
    for (const node of [this.sfx, this.ui, this.musicBus, this.amb, this.compressor, this.master])
      node?.disconnect();
    this.noiseBuf = null;
    this.last = {};
    if (this.ctx && this.ctx.state !== "closed") void this.ctx.close().catch(() => undefined);
  }

  diagnostics() {
    const now = this.now();
    const sfx = this.voices.diagnostics(now);
    const ambience = this.ambience.diagnostics(now);
    const music = this.musicInst?.diagnostics() ?? null;
    return Object.freeze({
      context: this.ctx?.state ?? "uncreated",
      muted: this.preference,
      effectiveMuted: this.mutedOverride ?? this.preference,
      paused: this.paused,
      disposed: this.disposed,
      unlocked: this.unlocked,
      contextTransition: this.contextTransition !== null,
      gestureListeners: this.listening ? 2 : 0,
      // Raw render-quantum value can lag the scheduled target while suspended.
      masterGain: this.master?.gain.value ?? 0,
      outcome: this.outcome,
      ownedSources: sfx.ownedSources + ambience.ownedSources + (music?.ownedSources ?? 0),
      scheduledSources:
        sfx.scheduledSources + ambience.scheduledSources + (music?.scheduledSources ?? 0),
      schedulerCount: (this.ambTimer === null ? 0 : 1) + (music?.schedulerCount ?? 0),
      limit: 80,
      sfx,
      ambience,
      music,
    });
  }

  private ensure(): void {
    if (this.ctx || this.blocked || !this.unlocked) return;
    const scope: typeof globalThis & { webkitAudioContext?: typeof AudioContext } = globalThis;
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) return;
    let ctx: AudioContext;
    try {
      ctx = new Ctor();
    } catch {
      return;
    }
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = (this.mutedOverride ?? this.isMuted) ? 0 : 0.5;
    this.master.connect(ctx.destination);
    const comp = ctx.createDynamicsCompressor();
    this.compressor = comp;
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;
    comp.connect(this.master);
    const mkBus = (gain: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = gain;
      n.connect(comp);
      return n;
    };
    this.sfx = mkBus(0.65);
    this.ui = mkBus(0.5);
    this.musicBus = mkBus(0.32); // Music.duck() restores to this baseline
    this.amb = mkBus(0.22);
    // one second of white noise for percussive voices
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    this.musicInst = new Music(ctx, this.musicBus);
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Rate-limit a given voice so overlapping events don't stack into noise. */
  private gate(key: string, ms: number): boolean {
    if (!this.ready()) return false;
    const t = this.now() * 1000;
    if (t - (this.last[key] ?? -1e9) < ms) return false;
    this.last[key] = t;
    return true;
  }

  private jit(): number {
    return 0.92 + Math.random() * 0.16;
  }

  // ── listener / spatializer ──────────────────────────────────────────────────

  /** Per-frame listener update: local hero position + aim (for the pan basis). */
  setListener(x: number, y: number, aimX: number, aimY: number): void {
    this.lx = x;
    this.ly = y;
    this.rx = -aimY;
    this.ry = aimX;
  }

  private spatial(x: number, y: number): { g: number; pan: number } | null {
    const dx = x - this.lx;
    const dy = y - this.ly;
    const d = Math.hypot(dx, dy);
    if (d > 55) return null; // cull past ~half arena
    const g = 1 / (1 + (d * d) / 100); // ref dist 10u
    const pan =
      d < 0.5 ? 0 : Math.max(-0.8, Math.min(0.8, ((dx * this.rx + dy * this.ry) / d) * 0.8));
    return { g: Math.max(0.06, g), pan };
  }

  // ── voice primitives ────────────────────────────────────────────────────────

  private busNode(name: BusName | undefined): GainNode | null {
    if (name === "ui") return this.ui;
    if (name === "amb") return this.amb;
    return this.sfx;
  }

  private route(node: AudioNode, pan: number, bus: BusName | undefined, group: VoiceGroup): void {
    const dest = this.busNode(bus);
    if (!dest || !this.ctx) return;
    if (pan !== 0) {
      const p = group.node(this.ctx.createStereoPanner());
      p.pan.value = pan;
      node.connect(p).connect(dest);
    } else {
      node.connect(dest);
    }
  }

  private applyFilter(
    head: AudioNode,
    f: FilterOpts,
    t: number,
    dur: number,
    group: VoiceGroup,
  ): AudioNode {
    if (!this.ctx) return head;
    const filt = group.node(this.ctx.createBiquadFilter());
    filt.type = f.type;
    filt.frequency.setValueAtTime(Math.max(20, f.from), t);
    if (f.to !== undefined)
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, f.to), t + dur);
    if (f.q !== undefined) filt.Q.value = f.q;
    if (f.lfo) {
      const ctx = this.ctx;
      const lfo = group.source(() => ctx.createOscillator(), t);
      if (!lfo) return head;
      lfo.type = "sine";
      lfo.frequency.value = f.lfo.freq;
      const depth = group.node(this.ctx.createGain());
      depth.gain.value = f.lfo.depth;
      lfo.connect(depth).connect(filt.frequency);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }
    head.connect(filt);
    return filt;
  }

  /** Spatial gain/pan + voice-cap shedding. Returns null when the voice culls. */
  private mix(o: VoiceOpts, gain: number): { g: number; pan: number } | null {
    let pan = o.pan ?? 0;
    if (o.x !== undefined && o.y !== undefined) {
      const s = this.spatial(o.x, o.y);
      if (!s) return null;
      if (this.voices.count >= VOICE_CAP && s.g < 0.35) return null; // shed distant first
      gain *= s.g;
      pan = Math.max(-1, Math.min(1, s.pan + pan));
    }
    return { g: gain, pan };
  }

  private tone(o: ToneOpts): void {
    if (!this.ready() || !this.ctx) return;
    const mix = this.mix(o, o.gain);
    if (mix) this.submit({ kind: "tone", o, mix, t: o.at ?? this.ctx.currentTime });
  }

  private noise(o: NoiseOpts): void {
    if (!this.ready() || !this.ctx || !this.noiseBuf) return;
    const mix = this.mix(o, o.gain);
    if (!mix) return;
    // Freeze the original random draw here, before later recipe pitch jitter.
    const offset = Math.random() * Math.max(0, 1 - o.dur - 0.05);
    this.submit({ kind: "noise", o, mix, t: o.at ?? this.ctx.currentTime, offset });
  }

  private sawStack(freq: number, at: number, dur: number, gain = 0.07, fallTo?: number): void {
    if (this.ready()) this.submit({ kind: "stack", freq, at, dur, gain, fallTo });
  }

  private submit(plan: Plan): void {
    if (this.plans) {
      this.plans.push(plan);
      return;
    }
    const pool = plan.kind !== "stack" && plan.o.bus === "amb" ? this.ambience : this.voices;
    const group = pool.begin(sourceCost(plan));
    if (!group) return;
    this.renderPlan(plan, group);
    group.seal();
  }

  private renderPlan(plan: Plan, group: VoiceGroup): void {
    if (plan.kind === "tone") this.renderTone(plan.o, plan.mix, plan.t, group);
    else if (plan.kind === "noise") this.renderNoise(plan.o, plan.mix, plan.t, plan.offset, group);
    else this.renderStack(plan.freq, plan.at, plan.dur, plan.gain, plan.fallTo, group);
  }

  private essential(build: () => void): void {
    if (!this.ready()) return;
    if (this.plans) {
      build();
      return;
    }
    const plans: Plan[] = [];
    this.plans = plans;
    try {
      build();
    } finally {
      this.plans = null;
    }
    if (plans.length === 0) return;
    const group = this.voices.begin(
      plans.reduce((n, plan) => n + sourceCost(plan), 0),
      "essential",
    );
    if (!group) return;
    for (const plan of plans) this.renderPlan(plan, group);
    group.seal();
  }

  private renderTone(o: ToneOpts, m: Mix, t: number, group: VoiceGroup): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const osc = group.source(() => ctx.createOscillator(), t);
    if (!osc) return;
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t);
    if (o.slideTo !== undefined)
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t + o.dur);
    if (o.detune !== undefined) osc.detune.setValueAtTime(o.detune, t);
    const env = group.node(ctx.createGain());
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0003, m.g), t + (o.attack ?? 0.005));
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let head: AudioNode = osc;
    if (o.filter) head = this.applyFilter(head, o.filter, t, o.dur, group);
    head.connect(env);
    this.route(env, m.pan, o.bus, group);
    osc.start(t);
    osc.stop(t + o.dur + 0.03);
  }

  private renderNoise(o: NoiseOpts, m: Mix, t: number, offset: number, group: VoiceGroup): void {
    const ctx = this.ctx;
    if (!ctx || !this.noiseBuf) return;
    const src = group.source(() => ctx.createBufferSource(), t);
    if (!src) return;
    src.buffer = this.noiseBuf;
    const env = group.node(ctx.createGain());
    env.gain.setValueAtTime(Math.max(0.0003, m.g), t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let head: AudioNode = src;
    if (o.filter) head = this.applyFilter(head, o.filter, t, o.dur, group);
    head.connect(env);
    this.route(env, m.pan, o.bus, group);
    src.start(t, offset);
    src.stop(t + o.dur + 0.03);
  }

  /** Brass-ish stinger note: 3 detuned saws → lowpass 1250 → shared envelope. */
  private renderStack(
    freq: number,
    at: number,
    dur: number,
    gain: number,
    fallTo: number | undefined,
    group: VoiceGroup,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const dest = this.busNode("sfx");
    if (!dest) return;
    const filt = group.node(ctx.createBiquadFilter());
    filt.type = "lowpass";
    filt.frequency.value = 1250;
    const env = group.node(ctx.createGain());
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    filt.connect(env).connect(dest);
    for (const det of [1, 1.006, 0.994]) {
      const osc = group.source(() => ctx.createOscillator(), at);
      if (!osc) return;
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq * det, at);
      if (fallTo !== undefined)
        osc.frequency.exponentialRampToValueAtTime(freq * det * fallTo, at + dur);
      osc.connect(filt);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
  }

  // ── layered impacts (A2) ────────────────────────────────────────────────────

  /** 3-layer impact at the hit point: transient / body / tail per damage type. */
  hit(x?: number, y?: number, dtype: DamageType = "physical", important = false): void {
    if (!this.gate(important ? "hit:local" : "hit", 45)) return;
    const play = () => {
      this.impact(this.now(), x, y, dtype, 1);
    };
    if (important) this.essential(play);
    else play();
  }

  /** Crit: physical layers pitched ×1.3 + 1244Hz ring + 72→48Hz sub. */
  crit(x?: number, y?: number, important = false): void {
    if (!this.gate(important ? "crit:local" : "crit", 60)) return;
    const play = () => {
      const t = this.now();
      this.impact(t, x, y, "physical", 1.3);
      this.tone({ at: t, x, y, freq: 1244, dur: 0.05, type: "sine", gain: 0.1 });
      this.tone({ at: t, x, y, freq: 72, slideTo: 48, dur: 0.14, type: "sine", gain: 0.2 });
    };
    if (important) this.essential(play);
    else play();
  }

  private impact(
    t: number,
    x: number | undefined,
    y: number | undefined,
    dtype: DamageType,
    p: number,
  ): void {
    const j = this.jit();
    if (dtype === "physical") {
      this.noise({
        at: t,
        x,
        y,
        dur: 0.012,
        gain: 0.22,
        filter: { type: "highpass", from: 3200 * p },
      });
      this.tone({
        at: t,
        x,
        y,
        freq: 185 * p * j,
        slideTo: 95 * p * j,
        dur: 0.09,
        type: "square",
        gain: 0.1,
      });
      this.noise({
        at: t,
        x,
        y,
        dur: 0.12,
        gain: 0.07,
        filter: { type: "lowpass", from: 1100 * p },
      });
    } else if (dtype === "magic") {
      this.noise({
        at: t,
        x,
        y,
        dur: 0.01,
        gain: 0.18,
        filter: { type: "highpass", from: 4200 * p },
      });
      this.tone({
        at: t,
        x,
        y,
        freq: 520 * p * j,
        slideTo: 260 * p * j,
        dur: 0.11,
        type: "sine",
        gain: 0.1,
      });
      this.tone({
        at: t,
        x,
        y,
        freq: 520 * 1.012 * p * j,
        slideTo: 260 * 1.012 * p * j,
        dur: 0.11,
        type: "sine",
        gain: 0.1,
      });
      this.noise({
        at: t,
        x,
        y,
        dur: 0.1,
        gain: 0.06,
        filter: { type: "bandpass", from: 900 * p },
      });
    } else {
      // pure: magic transient, brighter triangle body, no tail
      this.noise({
        at: t,
        x,
        y,
        dur: 0.01,
        gain: 0.18,
        filter: { type: "highpass", from: 4200 * p },
      });
      this.tone({
        at: t,
        x,
        y,
        freq: 720 * p * j,
        slideTo: 420 * p * j,
        dur: 0.08,
        type: "triangle",
        gain: 0.09,
      });
    }
  }

  // ── per-champ attack timbres (A3) ───────────────────────────────────────────

  /** One whoosh per swing, driven by the world-view attack one-shot delta. */
  attack(champId: string, x: number, y: number): void {
    if (!this.gate("atk:" + champId, 70)) return;
    const t = this.now();
    switch (champId) {
      case "knight":
        this.atkKnight(t, x, y);
        break;
      case "rogue":
        this.atkRogueHiss(t, x, y, true);
        break;
      case "ranger":
        // bow twang + string snap + thwip
        this.tone({
          at: t,
          x,
          y,
          freq: 235,
          slideTo: 175,
          dur: 0.035,
          type: "triangle",
          gain: 0.14,
        });
        this.noise({ at: t, x, y, dur: 0.02, gain: 0.1, filter: { type: "highpass", from: 4500 } });
        this.tone({ at: t, x, y, freq: 900, slideTo: 300, dur: 0.06, type: "sine", gain: 0.06 });
        break;
      case "mage":
        this.atkMageBeat(t, x, y, 1, 0.08);
        this.tone({ at: t, x, y, freq: 1860, dur: 0.04, type: "sine", gain: 0.05 });
        break;
      case "blackknight":
        // heavy 2H heft pitched 0.8×, longer
        this.atkHeavy(t, x, y, 0.8, 1.25);
        break;
      case "witch":
        this.witchVoice(t, x, y, 1, 1, 0.07);
        break;
      default:
        // creeps / skeletons
        this.noise({ at: t, x, y, dur: 0.07, gain: 0.09, filter: { type: "lowpass", from: 1600 } });
    }
  }

  /** Steel whoosh: noise through a bandpass sweeping 400→1300. */
  private atkKnight(t: number, x: number | undefined, y: number | undefined, p = 1, d = 1): void {
    this.noise({
      at: t,
      x,
      y,
      dur: 0.13 * d,
      gain: 0.13,
      filter: { type: "bandpass", from: 400 * p, to: 1300 * p },
    });
  }

  /** Heavy whoosh + 65Hz sub heft (the 2H weight — Black Knight's swing). */
  private atkHeavy(t: number, x: number | undefined, y: number | undefined, p = 1, d = 1): void {
    this.noise({
      at: t,
      x,
      y,
      dur: 0.17 * d,
      gain: 0.17,
      filter: { type: "bandpass", from: 250 * p, to: 800 * p },
    });
    this.tone({ at: t, x, y, freq: 65 * p, dur: 0.07 * d, type: "sine", gain: 0.12 });
  }

  /** Dagger hiss; `pair` adds the second shot at +45ms, pan-offset alternating. */
  private atkRogueHiss(
    t: number,
    x: number | undefined,
    y: number | undefined,
    pair: boolean,
  ): void {
    this.noise({ at: t, x, y, dur: 0.06, gain: 0.09, filter: { type: "highpass", from: 2600 } });
    if (!pair) return;
    this.hissFlip = !this.hissFlip;
    const off = this.hissFlip ? 0.15 : -0.15;
    this.noise({
      at: t + 0.045,
      x,
      y,
      pan: off,
      dur: 0.06,
      gain: 0.09,
      filter: { type: "highpass", from: 2600 },
    });
  }

  /** Two beating sines (620/627) — the arcane flick core. */
  private atkMageBeat(
    t: number,
    x: number | undefined,
    y: number | undefined,
    p: number,
    gain: number,
  ): void {
    this.tone({ at: t, x, y, freq: 620 * p, dur: 0.12, type: "sine", gain });
    this.tone({ at: t, x, y, freq: 627 * p, dur: 0.12, type: "sine", gain });
  }

  /** Witch: wobbly detuned sine pair (7Hz beat, woozy downward slide) + rising
   *  bubble bloops + a wet noise pop — brew-y. */
  private witchVoice(
    t: number,
    x: number | undefined,
    y: number | undefined,
    p: number,
    d: number,
    gain: number,
  ): void {
    this.tone({ at: t, x, y, freq: 315 * p, slideTo: 296 * p, dur: 0.18 * d, type: "sine", gain });
    this.tone({ at: t, x, y, freq: 322 * p, slideTo: 308 * p, dur: 0.18 * d, type: "sine", gain });
    for (let i = 0; i < 3; i++) {
      const f = (260 + Math.random() * 160) * p;
      this.tone({
        at: t + 0.02 + i * 0.055 * d,
        x,
        y,
        freq: f,
        slideTo: f * 2.3,
        dur: 0.05,
        type: "sine",
        gain: 0.055,
      });
    }
    this.noise({
      at: t + 0.03,
      x,
      y,
      dur: 0.03,
      gain: 0.04,
      filter: { type: "bandpass", from: 1100 },
    });
  }

  // ── per-champ cast timbres (A3) ─────────────────────────────────────────────

  /** Champ base voice × CAST_MOD; R adds the ult layer (sub drop + riser). */
  cast(champId = "", key: AbilityKey = "Q", x?: number, y?: number): void {
    if (!this.gate("cast", 60)) return;
    const t = this.now();
    const m = CAST_MOD[key];
    this.castVoice(champId, t, x, y, m.p, m.d);
    if (key === "DASH") this.dodge(x, y); // crisp air-whoosh on top of the zip
    if (m.ult && this.gate("ult", 300)) {
      this.tone({ at: t, x, y, freq: 55, slideTo: 38, dur: 0.4, type: "sine", gain: 0.22 });
      this.noise({
        at: t,
        x,
        y,
        dur: 0.5,
        gain: 0.08,
        filter: { type: "bandpass", from: 300, to: 2500 },
      });
    }
  }

  private castVoice(
    champId: string,
    t: number,
    x: number | undefined,
    y: number | undefined,
    p: number,
    d: number,
  ): void {
    switch (champId) {
      case "knight":
        this.castKnight(t, x, y, p, d);
        break;
      case "ranger":
        this.tone({
          at: t,
          x,
          y,
          freq: 330 * p,
          slideTo: 660 * p,
          dur: 0.22 * d,
          type: "triangle",
          gain: 0.12,
        });
        this.noise({
          at: t,
          x,
          y,
          dur: 0.02,
          gain: 0.05,
          filter: { type: "highpass", from: 4500 },
        });
        break;
      case "mage":
        this.tone({
          at: t,
          x,
          y,
          freq: 320 * p,
          slideTo: 980 * p,
          dur: 0.22 * d,
          type: "sine",
          gain: 0.14,
        });
        this.tone({ at: t, x, y, freq: 1560 * p, dur: 0.05, type: "sine", gain: 0.05 });
        this.tone({ at: t + 0.04, x, y, freq: 1976 * p, dur: 0.05, type: "sine", gain: 0.05 });
        this.tone({ at: t + 0.08, x, y, freq: 2349 * p, dur: 0.05, type: "sine", gain: 0.05 });
        break;
      case "rogue":
        this.castRogue(t, x, y, p, d);
        break;
      case "blackknight":
        this.castHeavy(t, x, y, p * 0.8, d * 1.25);
        break;
      case "witch":
        this.witchVoice(t, x, y, p, 1.2 * d, 0.08);
        break;
      default:
        // creeps / unknown: the original rising cast chirp
        this.tone({
          at: t,
          x,
          y,
          freq: 320 * p * this.jit(),
          slideTo: 760 * p,
          dur: 0.18 * d,
          type: "sine",
          gain: 0.14,
        });
    }
  }

  private castKnight(
    t: number,
    x: number | undefined,
    y: number | undefined,
    p: number,
    d: number,
  ): void {
    this.tone({
      at: t,
      x,
      y,
      freq: 220 * p,
      slideTo: 440 * p,
      dur: 0.22 * d,
      type: "square",
      gain: 0.12,
    });
    this.noise({ at: t, x, y, dur: 0.05, gain: 0.08, filter: { type: "highpass", from: 3000 } });
  }

  private castRogue(
    t: number,
    x: number | undefined,
    y: number | undefined,
    p: number,
    d: number,
  ): void {
    this.noise({
      at: t,
      x,
      y,
      dur: 0.18 * d,
      gain: 0.09,
      filter: { type: "highpass", from: 800, to: 3500 },
    });
    this.tone({
      at: t,
      x,
      y,
      freq: 660 * p,
      slideTo: 220 * p,
      dur: 0.18 * d,
      type: "sine",
      gain: 0.1,
    });
  }

  private castHeavy(
    t: number,
    x: number | undefined,
    y: number | undefined,
    p: number,
    d: number,
  ): void {
    this.tone({
      at: t,
      x,
      y,
      freq: 130 * p,
      slideTo: 180 * p,
      dur: 0.25 * d,
      type: "sawtooth",
      gain: 0.13,
      filter: { type: "lowpass", from: 900 },
    });
  }

  // ── stingers (A4) ───────────────────────────────────────────────────────────

  /** Your kill: bright triangle pair + air. The single biggest feel win. */
  killConfirm(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, freq: 784, dur: 0.09, type: "triangle", gain: 0.16 });
      this.tone({ at: t + 0.07, freq: 1046, dur: 0.14, type: "triangle", gain: 0.16 });
      this.noise({ at: t, dur: 0.03, gain: 0.08, filter: { type: "highpass", from: 5000 } });
    });
  }

  /** Announcer stingers, D minor: 0 spree/first-blood · 1 rampage ·
   *  2 unstoppable (staccato run + timpani) · 3 godlike (+ riser + sub). */
  stinger(tier: 0 | 1 | 2 | 3): void {
    this.essential(() => {
      if (!this.gate("stinger", 250)) return;
      const t = this.now();
      if (tier === 0) {
        this.sawStack(D3, t, 0.45);
        this.sawStack(F3, t, 0.45);
      } else if (tier === 1) {
        this.sawStack(D3, t, 0.45);
        this.sawStack(F3, t, 0.45);
        this.sawStack(A3, t, 0.45);
      } else {
        this.sawStack(D3, t, 0.16);
        this.sawStack(F3, t + 0.09, 0.16);
        this.sawStack(A3, t + 0.18, 0.16);
        this.sawStack(C4, t + 0.27, 0.4);
        this.tone({ at: t, freq: 82, slideTo: 58, dur: 0.3, type: "sine", gain: 0.18 });
        if (tier === 3) {
          this.noise({
            at: t,
            dur: 0.6,
            gain: 0.09,
            filter: { type: "bandpass", from: 400, to: 4000 },
          });
          this.tone({ at: t + 0.6, freq: 72, slideTo: 48, dur: 0.14, type: "sine", gain: 0.2 });
        }
      }
    });
  }

  /** The kill leader fell: descending saw-stack pair A3 → D3. */
  leaderSlain(): void {
    this.essential(() => {
      if (!this.gate("leaderSlain", 300)) return;
      const t = this.now();
      this.sawStack(A3, t, 0.3);
      this.sawStack(D3, t + 0.3, 0.3);
    });
  }

  // ── UI set (A6) + intro + movement ──────────────────────────────────────────

  uiOpen(): void {
    this.tone({ freq: 520, dur: 0.06, type: "sine", gain: 0.1, bus: "ui" });
  }
  uiClose(): void {
    this.tone({ freq: 390, dur: 0.06, type: "sine", gain: 0.1, bus: "ui" });
  }
  uiBuy(): void {
    const t = this.now();
    this.tone({ at: t, freq: 660, dur: 0.08, type: "triangle", gain: 0.14, bus: "ui" });
    this.tone({ at: t + 0.06, freq: 880, dur: 0.08, type: "triangle", gain: 0.14, bus: "ui" });
  }
  uiDeny(): void {
    if (!this.gate("uiDeny", 150)) return;
    const t = this.now();
    this.tone({ at: t, freq: 160, dur: 0.07, type: "square", gain: 0.12, bus: "ui" });
    this.tone({ at: t + 0.09, freq: 160, dur: 0.07, type: "square", gain: 0.12, bus: "ui" });
  }
  abilityReady(): void {
    if (!this.gate("abilityReady", 150)) return;
    this.tone({ freq: 1040, dur: 0.08, type: "triangle", gain: 0.07, bus: "ui" });
  }
  castDeny(): void {
    if (!this.gate("castDeny", 120)) return;
    this.tone({ freq: 140, dur: 0.05, type: "square", gain: 0.1, bus: "ui" });
  }
  respawnTick(): void {
    this.tone({ freq: 440, dur: 0.05, type: "sine", gain: 0.08, bus: "ui" });
  }
  respawnGo(): void {
    this.essential(() => {
      this.tone({ freq: 440, slideTo: 880, dur: 0.15, type: "sine", gain: 0.12, bus: "ui" });
    });
  }
  /** Low-HP 55Hz thump pair; HUD drives the 0.9s vignette-locked cadence. */
  heartbeat(): void {
    this.essential(() => {
      if (!this.gate("heartbeat", 400)) return;
      const t = this.now();
      this.tone({ at: t, freq: 55, dur: 0.09, type: "sine", gain: 0.16, bus: "ui" });
      this.tone({ at: t + 0.13, freq: 55, dur: 0.08, type: "sine", gain: 0.1, bus: "ui" });
    });
  }
  /** Countdown numeral blip ("3 · 2 · 1"). */
  count(): void {
    this.tone({ freq: 440, dur: 0.09, type: "sine", gain: 0.12, bus: "ui" });
  }
  /** "FIGHT!" — bright blip + snare crack. */
  fight(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, freq: 880, dur: 0.18, type: "sine", gain: 0.14, bus: "ui" });
      this.noise({
        at: t,
        dur: 0.09,
        gain: 0.1,
        filter: { type: "bandpass", from: 1800 },
        bus: "ui",
      });
    });
  }
  /** Air-whoosh — the DASH launch (spatialized when a position is given). */
  dodge(x?: number, y?: number): void {
    if (!this.gate("dodge", 150)) return;
    const t = this.now();
    this.noise({ at: t, x, y, dur: 0.1, gain: 0.12, filter: { type: "highpass", from: 5000 } });
    this.tone({ at: t, x, y, freq: 240, slideTo: 90, dur: 0.1, type: "sine", gain: 0.06 });
  }
  land(): void {
    if (!this.gate("land", 150)) return;
    this.noise({ dur: 0.08, gain: 0.1, filter: { type: "lowpass", from: 700 } });
  }

  // ── legacy voices (kept, spatialized, setTimeout → `at`) ────────────────────

  explosion(x?: number, y?: number): void {
    if (!this.gate("boom", 60)) return;
    const t = this.now();
    this.noise({ at: t, x, y, dur: 0.25, gain: 0.32, filter: { type: "lowpass", from: 900 } });
    this.tone({ at: t, x, y, freq: 90, slideTo: 45, dur: 0.3, type: "sine", gain: 0.3 });
    this.musicInst?.duck();
  }
  death(x?: number, y?: number): void {
    this.essential(() => {
      this.tone({ x, y, freq: 380, slideTo: 70, dur: 0.4, type: "sawtooth", gain: 0.16 });
      this.musicInst?.duck();
    });
  }
  coin(x?: number, y?: number): void {
    const t = this.now();
    this.tone({ at: t, x, y, freq: 880 * this.jit(), dur: 0.07, type: "triangle", gain: 0.2 });
    this.tone({ at: t + 0.02, x, y, freq: 1320, dur: 0.12, type: "triangle", gain: 0.18 });
  }
  levelup(): void {
    this.essential(() => {
      const t = this.now();
      [523, 659, 784, 1046].forEach((f, i) =>
        this.tone({ at: t + i * 0.07, freq: f, dur: 0.14, type: "triangle", gain: 0.16 }),
      );
    });
  }
  delivery(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, freq: 660, dur: 0.12, type: "sine", gain: 0.16 });
      this.tone({ at: t + 0.09, freq: 990, dur: 0.16, type: "sine", gain: 0.16 });
    });
  }
  alert(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, freq: 440, dur: 0.12, type: "square", gain: 0.18 });
      this.tone({ at: t + 0.15, freq: 440, dur: 0.12, type: "square", gain: 0.18 });
    });
  }
  victory(): void {
    this.essential(() => {
      const t = this.now();
      [523, 659, 784, 1046, 1318].forEach((f, i) =>
        this.tone({ at: t + i * 0.11, freq: f, dur: 0.2, type: "triangle", gain: 0.2 }),
      );
    });
  }

  // ── ambience (A7) ───────────────────────────────────────────────────────────

  /** Dungeon bed: constant sub rumble + torch crackle pops + a distant moan.
   *  Look-ahead interval schedules `at` times — no setTimeout voices. */
  private startAmbience(): void {
    if (
      this.ambStarted ||
      !this.ready() ||
      this.outcome !== "playing" ||
      !this.ctx ||
      !this.noiseBuf
    )
      return;
    const dest = this.busNode("amb");
    if (!dest) return;
    const ctx = this.ctx;
    const group = this.ambience.begin(1);
    if (!group) return;
    const src = group.source(() => ctx.createBufferSource(), ctx.currentTime);
    if (!src) {
      group.cancel();
      return;
    }
    this.ambStarted = true;
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = group.node(ctx.createBiquadFilter());
    filt.type = "lowpass";
    filt.frequency.value = 110;
    const g = group.node(ctx.createGain());
    g.gain.value = 0.05;
    src.connect(filt).connect(g).connect(dest);
    src.start();
    group.seal();
    const t = this.ctx.currentTime;
    this.ambNextPop = t + 0.4;
    this.ambNextMoan = t + 14 + Math.random() * 12;
    const generation = ++this.ambGeneration;
    this.ambTimer = window.setInterval(() => {
      if (generation === this.ambGeneration) this.ambTick();
    }, 400);
  }

  private stopAmbience(): void {
    this.ambGeneration++;
    if (this.ambTimer !== null) window.clearInterval(this.ambTimer);
    this.ambTimer = null;
    this.ambStarted = false;
    this.ambience.clear();
  }

  private ambTick(): void {
    if (!this.ready() || this.outcome !== "playing" || !this.ctx) return;
    const now = this.ctx.currentTime;
    if (this.ambNextPop < now - 0.9) this.ambNextPop = now + 0.4;
    if (this.ambNextMoan < now - 0.9) this.ambNextMoan = now + 14 + Math.random() * 12;
    const horizon = this.ctx.currentTime + 0.9;
    while (this.ambNextPop < horizon) {
      this.noise({
        at: this.ambNextPop,
        dur: 0.015 + Math.random() * 0.015,
        gain: 0.015 + Math.random() * 0.025,
        bus: "amb",
        pan: (Math.random() * 2 - 1) * 0.5,
        filter: { type: "bandpass", from: 2300 },
      });
      this.ambNextPop += 0.15 + Math.random() * 0.45;
    }
    if (this.ambNextMoan < horizon) {
      this.tone({
        at: this.ambNextMoan,
        freq: 290,
        slideTo: 255,
        dur: 3.5,
        type: "sine",
        gain: 0.014,
        bus: "amb",
        pan: (Math.random() * 2 - 1) * 0.6,
        attack: 0.9,
      });
      this.ambNextMoan += 20 + Math.random() * 20;
    }
  }
}
