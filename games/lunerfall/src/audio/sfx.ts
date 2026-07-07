// Self-contained WebAudio synth — no sound files. All SFX + a subtle neon-shrine
// music bed are generated at runtime. Unlocked on the first user gesture.

type Ctx = AudioContext & { createGain: () => GainNode };

class Sfx {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  muted = false;

  private ensure(): Ctx | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const AC = window.AudioContext;
      if (!AC) return null;
      this.ctx = new AC() as Ctx;
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0.32;
      this.musicGain.connect(this.master);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  // Call once — resumes audio + starts music on the first key/pointer.
  unlock() {
    this.ensure();
    if (this.ctx && !this.musicTimer && !this.muted) this.startMusic();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master && this.ctx) this.master.gain.setValueAtTime(this.muted ? 0 : 0.5, this.ctx.currentTime);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number, dest?: AudioNode) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest ?? this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, gain: number, filt: number, sweepTo?: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(filt, ctx.currentTime);
    if (sweepTo) bp.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    src.connect(bp).connect(g).connect(this.master);
    src.start();
    src.stop(ctx.currentTime + dur + 0.02);
  }

  private r(n: number) {
    return 1 + (Math.random() - 0.5) * n;
  }

  slash() {
    this.noise(0.12, 0.18, 2600 * this.r(0.2), 900);
  }
  hit() {
    this.tone(180 * this.r(0.15), 0.1, "square", 0.16, 90);
    this.noise(0.07, 0.12, 1400);
  }
  kill() {
    this.tone(140, 0.18, "square", 0.2, 60);
    this.noise(0.14, 0.16, 900, 300);
  }
  dash() {
    this.noise(0.18, 0.14, 700 * this.r(0.2), 2400);
  }
  jump() {
    this.tone(320 * this.r(0.1), 0.14, "sine", 0.12, 620);
  }
  hurt() {
    this.tone(300, 0.2, "sawtooth", 0.2, 90);
  }
  pickup() {
    this.tone(660, 0.09, "triangle", 0.16, 990);
    this.tone(990, 0.12, "triangle", 0.12);
  }
  boom() {
    this.tone(90, 0.4, "sine", 0.32, 38);
    this.noise(0.35, 0.24, 500, 120);
  }
  heal() {
    this.tone(520, 0.14, "sine", 0.14, 780);
    this.tone(780, 0.2, "sine", 0.12, 1040);
  }
  door() {
    this.tone(440, 0.18, "triangle", 0.12, 660);
  }
  select() {
    this.tone(560 * this.r(0.05), 0.07, "square", 0.1, 720);
  }
  die() {
    this.tone(260, 0.6, "sawtooth", 0.26, 60);
    this.noise(0.5, 0.18, 400, 100);
  }
  downed() {
    this.tone(220, 0.5, "sawtooth", 0.24, 55);
    this.noise(0.4, 0.16, 500, 120);
  }
  revive() {
    this.tone(440, 0.12, "triangle", 0.14, 660);
    this.tone(660, 0.18, "triangle", 0.12, 990);
    this.tone(990, 0.24, "sine", 0.1, 1320);
  }
  bossRoar() {
    this.tone(70, 0.7, "sawtooth", 0.34, 44);
    this.noise(0.6, 0.22, 300, 90);
  }

  // Sparse pentatonic bass + soft kick — a moody neon-shrine bed.
  private startMusic() {
    const ctx = this.ensure();
    if (!ctx || !this.musicGain) return;
    const mg = this.musicGain;
    const bass = [55, 82.4, 61.7, 73.4]; // A1 E2 B1 D2
    this.musicTimer = setInterval(() => {
      if (this.muted) return;
      const i = this.step % 16;
      if (i % 4 === 0) this.tone(90, 0.16, "sine", 0.5, 40, mg); // kick
      if (i % 8 === 0) {
        const root = bass[Math.floor(this.step / 8) % bass.length] ?? 55;
        this.tone(root, 1.4, "triangle", 0.4, undefined, mg);
        this.tone(root * 1.5, 1.2, "sine", 0.18, undefined, mg);
      }
      if (i === 6 || i === 12) this.tone(880 * this.r(0.02), 0.12, "sine", 0.1, undefined, mg);
      this.step++;
    }, 200);
  }
}

export const sfx = new Sfx();
