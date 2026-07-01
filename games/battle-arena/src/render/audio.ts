// Procedural SFX via the Web Audio API — no audio assets. Synth voices for the
// core feedback (hit, cast, explosion, death, coin, level-up, delivery, alert)
// with per-shot pitch jitter. Throttled so a busy brawl doesn't machine-gun.
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private last: Record<string, number> = {};

  constructor() {
    const unlock = (): void => {
      this.ensure();
      if (this.ctx?.state === "suspended") void this.ctx.resume();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  private ensure(): void {
    if (this.ctx) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
    // one second of white noise for percussive voices
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Rate-limit a given voice so overlapping events don't stack into noise. */
  private gate(key: string, ms: number): boolean {
    const t = this.now() * 1000;
    if (t - (this.last[key] ?? -1e9) < ms) return false;
    this.last[key] = t;
    return true;
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number): void {
    if (!this.ctx || !this.master) return;
    const t = this.now();
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, cutoff: number): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.now();
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = "lowpass";
    filt.frequency.value = cutoff;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  private jit(): number {
    return 0.92 + Math.random() * 0.16;
  }

  hit(): void {
    if (!this.gate("hit", 45)) return;
    this.noise(0.07, 0.18, 1800);
    this.tone(220 * this.jit(), 0.08, "square", 0.08, 140);
  }
  crit(): void {
    if (!this.gate("crit", 60)) return;
    this.noise(0.05, 0.24, 3000);
    this.tone(660, 0.06, "square", 0.12, 180);
  }
  cast(): void {
    if (!this.gate("cast", 60)) return;
    this.tone(320 * this.jit(), 0.18, "sine", 0.14, 760);
  }
  explosion(): void {
    if (!this.gate("boom", 60)) return;
    this.noise(0.25, 0.32, 900);
    this.tone(90, 0.3, "sine", 0.3, 45);
  }
  death(): void {
    this.tone(380, 0.4, "sawtooth", 0.16, 70);
  }
  coin(): void {
    this.tone(880 * this.jit(), 0.07, "triangle", 0.2);
    this.tone(1320, 0.12, "triangle", 0.18);
  }
  levelup(): void {
    [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this.tone(f, 0.14, "triangle", 0.16), i * 70));
  }
  delivery(): void {
    this.tone(660, 0.12, "sine", 0.16);
    setTimeout(() => this.tone(990, 0.16, "sine", 0.16), 90);
  }
  alert(): void {
    this.tone(440, 0.12, "square", 0.18);
    setTimeout(() => this.tone(440, 0.12, "square", 0.18), 150);
  }
  victory(): void {
    [523, 659, 784, 1046, 1318].forEach((f, i) => setTimeout(() => this.tone(f, 0.2, "triangle", 0.2), i * 110));
  }
}
