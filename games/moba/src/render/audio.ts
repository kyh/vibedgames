// Procedural WebAudio. SFX are short synth phrases (plus an optional recorded
// foley accent per hero); the score is a step grid driven by sim time, so a
// paused or muted stretch never queues catch-up beats.

import { ScoreClock } from "./score";
import { abilityFoley, abilityNotes } from "./ability-sound";
import type { FoleyKey, SynthTone, SynthNoise } from "./ability-sound";
import type { ScoreNote, SoundscapeFrame } from "./score";

const SOUND_KEY = "moba:sound";
const MASTER_GAIN = 0.32;
const VOICE_LIMIT = 32;
// Ordinary SFX leave eight voices for the player's own feedback (local hits,
// casts, level-ups, victory), which must never be crowded out by a teamfight.
const ROUTINE_LIMIT = 24;
const MUSIC_LIMIT = 6;
const AMBIENCE_LIMIT = 2;
const FOLEY_FILES: readonly [FoleyKey, string][] = [
  ["buckler", "audio/foley/buckler.ogg"],
  ["blade", "audio/foley/blade.ogg"],
  ["bowstring", "audio/foley/bowstring.ogg"],
  ["fire", "audio/foley/fire.ogg"],
  ["mechanism", "audio/foley/mechanism.ogg"],
  ["potion", "audio/foley/potion.ogg"],
];

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
    // Blocked store just loses persistence — never the run.
  }
}

interface Bus {
  context: AudioContext;
  master: GainNode;
}
type BedKind = "music" | "ambience";
interface Phrase {
  kind: "sfx" | BedKind;
  essential: boolean;
  voices: Set<Voice>;
}
interface Voice {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  phrase: Phrase;
}
interface Sample {
  kind: "sample";
  buffer: AudioBuffer;
  gain: number;
  at: number;
  dur: number;
}
type Note = SynthTone | SynthNoise | ScoreNote | Sample;
interface Reaction {
  important?: boolean;
  gain?: number;
}
interface Throttle {
  key: string;
  minMs: number;
}

let bus: Bus | null = null;
let contextTransition: Promise<void> | null = null;
let paused = false;
// Muted by default; sound is opt-in ("1") and the choice persists.
let muted = storageGet(SOUND_KEY) !== "1";
const voices = new Set<Voice>();
const phrases: Phrase[] = [];
const noiseBufs = new Map<number, AudioBuffer>();
const foleyBufs = new Map<FoleyKey, AudioBuffer>();
const lastAt = new Map<string, number>();
const scoreClock = new ScoreClock();
const bedBuses = new Map<BedKind, GainNode>();

const blocked = (): boolean => muted || paused;

function setMaster(): void {
  if (!bus) {
    return;
  }
  const t = bus.context.currentTime;
  bus.master.gain.cancelScheduledValues(t);
  bus.master.gain.setValueAtTime(blocked() ? 0 : MASTER_GAIN, t);
}

/** One resume/suspend in flight at a time; a pause/mute that lands mid-flight
 *  is reconciled when the transition settles. */
function reconcileContext(): void {
  if (!bus || contextTransition) {
    return;
  }
  const ctx = bus.context;
  const shouldRun = !blocked();
  if (ctx.state === (shouldRun ? "running" : "suspended")) {
    return;
  }
  const operation = shouldRun ? ctx.resume() : ctx.suspend();
  contextTransition = operation;
  const finish = (): void => {
    contextTransition = null;
    if (shouldRun !== !blocked()) {
      reconcileContext();
    }
  };
  void operation.then(finish, finish);
}

// Accents are optional: until (or unless) a sample lands, the synth phrase plays alone.
function loadFoley(context: AudioContext): void {
  for (const [key, file] of FOLEY_FILES) {
    void fetch(file)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(response)))
      .then((bytes) => context.decodeAudioData(bytes))
      .then((buffer) => foleyBufs.set(key, buffer))
      .catch(() => {});
  }
}

function audio(): Bus | null {
  if (blocked()) {
    return null;
  }
  if (!bus) {
    const Ctor = window.AudioContext;
    if (!Ctor) {
      return null;
    }
    const context = new Ctor();
    const master = context.createGain();
    master.gain.value = MASTER_GAIN;
    master.connect(context.destination);
    bus = { context, master };
    loadFoley(context);
  }
  reconcileContext();
  // Never queue notes behind the autoplay gate or an in-flight transition.
  return bus.context.state === "running" && !contextTransition ? bus : null;
}

function release(voice: Voice, stop: boolean): void {
  if (!voices.delete(voice)) {
    return;
  }
  voice.phrase.voices.delete(voice);
  if (voice.phrase.voices.size === 0) {
    const i = phrases.indexOf(voice.phrase);
    if (i !== -1) {
      phrases.splice(i, 1);
    }
  }
  if (stop) {
    voice.source.stop();
  }
  voice.source.disconnect();
  for (const node of voice.nodes) {
    node.disconnect();
  }
}

function stopPhrase(phrase: Phrase): void {
  for (const voice of phrase.voices) {
    release(voice, true);
  }
}

function stopBackground(kind?: BedKind): void {
  for (const voice of voices) {
    if (voice.phrase.kind !== "sfx" && (!kind || voice.phrase.kind === kind)) release(voice, true);
  }
}

function stopAll(): void {
  for (const voice of voices) {
    release(voice, true);
  }
  const now = bus?.context.currentTime ?? 0;
  for (const gain of bedBuses.values()) {
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(1, now);
  }
}

function applyIntent(): void {
  setMaster();
  if (blocked()) {
    stopAll();
  }
  reconcileContext();
}

export function resumeAudio(): void {
  audio();
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(next: boolean): void {
  muted = next;
  storageSet(SOUND_KEY, muted ? "0" : "1");
  applyIntent();
}

export function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}

/** Session-only mute override: never persists, so the player's saved opt-in
 *  survives. Trailer mode uses this to unmute for its run. */
export function setMutedTransient(next: boolean): void {
  muted = next;
  applyIntent();
}

export function setSoundPaused(next: boolean): void {
  paused = next;
  applyIntent();
}

/** Match/shot boundary: drop pending notes and gates; keep the user's intent. */
export function resetSound(): void {
  stopAll();
  lastAt.clear();
  scoreClock.reset();
}

const tone = (
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
  at = 0,
): SynthTone => ({ at, dur, freq, gain, kind: "tone", slideTo, type });
const noise = (
  dur: number,
  gain: number,
  frequency: number,
  at = 0,
  filter: BiquadFilterType = "lowpass",
): SynthNoise => ({ at, dur, filter, frequency, gain, kind: "noise" });

// Decaying white noise is indistinguishable between calls: cache one buffer per
// duration and replay it through a fresh (cheap) BufferSource each time.
function noiseBuffer(ctx: AudioContext, dur: number): AudioBuffer {
  const cached = noiseBufs.get(dur);
  if (cached) {
    return cached;
  }
  const n = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  }
  noiseBufs.set(dur, buffer);
  return buffer;
}

function play(
  notes: readonly Note[],
  { important = false, gain = 1 }: Reaction = {},
  throttle?: Throttle,
): void {
  const level = Math.max(0, Math.min(1, gain));
  if (level === 0 || notes.length === 0) {
    return;
  }
  const target = audio();
  if (!target) {
    return;
  }
  // The player's own reaction is gated separately so a busy fight can't swallow it.
  const gate = throttle && (important ? `${throttle.key}:local` : throttle.key);
  const now = performance.now();
  if (throttle && gate && (lastAt.get(gate) ?? -Infinity) + throttle.minMs > now) {
    return;
  }
  // Background beds yield first; important sounds may then bump the oldest
  // ordinary phrase, but nothing evicts another important sound.
  const limit = important ? VOICE_LIMIT : ROUTINE_LIMIT;
  while (voices.size + notes.length > limit) {
    const victim =
      phrases.find((p) => p.kind === "ambience") ??
      phrases.find((p) => p.kind === "music") ??
      (important ? phrases.find((p) => !p.essential) : undefined);
    if (!victim) {
      return;
    }
    stopPhrase(victim);
  }
  if (gate) {
    lastAt.set(gate, now);
  }
  const phrase: Phrase = { essential: important, kind: "sfx", voices: new Set() };
  phrases.push(phrase);
  const t = target.context.currentTime;
  if (important) {
    // Duck the beds under the player's own feedback.
    for (const [kind, bed] of bedBuses) {
      bed.gain.cancelScheduledValues(t);
      bed.gain.setValueAtTime(bed.gain.value, t);
      bed.gain.linearRampToValueAtTime(kind === "music" ? 0.4 : 0.15, t + 0.015);
      bed.gain.linearRampToValueAtTime(1, t + 0.28);
    }
  }
  for (const note of notes) {
    schedule(target, phrase, note, t, level);
  }
}

function bedDestination(target: Bus, kind: BedKind): GainNode {
  const existing = bedBuses.get(kind);
  if (existing) {
    return existing;
  }
  const gain = target.context.createGain();
  gain.connect(target.master);
  bedBuses.set(kind, gain);
  return gain;
}

function playBed(target: Bus, kind: BedKind, notes: readonly ScoreNote[]): void {
  if (notes.length === 0) {
    return;
  }
  let category = 0;
  for (const voice of voices) {
    if (voice.phrase.kind === kind) category++;
  }
  const limit = kind === "music" ? MUSIC_LIMIT : AMBIENCE_LIMIT;
  if (category + notes.length > limit || voices.size + notes.length > ROUTINE_LIMIT) {
    return;
  }
  const phrase: Phrase = { essential: false, kind, voices: new Set() };
  phrases.push(phrase);
  const now = target.context.currentTime + 0.015;
  for (const note of notes) {
    schedule(target, phrase, note, now, 1);
  }
}

/** Call once per frame after the frame's SFX, with accepted simulation time.
 *  Muted or paused frames only advance the cursor — no old music waits for unlock. */
export function updateSoundscape(frame: SoundscapeFrame): void {
  const previous = scoreClock.mode;
  const previousStep = scoreClock.step;
  const rewound = scoreClock.isRewind(frame.time);
  if (frame.kind === "silent" || frame.kind === "ended") {
    scoreClock.observe(frame, false);
    stopBackground();
    return;
  }
  const target = audio();
  const step = scoreClock.observe(frame, target !== null);
  if (
    scoreClock.mode === "silent" ||
    rewound ||
    (step && (step.step < previousStep || step.step > previousStep + 2))
  ) {
    stopBackground();
  }
  if (scoreClock.mode !== "quiet") {
    stopBackground("ambience");
  }
  if (scoreClock.mode === "fallen" && previous !== "fallen") {
    stopBackground("music");
  }
  if (!step || !target) {
    return;
  }
  playBed(target, "music", step.music);
  playBed(target, "ambience", step.ambience);
}

function schedule(target: Bus, phrase: Phrase, note: Note, now: number, level: number): void {
  const { context: ctx, master } = target;
  const t = now + note.at;
  const gain = ctx.createGain();
  const nodes: AudioNode[] = [gain];
  let source: AudioScheduledSourceNode;
  if (note.kind === "tone") {
    const osc = ctx.createOscillator();
    osc.type = note.type;
    osc.frequency.setValueAtTime(note.freq, t);
    if (note.slideTo) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, note.slideTo), t + note.dur);
    }
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(note.gain * level, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
    osc.connect(gain);
    source = osc;
  } else if (note.kind === "noise") {
    const bufferSource = ctx.createBufferSource();
    bufferSource.buffer = noiseBuffer(ctx, note.dur);
    const filter = ctx.createBiquadFilter();
    filter.type = note.filter;
    filter.frequency.value = note.frequency;
    if (note.attack === undefined) {
      gain.gain.value = note.gain * level;
    } else {
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.linearRampToValueAtTime(note.gain * level, t + note.attack);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
    }
    bufferSource.connect(filter).connect(gain);
    nodes.push(filter);
    source = bufferSource;
  } else if (note.kind === "sample") {
    const bufferSource = ctx.createBufferSource();
    bufferSource.buffer = note.buffer;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(note.gain * level, t + 0.002);
    gain.gain.setValueAtTime(note.gain * level, t + Math.max(0.002, note.dur - 0.02));
    gain.gain.linearRampToValueAtTime(0, t + note.dur);
    bufferSource.connect(gain);
    source = bufferSource;
  } else {
    const filter = ctx.createBiquadFilter();
    filter.type = note.kind === "score-tone" ? "lowpass" : note.filter;
    filter.frequency.value = note.kind === "score-tone" ? note.cutoff : note.frequency;
    filter.Q.value = 0.7;
    nodes.push(filter);
    if (note.kind === "score-tone") {
      const osc = ctx.createOscillator();
      osc.type = note.wave;
      osc.frequency.setValueAtTime(note.freq, t);
      if (note.endFreq) {
        osc.frequency.exponentialRampToValueAtTime(note.endFreq, t + note.dur);
      }
      osc.connect(filter);
      source = osc;
    } else {
      const bufferSource = ctx.createBufferSource();
      bufferSource.buffer = noiseBuffer(ctx, note.dur);
      bufferSource.connect(filter);
      source = bufferSource;
    }
    filter.connect(gain);
    const attack = Math.min(note.attack, note.dur * 0.4);
    const releaseAt = Math.max(attack, note.dur - note.release);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(note.gain * level, t + attack);
    gain.gain.setValueAtTime(note.gain * level, t + releaseAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + note.dur);
  }
  gain.connect(phrase.kind === "sfx" ? master : bedDestination(target, phrase.kind));
  const voice: Voice = { nodes, phrase, source };
  voices.add(voice);
  phrase.voices.add(voice);
  source.addEventListener("ended", () => release(voice, false), { once: true });
  source.start(t);
  if (note.kind === "tone" || note.kind === "score-tone") {
    source.stop(t + note.dur + 0.02);
  }
}

export const sfx = {
  ability(effect = "", gain = 1, local = false): void {
    const notes: Note[] = [...abilityNotes(effect)];
    const accent = abilityFoley(effect);
    const buffer = accent ? foleyBufs.get(accent.key) : undefined;
    const first = notes[0];
    // The recorded accent replaces the first synth voice rather than doubling it.
    if (buffer && accent && first)
      notes[0] = { kind: "sample", buffer, gain: accent.gain, at: first.at, dur: buffer.duration };
    play(notes, { gain, important: local }, { key: `ability:${effect}`, minMs: 90 });
  },
  death(reaction: Reaction = {}): void {
    play([tone(330, 0.2, "square", 0.06, 110)], reaction, { key: "death", minMs: 90 });
  },
  explosion(reaction: Reaction = {}): void {
    play([noise(0.28, 0.16, 700), tone(120, 0.3, "sine", 0.1, 50)], reaction, {
      key: "explosion",
      minMs: 110,
    });
  },
  gold(): void {
    play([tone(1200, 0.06, "square", 0.04)], {}, { key: "gold", minMs: 120 });
  },
  hit(reaction: Reaction = {}): void {
    play([noise(0.06, 0.07, 1400)], reaction, { key: "hit", minMs: 60 });
  },
  level(): void {
    play([tone(660, 0.12, "triangle", 0.12), tone(990, 0.16, "triangle", 0.12, undefined, 0.09)], {
      important: true,
    });
  },
  structureDown(): void {
    play([noise(0.5, 0.22, 500), tone(90, 0.5, "sine", 0.14, 40)], { important: true });
  },
  victory(win: boolean): void {
    play(
      (win ? [523, 659, 784, 1047] : [392, 330, 262]).map((freq, i) =>
        tone(freq, 0.3, "triangle", 0.16, undefined, i * 0.16),
      ),
      { important: true },
    );
  },
};

export function soundDiagnostics() {
  return {
    context: bus?.context.state ?? "uncreated",
    muted,
    paused,
    score: { mode: scoreClock.mode, step: scoreClock.step },
    voices: voices.size,
  };
}
