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

export function isMuted(): boolean {
  return muted;
}

/** Flip mute, persist the choice, and return the new muted state. Runs from a
 *  user gesture (the M key), so turning sound on can create/resume the ctx. */
export function toggleMute(): boolean {
  muted = !muted;
  storageSet(SOUND_KEY, muted ? "0" : "1");
  if (!muted) audio();
  return muted;
}

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  if (ctx === null && typeof AudioContext === "function") ctx = new AudioContext();
  if (ctx !== null && ctx.state === "suspended") void ctx.resume();
  return ctx;
}

type Blip = {
  freq: number;
  end?: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  at?: number;
};

function blip({ freq, end, dur, type, gain, at = 0 }: Blip): void {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + at;
  const jitter = 0.92 + Math.random() * 0.16;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * jitter, t0);
  if (end !== undefined) osc.frequency.exponentialRampToValueAtTime(end * jitter, t0 + dur);
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  move(): void {
    blip({ freq: 220, dur: 0.03, type: "square", gain: 0.04 });
  },
  rotate(): void {
    blip({ freq: 360, end: 460, dur: 0.05, type: "square", gain: 0.05 });
  },
  orbit(): void {
    blip({ freq: 180, end: 300, dur: 0.16, type: "sine", gain: 0.06 });
  },
  lock(): void {
    blip({ freq: 150, dur: 0.06, type: "triangle", gain: 0.08 });
  },
  hardDrop(): void {
    blip({ freq: 120, end: 70, dur: 0.12, type: "sawtooth", gain: 0.09 });
  },
  /** Pitch climbs with the number of lines cleared. */
  clear(lines: number): void {
    const base = 380 * 2 ** (Math.min(lines, 12) / 12);
    blip({ freq: base, dur: 0.1, type: "square", gain: 0.09 });
    blip({ freq: base * 1.5, dur: 0.16, type: "square", gain: 0.08, at: 0.08 });
  },
  catch(): void {
    [330, 440, 587, 784].forEach((freq, i) =>
      blip({ freq, dur: 0.12, type: "square", gain: 0.09, at: i * 0.07 }),
    );
  },
  gameOver(): void {
    [330, 262, 196, 131].forEach((freq, i) =>
      blip({ freq, dur: 0.18, type: "sawtooth", gain: 0.09, at: i * 0.12 }),
    );
  },
};
