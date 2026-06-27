// Procedural WebAudio sound — no asset files. Created lazily on first input so
// browsers don't block the context. All one-shots are safe no-ops until ready.
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private screechGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  muted = false;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.5;
    master.connect(ctx.destination);
    this.master = master;

    // White-noise buffer for screech / whoosh / thud.
    const buf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Continuous engine.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const sub = ctx.createOscillator();
    sub.type = "square";
    sub.detune.value = -12;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(filter);
    sub.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    osc.start();
    sub.start();
    this.engineOsc = osc;
    this.engineSub = sub;
    this.engineFilter = filter;
    this.engineGain = gain;

    // Drift screech: filtered noise loop, gated by gain.
    const screech = ctx.createBufferSource();
    screech.buffer = buf;
    screech.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1800;
    bp.Q.value = 6;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    screech.connect(bp);
    bp.connect(sg);
    sg.connect(master);
    screech.start();
    this.screechGain = sg;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  setEngine(speedFrac: number, throttle: number, boosting: boolean): void {
    if (!this.ctx || !this.engineOsc || !this.engineSub || !this.engineFilter || !this.engineGain)
      return;
    const t = this.ctx.currentTime;
    const base = 55 + speedFrac * (boosting ? 320 : 230);
    this.engineOsc.frequency.setTargetAtTime(base, t, 0.06);
    this.engineSub.frequency.setTargetAtTime(base * 0.5, t, 0.06);
    this.engineFilter.frequency.setTargetAtTime(420 + speedFrac * 2200, t, 0.08);
    const vol = 0.03 + Math.max(0, throttle) * 0.05 + speedFrac * 0.05;
    this.engineGain.gain.setTargetAtTime(vol, t, 0.08);
  }

  setScreech(on: boolean): void {
    if (!this.ctx || !this.screechGain) return;
    this.screechGain.gain.setTargetAtTime(on ? 0.12 : 0, this.ctx.currentTime, 0.05);
  }

  private blip(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    slideTo?: number,
  ): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo !== undefined) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noiseHit(dur: number, cutoff: number, vol: number, type: BiquadFilterType): void {
    if (!this.ctx || !this.master || !this.noise) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  pickup(): void {
    this.blip(560, 0.12, "square", 0.18);
    this.blip(840, 0.14, "square", 0.14);
  }
  dropoff(combo: number): void {
    const base = 520 + combo * 40;
    this.blip(base, 0.1, "triangle", 0.2);
    this.blip(base * 1.33, 0.12, "triangle", 0.18);
    this.blip(base * 1.7, 0.18, "triangle", 0.16);
  }
  nearMiss(): void {
    this.noiseHit(0.25, 2400, 0.12, "bandpass");
    this.blip(900, 0.12, "sine", 0.08, 1500);
  }
  crash(power: number): void {
    this.noiseHit(0.3, 320 + power * 30, Math.min(0.4, 0.12 + power * 0.02), "lowpass");
    this.blip(120, 0.18, "sawtooth", 0.12, 60);
  }
  boost(): void {
    this.blip(220, 0.3, "sawtooth", 0.12, 720);
  }
  beep(): void {
    this.blip(880, 0.08, "square", 0.16);
  }
  fanfare(): void {
    [523, 659, 784, 1046].forEach((f, i) => {
      window.setTimeout(() => this.blip(f, 0.18, "triangle", 0.16), i * 90);
    });
  }
  gameOver(): void {
    this.noiseHit(0.4, 900, 0.1, "lowpass"); // a final skid
    [440, 349, 262].forEach((f, i) => {
      window.setTimeout(() => this.blip(f, 0.24, "triangle", 0.16), 180 + i * 150);
    });
  }
}
