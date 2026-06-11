// Procedural WebAudio blips — no assets, matches the game's bare ink
// aesthetic. Every interaction sounds; pitch is randomized ±8% per play,
// and the paddle blip climbs with the rally so escalation is audible.
// The context is created lazily on the first call: the first sound is
// always the serve, which fires from a user gesture, so autoplay rules
// are satisfied without extra unlock plumbing.

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
