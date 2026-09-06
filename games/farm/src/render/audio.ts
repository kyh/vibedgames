// Tiny zero-asset sound engine. All SFX are synthesized with the Web Audio API
// so the game ships no audio files. Context is created lazily and resumed on the
// first user gesture (autoplay policy).

const SOUND_KEY = "farm:sound";
const MAX_VOICES = 32;
const ROUTINE_LIMIT = 24;
const MUSIC_LIMIT = 6;

type VoiceKind = "routine" | "important" | "music";
type Voice = {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  kind: VoiceKind;
  startsAt: number;
};
type MusicSession = { mode: "farm" | "mine"; step: number };

export type SoundDiagnostics = Readonly<{
  contextState: AudioContextState | "unavailable";
  muted: boolean;
  paused: boolean;
  disposed: boolean;
  masterGain: number;
  ownedVoices: number;
  scheduledVoices: number;
  musicVoices: number;
  voiceLimit: number;
  routineLimit: number;
  musicLimit: number;
  musicMode: "farm" | "mine" | null;
  schedulerCount: number;
  accepted: number;
  dropped: number;
  stopped: number;
  ended: number;
  peakOwnedVoices: number;
}>;

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
  private musicBus: GainNode | null = null;
  private paused = false;
  private disposed = false;
  private readonly voices = new Set<Voice>();
  private readonly noiseBuffers = new Map<number, AudioBuffer>();
  private accepted = 0;
  private dropped = 0;
  private stopped = 0;
  private ended = 0;
  private peakOwnedVoices = 0;
  // Muted by default; returning players who opted into sound stay unmuted.
  private mutedValue = storageGet(SOUND_KEY) !== "1";

  get muted(): boolean {
    return this.mutedValue;
  }

  /** Direct assignment is transient: trailer playback never writes preferences. */
  set muted(next: boolean) {
    if (this.disposed) return;
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
    if (this.disposed) return null;
    if (this.ctx) return this.ctx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted || this.paused ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      this.musicBus = this.ctx.createGain();
      this.musicBus.connect(this.master);
    } catch {
      this.ctx = null;
    }
    return this.ctx;
  }

  resume(): void {
    if (this.paused || this.disposed) return;
    const c = this.ensure();
    if (!c) return;
    if (c.state === "suspended") {
      void c.resume().then(
        () => {
          if (this.disposed || this.ctx !== c) return undefined;
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
    if (this.disposed || this.paused === paused) return;
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
        if (!this.disposed && this.ctx === c && !this.paused) this.resume();
        return undefined;
      },
      () => {},
    );
  }

  private syncMaster(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(
      this.disposed || this.muted || this.paused ? 0 : 0.5,
      this.ctx.currentTime,
    );
  }

  /** Never queue locked-context sounds to replay on a later gesture. */
  private admit(kind: VoiceKind): AudioContext | null {
    const c = this.ctx;
    if (this.disposed || this.muted || this.paused || !c || c.state !== "running") return null;
    if (
      (kind === "routine" && this.voices.size >= ROUTINE_LIMIT) ||
      (kind === "music" && this.musicVoiceCount() >= MUSIC_LIMIT)
    ) {
      this.dropped++;
      return null;
    }
    if (this.voices.size >= MAX_VOICES) {
      // Harvest, shipping and wake phrases can displace old tool/step noise.
      const routine = [...this.voices].find((voice) => voice.kind === "routine");
      if (kind === "routine" || !routine) {
        this.dropped++;
        return null;
      }
      this.releaseVoice(routine, true);
    }
    return c;
  }

  private ownVoice(
    source: AudioScheduledSourceNode,
    nodes: AudioNode[],
    kind: VoiceKind,
    startsAt: number,
  ): void {
    const voice = { source, nodes, kind, startsAt };
    this.voices.add(voice);
    this.accepted++;
    this.peakOwnedVoices = Math.max(this.peakOwnedVoices, this.voices.size);
    source.addEventListener("ended", () => this.releaseVoice(voice, false), { once: true });
  }

  private releaseVoice(voice: Voice, stopped: boolean): void {
    if (!this.voices.delete(voice)) return;
    if (stopped) {
      voice.source.stop();
      this.stopped++;
    } else {
      this.ended++;
    }
    for (const node of voice.nodes) node.disconnect();
  }

  private stopVoices(kind?: VoiceKind): void {
    for (const voice of this.voices) {
      if (kind === undefined || voice.kind === kind) this.releaseVoice(voice, true);
    }
  }

  private musicVoiceCount(): number {
    let count = 0;
    for (const voice of this.voices) if (voice.kind === "music") count++;
    return count;
  }

  private tone(opts: {
    freq: number;
    type?: OscillatorType;
    dur: number;
    vol?: number;
    decay?: number;
    slideTo?: number;
    delay?: number;
    important?: boolean;
  }): void {
    const kind = opts.important ? "important" : "routine";
    const c = this.admit(kind);
    if (!c || !this.master) return;
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
    this.ownVoice(osc, [osc, g], kind, t0);
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
    const c = this.admit("routine");
    if (!c || !this.master) return;
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
    this.ownVoice(src, nodes, "routine", t0);
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
    this.tone({ freq: 523, type: "triangle", dur: 0.1, vol: 0.18, important: true });
    this.tone({ freq: 784, type: "triangle", dur: 0.14, vol: 0.16, delay: 0.08, important: true });
  }
  coins(): void {
    [880, 1175, 1568].forEach((f, i) =>
      this.tone({
        freq: f,
        type: "square",
        dur: 0.12,
        vol: 0.12,
        delay: i * 0.06,
        important: true,
      }),
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
      this.tone({
        freq: f,
        type: "triangle",
        dur: 0.28,
        vol: 0.14,
        delay: i * 0.1,
        important: true,
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
    if (this.disposed) return () => {};
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
    if (this.disposed) return;
    this.muted = muted;
    storageSet(SOUND_KEY, muted ? "0" : "1");
  }

  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private syncMusic(): void {
    if (!this.disposed && this.musicId === null && this.music) this.musicTick(this.music);
  }

  private musicTick(session: MusicSession): void {
    if (
      this.disposed ||
      this.music !== session ||
      this.muted ||
      this.paused ||
      this.ctx?.state !== "running"
    )
      return;
    const stepDur = session.mode === "mine" ? 0.62 : 0.46;
    const mel = session.mode === "mine" ? SoundEngine.MINE_MELODY : SoundEngine.FARM_MELODY;
    const bass = session.mode === "mine" ? SoundEngine.MINE_BASS : SoundEngine.FARM_BASS;
    const s = session.step % mel.length;
    const note = mel[s];
    if (note) this.musicNote(note, session.mode === "mine" ? 0.05 : 0.06, stepDur * 1.6);
    const b = bass[s];
    if (b) this.musicNote(b, 0.05, stepDur * 2.2, "triangle");
    session.step++;
    this.musicId = setTimeout(() => {
      if (this.music !== session) return;
      this.musicId = null;
      this.musicTick(session);
    }, stepDur * 1000);
  }

  private musicNote(freq: number, vol: number, dur: number, type: OscillatorType = "sine"): void {
    const c = this.admit("music");
    if (!c || !this.musicBus) return;
    const t0 = c.currentTime;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.musicBus);
    this.ownVoice(osc, [osc, g], "music", t0);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** Final game owner only; ordinary scene handoff uses the music release token. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stopMusic();
    this.stopVoices();
    this.syncMaster();
    this.noiseBuffers.clear();
    this.musicBus?.disconnect();
    this.master?.disconnect();
    this.musicBus = null;
    this.master = null;
    const c = this.ctx;
    if (c && c.state !== "closed") void c.close().catch(() => {});
  }

  /** Counts owned/scheduled sources, not proof that a device is audible. */
  diagnostics(): SoundDiagnostics {
    let scheduledVoices = 0;
    const now = this.ctx?.currentTime ?? 0;
    for (const voice of this.voices) if (voice.startsAt > now) scheduledVoices++;
    return {
      contextState: this.ctx?.state ?? "unavailable",
      muted: this.muted,
      paused: this.paused,
      disposed: this.disposed,
      masterGain: this.master?.gain.value ?? 0,
      ownedVoices: this.voices.size,
      scheduledVoices,
      musicVoices: this.musicVoiceCount(),
      voiceLimit: MAX_VOICES,
      routineLimit: ROUTINE_LIMIT,
      musicLimit: MUSIC_LIMIT,
      musicMode: this.music?.mode ?? null,
      schedulerCount: this.musicId === null ? 0 : 1,
      accepted: this.accepted,
      dropped: this.dropped,
      stopped: this.stopped,
      ended: this.ended,
      peakOwnedVoices: this.peakOwnedVoices,
    };
  }
}

export const Sound = new SoundEngine();
