// Procedural audio engine — every sound synthesized with the Web Audio API, no
// assets, no fetches, no setTimeout (all sequencing rides sample-accurate `at`
// times on the AudioContext clock).
//
//   bus graph   sfx .65 / ui .50 / music .32 / amb .22
//               → compressor(−18, 12, 4, .003, .25) → master .5 → destination
//   spatializer StereoPanner: g = 1/(1 + d²/100), cull > 55u, pan ±0.8
//   voice cap   28 live voices — distant spatial voices (g < 0.35) shed first
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

type BusName = "sfx" | "ui" | "amb";

interface FilterOpts {
  type: BiquadFilterType;
  from: number;
  // exponential sweep across the voice duration
  to?: number;
  q?: number;
  // wobbles filter.frequency (necro rasp)
  lfo?: { freq: number; depth: number };
}

interface VoiceOpts {
  // absolute AudioContext time; defaults to now
  at?: number;
  // world position → spatialized (gain falloff + stereo pan)
  x?: number;
  y?: number;
  // manual pan, or additive offset when spatialized
  pan?: number;
  // defaults to sfx
  bus?: BusName;
  filter?: FilterOpts;
}

interface ToneOpts extends VoiceOpts {
  freq: number;
  dur: number;
  // defaults to sine
  type?: OscillatorType;
  gain: number;
  // exponential pitch slide target
  slideTo?: number;
  // cents
  detune?: number;
  // envelope attack seconds (default 0.005)
  attack?: number;
}

interface NoiseOpts extends VoiceOpts {
  dur: number;
  gain: number;
}

const VOICE_CAP = 28;

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
  Q: { d: 0.8, p: 1 },
  R: { d: 1.6, p: 0.7, ult: true },
  W: { d: 1, p: 1.15 },
};

/** ±8% pitch jitter so a repeated sample never reads as a loop. */
const jit = (): number => 0.92 + Math.random() * 0.16;

export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfx: GainNode | null = null;
  private ui: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private amb: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private musicInst: Music | null = null;
  // setMutedEphemeral — never persisted
  private mutedOverride: boolean | null = null;
  private last: Record<string, number> = {};
  private live = 0;
  // listener position + screen-right basis (rx,ry) = (-aimY, aimX)
  private lx = 0;
  private ly = 0;
  private rx = 0;
  private ry = 1;
  // rogue alternating dagger pan
  private hissFlip = false;
  private ambStarted = false;
  private ambTimer: number | null = null;
  private ambNextPop = 0;
  private ambNextMoan = 0;

  constructor() {
    const unlock = (): void => {
      this.ensure();
      if (this.ctx?.state === "suspended") {
        void this.ctx.resume();
      }
      this.musicInst?.start();
      this.startAmbience();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  /** The 4-layer combat music system (null until the audio unlock gesture). */
  get music(): Music | null {
    return this.musicInst;
  }

  /** MUTED BY DEFAULT — sound is opt-in (link-shared browser game; autoplaying
   *  audio is hostile). localStorage remembers the choice across visits. */
  // oxlint-disable-next-line class-methods-use-this -- the preference lives in localStorage, but isMuted is part of the Audio instance's public API (main.ts and hud.ts read it off the instance)
  get isMuted(): boolean {
    return localStorage.getItem("ba-muted") !== "0";
  }

  setMuted(on: boolean): void {
    // an explicit choice always wins
    this.mutedOverride = null;
    try {
      localStorage.setItem("ba-muted", on ? "1" : "0");
    } catch {
      /* private mode — session-only */
    }
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 0 : 0.5, this.ctx.currentTime, 0.03);
    }
  }

  /** Session-only mute override (trailer mode): drives the master gain WITHOUT
   *  touching the persisted localStorage["ba-muted"] preference, so normal
   *  gameplay keeps its muted-by-default contract. Survives a late ensure()
   *  (the AudioContext is created on the first trusted gesture). */
  setMutedEphemeral(on: boolean): void {
    this.mutedOverride = on;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(on ? 0 : 0.5, this.ctx.currentTime, 0.03);
    }
  }

  /** Wrapper-requested pause: halts the AudioContext clock, so every
   *  sample-accurate scheduled voice (SFX + Music's `start(t)`/`stop(t)`
   *  envelopes) simply stalls in place instead of drifting or double-firing. */
  suspend(): void {
    if (this.ctx?.state === "running") {
      void this.ctx.suspend();
    }
  }

  resume(): void {
    if (this.ctx?.state === "suspended") {
      void this.ctx.resume();
    }
  }

  private ensure(): void {
    if (this.ctx) {
      return;
    }
    const scope: typeof globalThis & { webkitAudioContext?: typeof AudioContext } = globalThis;
    const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Ctor) {
      return;
    }
    const ctx = new Ctor();
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
    // Music.duck() restores to this baseline
    this.musicBus = mkBus(0.32);
    this.amb = mkBus(0.22);
    // one second of white noise for percussive voices
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
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
    const t = this.now() * 1000;
    if (t - (this.last[key] ?? -1e9) < ms) {
      return false;
    }
    this.last[key] = t;
    return true;
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
      // cull past ~half arena
    }
    // ref dist 10u
    const g = 1 / (1 + (d * d) / 100);
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

  private route(node: AudioNode, pan: number, bus: BusName | undefined): void {
    const dest = this.busNode(bus);
    if (!dest || !this.ctx) {
      return;
    }
    if (pan === 0) {
      node.connect(dest);
    } else {
      const p = this.ctx.createStereoPanner();
      p.pan.value = pan;
      node.connect(p).connect(dest);
    }
  }

  private applyFilter(head: AudioNode, f: FilterOpts, t: number, dur: number): AudioNode {
    if (!this.ctx) {
      return head;
    }
    const filt = this.ctx.createBiquadFilter();
    filt.type = f.type;
    filt.frequency.setValueAtTime(Math.max(20, f.from), t);
    if (f.to !== undefined) {
      filt.frequency.exponentialRampToValueAtTime(Math.max(20, f.to), t + dur);
    }
    if (f.q !== undefined) {
      filt.Q.value = f.q;
    }
    if (f.lfo) {
      const lfo = this.ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = f.lfo.freq;
      const depth = this.ctx.createGain();
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
    let g = gain;
    if (o.x !== undefined && o.y !== undefined) {
      const s = this.spatial(o.x, o.y);
      if (!s) {
        return null;
      }
      if (this.live >= VOICE_CAP && s.g < 0.35) {
        return null;
        // shed distant first
      }
      g *= s.g;
      pan = Math.max(-1, Math.min(1, s.pan + pan));
    }
    return { g, pan };
  }

  private tone(o: ToneOpts): void {
    if (!this.ctx) {
      return;
    }
    const m = this.mix(o, o.gain);
    if (!m) {
      return;
    }
    const t = o.at ?? this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t);
    if (o.slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t + o.dur);
    }
    if (o.detune !== undefined) {
      osc.detune.setValueAtTime(o.detune, t);
    }
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0003, m.g), t + (o.attack ?? 0.005));
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let head: AudioNode = osc;
    if (o.filter) {
      head = this.applyFilter(head, o.filter, t, o.dur);
    }
    head.connect(env);
    this.route(env, m.pan, o.bus);
    this.countVoice(osc);
    osc.start(t);
    osc.stop(t + o.dur + 0.03);
  }

  /** Track live voices for the cap; decrement when the source finishes. */
  private countVoice(src: AudioScheduledSourceNode): void {
    this.live += 1;
    src.addEventListener(
      "ended",
      () => {
        this.live -= 1;
      },
      { once: true },
    );
  }

  private noise(o: NoiseOpts): void {
    if (!this.ctx || !this.noiseBuf) {
      return;
    }
    const m = this.mix(o, o.gain);
    if (!m) {
      return;
    }
    const t = o.at ?? this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(Math.max(0.0003, m.g), t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    let head: AudioNode = src;
    if (o.filter) {
      head = this.applyFilter(head, o.filter, t, o.dur);
    }
    head.connect(env);
    this.route(env, m.pan, o.bus);
    this.countVoice(src);
    src.start(t, Math.random() * Math.max(0, 1 - o.dur - 0.05));
    src.stop(t + o.dur + 0.03);
  }

  /** Brass-ish stinger note: 3 detuned saws → lowpass 1250 → shared envelope. */
  private sawStack(freq: number, at: number, dur: number, gain = 0.07, fallTo?: number): void {
    if (!this.ctx) {
      return;
    }
    const dest = this.busNode("sfx");
    if (!dest) {
      return;
    }
    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 1250;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, at);
    env.gain.exponentialRampToValueAtTime(gain, at + 0.02);
    env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    filt.connect(env).connect(dest);
    let first = true;
    for (const det of [1, 1.006, 0.994]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq * det, at);
      if (fallTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(freq * det * fallTo, at + dur);
      }
      osc.connect(filt);
      if (first) {
        this.countVoice(osc);
        first = false;
      }
      osc.start(at);
      osc.stop(at + dur + 0.05);
    }
  }

  // ── layered impacts (A2) ────────────────────────────────────────────────────

  /** 3-layer impact at the hit point: transient / body / tail per damage type. */
  hit(x?: number, y?: number, dtype: DamageType = "physical"): void {
    if (!this.gate("hit", 45)) {
      return;
    }
    this.impact(this.now(), x, y, dtype, 1);
  }

  /** Crit: physical layers pitched ×1.3 + 1244Hz ring + 72→48Hz sub. */
  crit(x?: number, y?: number): void {
    if (!this.gate("crit", 60)) {
      return;
    }
    const t = this.now();
    this.impact(t, x, y, "physical", 1.3);
    this.tone({ at: t, dur: 0.05, freq: 1244, gain: 0.1, type: "sine", x, y });
    this.tone({ at: t, dur: 0.14, freq: 72, gain: 0.2, slideTo: 48, type: "sine", x, y });
  }

  private impact(
    t: number,
    x: number | undefined,
    y: number | undefined,
    dtype: DamageType,
    p: number,
  ): void {
    const j = jit();
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
  attack(champId: string, x: number, y: number): void {
    if (!this.gate(`atk:${champId}`, 70)) {
      return;
    }
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
          dur: 0.035,
          freq: 235,
          gain: 0.14,
          slideTo: 175,
          type: "triangle",
          x,
          y,
        });
        this.noise({ at: t, dur: 0.02, filter: { from: 4500, type: "highpass" }, gain: 0.1, x, y });
        this.tone({ at: t, dur: 0.06, freq: 900, gain: 0.06, slideTo: 300, type: "sine", x, y });
        break;
      }
      case "mage": {
        this.atkMageBeat(t, x, y, 1, 0.08);
        this.tone({ at: t, dur: 0.04, freq: 1860, gain: 0.05, type: "sine", x, y });
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
        this.noise({ at: t, dur: 0.07, filter: { from: 1600, type: "lowpass" }, gain: 0.09, x, y });
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
    for (let i = 0; i < 3; i += 1) {
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
  cast(champId = "", key: AbilityKey = "Q", x?: number, y?: number): void {
    if (!this.gate("cast", 60)) {
      return;
    }
    const t = this.now();
    const m = CAST_MOD[key];
    this.castVoice(champId, t, x, y, m.p, m.d);
    if (key === "DASH") {
      this.dodge(x, y);
      // crisp air-whoosh on top of the zip
    }
    if (m.ult && this.gate("ult", 300)) {
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
          dur: 0.22 * d,
          freq: 330 * p,
          gain: 0.12,
          slideTo: 660 * p,
          type: "triangle",
          x,
          y,
        });
        this.noise({
          at: t,
          dur: 0.02,
          filter: { from: 4500, type: "highpass" },
          gain: 0.05,
          x,
          y,
        });
        break;
      }
      case "mage": {
        this.tone({
          at: t,
          dur: 0.22 * d,
          freq: 320 * p,
          gain: 0.14,
          slideTo: 980 * p,
          type: "sine",
          x,
          y,
        });
        this.tone({ at: t, dur: 0.05, freq: 1560 * p, gain: 0.05, type: "sine", x, y });
        this.tone({ at: t + 0.04, dur: 0.05, freq: 1976 * p, gain: 0.05, type: "sine", x, y });
        this.tone({ at: t + 0.08, dur: 0.05, freq: 2349 * p, gain: 0.05, type: "sine", x, y });
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
          dur: 0.18 * d,
          freq: 320 * p * jit(),
          gain: 0.14,
          slideTo: 760 * p,
          type: "sine",
          x,
          y,
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
    const t = this.now();
    this.tone({ at: t, dur: 0.09, freq: 784, gain: 0.16, type: "triangle" });
    this.tone({ at: t + 0.07, dur: 0.14, freq: 1046, gain: 0.16, type: "triangle" });
    this.noise({ at: t, dur: 0.03, filter: { from: 5000, type: "highpass" }, gain: 0.08 });
  }

  /** Announcer stingers, D minor: 0 spree/first-blood · 1 rampage ·
   *  2 unstoppable (staccato run + timpani) · 3 godlike (+ riser + sub). */
  stinger(tier: 0 | 1 | 2 | 3): void {
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
  }

  /** The kill leader fell: descending saw-stack pair A3 → D3. */
  leaderSlain(): void {
    if (!this.gate("leaderSlain", 300)) {
      return;
    }
    const t = this.now();
    this.sawStack(A3, t, 0.3);
    this.sawStack(D3, t + 0.3, 0.3);
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
    this.tone({ bus: "ui", dur: 0.15, freq: 440, gain: 0.12, slideTo: 880, type: "sine" });
  }
  /** Low-HP 55Hz thump pair; HUD drives the 0.9s vignette-locked cadence. */
  heartbeat(): void {
    if (!this.gate("heartbeat", 400)) {
      return;
    }
    const t = this.now();
    this.tone({ at: t, bus: "ui", dur: 0.09, freq: 55, gain: 0.16, type: "sine" });
    this.tone({ at: t + 0.13, bus: "ui", dur: 0.08, freq: 55, gain: 0.1, type: "sine" });
  }
  /** Countdown numeral blip ("3 · 2 · 1"). */
  count(): void {
    this.tone({ bus: "ui", dur: 0.09, freq: 440, gain: 0.12, type: "sine" });
  }
  /** "FIGHT!" — bright blip + snare crack. */
  fight(): void {
    const t = this.now();
    this.tone({ at: t, bus: "ui", dur: 0.18, freq: 880, gain: 0.14, type: "sine" });
    this.noise({
      at: t,
      bus: "ui",
      dur: 0.09,
      filter: { from: 1800, type: "bandpass" },
      gain: 0.1,
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
    this.tone({ dur: 0.4, freq: 380, gain: 0.16, slideTo: 70, type: "sawtooth", x, y });
    this.musicInst?.duck();
  }
  coin(x?: number, y?: number): void {
    const t = this.now();
    this.tone({ at: t, dur: 0.07, freq: 880 * jit(), gain: 0.2, type: "triangle", x, y });
    this.tone({ at: t + 0.02, dur: 0.12, freq: 1320, gain: 0.18, type: "triangle", x, y });
  }
  levelup(): void {
    const t = this.now();
    for (const [i, f] of [523, 659, 784, 1046].entries()) {
      this.tone({ at: t + i * 0.07, dur: 0.14, freq: f, gain: 0.16, type: "triangle" });
    }
  }
  delivery(): void {
    const t = this.now();
    this.tone({ at: t, dur: 0.12, freq: 660, gain: 0.16, type: "sine" });
    this.tone({ at: t + 0.09, dur: 0.16, freq: 990, gain: 0.16, type: "sine" });
  }
  alert(): void {
    const t = this.now();
    this.tone({ at: t, dur: 0.12, freq: 440, gain: 0.18, type: "square" });
    this.tone({ at: t + 0.15, dur: 0.12, freq: 440, gain: 0.18, type: "square" });
  }
  victory(): void {
    const t = this.now();
    for (const [i, f] of [523, 659, 784, 1046, 1318].entries()) {
      this.tone({ at: t + i * 0.11, dur: 0.2, freq: f, gain: 0.2, type: "triangle" });
    }
  }

  // ── ambience (A7) ───────────────────────────────────────────────────────────

  /** Dungeon bed: constant sub rumble + torch crackle pops + a distant moan.
   *  Look-ahead interval schedules `at` times — no setTimeout voices. */
  private startAmbience(): void {
    if (this.ambStarted || !this.ctx || !this.noiseBuf) {
      return;
    }
    const dest = this.busNode("amb");
    if (!dest) {
      return;
    }
    this.ambStarted = true;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = 110;
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    src.connect(filt).connect(g).connect(dest);
    src.start();
    const t = this.ctx.currentTime;
    this.ambNextPop = t + 0.4;
    this.ambNextMoan = t + 14 + Math.random() * 12;
    this.ambTimer = window.setInterval(() => this.ambTick(), 400);
  }

  private ambTick(): void {
    if (!this.ctx) {
      if (this.ambTimer !== null) {
        window.clearInterval(this.ambTimer);
      }
      this.ambTimer = null;
      return;
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
