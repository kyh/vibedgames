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
import { VoicePool } from "./audio-voices";
import type { VoiceGroup, VoicePriority } from "./audio-voices";

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

const VOICE_CAP = 28; // distant spatial voices shed above this, before the pool caps

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
const A3 = 220;
const C4 = 261.63;

/** Key modifiers applied to each champ's base cast voice (result-05 A3). DASH =
 *  short + pitched-up zip (a whoosh layer rides on top); JUMP = longer + pitched-
 *  down heave (the landing thud is the explosion fx event). */
type CastMods = { [K in AbilityKey]: { d: number; p: number; ult?: boolean } };
const CAST_MOD: CastMods = {
  DASH: { d: 0.5, p: 1.2 },
  E: { d: 1.1, p: 0.85 },
  JUMP: { d: 0.9, p: 0.85 },
  Q: { d: 0.8, p: 1.0 },
  R: { d: 1.6, p: 0.7, ult: true },
  W: { d: 1.0, p: 1.15 },
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
  private group: VoiceGroup | null = null; // the phrase under construction
  private preference = readMuted();
  private paused = false;
  private unlocked = false;
  private outcome: "playing" | "won" | "lost" | "unassigned" = "playing";
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
    this.unlocked = true;
    window.removeEventListener("pointerdown", this.unlock);
    window.removeEventListener("keydown", this.unlock);
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
    return this.paused || (this.mutedOverride ?? this.preference);
  }

  private ready(): boolean {
    return !this.blocked && this.unlocked && this.ctx?.state === "running";
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
    if (!on && window.navigator?.userActivation?.isActive === true) {
      this.unlocked = true;
    }
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

  /** Mute/pause/unlock all funnel here: silence in flight or bring the beds up. */
  private applyIntent(): void {
    if (this.blocked) {
      this.voices.clear();
      this.musicInst?.silence();
      this.stopAmbience();
    } else {
      this.ensure();
    }
    const { ctx } = this;
    if (!ctx || !this.master) {
      return;
    }
    const t = ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.blocked ? 0 : 0.5, t);
    if (this.blocked) {
      void ctx.suspend();
    } else if (ctx.state === "running") {
      this.syncBeds();
    } else {
      void ctx.resume().then(
        () => this.syncBeds(),
        () => undefined,
      );
    }
  }

  private syncBeds(): void {
    if (!this.ready() || this.outcome !== "playing") {
      return;
    }
    this.musicInst?.start();
    this.startAmbience();
  }

  /** Store completion before unlock too; no delayed combat bed or fanfare. */
  resolveMatch(outcome: "won" | "lost" | "unassigned"): void {
    if (this.outcome !== "playing") {
      return;
    }
    this.outcome = outcome;
    this.stopAmbience();
    if (this.ready() && outcome !== "unassigned") {
      this.musicInst?.resolve(outcome === "won");
    } else {
      this.musicInst?.silence();
    }
  }

  /** Rematch: fresh music transport on the same owned context. */
  beginMatch(): void {
    if (this.outcome === "playing") {
      return;
    }
    this.voices.clear();
    this.stopAmbience();
    this.musicInst?.dispose();
    this.musicInst = this.ctx && this.musicBus ? new Music(this.ctx, this.musicBus) : null;
    this.last = {};
    this.hissFlip = false;
    this.outcome = "playing";
    this.applyIntent();
  }

  diagnostics() {
    return {
      context: this.ctx?.state ?? "uncreated",
      muted: this.mutedOverride ?? this.preference,
      voices: this.voices.count,
    };
  }

  private ensure(): void {
    if (this.ctx || this.blocked || !this.unlocked) {
      return;
    }
    const scope: typeof globalThis & { webkitAudioContext?: typeof AudioContext } = globalThis;
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) {
      return;
    }
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
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuf = buf;
    this.musicInst = new Music(ctx, this.musicBus);
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Rate-limit a given voice so overlapping events don't stack into noise. */
  private gate(key: string, ms: number): boolean {
    if (!this.ready()) {
      return false;
    }
    const t = this.now() * 1000;
    if (t - (this.last[key] ?? -1e9) < ms) {
      return false;
    }
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
    if (d > 55) {
      return null;
    } // cull past ~half arena
    const g = 1 / (1 + (d * d) / 100); // ref dist 10u
    const pan =
      d < 0.5 ? 0 : Math.max(-0.8, Math.min(0.8, ((dx * this.rx + dy * this.ry) / d) * 0.8));
    return { g: Math.max(0.06, g), pan };
  }

  // ── voice primitives ────────────────────────────────────────────────────────

  private busNode(name: BusName | undefined): GainNode | null {
    if (name === "ui") {
      return this.ui;
    }
    if (name === "amb") {
      return this.amb;
    }
    return this.sfx;
  }

  private route(node: AudioNode, pan: number, bus: BusName | undefined, group: VoiceGroup): void {
    const dest = this.busNode(bus);
    if (!dest || !this.ctx) {
      return;
    }
    if (pan === 0) {
      node.connect(dest);
    } else {
      const p = group.node(this.ctx.createStereoPanner());
      p.pan.value = pan;
      node.connect(p).connect(dest);
    }
  }

  private applyFilter(
    head: AudioNode,
    f: FilterOpts,
    t: number,
    dur: number,
    group: VoiceGroup,
  ): AudioNode {
    if (!this.ctx) {
      return head;
    }
    const filt = group.node(this.ctx.createBiquadFilter());
    filt.type = f.type;
    filt.frequency.setValueAtTime(Math.max(20, f.from), t);
    if (f.to !== undefined) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, f.to), t + dur);
    }
    if (f.q !== undefined) {
      filt.Q.value = f.q;
    }
    if (f.lfo) {
      const { ctx } = this;
      const lfo = group.source(() => ctx.createOscillator());
      if (!lfo) {
        return head;
      }
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
      if (!s) {
        return null;
      }
      if (this.voices.count >= VOICE_CAP && s.g < 0.35) {
        return null;
      } // shed distant first
      gain *= s.g;
      pan = Math.max(-1, Math.min(1, s.pan + pan));
    }
    return { g: gain, pan };
  }

  /** The group a primitive renders into: the open phrase, else a one-off. */
  private open(bus: BusName | undefined): VoiceGroup {
    return this.group ?? (bus === "amb" ? this.ambience : this.voices).begin();
  }

  private close(group: VoiceGroup): void {
    if (group !== this.group) {
      group.seal();
    }
  }

  /** Voices built inside share one group, so the whole cue is dropped or kept
   *  together when the pool is saturated. */
  private phrase(priority: VoicePriority, build: () => void): void {
    if (!this.ready() || this.group) {
      build();
      return;
    }
    const group = this.voices.begin(priority);
    this.group = group;
    try {
      build();
    } finally {
      this.group = null;
      group.seal();
    }
  }

  private essential(build: () => void): void {
    this.phrase("essential", build);
  }

  private tone(o: ToneOpts): void {
    const { ctx } = this;
    if (!ctx || !this.ready()) {
      return;
    }
    const m = this.mix(o, o.gain);
    if (!m) {
      return;
    }
    const t = o.at ?? ctx.currentTime;
    const group = this.open(o.bus);
    const osc = group.source(() => ctx.createOscillator());
    if (osc) {
      osc.type = o.type ?? "sine";
      osc.frequency.setValueAtTime(Math.max(20, o.freq), t);
      if (o.slideTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t + o.dur);
      }
      if (o.detune !== undefined) {
        osc.detune.setValueAtTime(o.detune, t);
      }
      const env = group.node(ctx.createGain());
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0003, m.g), t + (o.attack ?? 0.005));
      env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      let head: AudioNode = osc;
      if (o.filter) {
        head = this.applyFilter(head, o.filter, t, o.dur, group);
      }
      head.connect(env);
      this.route(env, m.pan, o.bus, group);
      osc.start(t);
      osc.stop(t + o.dur + 0.03);
    }
    this.close(group);
  }

  private noise(o: NoiseOpts): void {
    const { ctx } = this;
    if (!ctx || !this.noiseBuf || !this.ready()) {
      return;
    }
    const m = this.mix(o, o.gain);
    if (!m) {
      return;
    }
    const t = o.at ?? ctx.currentTime;
    const group = this.open(o.bus);
    const src = group.source(() => ctx.createBufferSource());
    if (src) {
      src.buffer = this.noiseBuf;
      const env = group.node(ctx.createGain());
      env.gain.setValueAtTime(Math.max(0.0003, m.g), t);
      env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
      let head: AudioNode = src;
      if (o.filter) {
        head = this.applyFilter(head, o.filter, t, o.dur, group);
      }
      head.connect(env);
      this.route(env, m.pan, o.bus, group);
      src.start(t, Math.random() * Math.max(0, 1 - o.dur - 0.05));
      src.stop(t + o.dur + 0.03);
    }
    this.close(group);
  }

  /** Brass-ish stinger note: 3 detuned saws → lowpass 1250 → shared envelope. */
  private sawStack(freq: number, at: number, dur: number, gain = 0.07, fallTo?: number): void {
    const { ctx } = this;
    const dest = this.busNode("sfx");
    if (!ctx || !dest || !this.ready()) {
      return;
    }
    const group = this.open("sfx");
    const filt = group.node(ctx.createBiquadFilter());
    filt.type = "lowpass";
    filt.frequency.value = 1250;
    const env = group.node(ctx.createGain());
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    filt.connect(env).connect(dest);
    for (const det of [1, 1.006, 0.994]) {
      const osc = group.source(() => ctx.createOscillator());
      if (!osc) {
        break;
      }
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq * det, at);
      if (fallTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(freq * det * fallTo, at + dur);
      }
      osc.connect(filt);
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
    this.close(group);
  }

  // ── layered impacts (A2) ────────────────────────────────────────────────────

  /** 3-layer impact at the hit point: transient / body / tail per damage type. */
  hit(x?: number, y?: number, dtype: DamageType = "physical", important = false): void {
    if (!this.gate(important ? "hit:local" : "hit", 45)) {
      return;
    }
    this.phrase(important ? "essential" : "routine", () => this.impact(this.now(), x, y, dtype, 1));
  }

  /** Crit: physical layers pitched ×1.3 + 1244Hz ring + 72→48Hz sub. */
  crit(x?: number, y?: number, important = false): void {
    if (!this.gate(important ? "crit:local" : "crit", 60)) {
      return;
    }
    this.phrase(important ? "essential" : "routine", () => {
      const t = this.now();
      this.impact(t, x, y, "physical", 1.3);
      this.tone({ at: t, dur: 0.05, freq: 1244, gain: 0.1, type: "sine", x, y });
      this.tone({ at: t, dur: 0.14, freq: 72, gain: 0.2, slideTo: 48, type: "sine", x, y });
    });
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
        dur: 0.012,
        filter: { from: 3200 * p, type: "highpass" },
        gain: 0.22,
        x,
        y,
      });
      this.tone({
        at: t,
        dur: 0.09,
        freq: 185 * p * j,
        gain: 0.1,
        slideTo: 95 * p * j,
        type: "square",
        x,
        y,
      });
      this.noise({
        at: t,
        dur: 0.12,
        filter: { from: 1100 * p, type: "lowpass" },
        gain: 0.07,
        x,
        y,
      });
    } else if (dtype === "magic") {
      this.noise({
        at: t,
        dur: 0.01,
        filter: { from: 4200 * p, type: "highpass" },
        gain: 0.18,
        x,
        y,
      });
      this.tone({
        at: t,
        dur: 0.11,
        freq: 520 * p * j,
        gain: 0.1,
        slideTo: 260 * p * j,
        type: "sine",
        x,
        y,
      });
      this.tone({
        at: t,
        dur: 0.11,
        freq: 520 * 1.012 * p * j,
        gain: 0.1,
        slideTo: 260 * 1.012 * p * j,
        type: "sine",
        x,
        y,
      });
      this.noise({
        at: t,
        dur: 0.1,
        filter: { from: 900 * p, type: "bandpass" },
        gain: 0.06,
        x,
        y,
      });
    } else {
      // pure: magic transient, brighter triangle body, no tail
      this.noise({
        at: t,
        dur: 0.01,
        filter: { from: 4200 * p, type: "highpass" },
        gain: 0.18,
        x,
        y,
      });
      this.tone({
        at: t,
        dur: 0.08,
        freq: 720 * p * j,
        gain: 0.09,
        slideTo: 420 * p * j,
        type: "triangle",
        x,
        y,
      });
    }
  }

  // ── per-champ attack timbres (A3) ───────────────────────────────────────────

  /** One whoosh per swing, driven by the world-view attack one-shot delta. */
  attack(champId: string, x: number, y: number, local = false): void {
    // a culled/shed swing must not consume the throttle for the next audible one
    if (!this.mix({ x, y }, 1) || !this.gate(`atk:${champId}${local ? ":local" : ""}`, 70)) {
      return;
    }
    this.phrase(local ? "essential" : "routine", () => this.attackVoice(champId, x, y));
  }

  private attackVoice(champId: string, x: number, y: number): void {
    const t = this.now();
    switch (champId) {
      case "knight": {
        this.atkKnight(t, x, y);
        break;
      }
      case "rogue": {
        this.atkRogueHiss(t, x, y, true);
        break;
      }
      case "ranger": {
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
      }
      case "mage": {
        this.atkMageBeat(t, x, y, 1, 0.08);
        this.tone({ at: t, x, y, freq: 1860, dur: 0.04, type: "sine", gain: 0.05 });
        break;
      }
      case "blackknight": {
        // heavy 2H heft pitched 0.8×, longer
        this.atkHeavy(t, x, y, 0.8, 1.25);
        break;
      }
      case "witch": {
        this.witchVoice(t, x, y, 1, 1, 0.07);
        break;
      }
      default: {
        // creeps / skeletons
        this.noise({ at: t, x, y, dur: 0.07, gain: 0.09, filter: { type: "lowpass", from: 1600 } });
      }
    }
  }

  /** Steel whoosh: noise through a bandpass sweeping 400→1300. */
  private atkKnight(t: number, x: number | undefined, y: number | undefined, p = 1, d = 1): void {
    this.noise({
      at: t,
      dur: 0.13 * d,
      filter: { from: 400 * p, to: 1300 * p, type: "bandpass" },
      gain: 0.13,
      x,
      y,
    });
  }

  /** Heavy whoosh + 65Hz sub heft (the 2H weight — Black Knight's swing). */
  private atkHeavy(t: number, x: number | undefined, y: number | undefined, p = 1, d = 1): void {
    this.noise({
      at: t,
      dur: 0.17 * d,
      filter: { from: 250 * p, to: 800 * p, type: "bandpass" },
      gain: 0.17,
      x,
      y,
    });
    this.tone({ at: t, dur: 0.07 * d, freq: 65 * p, gain: 0.12, type: "sine", x, y });
  }

  /** Dagger hiss; `pair` adds the second shot at +45ms, pan-offset alternating. */
  private atkRogueHiss(
    t: number,
    x: number | undefined,
    y: number | undefined,
    pair: boolean,
  ): void {
    this.noise({ at: t, dur: 0.06, filter: { from: 2600, type: "highpass" }, gain: 0.09, x, y });
    if (!pair) {
      return;
    }
    this.hissFlip = !this.hissFlip;
    const off = this.hissFlip ? 0.15 : -0.15;
    this.noise({
      at: t + 0.045,
      dur: 0.06,
      filter: { from: 2600, type: "highpass" },
      gain: 0.09,
      pan: off,
      x,
      y,
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
    this.tone({ at: t, dur: 0.12, freq: 620 * p, gain, type: "sine", x, y });
    this.tone({ at: t, dur: 0.12, freq: 627 * p, gain, type: "sine", x, y });
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
    this.tone({ at: t, dur: 0.18 * d, freq: 315 * p, gain, slideTo: 296 * p, type: "sine", x, y });
    this.tone({ at: t, dur: 0.18 * d, freq: 322 * p, gain, slideTo: 308 * p, type: "sine", x, y });
    for (let i = 0; i < 3; i++) {
      const f = (260 + Math.random() * 160) * p;
      this.tone({
        at: t + 0.02 + i * 0.055 * d,
        dur: 0.05,
        freq: f,
        gain: 0.055,
        slideTo: f * 2.3,
        type: "sine",
        x,
        y,
      });
    }
    this.noise({
      at: t + 0.03,
      dur: 0.03,
      filter: { from: 1100, type: "bandpass" },
      gain: 0.04,
      x,
      y,
    });
  }

  // ── per-champ cast timbres (A3) ─────────────────────────────────────────────

  /** Champ base voice × CAST_MOD; R adds the ult layer (sub drop + riser). */
  cast(champId = "", key: AbilityKey = "Q", x?: number, y?: number, local = false): void {
    if (!this.mix({ x, y }, 1) || !this.gate(local ? `cast:${key}:local` : "cast", 60)) {
      return;
    }
    this.phrase(local ? "essential" : "routine", () => this.castPhrase(champId, key, x, y, local));
  }

  private castPhrase(
    champId: string,
    key: AbilityKey,
    x: number | undefined,
    y: number | undefined,
    local: boolean,
  ): void {
    const t = this.now();
    const m = CAST_MOD[key];
    this.castVoice(champId, t, x, y, m.p, m.d);
    if (key === "DASH") {
      this.dodge(x, y);
    } // crisp air-whoosh on top of the zip
    if (m.ult && this.gate(local ? "ult:local" : "ult", 300)) {
      this.tone({ at: t, dur: 0.4, freq: 55, gain: 0.22, slideTo: 38, type: "sine", x, y });
      this.noise({
        at: t,
        dur: 0.5,
        filter: { from: 300, to: 2500, type: "bandpass" },
        gain: 0.08,
        x,
        y,
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
      case "knight": {
        this.castKnight(t, x, y, p, d);
        break;
      }
      case "ranger": {
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
      }
      case "mage": {
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
      }
      case "rogue": {
        this.castRogue(t, x, y, p, d);
        break;
      }
      case "blackknight": {
        this.castHeavy(t, x, y, p * 0.8, d * 1.25);
        break;
      }
      case "witch": {
        this.witchVoice(t, x, y, p, 1.2 * d, 0.08);
        break;
      }
      default: {
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
      dur: 0.22 * d,
      freq: 220 * p,
      gain: 0.12,
      slideTo: 440 * p,
      type: "square",
      x,
      y,
    });
    this.noise({ at: t, dur: 0.05, filter: { from: 3000, type: "highpass" }, gain: 0.08, x, y });
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
      dur: 0.18 * d,
      filter: { from: 800, to: 3500, type: "highpass" },
      gain: 0.09,
      x,
      y,
    });
    this.tone({
      at: t,
      dur: 0.18 * d,
      freq: 660 * p,
      gain: 0.1,
      slideTo: 220 * p,
      type: "sine",
      x,
      y,
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
      dur: 0.25 * d,
      filter: { from: 900, type: "lowpass" },
      freq: 130 * p,
      gain: 0.13,
      slideTo: 180 * p,
      type: "sawtooth",
      x,
      y,
    });
  }

  // ── stingers (A4) ───────────────────────────────────────────────────────────

  /** Your kill: bright triangle pair + air. The single biggest feel win. */
  killConfirm(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, dur: 0.09, freq: 784, gain: 0.16, type: "triangle" });
      this.tone({ at: t + 0.07, dur: 0.14, freq: 1046, gain: 0.16, type: "triangle" });
      this.noise({ at: t, dur: 0.03, filter: { from: 5000, type: "highpass" }, gain: 0.08 });
    });
  }

  /** Announcer stingers, D minor: 0 spree/first-blood · 1 rampage ·
   *  2 unstoppable (staccato run + timpani) · 3 godlike (+ riser + sub). */
  stinger(tier: 0 | 1 | 2 | 3): void {
    this.essential(() => {
      if (!this.gate("stinger", 250)) {
        return;
      }
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
        this.tone({ at: t, dur: 0.3, freq: 82, gain: 0.18, slideTo: 58, type: "sine" });
        if (tier === 3) {
          this.noise({
            at: t,
            dur: 0.6,
            filter: { from: 400, to: 4000, type: "bandpass" },
            gain: 0.09,
          });
          this.tone({ at: t + 0.6, dur: 0.14, freq: 72, gain: 0.2, slideTo: 48, type: "sine" });
        }
      }
    });
  }

  /** The kill leader fell: descending saw-stack pair A3 → D3. */
  leaderSlain(): void {
    this.essential(() => {
      if (!this.gate("leaderSlain", 300)) {
        return;
      }
      const t = this.now();
      this.sawStack(A3, t, 0.3);
      this.sawStack(D3, t + 0.3, 0.3);
    });
  }

  // ── UI set (A6) + intro + movement ──────────────────────────────────────────

  uiOpen(): void {
    this.tone({ bus: "ui", dur: 0.06, freq: 520, gain: 0.1, type: "sine" });
  }
  uiClose(): void {
    this.tone({ bus: "ui", dur: 0.06, freq: 390, gain: 0.1, type: "sine" });
  }
  uiBuy(): void {
    const t = this.now();
    this.tone({ at: t, bus: "ui", dur: 0.08, freq: 660, gain: 0.14, type: "triangle" });
    this.tone({ at: t + 0.06, bus: "ui", dur: 0.08, freq: 880, gain: 0.14, type: "triangle" });
  }
  uiDeny(): void {
    if (!this.gate("uiDeny", 150)) {
      return;
    }
    const t = this.now();
    this.tone({ at: t, bus: "ui", dur: 0.07, freq: 160, gain: 0.12, type: "square" });
    this.tone({ at: t + 0.09, bus: "ui", dur: 0.07, freq: 160, gain: 0.12, type: "square" });
  }
  abilityReady(): void {
    if (!this.gate("abilityReady", 150)) {
      return;
    }
    this.tone({ bus: "ui", dur: 0.08, freq: 1040, gain: 0.07, type: "triangle" });
  }
  castDeny(): void {
    if (!this.gate("castDeny", 120)) {
      return;
    }
    this.tone({ bus: "ui", dur: 0.05, freq: 140, gain: 0.1, type: "square" });
  }
  respawnTick(): void {
    this.tone({ bus: "ui", dur: 0.05, freq: 440, gain: 0.08, type: "sine" });
  }
  respawnGo(): void {
    this.essential(() => {
      this.tone({ bus: "ui", dur: 0.15, freq: 440, gain: 0.12, slideTo: 880, type: "sine" });
    });
  }
  /** Low-HP 55Hz thump pair; HUD drives the 0.9s vignette-locked cadence. */
  heartbeat(): void {
    this.essential(() => {
      if (!this.gate("heartbeat", 400)) {
        return;
      }
      const t = this.now();
      this.tone({ at: t, bus: "ui", dur: 0.09, freq: 55, gain: 0.16, type: "sine" });
      this.tone({ at: t + 0.13, bus: "ui", dur: 0.08, freq: 55, gain: 0.1, type: "sine" });
    });
  }
  /** Countdown numeral blip ("3 · 2 · 1"). */
  count(): void {
    this.tone({ bus: "ui", dur: 0.09, freq: 440, gain: 0.12, type: "sine" });
  }
  /** "FIGHT!" — bright blip + snare crack. */
  fight(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, bus: "ui", dur: 0.18, freq: 880, gain: 0.14, type: "sine" });
      this.noise({
        at: t,
        bus: "ui",
        dur: 0.09,
        filter: { from: 1800, type: "bandpass" },
        gain: 0.1,
      });
    });
  }
  /** Air-whoosh — the DASH launch (spatialized when a position is given). */
  dodge(x?: number, y?: number): void {
    if (!this.gate("dodge", 150)) {
      return;
    }
    const t = this.now();
    this.noise({ at: t, dur: 0.1, filter: { from: 5000, type: "highpass" }, gain: 0.12, x, y });
    this.tone({ at: t, dur: 0.1, freq: 240, gain: 0.06, slideTo: 90, type: "sine", x, y });
  }
  land(): void {
    if (!this.gate("land", 150)) {
      return;
    }
    this.noise({ dur: 0.08, filter: { from: 700, type: "lowpass" }, gain: 0.1 });
  }

  // ── legacy voices (kept, spatialized, setTimeout → `at`) ────────────────────

  explosion(x?: number, y?: number): void {
    if (!this.gate("boom", 60)) {
      return;
    }
    const t = this.now();
    this.noise({ at: t, dur: 0.25, filter: { from: 900, type: "lowpass" }, gain: 0.32, x, y });
    this.tone({ at: t, dur: 0.3, freq: 90, gain: 0.3, slideTo: 45, type: "sine", x, y });
    this.musicInst?.duck();
  }
  death(x?: number, y?: number): void {
    this.essential(() => {
      this.tone({ dur: 0.4, freq: 380, gain: 0.16, slideTo: 70, type: "sawtooth", x, y });
      this.musicInst?.duck();
    });
  }
  coin(x?: number, y?: number): void {
    const t = this.now();
    this.tone({ at: t, dur: 0.07, freq: 880 * this.jit(), gain: 0.2, type: "triangle", x, y });
    this.tone({ at: t + 0.02, dur: 0.12, freq: 1320, gain: 0.18, type: "triangle", x, y });
  }
  levelup(): void {
    this.essential(() => {
      const t = this.now();
      [523, 659, 784, 1046].forEach((f, i) =>
        this.tone({ at: t + i * 0.07, dur: 0.14, freq: f, gain: 0.16, type: "triangle" }),
      );
    });
  }
  delivery(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, dur: 0.12, freq: 660, gain: 0.16, type: "sine" });
      this.tone({ at: t + 0.09, dur: 0.16, freq: 990, gain: 0.16, type: "sine" });
    });
  }
  alert(): void {
    this.essential(() => {
      const t = this.now();
      this.tone({ at: t, dur: 0.12, freq: 440, gain: 0.18, type: "square" });
      this.tone({ at: t + 0.15, dur: 0.12, freq: 440, gain: 0.18, type: "square" });
    });
  }
  victory(): void {
    this.essential(() => {
      const t = this.now();
      [523, 659, 784, 1046, 1318].forEach((f, i) =>
        this.tone({ at: t + i * 0.11, dur: 0.2, freq: f, gain: 0.2, type: "triangle" }),
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
    ) {
      return;
    }
    const dest = this.busNode("amb");
    if (!dest) {
      return;
    }
    const { ctx } = this;
    const group = this.ambience.begin();
    const src = group.source(() => ctx.createBufferSource());
    if (!src) {
      group.seal();
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
    this.ambTimer = window.setInterval(() => this.ambTick(), 400);
  }

  private stopAmbience(): void {
    if (this.ambTimer !== null) {
      window.clearInterval(this.ambTimer);
    }
    this.ambTimer = null;
    this.ambStarted = false;
    this.ambience.clear();
  }

  private ambTick(): void {
    if (!this.ready() || this.outcome !== "playing" || !this.ctx) {
      return;
    }
    const now = this.ctx.currentTime;
    if (this.ambNextPop < now - 0.9) {
      this.ambNextPop = now + 0.4;
    }
    if (this.ambNextMoan < now - 0.9) {
      this.ambNextMoan = now + 14 + Math.random() * 12;
    }
    const horizon = this.ctx.currentTime + 0.9;
    while (this.ambNextPop < horizon) {
      this.noise({
        at: this.ambNextPop,
        bus: "amb",
        dur: 0.015 + Math.random() * 0.015,
        filter: { from: 2300, type: "bandpass" },
        gain: 0.015 + Math.random() * 0.025,
        pan: (Math.random() * 2 - 1) * 0.5,
      });
      this.ambNextPop += 0.15 + Math.random() * 0.45;
    }
    if (this.ambNextMoan < horizon) {
      this.tone({
        at: this.ambNextMoan,
        attack: 0.9,
        bus: "amb",
        dur: 3.5,
        freq: 290,
        gain: 0.014,
        pan: (Math.random() * 2 - 1) * 0.6,
        slideTo: 255,
        type: "sine",
      });
      this.ambNextMoan += 20 + Math.random() * 20;
    }
  }
}
