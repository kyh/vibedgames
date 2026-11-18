const SOUND_KEY = "pong:sound";

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

let muted = storageGet(SOUND_KEY) !== "1";
let paused = false;
let ctx: AudioContext | null = null;

export const isMuted = () => muted;

const audio = () => {
  if (muted || paused) {
    return null;
  }

  if (ctx === null && "AudioContext" in window) {
    ctx = new AudioContext();
  }

  if (ctx === null || ctx.state === "running") {
    return ctx;
  }

  if (ctx.state === "suspended") {
    void ctx.resume();
  }

  return null;
};

/** Create/resume the context from a user gesture, so a fist or pad serve that
 *  follows (neither is a browser activation) still sounds. */
export const resumeSound = () => {
  audio();
};

/** Set mute and persist the choice. Runs from the M key or the touch cluster's
 *  button, so creating/resuming the context on unmute satisfies autoplay rules
 *  even when no sound has played yet. */
export const setMuted = (next: boolean) => {
  muted = next;
  storageSet(SOUND_KEY, muted ? "0" : "1");

  if (!muted) {
    resumeSound();
  }
};

/** Follow a platform that owns the sound switch (YouTube Playables), without
 *  persisting it: the platform's setting is the player's choice there. */
export const followSystemAudio = (enabled: boolean) => {
  muted = !enabled;

  if (!muted) {
    resumeSound();
  }
};

/** A live match keeps running behind the wrapper's pause overlay; it should not blip. */
export const setSoundPaused = (next: boolean) => {
  paused = next;
};

interface Blip {
  freq: number;
  end?: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  at?: number;
}

const blip = ({ freq, end, dur, type, gain, at = 0 }: Blip) => {
  const ac = audio();

  if (!ac) {
    return;
  }

  const t0 = ac.currentTime + at;
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
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
};

export const sfx = {
  /** Pitch climbs ~one octave over a long rally — audible speed ramp. */
  paddleHit(rallyHits: number) {
    const freq = 280 * 2 ** (Math.min(rallyHits, 14) / 14);
    blip({ dur: 0.07, freq, gain: 0.09, type: "square" });
  },

  score(playerScored: boolean) {
    if (playerScored) {
      blip({ dur: 0.09, freq: 392, gain: 0.09, type: "square" });
      blip({ at: 0.09, dur: 0.14, freq: 523, gain: 0.09, type: "square" });
    } else {
      blip({ dur: 0.3, end: 60, freq: 180, gain: 0.1, type: "sawtooth" });
    }
  },

  serve() {
    blip({ dur: 0.06, freq: 440, gain: 0.07, type: "sine" });
  },

  wall() {
    blip({ dur: 0.045, freq: 170, gain: 0.07, type: "triangle" });
  },

  win(playerWon: boolean) {
    const notes = playerWon ? [440, 554, 659, 880] : [330, 262, 220, 165];

    for (const [i, freq] of notes.entries()) {
      blip({ at: i * 0.11, dur: 0.12, freq, gain: 0.09, type: "square" });
    }
  },
};
