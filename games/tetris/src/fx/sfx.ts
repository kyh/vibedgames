// Procedural WebAudio blips — no assets. Muted by default; sound is opt-in
// via toggleMute() (the M key), which persists the choice and unlocks the
// lazy AudioContext from that user gesture. Pitch jittered ±8% per play.
// Adapted from pong's blip factory; the sound set is Tetris verbs.

const SOUND_KEY = "tetris:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). Sound prefs just fall back to the muted default.
const storageGet = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};
const storageSet = (key: string, value: string): void => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Blocked store just loses persistence — never the session.
  }
};

// Muted by default; returning players who opted into sound stay unmuted.
let muted = storageGet(SOUND_KEY) !== "1";
let paused = false;
let ctx: AudioContext | null = null;
// Every scheduled oscillator, so a pause or a new run can cut phrases short.
const live = new Set<OscillatorNode>();

const blocked = (): boolean => muted || paused;

const ensureContext = (): AudioContext | null => {
  if (ctx === null && "AudioContext" in window) {
    ctx = new AudioContext();
  }
  return ctx;
};

const stopVoices = (): void => {
  for (const osc of live) {
    osc.stop();
  }
  live.clear();
};

/** Park the context while blocked so nothing scheduled leaks past a pause. */
const sync = (): void => {
  if (blocked()) {
    stopVoices();
    if (ctx?.state === "running") {
      void ctx.suspend();
    }
    return;
  }
  const ac = ensureContext();
  if (ac?.state === "suspended") {
    void ac.resume();
  }
};

export const isMuted = (): boolean => muted;

/** Set mute and persist the choice. Runs from a user gesture (the M key or the
 *  touch control), so turning sound on can create/resume the ctx — even while
 *  paused, so a pose-only player gets sound on resume without another gesture. */
export const setMuted = (next: boolean): void => {
  muted = next;
  storageSet(SOUND_KEY, muted ? "0" : "1");
  if (!muted) {
    ensureContext();
  }
  sync();
};

/** Flip mute and return the new muted state. */
export const toggleMute = (): boolean => {
  setMuted(!muted);
  return muted;
};

/** Wrapper pause is independent of the stored sound preference. */
export const setSoundPaused = (next: boolean): void => {
  paused = next;
  sync();
};

/** New run: cut the previous run's fanfare. */
export const resetSound = (): void => {
  stopVoices();
};

/** A running context, or null: notes scheduled against a suspended context
 *  would pile up and burst out together when it unlocks. */
const audio = (): AudioContext | null => {
  if (blocked()) {
    return null;
  }
  const ac = ensureContext();
  if (!ac) {
    return null;
  }
  if (ac.state === "suspended") {
    void ac.resume();
  }
  return ac.state === "running" ? ac : null;
};

interface Blip {
  freq: number;
  end?: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  at?: number;
}

const blip = (
  ac: AudioContext,
  now: number,
  { freq, end, dur, type, gain, at = 0 }: Blip,
): void => {
  const t0 = now + at;
  const jitter = 0.92 + Math.random() * 0.16;
  const osc = ac.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq * jitter, t0);
  if (end !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(end * jitter, t0 + dur);
  }
  const g = ac.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(g).connect(ac.destination);
  live.add(osc);
  osc.addEventListener("ended", () => live.delete(osc), { once: true });
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
};

const play = (notes: readonly Blip[]): void => {
  const ac = audio();
  if (!ac) {
    return;
  }
  const now = ac.currentTime;
  for (const note of notes) {
    blip(ac, now, note);
  }
};

export const sfx = {
  catchCollapse(): void {
    play(
      [330, 440, 587, 784].map((freq, i): Blip => ({
        at: i * 0.07,
        dur: 0.12,
        freq,
        gain: 0.09,
        type: "square",
      })),
    );
  },
  /** Pitch climbs with the number of lines cleared; a crossed clear adds a top note. */
  clear(lines: number, crossed: boolean): void {
    const base = 380 * 2 ** (Math.min(lines, 12) / 12);
    const notes: Blip[] = [
      { dur: 0.1, freq: base, gain: 0.09, type: "square" },
      { at: 0.08, dur: 0.16, freq: base * 1.5, gain: 0.08, type: "square" },
    ];
    if (crossed) {
      notes.push({ at: 0.12, dur: 0.12, freq: base * 2, gain: 0.04, type: "sine" });
    }
    play(notes);
  },
  gameOver(): void {
    play(
      [330, 262, 196, 131].map((freq, i): Blip => ({
        at: i * 0.12,
        dur: 0.18,
        freq,
        gain: 0.09,
        type: "sawtooth",
      })),
    );
  },
  hardDrop(): void {
    play([{ dur: 0.12, end: 70, freq: 120, gain: 0.09, type: "sawtooth" }]);
  },
  lock(): void {
    play([{ dur: 0.06, freq: 150, gain: 0.08, type: "triangle" }]);
  },
  move(): void {
    play([{ dur: 0.03, freq: 220, gain: 0.04, type: "square" }]);
  },
  orbit(): void {
    play([{ dur: 0.16, end: 300, freq: 180, gain: 0.06, type: "sine" }]);
  },
  power(): void {
    play([
      { dur: 0.12, end: 480, freq: 240, gain: 0.08, type: "triangle" },
      { at: 0.08, dur: 0.16, end: 960, freq: 720, gain: 0.07, type: "sine" },
      { at: 0.16, dur: 0.1, freq: 1200, gain: 0.04, type: "sine" },
    ]);
  },
  rotate(): void {
    play([{ dur: 0.05, end: 460, freq: 360, gain: 0.05, type: "square" }]);
  },
};
