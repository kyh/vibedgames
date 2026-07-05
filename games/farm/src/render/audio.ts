// Tiny zero-asset sound engine. All SFX are synthesized with the Web Audio API
// so the game ships no audio files. Context is created lazily and resumed on the
// first user gesture (autoplay policy).

const SOUND_KEY = "farm:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). The game must boot and run without persistence.
function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the sound toggle.
  }
}

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  // Muted by default; returning players who opted into sound stay unmuted.
  muted = storageGet(SOUND_KEY) !== "1";

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  resume(): void {
    const c = this.ensure();
    if (c && c.state === "suspended") void c.resume();
  }

  private tone(opts: {
    freq: number;
    type?: OscillatorType;
    dur: number;
    vol?: number;
    decay?: number;
    slideTo?: number;
    delay?: number;
  }): void {
    const c = this.ensure();
    if (!c || !this.master || this.muted) return;
    const t0 = c.currentTime + (opts.delay ?? 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(opts.freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + opts.dur);
    const vol = opts.vol ?? 0.3;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  private noise(opts: {
    dur: number;
    vol?: number;
    hp?: number;
    lp?: number;
    delay?: number;
  }): void {
    const c = this.ensure();
    if (!c || !this.master || this.muted) return;
    const t0 = c.currentTime + (opts.delay ?? 0);
    const len = Math.floor(c.sampleRate * opts.dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    let node: AudioNode = src;
    if (opts.hp) {
      const f = c.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = opts.hp;
      node.connect(f);
      node = f;
    }
    if (opts.lp) {
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = opts.lp;
      node.connect(f);
      node = f;
    }
    const g = c.createGain();
    g.gain.value = opts.vol ?? 0.3;
    node.connect(g).connect(this.master);
    src.start(t0);
  }

  // ---- named sfx ----
  footstep(): void {
    this.noise({ dur: 0.08, vol: 0.07, hp: 600, lp: 2200 });
  }
  dig(): void {
    this.noise({ dur: 0.22, vol: 0.28, hp: 200, lp: 1400 });
    this.tone({ freq: 150, type: "sine", dur: 0.12, vol: 0.12, slideTo: 80 });
  }
  water(): void {
    this.noise({ dur: 0.35, vol: 0.12, hp: 1200, lp: 6000 });
  }
  chop(): void {
    this.tone({ freq: 240, type: "square", dur: 0.1, vol: 0.18, slideTo: 90 });
    this.noise({ dur: 0.12, vol: 0.18, hp: 300, lp: 2000 });
  }
  mine(): void {
    this.tone({ freq: 520, type: "square", dur: 0.06, vol: 0.16, slideTo: 200 });
    this.noise({ dur: 0.1, vol: 0.2, hp: 1500, lp: 7000 });
  }
  plant(): void {
    this.tone({ freq: 380, type: "triangle", dur: 0.12, vol: 0.16, slideTo: 560 });
  }
  harvest(): void {
    this.tone({ freq: 523, type: "triangle", dur: 0.1, vol: 0.18 });
    this.tone({ freq: 784, type: "triangle", dur: 0.14, vol: 0.16, delay: 0.08 });
  }
  coins(): void {
    [880, 1175, 1568].forEach((f, i) =>
      this.tone({ freq: f, type: "square", dur: 0.12, vol: 0.12, delay: i * 0.06 }),
    );
  }
  click(): void {
    this.tone({ freq: 660, type: "square", dur: 0.05, vol: 0.12 });
  }
  thud(): void {
    this.tone({ freq: 110, type: "sine", dur: 0.2, vol: 0.22, slideTo: 55 });
    this.noise({ dur: 0.18, vol: 0.18, lp: 800 });
  }
  wake(): void {
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone({ freq: f, type: "triangle", dur: 0.28, vol: 0.14, delay: i * 0.1 }),
    );
  }

  // ---- ambient music (procedural, looping) ----
  private musicMode: "farm" | "mine" | null = null;
  private musicId: ReturnType<typeof setTimeout> | null = null;
  private musicStep = 0;

  private static FARM_MELODY = [523, 659, 784, 659, 880, 784, 659, 587];
  private static FARM_BASS = [131, 0, 98, 0, 110, 0, 87, 0];
  private static MINE_MELODY = [440, 523, 659, 0, 392, 440, 0, 330];
  private static MINE_BASS = [82, 0, 0, 0, 73, 0, 0, 0];

  startMusic(mode: "farm" | "mine"): void {
    if (this.musicMode === mode && this.musicId) return;
    this.musicMode = mode;
    this.musicStep = 0;
    if (!this.musicId) this.musicTick();
  }

  stopMusic(): void {
    if (this.musicId) clearTimeout(this.musicId);
    this.musicId = null;
    this.musicMode = null;
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    storageSet(SOUND_KEY, this.muted ? "0" : "1");
    return this.muted;
  }

  private musicTick(): void {
    const c = this.ensure();
    const stepDur = this.musicMode === "mine" ? 0.62 : 0.46;
    if (c && c.state === "running" && !this.muted && this.musicMode) {
      const mel = this.musicMode === "mine" ? SoundEngine.MINE_MELODY : SoundEngine.FARM_MELODY;
      const bass = this.musicMode === "mine" ? SoundEngine.MINE_BASS : SoundEngine.FARM_BASS;
      const s = this.musicStep % mel.length;
      const note = mel[s];
      if (note) this.musicNote(note, this.musicMode === "mine" ? 0.05 : 0.06, stepDur * 1.6);
      const b = bass[s];
      if (b) this.musicNote(b, 0.05, stepDur * 2.2, "triangle");
      this.musicStep++;
    }
    this.musicId = setTimeout(() => this.musicTick(), stepDur * 1000);
  }

  private musicNote(freq: number, vol: number, dur: number, type: OscillatorType = "sine"): void {
    const c = this.ensure();
    if (!c || !this.master || this.muted) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

export const Sound = new SoundEngine();
