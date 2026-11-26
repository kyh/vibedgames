const SOUND_KEY = "farm:sound";
const MAX_VOICES = 32;
const ROUTINE_LIMIT = 24;
const LOCAL_LIMIT = 28;
const MUSIC_LIMIT = 6;

export type SoundPriority = "routine" | "local" | "important";

type VoiceKind = SoundPriority | "music";

interface Phrase {
  kind: VoiceKind;
  context: AudioContext;
}

interface Voice {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  phrase: Phrase;
}

interface MusicSession {
  mode: "farm" | "mine";
  step: number;
}

declare global {
  interface Window {
    /** Safari's prefixed constructor, absent everywhere else. */
    webkitAudioContext?: typeof AudioContext;
  }
}

const storageGet = (key: string) => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const storageSet = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);

    return true;
  } catch {
    return false;
  }
};

const outranks = (incoming: VoiceKind, playing: VoiceKind) =>
  (playing === "routine" && incoming !== "routine") ||
  (playing === "local" && incoming === "important");

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private paused = false;
  private readonly voices = new Set<Voice>();
  private readonly noiseBuffers = new Map<number, AudioBuffer>();
  private mutedValue = storageGet(SOUND_KEY) !== "1";

  get muted() {
    return this.mutedValue;
  }

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

  private ensure() {
    if (this.ctx) {
      return this.ctx;
    }

    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;

      if (!Ctx) {
        return null;
      }

      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted || this.paused ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }

    return this.ctx;
  }

  resume() {
    if (this.paused) {
      return;
    }

    const c = this.ensure();

    if (!c) {
      return;
    }

    if (c.state === "suspended") {
      void this.unlock(c);
    } else {
      this.syncMusic();
    }
  }

  private async unlock(c: AudioContext) {
    try {
      await c.resume();
    } catch {
      return;
    }

    if (this.ctx !== c) {
      return;
    }

    if (this.paused) {
      this.suspendContext(c);
    } else {
      this.syncMusic();
    }
  }

  setPaused(paused: boolean) {
    if (this.paused === paused) {
      return;
    }

    this.paused = paused;
    this.syncMaster();

    if (paused) {
      this.cancelMusicTick();
      this.stopVoices();

      if (this.ctx) {
        this.suspendContext(this.ctx);
      }
    } else if (this.ctx) {
      this.resume();
    }
  }

  private suspendContext(c: AudioContext) {
    if (c.state === "closed") {
      return;
    }

    void this.suspend(c);
  }

  private async suspend(c: AudioContext) {
    try {
      await c.suspend();
    } catch {
      return;
    }

    if (this.ctx === c && !this.paused) {
      this.resume();
    }
  }

  private syncMaster() {
    if (!this.ctx || !this.master) {
      return;
    }

    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(this.muted || this.paused ? 0 : 0.5, this.ctx.currentTime);
  }

  private admit(kind: VoiceKind, count: number) {
    const c = this.ctx;

    if (this.muted || this.paused || !c || c.state !== "running") {
      return null;
    }

    if (this.overBudget(kind, count)) {
      return null;
    }

    const victims = this.retirable(kind, count);

    if (!victims) {
      return null;
    }

    for (const voice of this.voices) {
      if (victims.has(voice.phrase)) {
        this.releaseVoice(voice, true);
      }
    }

    return { context: c, kind };
  }

  private overBudget(kind: VoiceKind, count: number) {
    return (
      (kind === "routine" && this.voices.size + count > ROUTINE_LIMIT) ||
      (kind === "music" && this.musicVoiceCount() + count > MUSIC_LIMIT)
    );
  }

  private retirable(kind: VoiceKind, count: number) {
    const limit = kind === "local" ? LOCAL_LIMIT : MAX_VOICES;
    const victims = new Set<Phrase>();
    let remaining = this.voices.size;

    for (const voice of this.voices) {
      if (remaining + count <= limit) {
        break;
      }

      const { phrase } = voice;

      if (!outranks(kind, phrase.kind) || victims.has(phrase)) {
        continue;
      }

      victims.add(phrase);

      for (const owned of this.voices) {
        if (owned.phrase === phrase) {
          remaining -= 1;
        }
      }
    }

    return remaining + count > limit ? null : victims;
  }

  private ownVoice(source: AudioScheduledSourceNode, nodes: AudioNode[], phrase: Phrase) {
    const voice = { nodes, phrase, source };
    this.voices.add(voice);
    source.addEventListener(
      "ended",
      () => {
        this.releaseVoice(voice, false);
      },
      { once: true },
    );
  }

  private releaseVoice(voice: Voice, stopped: boolean) {
    if (!this.voices.delete(voice)) {
      return;
    }

    if (stopped) {
      voice.source.stop();
    }

    for (const node of voice.nodes) {
      node.disconnect();
    }
  }

  private stopVoices(kind?: VoiceKind) {
    for (const voice of this.voices) {
      if (kind === undefined || voice.phrase.kind === kind) {
        this.releaseVoice(voice, true);
      }
    }
  }

  private musicVoiceCount() {
    let count = 0;

    for (const voice of this.voices) {
      if (voice.phrase.kind === "music") {
        count += 1;
      }
    }

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
  ) {
    const c = phrase.context;

    if (!this.master) {
      return;
    }

    const t0 = c.currentTime + (opts.delay ?? 0);
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = opts.type ?? "sine";
    osc.frequency.setValueAtTime(opts.freq, t0);

    if (opts.slideTo !== undefined && opts.slideTo !== 0) {
      osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + opts.dur);
    }

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
  ) {
    const c = phrase.context;

    if (!this.master) {
      return;
    }

    const t0 = c.currentTime + (opts.delay ?? 0);
    let buf = this.noiseBuffers.get(opts.dur);

    if (!buf) {
      const len = Math.floor(c.sampleRate * opts.dur);
      buf = c.createBuffer(1, len, c.sampleRate);
      const data = buf.getChannelData(0);

      for (let i = 0; i < len; i += 1) {
        data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }

      this.noiseBuffers.set(opts.dur, buf);
    }

    const src = c.createBufferSource();
    src.buffer = buf;
    const nodes: AudioNode[] = [src];
    let node: AudioNode = src;

    if (opts.hp !== undefined && opts.hp !== 0) {
      const f = c.createBiquadFilter();
      f.type = "highpass";
      f.frequency.value = opts.hp;
      node.connect(f);
      node = f;
      nodes.push(f);
    }

    if (opts.lp !== undefined && opts.lp !== 0) {
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

  footstep(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 1);

    if (!phrase) {
      return;
    }

    this.noise(phrase, { dur: 0.08, hp: 600, lp: 2200, vol: 0.07 });
  }
  dig(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 2);

    if (!phrase) {
      return;
    }

    this.noise(phrase, { dur: 0.22, hp: 200, lp: 1400, vol: 0.28 });
    this.tone(phrase, { dur: 0.12, freq: 150, slideTo: 80, type: "sine", vol: 0.12 });
  }
  water(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 1);

    if (!phrase) {
      return;
    }

    this.noise(phrase, { dur: 0.35, hp: 1200, lp: 6000, vol: 0.12 });
  }
  chop(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 2);

    if (!phrase) {
      return;
    }

    this.tone(phrase, { dur: 0.1, freq: 240, slideTo: 90, type: "square", vol: 0.18 });
    this.noise(phrase, { dur: 0.12, hp: 300, lp: 2000, vol: 0.18 });
  }
  mine(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 2);

    if (!phrase) {
      return;
    }

    this.tone(phrase, { dur: 0.06, freq: 520, slideTo: 200, type: "square", vol: 0.16 });
    this.noise(phrase, { dur: 0.1, hp: 1500, lp: 7000, vol: 0.2 });
  }
  plant(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 1);

    if (!phrase) {
      return;
    }

    this.tone(phrase, { dur: 0.12, freq: 380, slideTo: 560, type: "triangle", vol: 0.16 });
  }
  harvest(priority: SoundPriority = "important") {
    const phrase = this.admit(priority, 2);

    if (!phrase) {
      return;
    }

    this.tone(phrase, { dur: 0.1, freq: 523, type: "triangle", vol: 0.18 });
    this.tone(phrase, { delay: 0.08, dur: 0.14, freq: 784, type: "triangle", vol: 0.16 });
  }
  coins(priority: SoundPriority = "important") {
    const phrase = this.admit(priority, 3);

    if (!phrase) {
      return;
    }

    for (const [i, f] of [880, 1175, 1568].entries()) {
      this.tone(phrase, { delay: i * 0.06, dur: 0.12, freq: f, type: "square", vol: 0.12 });
    }
  }
  click(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 1);

    if (!phrase) {
      return;
    }

    this.tone(phrase, { dur: 0.05, freq: 660, type: "square", vol: 0.12 });
  }
  thud(priority: SoundPriority = "routine") {
    const phrase = this.admit(priority, 2);

    if (!phrase) {
      return;
    }

    this.tone(phrase, { dur: 0.2, freq: 110, slideTo: 55, type: "sine", vol: 0.22 });
    this.noise(phrase, { dur: 0.18, lp: 800, vol: 0.18 });
  }
  wake(priority: SoundPriority = "important") {
    const phrase = this.admit(priority, 4);

    if (!phrase) {
      return;
    }

    for (const [i, f] of [523, 659, 784, 1047].entries()) {
      this.tone(phrase, { delay: i * 0.1, dur: 0.28, freq: f, type: "triangle", vol: 0.14 });
    }
  }

  private music: MusicSession | null = null;
  private musicId: ReturnType<typeof setTimeout> | null = null;

  private static readonly FARM_MELODY = [523, 659, 784, 659, 880, 784, 659, 587];
  private static readonly FARM_BASS = [131, 0, 98, 0, 110, 0, 87, 0];
  private static readonly MINE_MELODY = [440, 523, 659, 0, 392, 440, 0, 330];
  private static readonly MINE_BASS = [82, 0, 0, 0, 73, 0, 0, 0];

  startMusic(mode: "farm" | "mine") {
    this.stopMusic();
    const session = { mode, step: 0 };
    this.music = session;
    this.syncMusic();

    return () => {
      if (this.music === session) {
        this.stopMusic();
      }
    };
  }

  stopMusic() {
    this.cancelMusicTick();
    this.music = null;
    this.stopVoices("music");
  }

  private cancelMusicTick() {
    if (this.musicId !== null) {
      clearTimeout(this.musicId);
    }

    this.musicId = null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    storageSet(SOUND_KEY, muted ? "0" : "1");
  }

  toggleMute() {
    this.setMuted(!this.muted);

    return this.muted;
  }

  private syncMusic() {
    if (this.musicId === null && this.music) {
      this.musicTick(this.music);
    }
  }

  private musicTick(session: MusicSession) {
    if (this.music !== session || this.muted || this.paused || this.ctx?.state !== "running") {
      return;
    }

    const stepDur = session.mode === "mine" ? 0.62 : 0.46;
    const mel = session.mode === "mine" ? SoundEngine.MINE_MELODY : SoundEngine.FARM_MELODY;
    const bass = session.mode === "mine" ? SoundEngine.MINE_BASS : SoundEngine.FARM_BASS;
    const s = session.step % mel.length;
    const note = mel[s];
    const b = bass[s];
    const phrase = this.admit("music", Number(Boolean(note)) + Number(Boolean(b)));

    if (phrase) {
      if (note !== undefined && note !== 0) {
        this.musicNote(phrase, note, session.mode === "mine" ? 0.05 : 0.06, stepDur * 1.6);
      }

      if (b !== undefined && b !== 0) {
        this.musicNote(phrase, b, 0.05, stepDur * 2.2, "triangle");
      }
    }

    session.step += 1;
    this.musicId = setTimeout(() => {
      if (this.music !== session) {
        return;
      }

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
  ) {
    const c = phrase.context;

    if (!this.master) {
      return;
    }

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
