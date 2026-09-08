// Procedural WebAudio blips — no assets, matches the game's bare ink
// aesthetic. Every interaction sounds; pitch is randomized ±8% per play,
// and the paddle blip climbs with the rally so escalation is audible.
// The context is created lazily. Remote contacts before a permitted gesture
// are dropped, never held on a suspended audio timeline for later playback.
//
// Muted by default: sound is opt-in (M key) and the choice persists in
// localStorage, so returning players who opted in stay unmuted.

const SOUND_KEY = "pong:sound";
const VOICE_LIMIT = 16;
const ROUTINE_LIMIT = 12;
type Priority = "routine" | "point" | "result";
type Phrase = { priority: Priority; context: AudioContext };
type Voice = { phrase: Phrase; release: () => void; startsAt: number };

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
let disposed = false;

export function isMuted(): boolean {
  return muted;
}

/** Set mute and persist the choice. Runs from the M key or the touch cluster's
 *  button, so creating/resuming the context on unmute satisfies autoplay rules
 *  even when no sound has played yet. */
export function setMuted(next: boolean): void {
  if (disposed) return;
  muted = next;
  storageSet(SOUND_KEY, muted ? "0" : "1");
  if (muted) stopVoices();
  else resumeSound();
}

let ctx: AudioContext | null = null;
let paused = false;
let hasRun = false;
let unlockBlocked = false;
let resumeAttempt: { context: AudioContext } | null = null;
const voices = new Map<OscillatorNode, Voice>();
let accepted = 0;
let dropped = 0;
let peakVoices = 0;

function stopVoices(): void {
  for (const [voice, { release }] of voices) {
    voice.stop();
    release();
  }
}

/** Stop active and scheduled notes; resuming never replays an old score fanfare. */
export function setSoundPaused(next: boolean): void {
  if (disposed) return;
  paused = next;
  if (paused) stopVoices();
}

/** Prime on an early native gesture; no sound is queued by unlocking. */
export function resumeSound(): void {
  if (disposed || muted || paused) return;
  audio(true);
}

function audio(requestedGesture = false): AudioContext | null {
  if (disposed || muted || paused) return null;
  let created = false;
  if (ctx === null && "AudioContext" in window) {
    try {
      ctx = new AudioContext();
      created = true;
    } catch {
      return null;
    }
  }
  const ac = ctx;
  if (!ac) return null;
  if (ac.state === "running") {
    hasRun = true;
    unlockBlocked = false;
    return ac;
  }
  const gesture =
    (requestedGesture || created) && window.navigator?.userActivation?.isActive !== false;
  // Never leave a pre-gesture resume promise waiting for a later activation.
  // A rejected device resume retries only on an explicit native gesture.
  if (
    ac.state === "suspended" &&
    resumeAttempt === null &&
    (gesture || (hasRun && !unlockBlocked))
  ) {
    const attempt = { context: ac };
    resumeAttempt = attempt;
    void ac.resume().then(
      () => {
        if (resumeAttempt !== attempt) return undefined;
        resumeAttempt = null;
        hasRun = ac.state === "running";
        unlockBlocked = !hasRun;
        return undefined;
      },
      () => {
        if (resumeAttempt !== attempt) return undefined;
        resumeAttempt = null;
        unlockBlocked = true;
        return undefined;
      },
    );
  }
  return null;
}

/** Final app teardown. Pending notes and context operations cannot reopen it. */
export function disposeSound(): void {
  if (disposed) return;
  disposed = true;
  resumeAttempt = null;
  stopVoices();
  if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
}

export function soundDiagnostics() {
  let scheduledVoices = 0;
  const phrases = new Set<Phrase>();
  for (const voice of voices.values()) {
    if (voice.startsAt > (ctx?.currentTime ?? 0)) scheduledVoices++;
    phrases.add(voice.phrase);
  }
  return Object.freeze({
    disposed,
    muted,
    paused,
    ownedVoices: voices.size,
    scheduledVoices,
    ownedPhrases: phrases.size,
    voiceLimit: VOICE_LIMIT,
    routineLimit: ROUTINE_LIMIT,
    resumePending: resumeAttempt !== null,
    accepted,
    dropped,
    peakVoices,
    context: ctx?.state ?? "uncreated",
  });
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

function admit(priority: Priority, count: number): Phrase | null {
  const ac = audio();
  if (!ac) return null;
  const limit = priority === "result" ? VOICE_LIMIT : ROUTINE_LIMIT;
  const victims = new Set<Phrase>();
  let remaining = voices.size;
  for (const { phrase } of voices.values()) {
    if (remaining + count <= limit) break;
    const lower =
      (phrase.priority === "routine" && priority !== "routine") ||
      (phrase.priority === "point" && priority === "result");
    if (!lower || victims.has(phrase)) continue;
    victims.add(phrase);
    for (const owned of voices.values()) if (owned.phrase === phrase) remaining--;
  }
  if (remaining + count > limit) {
    dropped += count;
    return null;
  }
  for (const [osc, voice] of voices) {
    if (!victims.has(voice.phrase)) continue;
    osc.stop();
    voice.release();
  }
  return { priority, context: ac };
}

function blip(phrase: Phrase, { freq, end, dur, type, gain, at = 0 }: Blip): void {
  const ac = phrase.context;
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
  const release = (): void => {
    if (!voices.delete(osc)) return;
    osc.removeEventListener("ended", release);
    osc.disconnect();
    g.disconnect();
  };
  voices.set(osc, { phrase, release, startsAt: t0 });
  accepted++;
  peakVoices = Math.max(peakVoices, voices.size);
  osc.addEventListener("ended", release, { once: true });
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  serve(): void {
    const phrase = admit("routine", 1);
    if (!phrase) return;
    blip(phrase, { freq: 440, dur: 0.06, type: "sine", gain: 0.07 });
  },

  /** Pitch climbs ~one octave over a long rally — audible speed ramp. */
  paddleHit(rallyHits: number): void {
    const phrase = admit("routine", 1);
    if (!phrase) return;
    const freq = 280 * 2 ** (Math.min(rallyHits, 14) / 14);
    blip(phrase, { freq, dur: 0.07, type: "square", gain: 0.09 });
  },

  wall(): void {
    const phrase = admit("routine", 1);
    if (!phrase) return;
    blip(phrase, { freq: 170, dur: 0.045, type: "triangle", gain: 0.07 });
  },

  score(playerScored: boolean): void {
    const phrase = admit("point", playerScored ? 2 : 1);
    if (!phrase) return;
    if (playerScored) {
      blip(phrase, { freq: 392, dur: 0.09, type: "square", gain: 0.09 });
      blip(phrase, { freq: 523, dur: 0.14, type: "square", gain: 0.09, at: 0.09 });
    } else {
      blip(phrase, { freq: 180, end: 60, dur: 0.3, type: "sawtooth", gain: 0.1 });
    }
  },

  win(playerWon: boolean): void {
    const phrase = admit("result", 4);
    if (!phrase) return;
    const notes = playerWon ? [440, 554, 659, 880] : [330, 262, 220, 165];
    notes.forEach((freq, i) => {
      blip(phrase, { freq, dur: 0.12, type: "square", gain: 0.09, at: i * 0.11 });
    });
  },
};
