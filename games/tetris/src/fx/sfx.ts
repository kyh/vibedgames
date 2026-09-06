// Procedural WebAudio blips — no assets. Muted by default; sound is opt-in
// via toggleMute() (the M key), which persists the choice and unlocks the
// lazy AudioContext from that user gesture. Pitch jittered ±8% per play.
// Adapted from pong's blip factory; the sound set is Tetris verbs.

const SOUND_KEY = "tetris:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). Sound prefs just fall back to the muted default.
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
    // Blocked store just loses persistence — never the session.
  }
}

// Muted by default; returning players who opted into sound stay unmuted.
let muted = storageGet(SOUND_KEY) !== "1";
let paused = false;
const VOICE_LIMIT = 24;
const ROUTINE_LIMIT = 16;

type AudioBus = { context: AudioContext; master: GainNode };
type Phrase = { essential: boolean; voices: Set<Voice> };
type Voice = {
  source: OscillatorNode;
  gain: GainNode;
  startsAt: number;
  phrase: Phrase;
  onEnded: () => void;
};

let bus: AudioBus | null = null;
let contextTransition: Promise<void> | null = null;
const voices = new Set<Voice>();
const phrases: Phrase[] = [];
// Lifetime ownership counters: resetSound cancels a run, not this diagnostic history.
let acceptedSources = 0;
let droppedSources = 0;
let stoppedSources = 0;
let endedSources = 0;
let peakSources = 0;

const blocked = (): boolean => muted || paused;

function setMaster(): void {
  if (!bus) return;
  bus.master.gain.cancelScheduledValues(bus.context.currentTime);
  bus.master.gain.setValueAtTime(blocked() ? 0 : 1, bus.context.currentTime);
}

/** One pending context operation. Its completion obeys the latest pause/mute
 * intent; rejected unlocks wait for the next gesture, never spin a retry loop. */
function reconcileContext(): void {
  if (!bus || bus.context.state === "closed") return;
  setMaster();
  if (contextTransition) return;
  const ac = bus.context;
  const shouldRun = !blocked();
  if (ac.state === (shouldRun ? "running" : "suspended")) return;
  const operation = shouldRun ? ac.resume() : ac.suspend();
  contextTransition = operation;
  void operation.then(
    () => {
      contextTransition = null;
      // Successful operations can race a newer intent. Reconcile only that
      // change; an interrupted device must not cause unbounded resume retries.
      if (shouldRun !== !blocked()) reconcileContext();
      return undefined;
    },
    () => {
      contextTransition = null;
      if (shouldRun !== !blocked()) reconcileContext();
      return undefined;
    },
  );
}

function audio(): AudioBus | null {
  if (blocked()) return null;
  if (!bus && "AudioContext" in window) {
    try {
      const context = new AudioContext();
      const master = context.createGain();
      master.gain.value = 1;
      master.connect(context.destination);
      bus = { context, master };
    } catch {
      // Audio may be unavailable in an embed; input/gameplay still proceeds.
      return null;
    }
  }
  reconcileContext();
  // Never accumulate notes behind a locked or pending context operation.
  return bus?.context.state === "running" && !contextTransition ? bus : null;
}

function release(voice: Voice, reason: "stopped" | "ended"): void {
  if (!voices.delete(voice)) return;
  voice.phrase.voices.delete(voice);
  if (voice.phrase.voices.size === 0) {
    const index = phrases.indexOf(voice.phrase);
    if (index >= 0) phrases.splice(index, 1);
  }
  voice.source.removeEventListener("ended", voice.onEnded);
  if (reason === "stopped") {
    stoppedSources++;
    voice.source.stop();
  } else endedSources++;
  voice.source.disconnect();
  voice.gain.disconnect();
}

function stopPhrase(phrase: Phrase): void {
  for (const voice of phrase.voices) release(voice, "stopped");
}

function stopVoices(): void {
  for (const voice of voices) release(voice, "stopped");
}

export function isMuted(): boolean {
  return muted;
}

/** Set mute and persist the choice. Runs from a user gesture (the M key or the
 *  touch control), so turning sound on can create/resume the ctx. */
export function setMuted(next: boolean): void {
  muted = next;
  storageSet(SOUND_KEY, muted ? "0" : "1");
  if (blocked()) {
    setMaster();
    stopVoices();
    reconcileContext();
  } else audio();
}

/** Flip mute and return the new muted state. */
export function toggleMute(): boolean {
  setMuted(!muted);
  return muted;
}

/** Local wrapper pause is independent of the stored sound preference. */
export function setSoundPaused(next: boolean): void {
  paused = next;
  if (blocked()) {
    setMaster();
    stopVoices();
    reconcileContext();
  } else audio();
}

/** New run: cancel even future fanfare notes, retaining mute/pause intent. */
export function resetSound(): void {
  stopVoices();
  if (!blocked()) audio();
}

/** Owned WebAudio sources, including future notes; not a hardware audibility meter. */
export function soundDiagnostics() {
  const now = bus?.context.currentTime ?? 0;
  let scheduledSources = 0;
  let routineSources = 0;
  for (const voice of voices) {
    if (voice.startsAt > now) scheduledSources++;
    if (!voice.phrase.essential) routineSources++;
  }
  return Object.freeze({
    context: bus?.context.state ?? "uncreated",
    muted,
    paused,
    masterGain: bus?.master.gain.value ?? 0,
    contextTransition: contextTransition !== null,
    ownedSources: voices.size,
    scheduledSources,
    routineSources,
    essentialSources: voices.size - routineSources,
    phrases: phrases.length,
    limit: VOICE_LIMIT,
    routineLimit: ROUTINE_LIMIT,
    acceptedSources,
    droppedSources,
    stoppedSources,
    endedSources,
    peakSources,
  });
}

type Blip = {
  freq: number;
  end?: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  at?: number;
};

function play(notes: readonly Blip[], essential = false): void {
  const audioBus = audio();
  const routineCount = [...voices].filter((voice) => !voice.phrase.essential).length;
  if (
    !audioBus ||
    notes.length > VOICE_LIMIT ||
    (!essential &&
      (routineCount + notes.length > ROUTINE_LIMIT || voices.size + notes.length > VOICE_LIMIT))
  ) {
    droppedSources += notes.length;
    return;
  }
  // Essential phrases are admitted whole. Retire old routine groups before
  // another catch/clear/loss phrase; never clip the new phrase halfway through.
  while (voices.size + notes.length > VOICE_LIMIT) {
    const oldest = phrases.find((phrase) => !phrase.essential) ?? phrases[0];
    if (!oldest) return;
    stopPhrase(oldest);
  }
  const phrase: Phrase = { essential, voices: new Set() };
  phrases.push(phrase);
  const now = audioBus.context.currentTime;
  for (const note of notes) blip(audioBus, phrase, now, note);
}

function blip(
  { context: ac, master }: AudioBus,
  phrase: Phrase,
  now: number,
  { freq, end, dur, type, gain, at = 0 }: Blip,
): void {
  const t0 = now + at;
  const jitter = 0.92 + Math.random() * 0.16;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * jitter, t0);
  if (end !== undefined) osc.frequency.exponentialRampToValueAtTime(end * jitter, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(master);
  const voice: Voice = {
    source: osc,
    gain: g,
    startsAt: t0,
    phrase,
    onEnded: () => release(voice, "ended"),
  };
  voices.add(voice);
  phrase.voices.add(voice);
  acceptedSources++;
  peakSources = Math.max(peakSources, voices.size);
  osc.addEventListener("ended", voice.onEnded, { once: true });
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  move(): void {
    play([{ freq: 220, dur: 0.03, type: "square", gain: 0.04 }]);
  },
  rotate(): void {
    play([{ freq: 360, end: 460, dur: 0.05, type: "square", gain: 0.05 }]);
  },
  orbit(): void {
    play([{ freq: 180, end: 300, dur: 0.16, type: "sine", gain: 0.06 }]);
  },
  lock(): void {
    play([{ freq: 150, dur: 0.06, type: "triangle", gain: 0.08 }]);
  },
  hardDrop(): void {
    play([{ freq: 120, end: 70, dur: 0.12, type: "sawtooth", gain: 0.09 }]);
  },
  /** Pitch climbs with the number of lines cleared. */
  clear(lines: number, crossed = false): void {
    const base = 380 * 2 ** (Math.min(lines, 12) / 12);
    const notes: Blip[] = [
      { freq: base, dur: 0.1, type: "square", gain: 0.09 },
      { freq: base * 1.5, dur: 0.16, type: "square", gain: 0.08, at: 0.08 },
    ];
    if (crossed) notes.push({ freq: base * 2, dur: 0.12, type: "sine", gain: 0.04, at: 0.12 });
    play(notes, true);
  },
  power(): void {
    play(
      [
        { freq: 240, end: 480, dur: 0.12, type: "triangle", gain: 0.08 },
        { freq: 720, end: 960, dur: 0.16, type: "sine", gain: 0.07, at: 0.08 },
        { freq: 1200, dur: 0.1, type: "sine", gain: 0.04, at: 0.16 },
      ],
      true,
    );
  },
  catch(): void {
    play(
      [330, 440, 587, 784].map((freq, i): Blip => ({
        freq,
        dur: 0.12,
        type: "square",
        gain: 0.09,
        at: i * 0.07,
      })),
      true,
    );
  },
  gameOver(): void {
    play(
      [330, 262, 196, 131].map((freq, i): Blip => ({
        freq,
        dur: 0.18,
        type: "sawtooth",
        gain: 0.09,
        at: i * 0.12,
      })),
      true,
    );
  },
};
