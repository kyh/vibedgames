// Self-contained WebAudio synth — no sound files. All SFX + a subtle neon-shrine
// music bed are generated at runtime. Unlocked on the first user gesture.
//
// Voices are bounded: every cue is a phrase of one or more scheduled sources,
// and admission retires the oldest routine (then local) phrases before a burst
// of remote-player cues can starve the local player's own hits and the music.

interface Tone {
  kind: "tone";
  freq: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  slideTo?: number;
}
interface Noise {
  kind: "noise";
  dur: number;
  gain: number;
  filt: number;
  sweepTo?: number;
}
type Note = Tone | Noise;
export type SfxPriority = "routine" | "local" | "essential";
type Kind = SfxPriority | "music";
interface Bus {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
}
interface Phrase {
  kind: Kind;
  voices: Set<Voice>;
}
interface Voice {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  startsAt: number;
  phrase: Phrase;
  onEnded: () => void;
}

const SFX_LIMIT = 26;
const ROUTINE_LIMIT = 20;
const LOCAL_LIMIT = 23;
const MUSIC_LIMIT = 6;

const tone = (
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
): Tone => ({ dur, freq, gain, kind: "tone", slideTo, type });
const noise = (dur: number, gain: number, filt: number, sweepTo?: number): Noise => ({
  dur,
  filt,
  gain,
  kind: "noise",
  sweepTo,
});

class Sfx {
  private bus: Bus | null = null;
  private transition: Promise<void> | null = null;
  private hasRun = false;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private musicGeneration = 0;
  private musicRequested = false;
  private step = 0;
  private muteIntent = false;
  private paused = false;
  private voices = new Set<Voice>();
  private phrases: Phrase[] = [];
  private noiseBuffers = new Map<number, AudioBuffer>();

  get muted(): boolean {
    return this.muteIntent;
  }

  set muted(next: boolean) {
    this.muteIntent = next;
    this.applyIntent();
  }

  private get blocked(): boolean {
    return this.muteIntent || this.paused;
  }

  private setMaster(): void {
    if (!this.bus) {
      return;
    }
    const { ctx, master } = this.bus;
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(this.blocked ? 0 : 0.5, ctx.currentTime);
  }

  private applyIntent(): void {
    this.setMaster();
    if (this.blocked) {
      this.stopMusic();
      for (const voice of this.voices) {
        this.release(voice, "stopped");
      }
      this.reconcileContext();
    } else if (this.bus || this.musicRequested) {
      this.ensure();
    }
  }

  private ensure(): Bus | null {
    if (this.blocked) {
      return null;
    }
    if (!this.bus) {
      const AC = window.AudioContext;
      if (!AC) {
        return null;
      }
      try {
        const ctx = new AC();
        const master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        const music = ctx.createGain();
        music.gain.value = 0.32;
        music.connect(master);
        this.bus = { ctx, master, music };
      } catch {
        return null; // Unavailable audio never blocks a control or scene change.
      }
    }
    this.reconcileContext();
    return this.bus.ctx.state === "running" && !this.transition ? this.bus : null;
  }

  /** A completion may follow a newer mute/pause. Reconcile only that intent
   * change; an interrupted/rejected device must not spin an unlock retry loop. */
  private reconcileContext(): void {
    if (!this.bus || this.bus.ctx.state === "closed") {
      return;
    }
    this.setMaster();
    if (this.transition) {
      return;
    }
    const { ctx } = this.bus;
    const shouldRun = !this.blocked;
    if (ctx.state === (shouldRun ? "running" : "suspended")) {
      if (shouldRun) {
        this.hasRun = true;
      }
      this.syncMusic();
      return;
    }
    // Scene create also calls unlock. Do not leave a pre-gesture resume promise
    // pending forever and then ignore the first real gesture behind that promise.
    // Once this context has run, programmatic wrapper resumes are permitted.
    if (shouldRun && !this.hasRun && window.navigator?.userActivation?.isActive === false) {
      return;
    }
    const operation = shouldRun ? ctx.resume() : ctx.suspend();
    this.transition = operation;
    this.stopMusic();
    const finish = (): void => {
      this.transition = null;
      if (ctx.state === "running") {
        this.hasRun = true;
      }
      if (shouldRun === !this.blocked) {
        this.syncMusic();
      } else {
        this.reconcileContext();
      }
    };
    void operation.then(finish, finish);
  }

  // Repeated Select/Game gestures keep the same app-owned music phase/timer.
  unlock(): void {
    this.musicRequested = true;
    this.ensure();
  }

  toggleMute(): void {
    this.muted = !this.muted;
  }

  setPaused(next: boolean): void {
    this.paused = next;
    this.applyIntent();
  }

  private release(voice: Voice, reason: "ended" | "stopped"): void {
    if (!this.voices.delete(voice)) {
      return;
    }
    voice.phrase.voices.delete(voice);
    if (voice.phrase.voices.size === 0) {
      const index = this.phrases.indexOf(voice.phrase);
      if (index !== -1) {
        this.phrases.splice(index, 1);
      }
    }
    voice.source.removeEventListener("ended", voice.onEnded);
    if (reason === "stopped") {
      voice.source.stop();
    }
    voice.source.disconnect();
    for (const node of voice.nodes) {
      node.disconnect();
    }
  }

  private stopPhrase(phrase: Phrase): void {
    for (const voice of phrase.voices) {
      this.release(voice, "stopped");
    }
  }

  private play(notes: readonly Note[], kind: Kind = "routine"): void {
    if (notes.length === 0) {
      return;
    }
    const bus = this.ensure();
    if (!bus) {
      return;
    }
    const live = { essential: 0, local: 0, music: 0, routine: 0 } satisfies Record<Kind, number>;
    for (const voice of this.voices) {
      live[voice.phrase.kind]++;
    }
    const sfxCount = live.routine + live.local + live.essential;
    const limit = kind === "music" ? MUSIC_LIMIT : kind === "local" ? LOCAL_LIMIT : SFX_LIMIT;
    const refused =
      notes.length > limit ||
      (kind === "local" && live.essential + notes.length > LOCAL_LIMIT) ||
      (kind === "routine" &&
        (live.routine + notes.length > ROUTINE_LIMIT || sfxCount + notes.length > SFX_LIMIT));
    if (refused) {
      return;
    }
    // Music and combat keep independent reserves. Local actions leave three
    // SFX voices for essential cues; admission always retires whole phrases.
    let owned = kind === "music" ? live.music : sfxCount;
    while (owned + notes.length > limit) {
      const oldest =
        kind === "music"
          ? this.phrases.find((p) => p.kind === "music")
          : (this.phrases.find((p) => p.kind === "routine") ??
            this.phrases.find((p) => p.kind === "local") ??
            (kind === "essential" ? this.phrases.find((p) => p.kind === "essential") : undefined));
      if (!oldest) {
        return;
      }
      owned -= oldest.voices.size;
      this.stopPhrase(oldest);
    }
    const phrase: Phrase = { kind, voices: new Set() };
    this.phrases.push(phrase);
    const t = bus.ctx.currentTime;
    for (const note of notes) {
      this.schedule(bus, phrase, note, t);
    }
  }

  private schedule(bus: Bus, phrase: Phrase, note: Note, t: number): void {
    const { ctx } = bus;
    const gain = ctx.createGain();
    const nodes: AudioNode[] = [gain];
    let source: AudioScheduledSourceNode;
    if (note.kind === "tone") {
      const osc = ctx.createOscillator();
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, t);
      if (note.slideTo) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(1, note.slideTo), t + note.dur);
      }
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(note.gain, t + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
      osc.connect(gain);
      source = osc;
    } else {
      const bufferSource = ctx.createBufferSource();
      let buffer = this.noiseBuffers.get(note.dur);
      if (!buffer) {
        const length = Math.floor(ctx.sampleRate * note.dur);
        buffer = ctx.createBuffer(1, length, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        this.noiseBuffers.set(note.dur, buffer);
      }
      bufferSource.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(note.filt, t);
      if (note.sweepTo) {
        filter.frequency.exponentialRampToValueAtTime(note.sweepTo, t + note.dur);
      }
      gain.gain.setValueAtTime(note.gain, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
      bufferSource.connect(filter).connect(gain);
      nodes.push(filter);
      source = bufferSource;
    }
    gain.connect(phrase.kind === "music" ? bus.music : bus.master);
    const voice: Voice = {
      nodes,
      onEnded: () => this.release(voice, "ended"),
      phrase,
      source,
      startsAt: t,
    };
    this.voices.add(voice);
    phrase.voices.add(voice);
    source.addEventListener("ended", voice.onEnded, { once: true });
    source.start(t);
    source.stop(t + note.dur + 0.02);
  }

  private r(n: number): number {
    return 1 + (Math.random() - 0.5) * n;
  }

  slash(priority: SfxPriority = "routine"): void {
    this.play([noise(0.12, 0.18, 2600 * this.r(0.2), 900)], priority);
  }
  hit(priority: SfxPriority = "routine"): void {
    this.play(
      [tone(180 * this.r(0.15), 0.1, "square", 0.16, 90), noise(0.07, 0.12, 1400)],
      priority,
    );
  }
  kill(priority: SfxPriority = "routine"): void {
    this.play([tone(140, 0.18, "square", 0.2, 60), noise(0.14, 0.16, 900, 300)], priority);
  }
  dash(priority: SfxPriority = "routine"): void {
    this.play([noise(0.18, 0.14, 700 * this.r(0.2), 2400)], priority);
  }
  jump(priority: SfxPriority = "routine"): void {
    this.play([tone(320 * this.r(0.1), 0.14, "sine", 0.12, 620)], priority);
  }
  hurt(priority: SfxPriority = "essential"): void {
    this.play([tone(300, 0.2, "sawtooth", 0.2, 90)], priority);
  }
  pickup(priority: SfxPriority = "routine"): void {
    this.play(
      [tone(660, 0.09, "triangle", 0.16, 990), tone(990, 0.12, "triangle", 0.12)],
      priority,
    );
  }
  boom(priority: SfxPriority = "routine"): void {
    this.play([tone(90, 0.4, "sine", 0.32, 38), noise(0.35, 0.24, 500, 120)], priority);
  }
  heal(priority: SfxPriority = "routine"): void {
    this.play([tone(520, 0.14, "sine", 0.14, 780), tone(780, 0.2, "sine", 0.12, 1040)], priority);
  }
  door(priority: SfxPriority = "routine"): void {
    this.play([tone(440, 0.18, "triangle", 0.12, 660)], priority);
  }
  select(priority: SfxPriority = "routine"): void {
    this.play([tone(560 * this.r(0.05), 0.07, "square", 0.1, 720)], priority);
  }
  die(priority: SfxPriority = "essential"): void {
    this.play([tone(260, 0.6, "sawtooth", 0.26, 60), noise(0.5, 0.18, 400, 100)], priority);
  }
  downed(priority: SfxPriority = "essential"): void {
    this.play([tone(220, 0.5, "sawtooth", 0.24, 55), noise(0.4, 0.16, 500, 120)], priority);
  }
  revive(priority: SfxPriority = "essential"): void {
    this.play(
      [
        tone(440, 0.12, "triangle", 0.14, 660),
        tone(660, 0.18, "triangle", 0.12, 990),
        tone(990, 0.24, "sine", 0.1, 1320),
      ],
      priority,
    );
  }
  bossRoar(priority: SfxPriority = "essential"): void {
    this.play([tone(70, 0.7, "sawtooth", 0.34, 44), noise(0.6, 0.22, 300, 90)], priority);
  }

  private stopMusic(): void {
    this.musicGeneration++;
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
    }
    this.musicTimer = null;
  }

  private syncMusic(): void {
    const ready =
      !this.blocked && this.musicRequested && this.bus?.ctx.state === "running" && !this.transition;
    if (!ready) {
      this.stopMusic();
      return;
    }
    if (this.musicTimer !== null) {
      return;
    }
    const generation = ++this.musicGeneration;
    this.musicTimer = setInterval(() => {
      if (generation === this.musicGeneration) {
        this.musicTick();
      }
    }, 200);
  }

  // Sparse pentatonic bass + soft kick — a moody neon-shrine bed.
  private musicTick(): void {
    if (!this.ensure()) {
      return;
    }
    const bass = [55, 82.4, 61.7, 73.4];
    const i = this.step % 16;
    const notes: Note[] = [];
    if (i % 4 === 0) {
      notes.push(tone(90, 0.16, "sine", 0.5, 40));
    }
    if (i % 8 === 0) {
      const root = bass[Math.floor(this.step / 8) % bass.length] ?? 55;
      notes.push(tone(root, 1.4, "triangle", 0.4), tone(root * 1.5, 1.2, "sine", 0.18));
    }
    if (i === 6 || i === 12) {
      notes.push(tone(880 * this.r(0.02), 0.12, "sine", 0.1));
    }
    this.play(notes, "music");
    this.step++;
  }
}

export const sfx = new Sfx();
