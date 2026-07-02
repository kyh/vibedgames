// 4-layer intensity-driven combat music — pure Web Audio synthesis, D minor,
// 96 BPM (112 at intensity 3, tempo switches only on a bar boundary).
// Look-ahead scheduler: setInterval(45ms) schedules everything ≤ 0.18s out with
// sample-accurate `start(t)` times — no setTimeout voices, nothing drifts when
// the tab hiccups.
//
// Layers (each behind a persistent GainNode crossfaded 1.5s on intensity change):
//   drone ≥0 — 2 detuned saws D2 → lowpass 300 (started once, never per-step)
//   pulse ≥1 — bass plucks on 8ths  [D2 D2 F2 D2 A1 D2 C3 D2]
//   kit   ≥1 — kick steps 0+4 · snare step 4 · hats odd steps (all 8ths at 3)
//   lead  ≥2 — 16th arp [D4 F4 A4 C5 A4 F4] square → lowpass 2200
//
// Owned by the audio layer (constructed with the shared ctx + musicBus, started
// on the same unlock gesture). Consumers: fx.ts / game-scene via
// setIntensity / duck / stop / resolve.
export type MusicIntensity = 0 | 1 | 2 | 3;

// D minor pitch set (Hz)
const A1 = 55.0;
const D2 = 73.42;
const F2 = 87.31;
const C3 = 130.81;
const D3 = 146.83;
const E3 = 164.81;
const F3 = 174.61;
const G3 = 196.0;
const A3 = 220.0;
const BB3 = 233.08;
const D4 = 293.66;
const F4 = 349.23;
const A4 = 440.0;
const C5 = 523.25;

const PULSE_PATTERN: number[] = [D2, D2, F2, D2, A1, D2, C3, D2]; // 8ths
const LEAD_PATTERN: number[] = [D4, F4, A4, C5, A4, F4]; // 16ths

const SCHEDULER_MS = 45;
const LOOKAHEAD_S = 0.18;
const FADE_S = 1.5;
const BUS_GAIN = 0.32; // musicBus baseline (duck target 0.19, restored +0.4s)

type LayerName = "drone" | "pulse" | "kit" | "lead";
const LAYER_NAMES: LayerName[] = ["drone", "pulse", "kit", "lead"];
const LAYER_MIN: Record<LayerName, number> = { drone: 0, pulse: 1, kit: 1, lead: 2 };

export class Music {
  private gains: Record<LayerName, GainNode> | null = null;
  private targets: Record<LayerName, number> = { drone: 1, pulse: 0, kit: 0, lead: 0 };
  private fadeEnds: Record<LayerName, number> = { drone: 0, pulse: 0, kit: 0, lead: 0 };
  private droneOscs: OscillatorNode[] = [];
  private noiseBuf: AudioBuffer | null = null;
  private timer: number | null = null;
  private nextTime = 0;
  private step = 0; // global 8th-note counter (16ths derive from step*2)
  private bpm = 96;
  private intensity: MusicIntensity = 0;
  private running = false;

  constructor(
    private ctx: AudioContext,
    private bus: GainNode,
  ) {}

  /** Begin the scheduler + drone. Call once, on the audio unlock gesture. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.ensureNoise();
    const t = this.ctx.currentTime;
    const gains: Record<LayerName, GainNode> = {
      drone: this.ctx.createGain(),
      pulse: this.ctx.createGain(),
      kit: this.ctx.createGain(),
      lead: this.ctx.createGain(),
    };
    for (const name of LAYER_NAMES) {
      gains[name].gain.value = this.targets[name];
      gains[name].connect(this.bus);
    }
    this.gains = gains;
    this.applyIntensityGains(); // in case setIntensity ran before start
    this.startDrone(gains.drone, t);
    this.nextTime = t + 0.06;
    this.step = 0;
    this.timer = window.setInterval(() => this.tick(), SCHEDULER_MS);
  }

  /** Crossfade the layer stack (1.5s); tempo shifts to 112 on the next bar at 3. */
  setIntensity(n: MusicIntensity): void {
    if (n === this.intensity) return;
    this.intensity = n;
    this.applyIntensityGains();
  }

  /** Sidechain dip for big impacts (explosion/death) — 0.19 then back to 0.32. */
  duck(): void {
    const t = this.ctx.currentTime;
    this.bus.gain.setTargetAtTime(0.19, t, 0.08);
    this.bus.gain.setTargetAtTime(BUS_GAIN, t + 0.4, 0.1);
  }

  /** Halt the scheduler + drone; layers ramp out fast. */
  stop(): void {
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
    for (const osc of this.droneOscs) osc.stop(t + 0.3);
    this.droneOscs.length = 0;
    this.gains = null;
    this.running = false;
  }

  /** Match-end cadence: I-chord (D3 F3 A3, 1.2s) on a win; falling ii°-ish
   *  (E3 G3 Bb3) on a loss. Stops the layers first. */
  resolve(won: boolean): void {
    this.stop();
    this.ensureNoise();
    const t = this.ctx.currentTime + 0.05;
    if (won) {
      this.sawStackNote(D3, t, 1.2, 0.07);
      this.sawStackNote(F3, t, 1.2, 0.07);
      this.sawStackNote(A3, t, 1.2, 0.07);
    } else {
      this.sawStackNote(E3, t, 1.0, 0.06, 0.84);
      this.sawStackNote(G3, t, 1.0, 0.06, 0.84);
      this.sawStackNote(BB3, t, 1.0, 0.06, 0.84);
    }
  }

  // ── scheduler ──────────────────────────────────────────────────────────────

  private tick(): void {
    if (!this.running) return;
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;
    while (this.nextTime < horizon) {
      if (this.step % 8 === 0) this.bpm = this.intensity === 3 ? 112 : 96; // bar boundary
      const stepDur = 60 / this.bpm / 2; // one 8th
      this.scheduleStep(this.step, this.nextTime, stepDur);
      this.nextTime += stepDur;
      this.step++;
    }
  }

  private scheduleStep(step: number, t: number, stepDur: number): void {
    const s8 = step % 8;
    // pulse — bass plucks on 8ths
    if (this.layerAudible("pulse")) {
      const f = PULSE_PATTERN[s8] ?? D2;
      this.tone("pulse", "triangle", f, t, 0.18, 0.09);
    }
    // kit — kick / snare / hats
    if (this.layerAudible("kit")) {
      if (s8 === 0 || s8 === 4) this.tone("kit", "sine", 110, t, 0.12, 0.15, 45);
      if (s8 === 4) this.noise("kit", t, 0.09, 0.1, "bandpass", 1800);
      if (s8 % 2 === 1 || this.intensity === 3) this.noise("kit", t, 0.03, 0.045, "highpass", 6000);
    }
    // lead — 16th arp (two notes per 8th step)
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

  /** Skip node creation for layers that are silent AND done fading. */
  private layerAudible(name: LayerName): boolean {
    return this.targets[name] > 0 || this.ctx.currentTime < this.fadeEnds[name];
  }

  private applyIntensityGains(): void {
    const t = this.ctx.currentTime;
    for (const name of LAYER_NAMES) {
      const target = this.intensity >= LAYER_MIN[name] ? 1 : 0;
      if (target === this.targets[name]) continue;
      this.targets[name] = target;
      this.fadeEnds[name] = t + FADE_S;
      if (!this.gains) continue;
      const g = this.gains[name].gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(target, t + FADE_S);
    }
  }

  // ── voices ─────────────────────────────────────────────────────────────────

  private ensureNoise(): void {
    if (this.noiseBuf) return;
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  private dest(layer: LayerName): AudioNode {
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
  ): void {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined)
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head: AudioNode = osc;
    if (lowpass !== undefined) {
      const f = this.ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = lowpass;
      osc.connect(f);
      head = f;
    }
    head.connect(g).connect(this.dest(layer));
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  private noise(
    layer: LayerName,
    t: number,
    dur: number,
    gain: number,
    ftype: BiquadFilterType,
    ffreq: number,
  ): void {
    if (!this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = ftype;
    f.frequency.value = ffreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.dest(layer));
    src.start(t, Math.random());
    src.stop(t + dur + 0.03);
  }

  private startDrone(layerGain: GainNode, t: number): void {
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 300;
    const level = this.ctx.createGain();
    level.gain.value = 0.05;
    filter.connect(level).connect(layerGain);
    for (const f of [D2, D2 * 1.007]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = f;
      osc.connect(filter);
      osc.start(t);
      this.droneOscs.push(osc);
    }
  }

  /** Brass-ish stack: 3 detuned saws → lowpass 1250 (stinger timbre). Optional
   *  `fallTo` ratio pitches the note downward across its length (loss cadence). */
  private sawStackNote(freq: number, t: number, dur: number, gain: number, fallTo?: number): void {
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 1250;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    filter.connect(g).connect(this.bus);
    for (const det of [1, 1.006, 0.994]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(freq * det, t);
      if (fallTo !== undefined)
        osc.frequency.exponentialRampToValueAtTime(freq * det * fallTo, t + dur);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }
}
