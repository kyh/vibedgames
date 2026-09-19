// Short procedural arcade sounds on one WebAudio graph. Nothing plays before a
// user gesture; mute and pause silence every live voice rather than queue cues.
import { RoundScore, scoreNotes } from "./round-score";
import type { RoundScoreMode } from "./round-score";

export type { RoundScoreMode } from "./round-score";

const STORAGE_KEY = "bomberman:sound";
const VOICE_LIMIT = 20;
const BACKGROUND_LIMIT = 2;

export type BlastSound = Readonly<{ strength: number; pan: number }>;
export type RoundOutcome = "won" | "lost" | "draw";
/** Buses: the result phrase ducks routine/personal cues; the score bed is its own lane. */
type Role = "background" | "routine" | "personal" | "result";
interface Graph {
  context: AudioContext;
  master: GainNode;
  buses: Record<Role, GainNode>;
  noise: AudioBuffer | null;
}
interface Voice {
  source: AudioScheduledSourceNode;
  nodes: AudioNode[];
  role: Role;
}

const RESULT_NOTES: Record<RoundOutcome, readonly number[]> = {
  draw: [392, 440, 392],
  lost: [330, 260, 196],
  won: [440, 550, 660],
};

const readSoundPreference = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "1";
  } catch {
    return true;
  }
};

let muted = readSoundPreference();
let paused = false;
let graph: Graph | null = null;
let lastBlast = -Infinity;
let outcome: RoundOutcome | null = null;
let scoreMode: RoundScoreMode = "silent";
const score = new RoundScore();
const voices = new Set<Voice>();

const release = (voice: Voice): void => {
  if (!voices.delete(voice)) {
    return;
  }
  // Every source has its end scheduled at creation and a second stop() throws,
  // so a forced release only unplugs it: silent at once, reaped on schedule.
  voice.source.disconnect();
  for (const node of voice.nodes) {
    node.disconnect();
  }
};

/** Stop every voice and clear bus automation (ducking) so nothing leaks past a mute/pause/reset. */
const silence = (): void => {
  for (const voice of voices) {
    release(voice);
  }
  score.reset();
  if (!graph) {
    return;
  }
  const at = graph.context.currentTime;
  graph.master.gain.cancelScheduledValues(at);
  graph.master.gain.setValueAtTime(muted || paused ? 0 : 1, at);
  for (const bus of Object.values(graph.buses)) {
    bus.gain.cancelScheduledValues(at);
    bus.gain.setValueAtTime(1, at);
  }
};

const createGraph = (): Graph | null => {
  try {
    const context = new AudioContext();
    const master = context.createGain();
    master.connect(context.destination);
    const buses = {
      background: context.createGain(),
      personal: context.createGain(),
      result: context.createGain(),
      routine: context.createGain(),
    };
    for (const bus of Object.values(buses)) {
      bus.connect(master);
    }
    return { buses, context, master, noise: null };
  } catch {
    return null;
  }
};

// Browsers hold a pre-activation resume() until the next gesture, which is the behaviour we want.
const resume = async (context: AudioContext): Promise<void> => {
  try {
    await context.resume();
  } catch {
    // The next gesture retries.
  }
};

const syncContext = (): void => {
  if (muted || paused) {
    silence();
  }
  if (muted) {
    return;
  }
  if (!graph) {
    // Creating a context outside user activation only logs an autoplay
    // warning; the next unmute/Play tap creates it instead.
    if (window.navigator.userActivation?.isActive === false || !("AudioContext" in window)) {
      return;
    }
    graph = createGraph();
    if (!graph) {
      return;
    }
  }
  graph.master.gain.setValueAtTime(paused ? 0 : 1, graph.context.currentTime);
  if (!paused && graph.context.state === "suspended") {
    void resume(graph.context);
  }
};

export const isMuted = (): boolean => muted;

export const setMuted = (value: boolean): void => {
  muted = value;
  try {
    localStorage.setItem(STORAGE_KEY, value ? "0" : "1");
  } catch {
    /* Optional persistence. */
  }
  syncContext();
};

export const pauseAudio = (value: boolean): void => {
  paused = value;
  syncContext();
};

/** Gesture entry point (Play): creates the context while activation is fresh. */
export const unlockAudio = (): void => {
  syncContext();
};

export const resetRoundAudio = (): void => {
  silence();
  scoreMode = "silent";
  lastBlast = -Infinity;
  outcome = null;
};

const own = (source: AudioScheduledSourceNode, nodes: AudioNode[], role: Role): void => {
  const voice: Voice = { nodes, role, source };
  voices.add(voice);
  source.addEventListener("ended", () => release(voice), { once: true });
};

const ready = (): Graph | null =>
  !muted && !paused && graph?.context.state === "running" ? graph : null;

/** Reserve a whole phrase before creating nodes. Personal and result cues
 * outrank ambience: they evict the oldest expendable voices to fit. */
const admit = (size: number, role: Role): Graph | null => {
  const current = ready();
  if (!current) {
    return null;
  }
  if (role === "background") {
    let background = 0;
    for (const voice of voices) {
      if (voice.role === "background") {
        background += 1;
      }
    }
    if (background + size > BACKGROUND_LIMIT) {
      return null;
    }
  }
  if (voices.size + size > VOICE_LIMIT) {
    if (role === "background" || role === "routine") {
      return null;
    }
    for (const voice of voices) {
      if (voices.size + size <= VOICE_LIMIT) {
        break;
      }
      if (voice.role !== "result") {
        release(voice);
      }
    }
    if (voices.size + size > VOICE_LIMIT) {
      return null;
    }
  }
  return current;
};

const stopBackground = (): void => {
  for (const voice of voices) {
    if (voice.role === "background") {
      release(voice);
    }
  }
};

const route = (
  current: Graph,
  gain: GainNode,
  nodes: AudioNode[],
  pan: number,
  role: Role,
): void => {
  const bus = current.buses[role];
  if (pan === 0) {
    gain.connect(bus);
    return;
  }
  const panner = current.context.createStereoPanner();
  panner.pan.value = pan;
  nodes.push(panner);
  gain.connect(panner).connect(bus);
};

const tone = (
  current: Graph,
  role: Role,
  frequency: number,
  end: number,
  duration: number,
  volume: number,
  delay = 0,
  pan = 0,
  strength = 1,
): void => {
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
  route(current, gain, nodes, pan, role);
  own(oscillator, nodes, role);
  oscillator.start(at);
  oscillator.stop(at + duration + 0.01);
};

const rumble = (current: Graph, strength: number, pan: number): void => {
  const ac = current.context;
  if (!current.noise) {
    current.noise = ac.createBuffer(1, Math.ceil(ac.sampleRate * 0.24), ac.sampleRate);
    const data = current.noise.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) {
      data[i] = Math.random() * 2 - 1;
    }
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
  route(current, gain, nodes, pan, "routine");
  own(source, nodes, "routine");
  source.start();
  source.stop(ac.currentTime + 0.25);
};

/** The result lands before the finishing blast/death in render order, so bus
 * automation ducks cues that are already playing AND the ones admitted next. */
const duckForResult = (current: Graph): void => {
  const at = current.context.currentTime;
  for (const role of ["routine", "personal"] satisfies Role[]) {
    const { gain } = current.buses[role];
    const level = role === "routine" ? 0.22 : 0.35;
    gain.cancelScheduledValues(at);
    gain.setValueAtTime(level, at);
    gain.setValueAtTime(level, at + 0.45);
    gain.linearRampToValueAtTime(1, at + 0.9);
  }
};

export const sfx = {
  blast(spatial: BlastSound): void {
    const strength = Math.max(0, Math.min(1, spatial.strength));
    const pan = Math.max(-1, Math.min(1, spatial.pan));
    if (!ready() || strength === 0) {
      return;
    }
    // One punch per render batch; a chain still reads as one detonation.
    const now = performance.now();
    if (now - lastBlast < 65) {
      return;
    }
    lastBlast = now;
    const current = admit(2, "routine");
    if (!current) {
      return;
    }
    tone(current, "routine", 95, 35, 0.2, 0.17, 0, pan, strength);
    rumble(current, strength, pan);
  },
  death(): void {
    const current = admit(1, "personal");
    if (current) {
      tone(current, "personal", 330, 55, 0.3, 0.12);
    }
  },
  pickup(): void {
    const current = admit(2, "personal");
    if (!current) {
      return;
    }
    tone(current, "personal", 660, 850, 0.07, 0.1);
    tone(current, "personal", 990, 1320, 0.12, 0.08, 0.07);
  },
  place(local: boolean): void {
    const role: Role = local ? "personal" : "routine";
    const current = admit(1, role);
    if (current) {
      tone(current, role, 150, 75, 0.07, 0.1);
    }
  },
  win(result: RoundOutcome): void {
    if (outcome !== null) {
      return;
    }
    outcome = result;
    score.reset();
    scoreMode = "silent";
    stopBackground();
    const current = admit(3, "result");
    if (!current) {
      return;
    }
    duckForResult(current);
    for (const [index, note] of RESULT_NOTES[result].entries()) {
      tone(current, "result", note, note, 0.16, 0.09, index * 0.1);
    }
  },
};

const scoreNote = (current: Graph, frequency: number): void => {
  const ac = current.context;
  const at = ac.currentTime;
  const oscillator = ac.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, at);
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(frequency < 200 ? 600 : 1700, at);
  const gain = ac.createGain();
  const volume = (frequency < 200 ? 0.025 : 0.02) * (0.94 + Math.random() * 0.12);
  gain.gain.setValueAtTime(0.001, at);
  gain.gain.linearRampToValueAtTime(volume, at + 0.006);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.22);
  oscillator.connect(filter).connect(gain).connect(current.buses.background);
  own(oscillator, [filter, gain], "background");
  oscillator.start(at);
  oscillator.stop(at + 0.23);
};

/** Once per frame from the scene. A finished round never restarts its bed. */
export const updateRoundScore = (mode: RoundScoreMode, nowMs: number): void => {
  const next = outcome === null ? mode : "silent";
  if (next !== scoreMode) {
    stopBackground();
  }
  scoreMode = next;
  const current = ready();
  if (!current) {
    stopBackground();
    score.reset();
    return;
  }
  const frame = score.observe(next, nowMs);
  if (!frame) {
    return;
  }
  if (frame.kind === "rebase") {
    stopBackground();
    return;
  }
  const notes = scoreNotes(frame.beat);
  if (notes.length === 0) {
    return;
  }
  const admitted = admit(notes.length, "background");
  if (!admitted) {
    return;
  }
  for (const frequency of notes) {
    scoreNote(admitted, frequency);
  }
};

/** Dev-console view (`window.__bb.audio()`). */
export const audioDiagnostics = () => ({
  muted,
  outcome,
  paused,
  scoreMode,
  state: graph?.context.state ?? "locked",
  voices: voices.size,
});
