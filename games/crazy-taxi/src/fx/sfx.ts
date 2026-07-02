// Procedural WebAudio sound — no asset files. Created lazily on first input so
// browsers don't block the context. All methods are safe no-ops until ensure()
// has run (and if the browser has no AudioContext at all).
//
// Signal flow:
//   one-shots + loops ─┐
//   music bus ─────────┴→ master gain → compressor (-18dB, 4:1) → destination

const MASTER_LEVEL = 0.5;
/** Music bus sits at ~half of the sfx mix — a subtle driving groove, not loud. */
const MUSIC_LEVEL = 0.5;
const BPM = 138;
const EIGHTH = 60 / BPM / 2;
/** A-pentatonic bass riff, one bar of 8ths: A1 A1 C2 D2 | A1 G1 A1 rest. */
const BASS_RIFF: readonly (number | null)[] = [55, 55, 65.41, 73.42, 55, 49, 55, null];

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  // Engine (quantized 4-gear whine + wind layer).
  private engineOsc: OscillatorNode | null = null;
  private engineOsc2: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private engineLfoDepth: GainNode | null = null;
  private windGain: GainNode | null = null;
  private lastGear = -1;
  private gearDipUntil = 0;

  // Gated loops.
  private screechFilter: BiquadFilterNode | null = null;
  private screechGain: GainNode | null = null;
  private scrapeGain: GainNode | null = null;
  private boostLoopFilter: BiquadFilterNode | null = null;
  private boostLoopGain: GainNode | null = null;
  private boostLoopOn = false;

  // Music scheduler (lookahead pattern: interval books notes ~100ms ahead).
  private musicOn = false;
  private musicTimer: number | null = null;
  private nextNoteTime = 0;
  private musicStep = 0;

  muted = false;

  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      this.startMusicScheduler();
      return;
    }
    const Ctor = window.AudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    this.ctx = ctx;

    // Master chain: gain → compressor → destination.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : MASTER_LEVEL;
    master.connect(comp);
    this.master = master;

    const musicBus = ctx.createGain();
    musicBus.gain.value = MUSIC_LEVEL;
    musicBus.connect(master);
    this.musicBus = musicBus;

    // Shared white-noise buffer for every noise-based voice.
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.5), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = buf;

    // Engine: two saws (one +7 cents for thickness) + a sub square, through a
    // lowpass, with a subtle 4Hz gain LFO that fades in at idle.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    const osc2 = ctx.createOscillator();
    osc2.type = "sawtooth";
    osc2.detune.value = 7;
    const sub = ctx.createOscillator();
    sub.type = "square";
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 500;
    const engineGain = ctx.createGain();
    engineGain.gain.value = 0;
    osc.connect(filter);
    osc2.connect(filter);
    sub.connect(filter);
    filter.connect(engineGain);
    engineGain.connect(master);
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 4;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0;
    lfo.connect(lfoDepth);
    lfoDepth.connect(engineGain.gain);
    osc.start();
    osc2.start();
    sub.start();
    lfo.start();
    this.engineOsc = osc;
    this.engineOsc2 = osc2;
    this.engineSub = sub;
    this.engineFilter = filter;
    this.engineGain = engineGain;
    this.engineLfoDepth = lfoDepth;

    // Wind: looped noise → highpass 1200Hz, gain scales with speed².
    this.windGain = this.makeNoiseLoop(ctx, master, "highpass", 1200, 0.7).gain;

    // Tire screech: looped noise → bandpass, Q wobbled 4–8 by a 6Hz LFO.
    const screechSrc = ctx.createBufferSource();
    screechSrc.buffer = buf;
    screechSrc.loop = true;
    const screechBp = ctx.createBiquadFilter();
    screechBp.type = "bandpass";
    screechBp.frequency.value = 1800;
    screechBp.Q.value = 6;
    const screechGain = ctx.createGain();
    screechGain.gain.value = 0;
    screechSrc.connect(screechBp);
    screechBp.connect(screechGain);
    screechGain.connect(master);
    const qLfo = ctx.createOscillator();
    qLfo.type = "sine";
    qLfo.frequency.value = 6;
    const qDepth = ctx.createGain();
    qDepth.gain.value = 2;
    qLfo.connect(qDepth);
    qDepth.connect(screechBp.Q);
    screechSrc.start();
    qLfo.start();
    this.screechFilter = screechBp;
    this.screechGain = screechGain;

    // Wall scrape: looped noise → bandpass 800Hz Q2, gated.
    this.scrapeGain = this.makeNoiseLoop(ctx, master, "bandpass", 800, 2).gain;

    // Boost loop: looped noise → bandpass swept 900→2400Hz on activation.
    const boostLoop = this.makeNoiseLoop(ctx, master, "bandpass", 900, 1.2);
    this.boostLoopGain = boostLoop.gain;
    this.boostLoopFilter = boostLoop.filter;

    this.startMusicScheduler();
  }

  /** Looped noise → filter → zero gain → out. Returns the gate gain + filter. */
  private makeNoiseLoop(
    ctx: AudioContext,
    out: AudioNode,
    type: BiquadFilterType,
    freq: number,
    q: number,
  ): { gain: GainNode; filter: BiquadFilterNode } {
    const src = ctx.createBufferSource();
    if (this.noise) src.buffer = this.noise;
    src.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = 0;
    src.connect(f);
    f.connect(g);
    g.connect(out);
    src.start();
    return { gain: g, filter: f };
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(m ? 0 : MASTER_LEVEL, this.ctx.currentTime, 0.02);
    }
  }

  /**
   * Continuous engine. Four quantized gears: pitch climbs within a gear then
   * drops at each shift, with a ~50ms gain dip + 200Hz clunk on the change.
   * Boost ×1.6 pitch, airborne (no load) +20%. Also drives the wind layer.
   */
  setEngine(speedFrac: number, throttle: number, boosting: boolean, airborne = false): void {
    const ctx = this.ctx;
    if (
      !ctx ||
      !this.engineOsc ||
      !this.engineOsc2 ||
      !this.engineSub ||
      !this.engineFilter ||
      !this.engineGain
    ) {
      return;
    }
    const t = ctx.currentTime;
    const sf = Math.max(0, Math.min(1, speedFrac));
    const gear = Math.min(3, Math.floor(sf * 4));
    const inGear = sf * 4 - gear;
    let base = 60 + gear * 12 + inGear * 95;
    if (boosting) base *= 1.6;
    if (airborne) base *= 1.2;
    this.engineOsc.frequency.setTargetAtTime(base, t, 0.04);
    this.engineOsc2.frequency.setTargetAtTime(base, t, 0.04);
    this.engineSub.frequency.setTargetAtTime(base * 0.5, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(420 + sf * 2400, t, 0.08);

    const vol = 0.035 + Math.max(0, Math.min(1, throttle)) * 0.05 + sf * 0.05;
    const g = this.engineGain.gain;
    const shifted = gear !== this.lastGear && this.lastGear >= 0;
    this.lastGear = gear;
    if (shifted && sf > 0.05) {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(vol * 0.2, t, 0.01);
      g.setTargetAtTime(vol, t + 0.05, 0.03);
      this.gearDipUntil = t + 0.1;
      this.blip(200, 0.05, "square", 0.06); // tiny gearbox clunk
    } else if (t >= this.gearDipUntil) {
      g.setTargetAtTime(vol, t, 0.08);
    }

    // Subtle 4Hz idle chug, fading out as speed rises.
    if (this.engineLfoDepth) this.engineLfoDepth.gain.setTargetAtTime((1 - sf) * 0.012, t, 0.2);
    // Wind rises with speed².
    if (this.windGain) this.windGain.gain.setTargetAtTime(sf * sf * 0.14, t, 0.15);
  }

  /** Fully silence the engine + wind (menus, pause) — setEngine has an idle floor. */
  stopEngine(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (this.engineGain) {
      this.engineGain.gain.cancelScheduledValues(t);
      this.engineGain.gain.setTargetAtTime(0, t, 0.1);
      this.gearDipUntil = 0;
    }
    if (this.windGain) this.windGain.gain.setTargetAtTime(0, t, 0.1);
    if (this.engineLfoDepth) this.engineLfoDepth.gain.setTargetAtTime(0, t, 0.1);
  }

  /** Tire slip 0..1 (0 disables); speedFrac scales loudness. */
  setScreech(slip: number, speedFrac: number): void;
  /** @deprecated boolean gate — pass a slip amount instead. */
  setScreech(on: boolean): void;
  setScreech(slip: number | boolean, speedFrac = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.screechGain || !this.screechFilter) return;
    const s = typeof slip === "boolean" ? (slip ? 1 : 0) : Math.max(0, Math.min(1, slip));
    const t = ctx.currentTime;
    this.screechFilter.frequency.setTargetAtTime(1100 + s * 1400, t, 0.05);
    const speedScale = Math.min(1, Math.max(0, speedFrac) * 2 + 0.15);
    this.screechGain.gain.setTargetAtTime(s > 0 ? (0.05 + s * 0.12) * speedScale : 0, t, 0.05);
  }

  /** Gated wall-grind loop while scraping along a wall. */
  setScrape(on: boolean): void {
    if (!this.ctx || !this.scrapeGain) return;
    this.scrapeGain.gain.setTargetAtTime(on ? 0.1 : 0, this.ctx.currentTime, 0.04);
  }

  /** Sustained boost roar: noise bandpass swept 900Hz→2.4kHz on activation. */
  setBoostLoop(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.boostLoopGain || !this.boostLoopFilter) return;
    if (on === this.boostLoopOn) return;
    this.boostLoopOn = on;
    const t = ctx.currentTime;
    const g = this.boostLoopGain.gain;
    if (on) {
      const f = this.boostLoopFilter.frequency;
      f.cancelScheduledValues(t);
      f.setValueAtTime(900, t);
      f.linearRampToValueAtTime(2400, t + 0.12);
      g.cancelScheduledValues(t);
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(0.1, t + 0.12);
    } else {
      g.cancelScheduledValues(t);
      g.setTargetAtTime(0, t, 0.06);
    }
  }

  // ── One-shot helpers ────────────────────────────────────────────────────

  /** Tone one-shot; pitch randomized ±10%; optional slide + stereo pan. */
  private blip(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    slideTo?: number,
    pan?: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master) return;
    const t = ctx.currentTime;
    const jitter = 0.9 + Math.random() * 0.2;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq * jitter, t);
    if (slideTo !== undefined) {
      o.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo * jitter), t + dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g);
    let out: AudioNode = g;
    if (pan !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      out = p;
    }
    out.connect(master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  /** Filtered noise burst; playback rate + cutoff randomized ±10%. */
  private noiseHit(
    dur: number,
    cutoff: number,
    vol: number,
    type: BiquadFilterType,
    q = 1,
    pan?: number,
  ): void {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || !this.noise) return;
    const t = ctx.currentTime;
    const jitter = 0.9 + Math.random() * 0.2;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = jitter;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = cutoff * jitter;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(0.0001, vol), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    let out: AudioNode = g;
    if (pan !== undefined) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      out = p;
    }
    out.connect(master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  // ── One-shots ───────────────────────────────────────────────────────────

  /** Boost ignition sweep. */
  boost(): void {
    this.blip(220, 0.3, "sawtooth", 0.12, 720);
  }

  /** Wall/traffic impact: metallic clank + body thud (+ glass tinkle when hard). */
  crash(power: number): void {
    const k = Math.min(1, 0.4 + power * 0.03);
    // (a) metallic clank
    this.noiseHit(0.04, 2800, 0.25 * k, "bandpass", 2);
    // (b) body thud
    this.noiseHit(0.25, 160, 0.3 * k, "lowpass");
    this.blip(55, 0.15, "sine", 0.2 * k);
    // (c) glass tinkle on hard hits
    if (power > 15) {
      const n = 3 + (Math.random() < 0.5 ? 1 : 0);
      let delay = 60;
      for (let i = 0; i < n; i++) {
        const f = 2000 + Math.random() * 2000;
        window.setTimeout(() => this.blip(f, 0.06, "square", 0.05 + Math.random() * 0.03), delay);
        delay += 60 + Math.random() * 60;
      }
    }
    this.duck(0.2, 350);
  }

  /** Small curb tap. */
  thud(): void {
    this.noiseHit(0.08, 300, 0.06, "lowpass");
  }

  /** Hill-jump landing; power 0..1-ish scales weight. */
  landThud(power: number): void {
    const k = Math.max(0.3, Math.min(1, power));
    this.noiseHit(0.2, 180, 0.22 * k, "lowpass");
    this.blip(50, 0.12, "sine", 0.15 * k);
  }

  /** Two-tone traffic horn, panned toward the honker. */
  honk(pan: number): void {
    this.blip(392, 0.18, "square", 0.12, undefined, pan);
    this.blip(494, 0.18, "square", 0.12, undefined, pan);
  }

  /** Falling whoosh for a near miss, panned toward the passed car. */
  nearMiss(pan = 0): void {
    this.noiseHit(0.22, 1200, 0.1, "bandpass", 1.5, pan);
    this.blip(1500, 0.2, "sine", 0.08, 700, pan);
  }

  /** Rising two-blip when the drift charge arms. */
  driftArm(): void {
    this.blip(660, 0.08, "sine", 0.12);
    window.setTimeout(() => this.blip(990, 0.08, "sine", 0.12), 70);
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
    this.duck(0.4, 250);
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
    this.duck(0.1, 900);
    this.noiseHit(0.4, 900, 0.1, "lowpass"); // a final skid
    [440, 349, 262].forEach((f, i) => {
      window.setTimeout(() => this.blip(f, 0.24, "triangle", 0.16), 180 + i * 150);
    });
  }

  /** Pre-round count blip. */
  countdown(): void {
    this.blip(440, 0.09, "square", 0.15);
  }

  /** "GO!" blip. */
  go(): void {
    this.blip(880, 0.22, "square", 0.18);
  }

  /** Dry click for boost-with-empty-meter. */
  denied(): void {
    this.blip(180, 0.05, "square", 0.08);
  }

  // ── Music: 138 BPM procedural loop via lookahead scheduler ──────────────

  startMusic(): void {
    this.musicOn = true;
    this.startMusicScheduler();
  }

  stopMusic(): void {
    this.musicOn = false;
    if (this.musicTimer !== null) {
      window.clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  private startMusicScheduler(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicOn || this.musicTimer !== null) return;
    this.nextNoteTime = ctx.currentTime + 0.05;
    this.musicStep = 0;
    this.musicTimer = window.setInterval(() => this.scheduleMusic(), 25);
  }

  /** Books every 8th-note falling within the next ~100ms. */
  private scheduleMusic(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    // After a stall (tab hidden, long GC) skip the backlog instead of firing
    // every missed note at once.
    if (this.nextNoteTime < ctx.currentTime - 0.2) {
      this.nextNoteTime = ctx.currentTime + 0.05;
    }
    while (this.nextNoteTime < ctx.currentTime + 0.1) {
      const t = this.nextNoteTime;
      const step = this.musicStep % BASS_RIFF.length;
      if (step % 2 === 0) this.kickAt(t);
      if (Math.random() > 0.2) this.hatAt(t); // ~20% random skips
      const note = BASS_RIFF[step];
      if (note !== null && note !== undefined) this.bassAt(t, note);
      this.nextNoteTime += EIGHTH;
      this.musicStep++;
    }
  }

  /** Kick: sine with a 140→45Hz pitch drop. */
  private kickAt(t: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.26, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + 0.26);
  }

  /** Hat: 30ms of noise through a highpass at 8kHz. */
  private hatAt(t: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 8000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.05, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    src.connect(hp);
    hp.connect(g);
    g.connect(bus);
    src.start(t, Math.random());
    src.stop(t + 0.05);
  }

  /** Bass: square riff note through a 380Hz lowpass. */
  private bassAt(t: number, freq: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(freq, t);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.08, t + 0.01);
    g.gain.setValueAtTime(0.08, t + 0.14);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(lp);
    lp.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + 0.22);
  }

  /** Dip the music bus to `to`×base for `ms`, then recover. */
  private duck(to: number, ms: number): void {
    const ctx = this.ctx;
    const bus = this.musicBus;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setTargetAtTime(MUSIC_LEVEL * to, t, 0.02);
    bus.gain.setTargetAtTime(MUSIC_LEVEL, t + ms / 1000, 0.15);
  }
}
