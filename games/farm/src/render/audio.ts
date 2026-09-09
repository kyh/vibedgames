// Tiny zero-asset sound engine. All SFX are synthesized with the Web Audio API
// so the game ships no audio files. Context is created lazily and resumed on the
// first user gesture (autoplay policy).

const SOUND_KEY = "farm:sound";
const MAX_VOICES = 32;
const ROUTINE_LIMIT = 24;
const LOCAL_LIMIT = 28;
const MUSIC_LIMIT = 6;

export type SoundPriority = "routine" | "local" | "important";
type VoiceKind = SoundPriority | "music";
type Phrase = { kind: VoiceKind; context: AudioContext };
type Voice = { source: AudioScheduledSourceNode; nodes: AudioNode[]; phrase: Phrase };
type MusicSession = { mode: "farm" | "mine"; step: number };

declare global {
  interface Window {
    /** Safari's prefixed constructor, absent everywhere else. */
    webkitAudioContext?: typeof AudioContext;
  }
}

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
  private paused = false;
  private readonly voices = new Set<Voice>();
  private readonly noiseBuffers = new Map<number, AudioBuffer>();
  // Muted by default; returning players who opted into sound stay unmuted.
  private mutedValue = storageGet(SOUND_KEY) !== "1";

  get muted(): boolean {
    return this.mutedValue;
  }

  /** Direct assignment is transient: trailer playback never writes preferences. */
  set muted(next: boolean) {
    this.mutedValue = next;
    this.syncMaster();
    if (next) {
      this.cancelMusicTick();
      this.stopVoices();
    } else {
      this.resume();
    }
  }

  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted || this.paused ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  resume(): void {
    if (this.paused) return;
    const c = this.ensure();
    if (!c) return;
    if (c.state === "suspended") {
      void c.resume().then(
        () => {
          if (this.ctx !== c) return undefined;
          // A pause may have arrived while the browser was unlocking audio.
          if (this.paused) this.suspendContext(c);
          else this.syncMusic();
          return undefined;
        },
        () => {},
      );
    } else {
      this.syncMusic();
    }
  }

  /** Local presentation only; online simulation keeps its existing policy. */
  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.syncMaster();
    if (paused) {
      this.cancelMusicTick();
      this.stopVoices();
      if (this.ctx) this.suspendContext(this.ctx);
    } else if (this.ctx) {
      this.resume();
    }
  }

  private suspendContext(c: AudioContext): void {
    if (c.state === "closed") return;
    void c.suspend().then(
      () => {
        // A quick resume can precede completion of the older suspend request.
        if (this.ctx === c && !this.paused) this.resume();
        return undefined;
      },
      () => {},
    );
  }

  private syncMaster(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(this.muted || this.paused ? 0 : 0.5, this.ctx.currentTime);
  }

  /** Never queue locked-context sounds to replay on a later gesture. */
  private admit(kind: VoiceKind, count: number): Phrase | null {
    const c = this.ctx;
    if (this.muted || this.paused || !c || c.state !== "running") return null;
    if (
      (kind === "routine" && this.voices.size + count > ROUTINE_LIMIT) ||
      (kind === "music" && this.musicVoiceCount() + count > MUSIC_LIMIT)
    )
      return null;
    const limit = kind === "local" ? LOCAL_LIMIT : MAX_VOICES;
    const victims = new Set<Phrase>();
    let remaining = this.voices.size;
    // Reserve the entire cue before retiring anything. Music never cuts a
    // personal cue; progression can retire lower-priority phrases as a unit.
    for (const voice of this.voices) {
      if (remaining + count <= limit) break;
      const phrase = voice.phrase;
      const lower =
        (phrase.kind === "routine" && kind !== "routine") ||
        (phrase.kind === "local" && kind === "important");
      if (!lower || victims.has(phrase)) continue;
      victims.add(phrase);
      for (const owned of this.voices) {
        if (owned.phrase === phrase) remaining--;
      }
    }
    if (remaining + count > limit) return null;
    for (const voice of this.voices) {
      if (victims.has(voice.phrase)) this.releaseVoice(voice, true);
    }
    return { kind, context: c };
  }

  private ownVoice(source: AudioScheduledSourceNode, nodes: AudioNode[], phrase: Phrase): void {
    const voice = { source, nodes, phrase };
    this.voices.add(voice);
    source.addEventListener("ended", () => this.releaseVoice(voice, false), { once: true });
  }

  private releaseVoice(voice: Voice, stopped: boolean): void {
    if (!this.voices.delete(voice)) return;
    if (stopped) voice.source.stop();
    for (const node of voice.nodes) node.disconnect();
  }

  private stopVoices(kind?: VoiceKind): void {
    for (const voice of this.voices) {
      if (kind === undefined || voice.phrase.kind === kind) this.releaseVoice(voice, true);
    }
  }

  private musicVoiceCount(): number {
    let count = 0;
    for (const voice of this.voices) if (voice.phrase.kind === "music") count++;
    return count;
  }

  private tone(
    phrase: Phrase,
    opts: {
      freq: number;
      type?: OscillatorType;
      dur: number;
      vol?: number;
      decay?: number;
      slideTo?: number;
      delay?: number;
    },
  ): void {
    const c = phrase.context;
    if (!this.master) return;
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
    this.ownVoice(osc, [osc, g], phrase);
    osc.start(t0);
    osc.stop(t0 + opts.dur + 0.02);
  }

  private noise(
    phrase: Phrase,
    opts: {
      dur: number;
      vol?: number;
      hp?: number;
      lp?: number;
      delay?: number;
    },
  ): void {
    const c = phrase.context;
    if (!this.master) return;
    const t0 = c.currentTime + (opts.delay ?? 0);
    let buf = this.noiseBuffers.get(opts.dur);
    if (!buf) {
      const len = Math.floor(c.sampleRate * opts.dur);
      buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      this.noiseBuffers.set(opts.dur, buf);
    }
    const src = c.createBufferSource();
    src.buffer = buf;
    const nodes: AudioNode[] = [src];
    let node: AudioNode = src;
    if (opts.hp) {
      const f = c.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = opts.hp;
      node.connect(f);
      node = f;
      nodes.push(f);
    }
    if (opts.lp) {
      const f = c.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = opts.lp;
      node.connect(f);
      node = f;
      nodes.push(f);
    }
    const g = c.createGain();
    g.gain.value = opts.vol ?? 0.3;
    node.connect(g).connect(this.master);
    nodes.push(g);
    this.ownVoice(src, nodes, phrase);
    src.start(t0);
  }

  // ---- named sfx ----
  footstep(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 1);
    if (!phrase) return;
    this.noise(phrase, { dur: 0.08, vol: 0.07, hp: 600, lp: 2200 });
  }
  dig(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 2);
    if (!phrase) return;
    this.noise(phrase, { dur: 0.22, vol: 0.28, hp: 200, lp: 1400 });
    this.tone(phrase, { freq: 150, type: "sine", dur: 0.12, vol: 0.12, slideTo: 80 });
  }
  water(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 1);
    if (!phrase) return;
    this.noise(phrase, { dur: 0.35, vol: 0.12, hp: 1200, lp: 6000 });
  }
  chop(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 2);
    if (!phrase) return;
    this.tone(phrase, { freq: 240, type: "square", dur: 0.1, vol: 0.18, slideTo: 90 });
    this.noise(phrase, { dur: 0.12, vol: 0.18, hp: 300, lp: 2000 });
  }
  mine(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 2);
    if (!phrase) return;
    this.tone(phrase, { freq: 520, type: "square", dur: 0.06, vol: 0.16, slideTo: 200 });
    this.noise(phrase, { dur: 0.1, vol: 0.2, hp: 1500, lp: 7000 });
  }
  plant(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 1);
    if (!phrase) return;
    this.tone(phrase, { freq: 380, type: "triangle", dur: 0.12, vol: 0.16, slideTo: 560 });
  }
  harvest(priority: SoundPriority = "important"): void {
    const phrase = this.admit(priority, 2);
    if (!phrase) return;
    this.tone(phrase, { freq: 523, type: "triangle", dur: 0.1, vol: 0.18 });
    this.tone(phrase, { freq: 784, type: "triangle", dur: 0.14, vol: 0.16, delay: 0.08 });
  }
  coins(priority: SoundPriority = "important"): void {
    const phrase = this.admit(priority, 3);
    if (!phrase) return;
    [880, 1175, 1568].forEach((f, i) =>
      this.tone(phrase, {
        freq: f,
        type: "square",
        dur: 0.12,
        vol: 0.12,
        delay: i * 0.06,
      }),
    );
  }
  click(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 1);
    if (!phrase) return;
    this.tone(phrase, { freq: 660, type: "square", dur: 0.05, vol: 0.12 });
  }
  thud(priority: SoundPriority = "routine"): void {
    const phrase = this.admit(priority, 2);
    if (!phrase) return;
    this.tone(phrase, { freq: 110, type: "sine", dur: 0.2, vol: 0.22, slideTo: 55 });
    this.noise(phrase, { dur: 0.18, vol: 0.18, lp: 800 });
  }
  wake(priority: SoundPriority = "important"): void {
    const phrase = this.admit(priority, 4);
    if (!phrase) return;
    [523, 659, 784, 1047].forEach((f, i) =>
      this.tone(phrase, {
        freq: f,
        type: "triangle",
        dur: 0.28,
        vol: 0.14,
        delay: i * 0.1,
      }),
    );
  }

  // ---- ambient music (procedural, looping) ----
  private music: MusicSession | null = null;
  private musicId: ReturnType<typeof setTimeout> | null = null;

  private static FARM_MELODY = [523, 659, 784, 659, 880, 784, 659, 587];
  private static FARM_BASS = [131, 0, 98, 0, 110, 0, 87, 0];
  private static MINE_MELODY = [440, 523, 659, 0, 392, 440, 0, 330];
  private static MINE_BASS = [82, 0, 0, 0, 73, 0, 0, 0];

  /** A late shutdown from a previous scene cannot stop a newer music owner. */
  startMusic(mode: "farm" | "mine"): () => void {
    this.stopMusic();
    const session = { mode, step: 0 };
    this.music = session;
    this.syncMusic();
    return () => {
      if (this.music === session) this.stopMusic();
    };
  }

  stopMusic(): void {
    this.cancelMusicTick();
    this.music = null;
    this.stopVoices("music");
  }

  private cancelMusicTick(): void {
    if (this.musicId !== null) clearTimeout(this.musicId);
    this.musicId = null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    storageSet(SOUND_KEY, muted ? "0" : "1");
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private syncMusic(): void {
    if (this.musicId === null && this.music) this.musicTick(this.music);
  }

  private musicTick(session: MusicSession): void {
    if (this.music !== session || this.muted || this.paused || this.ctx?.state !== "running")
      return;
    const stepDur = session.mode === "mine" ? 0.62 : 0.46;
    const mel = session.mode === "mine" ? SoundEngine.MINE_MELODY : SoundEngine.FARM_MELODY;
    const bass = session.mode === "mine" ? SoundEngine.MINE_BASS : SoundEngine.FARM_BASS;
    const s = session.step % mel.length;
    const note = mel[s];
    const b = bass[s];
    const phrase = this.admit("music", Number(Boolean(note)) + Number(Boolean(b)));
    if (phrase) {
      if (note) this.musicNote(phrase, note, session.mode === "mine" ? 0.05 : 0.06, stepDur * 1.6);
      if (b) this.musicNote(phrase, b, 0.05, stepDur * 2.2, "triangle");
    }
    session.step++;
    this.musicId = setTimeout(() => {
      if (this.music !== session) return;
      this.musicId = null;
      this.musicTick(session);
    }, stepDur * 1000);
  }

  private musicNote(
    phrase: Phrase,
    freq: number,
    vol: number,
    dur: number,
    type: OscillatorType = "sine",
  ): void {
    const c = phrase.context;
    if (!this.master) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master);
    this.ownVoice(osc, [osc, g], phrase);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }
}

export const Sound = new SoundEngine();
