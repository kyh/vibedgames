// Tiny procedural sound system (WebAudio). No audio assets — every SFX is
// synthesised. Lazily created and resumed on first user gesture (autoplay
// policy). Globally throttled so a busy teamfight doesn't turn into noise.

const SOUND_KEY = "moba:sound";

// localStorage throws in some embeds (sandboxed iframes, blocked cookies,
// private modes). The game must boot and run without persistence.
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
    // Blocked store just loses persistence — never the run.
  }
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
// Muted by default; sound is opt-in ("1") and the choice persists.
let muted = storageGet(SOUND_KEY) !== "1";

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.32;
    master.connect(ctx.destination);
  }
  return ctx;
}

export function resumeAudio(): void {
  const c = ac();
  if (c && c.state === "suspended") void c.resume();
}

export function isMuted(): boolean {
  return muted;
}

export function toggleMute(): boolean {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.32;
  storageSet(SOUND_KEY, muted ? "0" : "1");
  return muted;
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
): void {
  const c = ac();
  if (!c || !master || muted) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(40, slideTo), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

// Synthesising a fresh AudioBuffer per SFX call was needless per-hit work — the
// decaying white noise is indistinguishable between calls, so cache one buffer
// per duration and replay it through a fresh (cheap) BufferSource each time.
const noiseBufs = new Map<number, AudioBuffer>();
function noiseBuffer(c: AudioContext, dur: number): AudioBuffer {
  const cached = noiseBufs.get(dur);
  if (cached) return cached;
  const n = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, n, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
  noiseBufs.set(dur, buf);
  return buf;
}

function noise(dur: number, gain: number, lp: number): void {
  const c = ac();
  if (!c || !master || muted) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c, dur);
  const filt = c.createBiquadFilter();
  filt.type = "lowpass";
  filt.frequency.value = lp;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filt).connect(g).connect(master);
  src.start(t);
}

// ---- throttling ------------------------------------------------------------
const lastAt: Record<string, number> = {};
function gate(key: string, minMs: number): boolean {
  const now = performance.now();
  if ((lastAt[key] ?? 0) + minMs > now) return false;
  lastAt[key] = now;
  return true;
}

export const sfx = {
  hit(): void {
    if (!gate("hit", 60)) return;
    noise(0.06, 0.07, 1400);
  },
  ability(): void {
    if (!gate("ability", 90)) return;
    tone(440, 0.18, "sawtooth", 0.06, 880);
  },
  explosion(): void {
    if (!gate("explosion", 110)) return;
    noise(0.28, 0.16, 700);
    tone(120, 0.3, "sine", 0.1, 50);
  },
  level(): void {
    tone(660, 0.12, "triangle", 0.12);
    setTimeout(() => tone(990, 0.16, "triangle", 0.12), 90);
  },
  structureDown(): void {
    noise(0.5, 0.22, 500);
    tone(90, 0.5, "sine", 0.14, 40);
  },
  death(): void {
    if (!gate("death", 90)) return;
    tone(330, 0.2, "square", 0.06, 110);
  },
  gold(): void {
    if (!gate("gold", 120)) return;
    tone(1200, 0.06, "square", 0.04);
  },
  victory(win: boolean): void {
    const notes = win ? [523, 659, 784, 1047] : [392, 330, 262];
    notes.forEach((f, i) => setTimeout(() => tone(f, 0.3, "triangle", 0.16), i * 160));
  },
};
