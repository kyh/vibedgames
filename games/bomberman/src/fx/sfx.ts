// Short procedural arcade sounds. Own every active/future source and its graph.
// No sound work before a user gesture; round resets retain the same context.
import { RoundScore, scoreNotes, type RoundScoreMode } from "./round-score";
export type { RoundScoreMode } from "./round-score";

const STORAGE_KEY = "bomberman:sound";
const VOICE_LIMIT = 20;
const ROUTINE_LIMIT = 14;
const PERSONAL_LIMIT = 17;
const BACKGROUND_LIMIT = 2;
export type BlastSound = Readonly<{ strength: number; pan: number }>;
export type RoundOutcome = "won" | "lost" | "draw";
type Role = "background" | "routine" | "personal" | "result";
type Phrase = { role: Role; voices: Set<Voice> };

type AudioOwner = {
  context: AudioContext;
  master: GainNode;
  buses: Record<Role, GainNode>;
  noise: AudioBuffer | null;
  transition: Promise<void> | null;
  hasRun: boolean;
};
type Voice = {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  startsAt: number;
  onEnded: () => void;
  phrase: Phrase;
};
type Admission = { owner: AudioOwner; phrase: Phrase };

let muted = readSoundPreference();
let paused = false;
let owner: AudioOwner | null = null;
let lastBlast = -Infinity;
let outcome: RoundOutcome | null = null;
let duckUntil = 0;
let scoreMode: RoundScoreMode = "silent";
let scoreSeed = 0x4b1d;
const score = new RoundScore();
const voices = new Map<AudioScheduledSourceNode, Voice>();
const phrases = new Set<Phrase>();
const events = { place: 0, blast: 0, pickup: 0, death: 0, win: 0 };
const counts = { accepted: 0, stopped: 0, ended: 0, dropped: 0, peak: 0, resets: 0, scoreBeats: 0 };

function readSoundPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
}

export function isMuted(): boolean {
  return muted;
}

function activeGesture(): boolean {
  return window.navigator?.userActivation?.isActive === true;
}

/** Explicit gesture entry point used by Play. */
export function unlockAudio(): void {
  // Older browsers without UserActivation retain the explicit gesture API.
  applyIntent(window.navigator?.userActivation?.isActive === false ? "passive" : "gesture");
}

export function setMuted(value: boolean): void {
  muted = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "0" : "1");
  } catch {
    /* Optional persistence. */
  }
  // The native sound button seals pointer events; adopt its gesture here.
  applyIntent(!value && activeGesture() ? "sound-gesture" : "passive");
}

export function pauseAudio(value: boolean): void {
  paused = value;
  applyIntent(activeGesture() ? "gesture" : "passive");
}

function applyIntent(intent: "passive" | "gesture" | "sound-gesture"): void {
  if (muted || paused) {
    stopVoices();
    score.reset();
    resetMix();
    // Unlock an empty context during the sound tap; paused recipes stay gated.
    if (muted || intent !== "sound-gesture") return;
  }
  const gesture = intent !== "passive";
  if (!owner) {
    if (!gesture || !("AudioContext" in window)) return;
    try {
      const context = new AudioContext();
      const master = context.createGain();
      master.connect(context.destination);
      const buses = {
        background: context.createGain(),
        routine: context.createGain(),
        personal: context.createGain(),
        result: context.createGain(),
      };
      for (const bus of Object.values(buses)) bus.connect(master);
      owner = { context, master, buses, noise: null, transition: null, hasRun: false };
      resetMix();
    } catch {
      return;
    }
  }
  const current = owner;
  const ac = current.context;
  current.master.gain.setValueAtTime(muted || paused ? 0 : 1, ac.currentTime);
  if (ac.state === "running") {
    current.hasRun = true;
    return;
  }
  if (ac.state !== "suspended" || current.transition || (!gesture && !current.hasRun)) return;
  const operation = ac.resume();
  current.transition = operation;
  const finish = (): void => {
    if (owner !== current) return;
    current.transition = null;
    if (ac.state === "running") current.hasRun = true;
    // No cue queue: late completion cannot replay sounds or override pause/mute.
    if (muted || paused) {
      stopVoices();
      score.reset();
      resetMix();
    }
  };
  void operation.then(finish, finish);
}

export function resetRoundAudio(): void {
  stopVoices();
  score.reset();
  scoreMode = "silent";
  scoreSeed = 0x4b1d;
  resetMix();
  lastBlast = -Infinity;
  outcome = null;
  counts.resets++;
}

export function disposeAudio(): void {
  stopVoices();
  score.reset();
  scoreMode = "silent";
  resetMix();
  const previous = owner;
  owner = null;
  lastBlast = -Infinity;
  outcome = null;
  if (!previous) return;
  previous.noise = null;
  previous.master.disconnect();
  for (const bus of Object.values(previous.buses)) bus.disconnect();
  if (previous.context.state !== "closed") void previous.context.close().catch(() => undefined);
}

function release(voice: Voice, forced: boolean): void {
  if (!voices.delete(voice.source)) return;
  voice.phrase.voices.delete(voice);
  if (voice.phrase.voices.size === 0) phrases.delete(voice.phrase);
  voice.source.removeEventListener("ended", voice.onEnded);
  if (forced) {
    voice.source.stop();
    counts.stopped++;
  } else counts.ended++;
  voice.source.disconnect();
  for (const node of voice.nodes) node.disconnect();
}

function stopVoices(): void {
  for (const voice of voices.values()) release(voice, true);
}

function own(
  source: AudioScheduledSourceNode,
  nodes: AudioNode[],
  startsAt: number,
  phrase: Phrase,
): void {
  const voice: Voice = { source, nodes, startsAt, phrase, onEnded: () => release(voice, false) };
  phrase.voices.add(voice);
  phrases.add(phrase);
  voices.set(source, voice);
  source.addEventListener("ended", voice.onEnded, { once: true });
  counts.accepted++;
  counts.peak = Math.max(counts.peak, voices.size);
}

function ready(): AudioOwner | null {
  return !muted && !paused && owner?.context.state === "running" ? owner : null;
}

/** Reserve the complete phrase before creating any nodes. Routine pressure
 * cannot consume the personal or three-note result reserve. */
function admit(size: number, role: Role): Admission | null {
  const current = ready();
  if (!current) return null;
  if (role === "background" && countRole("background") + size > BACKGROUND_LIMIT) {
    counts.dropped += size;
    return null;
  }
  const limit =
    role === "result" ? VOICE_LIMIT : role === "personal" ? PERSONAL_LIMIT : ROUTINE_LIMIT;
  if (role === "personal" || role === "result") {
    const expendable: Role[] = ["background", "routine", "personal"];
    for (const candidate of expendable) {
      for (const phrase of phrases) {
        if (voices.size + size <= limit) break;
        if (phrase.role === candidate) stopPhrase(phrase);
      }
    }
  }
  if (voices.size + size > limit) {
    counts.dropped += size;
    return null;
  }
  return { owner: current, phrase: { role, voices: new Set() } };
}

function stopPhrase(phrase: Phrase): void {
  for (const voice of phrase.voices) release(voice, true);
}

function stopBackground(): void {
  for (const phrase of phrases) if (phrase.role === "background") stopPhrase(phrase);
}

function countRole(role: Role): number {
  let total = 0;
  for (const phrase of phrases) if (phrase.role === role) total += phrase.voices.size;
  return total;
}

function route(
  ac: AudioContext,
  gain: GainNode,
  nodes: AudioNode[],
  pan: number,
  bus: GainNode,
): void {
  if (pan === 0) {
    gain.connect(bus);
    return;
  }
  const panner = ac.createStereoPanner();
  panner.pan.value = pan;
  nodes.push(panner);
  gain.connect(panner).connect(bus);
}

function tone(
  admission: Admission,
  frequency: number,
  end: number,
  duration: number,
  volume: number,
  delay = 0,
  pan = 0,
  strength = 1,
): void {
  const current = admission.owner;
  const ac = current.context;
  const oscillator = ac.createOscillator();
  oscillator.type = "triangle";
  const at = ac.currentTime + delay;
  const pitch = 0.96 + Math.random() * 0.08;
  oscillator.frequency.setValueAtTime(frequency * pitch, at);
  oscillator.frequency.exponentialRampToValueAtTime(end * pitch, at + duration);
  const gain = ac.createGain();
  gain.gain.setValueAtTime(volume * strength, at);
  gain.gain.exponentialRampToValueAtTime(0.001 * strength, at + duration);
  const nodes: AudioNode[] = [gain];
  oscillator.connect(gain);
  route(ac, gain, nodes, pan, current.buses[admission.phrase.role]);
  own(oscillator, nodes, at, admission.phrase);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.01);
}

function rumble(admission: Admission, strength: number, pan: number): void {
  const current = admission.owner;
  const ac = current.context;
  if (!current.noise) {
    current.noise = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.24), ac.sampleRate);
    const data = current.noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  const source = ac.createBufferSource();
  source.buffer = current.noise;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = 1100;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.13 * strength, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001 * strength, ac.currentTime + 0.24);
  const nodes: AudioNode[] = [filter, gain];
  source.connect(filter).connect(gain);
  route(ac, gain, nodes, pan, current.buses[admission.phrase.role]);
  own(source, nodes, ac.currentTime, admission.phrase);
  source.start();
  source.stop(ac.currentTime + 0.25);
}

export const sfx = {
  place(): void {
    events.place++;
    const admission = admit(1, "routine");
    if (admission) tone(admission, 150, 75, 0.07, 0.1);
  },
  blast(spatial: BlastSound = { strength: 1, pan: 0 }, logicalCount = 1): void {
    events.blast += Number.isSafeInteger(logicalCount) && logicalCount > 0 ? logicalCount : 1;
    const strength = Number.isFinite(spatial.strength)
      ? Math.max(0, Math.min(1, spatial.strength))
      : 1;
    const pan = Number.isFinite(spatial.pan) ? Math.max(-1, Math.min(1, spatial.pan)) : 0;
    if (!ready() || strength === 0) return;
    // One nearest representative per render batch; chains still share one punch.
    const now = performance.now();
    if (now - lastBlast < 65) return;
    lastBlast = now;
    const admission = admit(2, "routine");
    if (!admission) return;
    tone(admission, 95, 35, 0.2, 0.17, 0, pan, strength);
    rumble(admission, strength, pan);
  },
  pickup(): void {
    events.pickup++;
    const admission = admit(2, "personal");
    if (!admission) return;
    tone(admission, 660, 850, 0.07, 0.1);
    tone(admission, 990, 1320, 0.12, 0.08, 0.07);
  },
  death(): void {
    events.death++;
    const admission = admit(1, "personal");
    if (admission) tone(admission, 330, 55, 0.3, 0.12);
  },
  win(result: RoundOutcome): void {
    if (outcome !== null) return;
    outcome = result;
    events.win++;
    score.reset();
    scoreMode = "silent";
    stopBackground();
    const admission = admit(3, "result");
    if (!admission) return;
    duckResult(admission.owner);
    const notes =
      result === "won" ? [440, 550, 660] : result === "lost" ? [330, 260, 196] : [392, 440, 392];
    for (const [index, note] of notes.entries())
      tone(admission, note, note, 0.16, 0.09, index * 0.1);
  },
};

function resetMix(): void {
  duckUntil = 0;
  const current = owner;
  if (!current) return;
  const at = current.context.currentTime;
  current.master.gain.cancelScheduledValues(at);
  current.master.gain.setValueAtTime(muted || paused ? 0 : 1, at);
  for (const bus of Object.values(current.buses)) {
    bus.gain.cancelScheduledValues(at);
    bus.gain.setValueAtTime(1, at);
  }
}

/** The result arrives before the finishing blast/death in render order. Bus
 * automation therefore ducks both already playing and newly admitted cues. */
function duckResult(current: AudioOwner): void {
  const at = current.context.currentTime;
  duckUntil = at + 0.9;
  for (const role of ["routine", "personal"] satisfies Role[]) {
    const gain = current.buses[role].gain;
    const level = role === "routine" ? 0.22 : 0.35;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(level, at);
    gain.setValueAtTime(level, at + 0.45);
    gain.linearRampToValueAtTime(1, duckUntil);
  }
}

function cosmeticRandom(): number {
  scoreSeed ^= scoreSeed << 13;
  scoreSeed ^= scoreSeed >>> 17;
  scoreSeed ^= scoreSeed << 5;
  return (scoreSeed >>> 0) / 4294967296;
}

function scoreNote(admission: Admission, frequency: number): void {
  const current = admission.owner;
  const ac = current.context;
  const at = ac.currentTime;
  const oscillator = ac.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, at);
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(frequency < 200 ? 600 : 1700, at);
  const gain = ac.createGain();
  const volume = (frequency < 200 ? 0.025 : 0.02) * (0.94 + cosmeticRandom() * 0.12);
  gain.gain.setValueAtTime(0.001, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
  oscillator.connect(filter).connect(gain).connect(current.buses.background);
  own(oscillator, [filter, gain], at, admission.phrase);
  oscillator.start(at);
  oscillator.stop(at + 0.23);
}

/** Called once by the existing scene update. Local elimination only supplies
 * silent; it never resolves a loss. A completed round cannot restart its bed. */
export function updateRoundScore(mode: RoundScoreMode, nowMs: number): void {
  const next = outcome === null ? mode : "silent";
  if (next !== scoreMode) stopBackground();
  scoreMode = next;
  if (!ready()) {
    stopBackground();
    score.reset();
    return;
  }
  const frame = score.observe(next, nowMs);
  if (!frame) return;
  if (frame.kind === "rebase") {
    stopBackground();
    return;
  }
  const notes = scoreNotes(frame.beat);
  if (notes.length === 0) return;
  const admission = admit(notes.length, "background");
  if (!admission) return;
  counts.scoreBeats++;
  for (const frequency of notes) scoreNote(admission, frequency);
}

export function audioDiagnostics() {
  const now = owner?.context.currentTime ?? 0;
  let scheduledVoices = 0;
  let graphNodes = 0;
  for (const voice of voices.values()) {
    if (voice.startsAt > now) scheduledVoices++;
    graphNodes += voice.nodes.length;
  }
  return Object.freeze({
    muted,
    paused,
    state: owner?.context.state ?? "locked",
    contextTransition: owner?.transition !== null && owner !== null,
    voices: voices.size,
    scheduledVoices,
    graphNodes,
    limit: VOICE_LIMIT,
    routineLimit: ROUTINE_LIMIT,
    personalLimit: PERSONAL_LIMIT,
    backgroundLimit: BACKGROUND_LIMIT,
    backgroundVoices: countRole("background"),
    routineVoices: countRole("routine"),
    personalVoices: countRole("personal"),
    resultVoices: countRole("result"),
    phrases: phrases.size,
    mixNodes: owner ? 5 : 0,
    duckRemaining: Math.max(0, duckUntil - now),
    scoreMode,
    score: score.diagnostics(),
    schedulerCount: 0,
    outcome,
    ...counts,
    events: Object.freeze({ ...events }),
  });
}
