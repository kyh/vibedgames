// Procedural WebAudio blips — no assets, matches the game's bare ink
// aesthetic. Every interaction sounds; pitch is randomized ±8% per play,
// and the paddle blip climbs with the rally so escalation is audible.
// The context is created lazily on the first call: the first sound is
// always the serve, which fires from a user gesture, so autoplay rules
// are satisfied without extra unlock plumbing.
//
// Muted by default: sound is opt-in (M key) and the choice persists in
// localStorage, so returning players who opted in stay unmuted.

const SOUND_KEY = "pong:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). Sound then just stays muted-by-default, no persistence.
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
    // Blocked store just loses persistence — never the game.
  }
}

let muted = storageGet(SOUND_KEY) !== "1";

export function isMuted(): boolean {
  return muted;
}

/** Flip mute, persist the choice, return the new muted state. Runs from the
 *  M-key gesture, so creating/resuming the context on unmute satisfies
 *  autoplay rules even when no sound has played yet. */
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
  /** Exponential glide target; omit for a steady tone. */
  end?: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  /** Start offset in seconds (for tiny arpeggios). */
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
  serve(): void {
    blip({ freq: 440, dur: 0.06, type: "sine", gain: 0.07 });
  },

  /** Pitch climbs ~one octave over a long rally — audible speed ramp. */
  paddleHit(rallyHits: number): void {
    const freq = 280 * 2 ** (Math.min(rallyHits, 14) / 14);
    blip({ freq, dur: 0.07, type: "square", gain: 0.09 });
  },

  wall(): void {
    blip({ freq: 170, dur: 0.045, type: "triangle", gain: 0.07 });
  },

  score(playerScored: boolean): void {
    if (playerScored) {
      blip({ freq: 392, dur: 0.09, type: "square", gain: 0.09 });
      blip({ freq: 523, dur: 0.14, type: "square", gain: 0.09, at: 0.09 });
    } else {
      blip({ freq: 180, end: 60, dur: 0.3, type: "sawtooth", gain: 0.1 });
    }
  },

  win(playerWon: boolean): void {
    const notes = playerWon ? [440, 554, 659, 880] : [330, 262, 220, 165];
    notes.forEach((freq, i) => {
      blip({ freq, dur: 0.12, type: "square", gain: 0.09, at: i * 0.11 });
    });
  },
};
