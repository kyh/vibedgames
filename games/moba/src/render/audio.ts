// Procedural WebAudio. Complete phrases own every active/future source; the
// authoritative score grid never queues missed beats or uses wall-time timers.

import { ScoreClock } from "./score";
import type { ScoreNote, SoundscapeFrame } from "./score";

const SOUND_KEY = "moba:sound";
const VOICE_LIMIT = 32;
const ROUTINE_LIMIT = 24;
const MASTER_GAIN = 0.32;
const MUSIC_LIMIT = 6;
const AMBIENCE_LIMIT = 2;

// Blocked storage loses persistence, never the current sound preference.
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
    // Embeds can deny storage while still allowing audio.
  }
}

type Bus = { context: AudioContext; master: GainNode };
type BedKind = "music" | "ambience";
type Phrase = { voices: Set<Voice> } & (
  | { kind: "sfx"; essential: boolean }
  | { kind: BedKind; essential: false }
);
type Voice = {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  startsAt: number;
  phrase: Phrase;
  onEnded: () => void;
};
type Tone = {
  kind: "tone";
  freq: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  slideTo?: number;
  at: number;
};
type Noise = {
  kind: "noise";
  dur: number;
  gain: number;
  filter: BiquadFilterType;
  frequency: number;
  at: number;
};
type Note = Tone | Noise | ScoreNote;
type Reaction = { important?: boolean; gain?: number };
type Throttle = { key: string; minMs: number };

let bus: Bus | null = null;
let contextTransition: Promise<void> | null = null;
let hasRun = false;
let paused = false;
let disposed = false;
// Muted by default; returning players can retain their explicit opt-in.
let muted = storageGet(SOUND_KEY) !== "1";
const voices = new Set<Voice>();
const phrases: Phrase[] = [];
const noiseBufs = new Map<number, AudioBuffer>();
const lastAt = new Map<string, number>();
const scoreClock = new ScoreClock();
const bedBuses = new Map<BedKind, GainNode>();
let acceptedSources = 0;
let droppedSources = 0;
let stoppedSources = 0;
let endedSources = 0;
let peakSources = 0;

const blocked = (): boolean => muted || paused || disposed;

function setMaster(): void {
  if (!bus) return;
  const t = bus.context.currentTime;
  bus.master.gain.cancelScheduledValues(t);
  bus.master.gain.setValueAtTime(blocked() ? 0 : MASTER_GAIN, t);
}

/** A pending resume can finish after a newer pause/mute. Only reconcile that
 * intent change; a rejected/interrupted device must not spin unlock retries. */
function reconcileContext(): void {
  if (!bus || disposed || bus.context.state === "closed") return;
  setMaster();
  if (contextTransition) return;
  const ctx = bus.context;
  const shouldRun = !blocked();
  if (ctx.state === (shouldRun ? "running" : "suspended")) {
    if (shouldRun) hasRun = true;
    return;
  }
  // An early scene SFX must not park a pre-gesture resume promise ahead of the
  // real gesture. Once unlocked, programmatic wrapper resumes are permitted.
  if (shouldRun && !hasRun && window.navigator?.userActivation?.isActive === false) return;
  const operation = shouldRun ? ctx.resume() : ctx.suspend();
  contextTransition = operation;
  const finish = (): void => {
    contextTransition = null;
    if (disposed) return;
    if (ctx.state === "running") hasRun = true;
    if (shouldRun !== !blocked()) reconcileContext();
  };
  void operation.then(finish, finish);
}

function audio(): Bus | null {
  if (blocked()) return null;
  if (!bus) {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    try {
      const context = new Ctor();
      const master = context.createGain();
      master.gain.value = MASTER_GAIN;
      master.connect(context.destination);
      bus = { context, master };
    } catch {
      return null;
    }
  }
  reconcileContext();
  // Never queue notes behind an autoplay gate or an asynchronous transition.
  return bus.context.state === "running" && !contextTransition ? bus : null;
}

function release(voice: Voice, reason: "ended" | "stopped"): void {
  if (!voices.delete(voice)) return;
  voice.phrase.voices.delete(voice);
  if (voice.phrase.voices.size === 0) {
    const i = phrases.indexOf(voice.phrase);
    if (i >= 0) phrases.splice(i, 1);
  }
  voice.source.removeEventListener("ended", voice.onEnded);
  if (reason === "stopped") {
    stoppedSources++;
    voice.source.stop();
  } else endedSources++;
  voice.source.disconnect();
  for (const node of voice.nodes) node.disconnect();
}

function stopPhrase(phrase: Phrase): void {
  for (const voice of phrase.voices) release(voice, "stopped");
}

function stopVoices(): void {
  for (const voice of voices) release(voice, "stopped");
}

function stopBackground(kind?: BedKind): void {
  for (const voice of voices)
    if (voice.phrase.kind !== "sfx" && (!kind || voice.phrase.kind === kind))
      release(voice, "stopped");
}

function resetBedMix(): void {
  const now = bus?.context.currentTime ?? 0;
  for (const gain of bedBuses.values()) {
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(1, now);
  }
}

function applyIntent(): void {
  setMaster();
  if (blocked()) {
    stopVoices();
    resetBedMix();
  }
  // A mute/pause toggle alone does not create an unused context.
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

/** Trailer override changes only this session, never the saved opt-in. */
export function setMutedTransient(next: boolean): void {
  muted = next;
  applyIntent();
}

export function setSoundPaused(next: boolean): void {
  paused = next;
  applyIntent();
}

/** Match/shot boundary: cancel pending notes and gates; retain user intent. */
export function resetSound(): void {
  stopVoices();
  lastAt.clear();
  scoreClock.reset();
  resetBedMix();
}

/** Only final Phaser Game destruction closes the app-owned context. */
export function disposeSound(): void {
  if (disposed) return;
  disposed = true;
  setMaster();
  resetSound();
  noiseBufs.clear();
  for (const gain of bedBuses.values()) gain.disconnect();
  bedBuses.clear();
  if (bus) {
    bus.master.disconnect();
    if (bus.context.state !== "closed") void bus.context.close().catch(() => undefined);
  }
}

const tone = (
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
  at = 0,
): Tone => ({ kind: "tone", freq, dur, type, gain, slideTo, at });
const noise = (
  dur: number,
  gain: number,
  frequency: number,
  at = 0,
  filter: BiquadFilterType = "lowpass",
): Noise => ({ kind: "noise", dur, gain, frequency, at, filter });

// Same decaying white-noise buffer per duration as the original recipes.
function noiseBuffer(ctx: AudioContext, dur: number): AudioBuffer {
  const cached = noiseBufs.get(dur);
  if (cached) return cached;
  const n = Math.floor(ctx.sampleRate * dur);
  const buffer = ctx.createBuffer(1, n, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  noiseBufs.set(dur, buffer);
  return buffer;
}

function play(
  notes: readonly Note[],
  { important = false, gain = 1 }: Reaction = {},
  throttle?: Throttle,
): void {
  const level = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0;
  // Silent/distant/paused events neither allocate audio nor consume a gate.
  if (blocked() || level === 0) return;
  const target = audio();
  let routine = 0;
  for (const voice of voices) if (!voice.phrase.essential) routine++;
  if (!target || notes.length > VOICE_LIMIT) {
    droppedSources += notes.length;
    return;
  }
  let throttleKey: string | null = null;
  let throttleTime = 0;
  if (throttle) {
    // Routine activity cannot swallow the local victim's same-frame reaction.
    const key = important ? `${throttle.key}:local` : throttle.key;
    const now = performance.now();
    const previous = lastAt.get(key);
    if (previous !== undefined && previous + throttle.minMs > now) return;
    throttleKey = key;
    throttleTime = now;
  }
  // Background phrases yield first, including to ordinary accepted combat SFX.
  // They can never consume the eight-source essential reserve.
  const routineBudget = important ? VOICE_LIMIT : ROUTINE_LIMIT;
  while (voices.size + notes.length > VOICE_LIMIT || routine + notes.length > routineBudget) {
    const background =
      phrases.find((phrase) => phrase.kind === "ambience") ??
      phrases.find((phrase) => phrase.kind === "music");
    if (!background) break;
    routine -= background.voices.size;
    stopPhrase(background);
  }
  if (
    !important &&
    (routine + notes.length > ROUTINE_LIMIT || voices.size + notes.length > VOICE_LIMIT)
  ) {
    droppedSources += notes.length;
    return;
  }
  while (voices.size + notes.length > VOICE_LIMIT) {
    const oldest = phrases.find((p) => !p.essential) ?? phrases[0];
    if (!oldest) return;
    stopPhrase(oldest);
  }
  const phrase: Phrase = { kind: "sfx", essential: important, voices: new Set() };
  if (throttleKey !== null) lastAt.set(throttleKey, throttleTime);
  phrases.push(phrase);
  const now = target.context.currentTime;
  if (important) {
    for (const [kind, gain] of bedBuses) {
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(gain.gain.value, now);
      gain.gain.linearRampToValueAtTime(kind === "music" ? 0.4 : 0.15, now + 0.015);
      gain.gain.linearRampToValueAtTime(1, now + 0.28);
    }
  }
  for (const note of notes) schedule(target, phrase, note, now, level);
}

function bedDestination(target: Bus, kind: BedKind): GainNode {
  const existing = bedBuses.get(kind);
  if (existing) return existing;
  const gain = target.context.createGain();
  gain.connect(target.master);
  bedBuses.set(kind, gain);
  return gain;
}

function playBed(target: Bus, kind: BedKind, notes: readonly ScoreNote[]): void {
  if (notes.length === 0) return;
  let category = 0;
  let routine = 0;
  for (const voice of voices) {
    if (voice.phrase.kind === kind) category++;
    if (!voice.phrase.essential) routine++;
  }
  const limit = kind === "music" ? MUSIC_LIMIT : AMBIENCE_LIMIT;
  if (
    category + notes.length > limit ||
    routine + notes.length > ROUTINE_LIMIT ||
    voices.size + notes.length > VOICE_LIMIT
  ) {
    droppedSources += notes.length;
    return;
  }
  const phrase: Phrase = { kind, essential: false, voices: new Set() };
  phrases.push(phrase);
  const now = target.context.currentTime + 0.015;
  for (const note of notes) schedule(target, phrase, note, now, 1);
}

/** Call once after the frame's SFX, using accepted simulation time. Muted or
 * paused observations advance only the cursor; no old music waits for unlock. */
export function updateSoundscape(frame: SoundscapeFrame): void {
  const previous = scoreClock.mode;
  const previousStep = scoreClock.diagnostics().step;
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
  )
    stopBackground();
  if (scoreClock.mode !== "quiet") stopBackground("ambience");
  if (scoreClock.mode === "fallen" && previous !== "fallen") stopBackground("music");
  if (!step || !target) return;
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
    if (note.slideTo)
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, note.slideTo), t + note.dur);
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
    gain.gain.value = note.gain * level;
    bufferSource.connect(filter).connect(gain);
    nodes.push(filter);
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
      if (note.endFreq) osc.frequency.exponentialRampToValueAtTime(note.endFreq, t + note.dur);
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
  const voice: Voice = {
    source,
    nodes,
    startsAt: t,
    phrase,
    onEnded: () => release(voice, "ended"),
  };
  voices.add(voice);
  phrase.voices.add(voice);
  acceptedSources++;
  peakSources = Math.max(peakSources, voices.size);
  source.addEventListener("ended", voice.onEnded, { once: true });
  source.start(t);
  if (note.kind === "tone" || note.kind === "score-tone") source.stop(t + note.dur + 0.02);
}

/** Only accepted cast IDs choose a family. Unknown IDs retain the old phrase. */
function abilityNotes(effect: string): readonly Note[] {
  switch (effect.split(":")[0]) {
    case "ironvow":
      return [
        noise(0.045, 0.055, 2400, 0, "highpass"),
        tone(720, 0.12, "triangle", 0.05, 520, 0.025),
      ];
    case "duskblade":
      return [noise(0.12, 0.055, 1800), tone(260, 0.16, "sine", 0.045, 90)];
    case "stormcaller":
      return [
        tone(880, 0.075, "square", 0.035, 1320),
        tone(1320, 0.1, "triangle", 0.055, undefined, 0.045),
      ];
    case "emberhex":
      return [noise(0.16, 0.07, 1100), tone(220, 0.18, "sawtooth", 0.045, 100)];
    case "boomtinker":
      return [
        tone(1450, 0.025, "square", 0.028),
        noise(0.07, 0.07, 2600, 0.03, "bandpass"),
        tone(150, 0.11, "sine", 0.045, 75, 0.03),
      ];
    case "brewkeeper":
      return [tone(360, 0.1, "sine", 0.06, 600), tone(600, 0.13, "sine", 0.045, 420, 0.065)];
    default:
      return [tone(440, 0.18, "sawtooth", 0.06, 880)];
  }
}

export const sfx = {
  hit(reaction: Reaction = {}): void {
    play([noise(0.06, 0.07, 1400)], reaction, { key: "hit", minMs: 60 });
  },
  ability(effect = "", gain = 1): void {
    play(abilityNotes(effect), { gain }, { key: "ability", minMs: 90 });
  },
  explosion(reaction: Reaction = {}): void {
    play([noise(0.28, 0.16, 700), tone(120, 0.3, "sine", 0.1, 50)], reaction, {
      key: "explosion",
      minMs: 110,
    });
  },
  level(): void {
    play([tone(660, 0.12, "triangle", 0.12), tone(990, 0.16, "triangle", 0.12, undefined, 0.09)], {
      important: true,
    });
  },
  structureDown(): void {
    play([noise(0.5, 0.22, 500), tone(90, 0.5, "sine", 0.14, 40)], { important: true });
  },
  death(reaction: Reaction = {}): void {
    play([tone(330, 0.2, "square", 0.06, 110)], reaction, { key: "death", minMs: 90 });
  },
  gold(): void {
    play([tone(1200, 0.06, "square", 0.04)], {}, { key: "gold", minMs: 120 });
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

/** Counts owned resources (future notes included), not physical audibility. */
export function soundDiagnostics() {
  const now = bus?.context.currentTime ?? 0;
  let scheduledSources = 0;
  let routineSources = 0;
  let musicSources = 0;
  let ambienceSources = 0;
  for (const voice of voices) {
    if (voice.startsAt > now) scheduledSources++;
    if (!voice.phrase.essential) routineSources++;
    if (voice.phrase.kind === "music") musicSources++;
    if (voice.phrase.kind === "ambience") ambienceSources++;
  }
  return Object.freeze({
    context: bus?.context.state ?? "uncreated",
    muted,
    paused,
    disposed,
    // Raw AudioParam reading; it may retain the last render value while suspended.
    masterGain: bus?.master.gain.value ?? 0,
    contextTransition: contextTransition !== null,
    ownedSources: voices.size,
    scheduledSources,
    routineSources,
    musicSources,
    ambienceSources,
    musicLimit: MUSIC_LIMIT,
    ambienceLimit: AMBIENCE_LIMIT,
    score: scoreClock.diagnostics(),
    essentialSources: voices.size - routineSources,
    phrases: phrases.length,
    noiseBuffers: noiseBufs.size,
    throttleGates: lastAt.size,
    limit: VOICE_LIMIT,
    routineLimit: ROUTINE_LIMIT,
    acceptedSources,
    droppedSources,
    stoppedSources,
    endedSources,
    peakSources,
  });
}
