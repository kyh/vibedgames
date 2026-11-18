import { VoicePool } from "./audio-voices";
import type { VoiceGroup } from "./audio-voices";

export type MusicIntensity = 0 | 1 | 2 | 3;

const A1 = 55;
const D2 = 73.42;
const F2 = 87.31;
const C3 = 130.81;
const D3 = 146.83;
const E3 = 164.81;
const F3 = 174.61;
const G3 = 196;
const A3 = 220;
const BB3 = 233.08;
const D4 = 293.66;
const F4 = 349.23;
const A4 = 440;
const C5 = 523.25;

const PULSE_PATTERN: number[] = [D2, D2, F2, D2, A1, D2, C3, D2];
const LEAD_PATTERN: number[] = [D4, F4, A4, C5, A4, F4];

const SCHEDULER_MS = 45;
const LOOKAHEAD_S = 0.18;
const FADE_S = 1.5;
const BUS_GAIN = 0.32;

type LayerName = "drone" | "pulse" | "kit" | "lead";

const LAYER_NAMES: LayerName[] = ["drone", "pulse", "kit", "lead"];
const LAYER_MIN = { drone: 0, kit: 1, lead: 2, pulse: 1 } satisfies Record<LayerName, number>;

export class Music {
  private gains: Record<LayerName, GainNode> | null = null;
  private targets = { drone: 1, kit: 0, lead: 0, pulse: 0 } satisfies Record<LayerName, number>;
  private fadeEnds = { drone: 0, kit: 0, lead: 0, pulse: 0 } satisfies Record<LayerName, number>;
  private drone: VoiceGroup | null = null;
  private voices = new VoicePool(24, 24);
  private disposed = false;
  private resolved = false;
  private noiseBuf: AudioBuffer | null = null;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0;
  private bpm = 96;
  private intensity: MusicIntensity = 0;
  private running = false;

  private ctx: AudioContext;
  private bus: GainNode;

  constructor(ctx: AudioContext, bus: GainNode) {
    this.ctx = ctx;
    this.bus = bus;
  }

  /** Begin once or resume the same phase, rebased to the current sample clock. */
  start() {
    if (this.running || this.disposed || this.resolved || this.ctx.state !== "running") {
      return;
    }

    this.voices.clear();
    this.running = true;
    this.ensureNoise();
    const t = this.ctx.currentTime;

    if (!this.gains) {
      this.gains = {
        drone: this.ctx.createGain(),
        kit: this.ctx.createGain(),
        lead: this.ctx.createGain(),
        pulse: this.ctx.createGain(),
      } satisfies Record<LayerName, GainNode>;

      for (const name of LAYER_NAMES) {
        this.gains[name].connect(this.bus);
      }
    }

    for (const name of LAYER_NAMES) {
      const { gain } = this.gains[name];
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(this.targets[name], t);
    }

    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(BUS_GAIN, t);
    this.applyIntensityGains();
    this.startDrone(this.gains.drone, t);
    this.nextTime = t + 0.06;
    this.timer = window.setInterval(() => this.tick(), SCHEDULER_MS);
  }

  /** Crossfade the layer stack (1.5s); tempo shifts to 112 on the next bar at 3. */
  setIntensity(n: MusicIntensity) {
    if (this.disposed || n === this.intensity) {
      return;
    }

    this.intensity = n;
    this.applyIntensityGains();
  }

  /** Sidechain dip for big impacts (explosion/death) — 0.19 then back to 0.32. */
  duck() {
    if (!this.running || this.disposed || this.ctx.state !== "running") {
      return;
    }

    const t = this.ctx.currentTime;
    this.bus.gain.setTargetAtTime(0.19, t, 0.08);
    this.bus.gain.setTargetAtTime(BUS_GAIN, t + 0.4, 0.1);
  }

  /** Halt the scheduler + drone; layers ramp out fast. */
  stop() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }

    const t = this.ctx.currentTime;

    if (this.gains) {
      for (const name of LAYER_NAMES) {
        const g = this.gains[name].gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(g.value, t);
        g.linearRampToValueAtTime(0, t + 0.25);
      }
    }

    this.drone?.stopAt(t + 0.3);
    this.drone = null;
    this.running = false;
  }

  /** Match-end cadence: I-chord (D3 F3 A3, 1.2s) on a win; falling ii°-ish
   *  (E3 G3 Bb3) on a loss. Stops the layers first. */
  resolve(won: boolean) {
    if (this.disposed || this.resolved) {
      return;
    }

    this.resolved = true;
    this.stop();

    if (this.ctx.state !== "running") {
      return;
    }

    const phrase = this.voices.begin("essential");
    this.ensureNoise();
    const t = this.ctx.currentTime + 0.05;

    if (won) {
      this.sawStackNote(D3, t, 1.2, 0.07, undefined, phrase);
      this.sawStackNote(F3, t, 1.2, 0.07, undefined, phrase);
      this.sawStackNote(A3, t, 1.2, 0.07, undefined, phrase);
    } else {
      this.sawStackNote(E3, t, 1, 0.06, 0.84, phrase);
      this.sawStackNote(G3, t, 1, 0.06, 0.84, phrase);
      this.sawStackNote(BB3, t, 1, 0.06, 0.84, phrase);
    }

    phrase.seal();
  }

  /** Immediate cancellation for mute/pause; retain the musical phase and mix. */
  silence() {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
    }

    this.timer = null;
    this.running = false;
    this.voices.clear();
    this.drone = null;
    const t = this.ctx.currentTime;
    this.bus.gain.cancelScheduledValues(t);
    this.bus.gain.setValueAtTime(BUS_GAIN, t);

    if (this.gains) {
      for (const name of LAYER_NAMES) {
        this.gains[name].gain.cancelScheduledValues(t);
        this.gains[name].gain.setValueAtTime(0, t);
      }
    }
  }

  dispose() {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.silence();

    if (this.gains) {
      for (const name of LAYER_NAMES) {
        this.gains[name].disconnect();
      }
    }

    this.gains = null;
    this.noiseBuf = null;
  }

  private tick() {
    if (!this.running || this.disposed || this.ctx.state !== "running") {
      return;
    }

    const now = this.ctx.currentTime;

    if (this.nextTime < now - LOOKAHEAD_S) {
      this.nextTime = now + 0.06;
    }

    const horizon = now + LOOKAHEAD_S;

    while (this.nextTime < horizon) {
      if (this.step % 8 === 0) {
        this.bpm = this.intensity === 3 ? 112 : 96;
      }

      const stepDur = 60 / this.bpm / 2;
      this.scheduleStep(this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step += 1;
    }
  }

  private scheduleStep(step: number, t: number, stepDur: number) {
    const s8 = step % 8;

    if (this.layerAudible("pulse")) {
      const f = PULSE_PATTERN[s8] ?? D2;
      this.tone("pulse", "triangle", f, t, 0.18, 0.09);
    }

    if (this.layerAudible("kit")) {
      if (s8 === 0 || s8 === 4) {
        this.tone("kit", "sine", 110, t, 0.12, 0.15, 45);
      }

      if (s8 === 4) {
        this.noise("kit", t, 0.09, 0.1, "bandpass", 1800);
      }

      if (s8 % 2 === 1 || this.intensity === 3) {
        this.noise("kit", t, 0.03, 0.045, "highpass", 6000);
      }
    }

    if (this.layerAudible("lead")) {
      const i0 = (step * 2) % LEAD_PATTERN.length;
      const i1 = (step * 2 + 1) % LEAD_PATTERN.length;
      this.tone("lead", "square", LEAD_PATTERN[i0] ?? D4, t, 0.09, 0.045, undefined, 2200);
      this.tone(
        "lead",
        "square",
        LEAD_PATTERN[i1] ?? F4,
        t + stepDur / 2,
        0.09,
        0.045,
        undefined,
        2200,
      );
    }
  }

  private layerAudible(name: LayerName) {
    return this.targets[name] > 0 || this.ctx.currentTime < this.fadeEnds[name];
  }

  private applyIntensityGains() {
    const t = this.ctx.currentTime;

    for (const name of LAYER_NAMES) {
      const target = this.intensity >= LAYER_MIN[name] ? 1 : 0;

      if (target === this.targets[name]) {
        continue;
      }

      this.targets[name] = target;
      this.fadeEnds[name] = t + FADE_S;

      if (!this.gains) {
        continue;
      }

      const g = this.gains[name].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(target, t + FADE_S);
    }
  }

  private ensureNoise() {
    if (this.noiseBuf) {
      return;
    }

    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const data = buf.getChannelData(0);

    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }

    this.noiseBuf = buf;
  }

  private dest(layer: LayerName) {
    return this.gains ? this.gains[layer] : this.bus;
  }

  private tone(
    layer: LayerName,
    type: OscillatorType,
    freq: number,
    t: number,
    dur: number,
    gain: number,
    slideTo?: number,
    lowpass?: number,
  ) {
    const group = this.voices.begin();
    const osc = group.source(() => this.ctx.createOscillator());

    if (!osc) {
      group.seal();

      return;
    }

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    if (slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    }

    const g = group.node(this.ctx.createGain());
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head: AudioNode = osc;

    if (lowpass !== undefined) {
      const f = group.node(this.ctx.createBiquadFilter());
      f.type = "lowpass";
      f.frequency.value = lowpass;
      osc.connect(f);
      head = f;
    }

    head.connect(g).connect(this.dest(layer));
    osc.start(t);
    osc.stop(t + dur + 0.03);
    group.seal();
  }

  private noise(
    layer: LayerName,
    t: number,
    dur: number,
    gain: number,
    ftype: BiquadFilterType,
    ffreq: number,
  ) {
    if (!this.noiseBuf) {
      return;
    }

    const group = this.voices.begin();
    const src = group.source(() => this.ctx.createBufferSource());

    if (!src) {
      group.seal();

      return;
    }

    src.buffer = this.noiseBuf;
    const f = group.node(this.ctx.createBiquadFilter());
    f.type = ftype;
    f.frequency.value = ffreq;
    const g = group.node(this.ctx.createGain());
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.dest(layer));
    src.start(t, Math.random());
    src.stop(t + dur + 0.03);
    group.seal();
  }

  private startDrone(layerGain: GainNode, t: number) {
    const group = this.voices.begin();
    this.drone = group;
    const filter = group.node(this.ctx.createBiquadFilter());
    filter.type = "lowpass";
    filter.frequency.value = 300;
    const level = group.node(this.ctx.createGain());
    level.gain.value = 0.05;
    filter.connect(level).connect(layerGain);

    for (const f of [D2, D2 * 1.007]) {
      const osc = group.source(() => this.ctx.createOscillator());

      if (!osc) {
        break;
      }

      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.connect(filter);
      osc.start(t);
    }

    group.seal();
  }

  private sawStackNote(
    freq: number,
    t: number,
    dur: number,
    gain: number,
    fallTo?: number,
    phrase?: VoiceGroup,
  ) {
    const group = phrase ?? this.voices.begin();
    const filter = group.node(this.ctx.createBiquadFilter());
    filter.type = "lowpass";
    filter.frequency.value = 1250;
    const g = group.node(this.ctx.createGain());
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    filter.connect(g).connect(this.bus);

    for (const det of [1, 1.006, 0.994]) {
      const osc = group.source(() => this.ctx.createOscillator());

      if (!osc) {
        break;
      }

      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq * det, t);

      if (fallTo !== undefined) {
        osc.frequency.exponentialRampToValueAtTime(freq * det * fallTo, t + dur);
      }

      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }

    if (!phrase) {
      group.seal();
    }
  }
}
