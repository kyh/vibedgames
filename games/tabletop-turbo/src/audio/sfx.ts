// Procedural WebAudio — no assets. An engine drone that climbs with speed, a
// tyre hiss under a drift that sharpens as the boost charges, and one-shots for
// the boost, the countdown, bumps and splat pads. The context is created
// lazily from a user gesture; nothing is scheduled while it is suspended.

import type { ItemKind } from "../shared/constants";

const SOUND_KEY = "tabletop-turbo:sound";

// localStorage throws in some embeds (sandboxed iframes, private modes). Sound
// then just loses persistence, never the game.
const storageGet = (): string | null => {
  try {
    return window.localStorage.getItem(SOUND_KEY);
  } catch {
    return null;
  }
};
const storageSet = (value: string): void => {
  try {
    window.localStorage.setItem(SOUND_KEY, value);
  } catch {
    // Blocked store: the choice lasts this session only.
  }
};

interface Rig {
  ctx: AudioContext;
  master: GainNode;
  engineA: OscillatorNode;
  engineB: OscillatorNode;
  engineGain: GainNode;
  engineFilter: BiquadFilterNode;
  hissGain: GainNode;
  hissFilter: BiquadFilterNode;
  noise: AudioBuffer;
}

let muted = storageGet() === "0";
let paused = false;
let rig: Rig | null = null;

export const isMuted = (): boolean => muted;

const noiseBuffer = (ctx: AudioContext): AudioBuffer => {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
};

const build = (): Rig | null => {
  if (!("AudioContext" in window)) {
    return null;
  }
  const ctx = new AudioContext();
  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  const engineFilter = ctx.createBiquadFilter();
  engineFilter.type = "lowpass";
  engineFilter.frequency.value = 500;
  const engineGain = ctx.createGain();
  engineGain.gain.value = 0;
  engineFilter.connect(engineGain).connect(master);
  const engineA = ctx.createOscillator();
  engineA.type = "sawtooth";
  const engineB = ctx.createOscillator();
  engineB.type = "square";
  engineA.connect(engineFilter);
  engineB.connect(engineFilter);
  engineA.start();
  engineB.start();

  const noise = noiseBuffer(ctx);
  const hiss = ctx.createBufferSource();
  hiss.buffer = noise;
  hiss.loop = true;
  const hissFilter = ctx.createBiquadFilter();
  hissFilter.type = "bandpass";
  hissFilter.frequency.value = 1800;
  hissFilter.Q.value = 1.4;
  const hissGain = ctx.createGain();
  hissGain.gain.value = 0;
  hiss.connect(hissFilter).connect(hissGain).connect(master);
  hiss.start();

  return { ctx, engineA, engineB, engineFilter, engineGain, hissFilter, hissGain, master, noise };
};

/** The running rig, or null while muted, paused or not yet unlocked. */
const live = (): Rig | null => {
  if (muted || paused || rig === null) {
    return null;
  }
  return rig.ctx.state === "running" ? rig : null;
};

const applyMaster = (): void => {
  if (rig) {
    rig.master.gain.value = muted || paused ? 0 : 0.5;
  }
};

/** Call from any user gesture: creates or resumes the context. */
export const unlockAudio = (): void => {
  if (muted) {
    return;
  }
  rig ??= build();
  if (rig && rig.ctx.state === "suspended") {
    void rig.ctx.resume();
  }
};

export const setMuted = (next: boolean): void => {
  muted = next;
  storageSet(next ? "0" : "1");
  if (!next) {
    unlockAudio();
  }
  applyMaster();
};

export const setAudioPaused = (next: boolean): void => {
  paused = next;
  applyMaster();
};

/** Every frame: `speed` 0–1 of top speed, `drift` 0 (none) … 1 (fully charged). */
export const driveAudio = (speed: number, drift: number, boosting: boolean): void => {
  const r = live();
  if (!r) {
    return;
  }
  const now = r.ctx.currentTime;
  const hz = 52 + speed * 120 + (boosting ? 30 : 0);
  r.engineA.frequency.setTargetAtTime(hz, now, 0.05);
  r.engineB.frequency.setTargetAtTime(hz * 0.502, now, 0.05);
  r.engineFilter.frequency.setTargetAtTime(380 + speed * 1500, now, 0.08);
  r.engineGain.gain.setTargetAtTime(0.05 + speed * 0.07, now, 0.08);
  r.hissGain.gain.setTargetAtTime(drift > 0 ? 0.1 + drift * 0.12 : 0, now, 0.04);
  r.hissFilter.frequency.setTargetAtTime(1400 + drift * 2600, now, 0.05);
};

/** Silence the continuous voices (title screen, results). */
export const idleAudio = (): void => {
  const r = live();
  if (r) {
    r.engineGain.gain.setTargetAtTime(0, r.ctx.currentTime, 0.1);
    r.hissGain.gain.setTargetAtTime(0, r.ctx.currentTime, 0.05);
  }
};

const tone = (
  hz: number,
  seconds: number,
  volume: number,
  type: OscillatorType = "square",
  slideTo = hz,
): void => {
  const r = live();
  if (!r) {
    return;
  }
  const now = r.ctx.currentTime;
  const osc = r.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(hz, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), now + seconds);
  const gain = r.ctx.createGain();
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  osc.connect(gain).connect(r.master);
  osc.start(now);
  osc.stop(now + seconds + 0.02);
};

const burst = (seconds: number, volume: number, from: number, to: number): void => {
  const r = live();
  if (!r) {
    return;
  }
  const now = r.ctx.currentTime;
  const source = r.ctx.createBufferSource();
  source.buffer = r.noise;
  const filter = r.ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.setValueAtTime(from, now);
  filter.frequency.exponentialRampToValueAtTime(to, now + seconds);
  const gain = r.ctx.createGain();
  gain.gain.setValueAtTime(volume, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  source.connect(filter).connect(gain).connect(r.master);
  source.start(now);
  source.stop(now + seconds + 0.02);
};

const USE_NOTES = {
  blot: () => {
    tone(160, 0.22, 0.14, "sine", 70);
  },
  bomb: () => {
    tone(300, 0.5, 0.12, "triangle", 900);
    burst(0.3, 0.2, 600, 2400);
  },
  solvent: () => {
    burst(0.6, 0.3, 4200, 500);
    tone(880, 0.4, 0.08, "sine", 220);
  },
  turbo: () => {
    burst(0.7, 0.36, 400, 6000);
    tone(330, 0.4, 0.14, "sawtooth", 1320);
  },
} satisfies Record<ItemKind, () => void>;

export const sfx = {
  boost: (tier: number): void => {
    burst(0.45 + tier * 0.12, 0.35, 500, 5200);
    tone(220 * tier, 0.3, 0.12, "sawtooth", 660 * tier);
  },
  box: (): void => {
    for (const [i, hz] of [660, 880, 1175].entries()) {
      window.setTimeout(() => tone(hz, 0.1, 0.1, "square"), i * 70);
    }
  },
  bump: (): void => {
    burst(0.12, 0.3, 900, 200);
  },
  countdown: (go: boolean): void => {
    tone(go ? 880 : 440, go ? 0.5 : 0.16, 0.16, "square");
  },
  finish: (): void => {
    for (const [i, hz] of [523, 659, 784, 1047].entries()) {
      window.setTimeout(() => tone(hz, 0.22, 0.14, "triangle"), i * 110);
    }
  },
  lap: (): void => {
    tone(660, 0.12, 0.12, "triangle", 990);
  },
  orb: (): void => {
    tone(1320, 0.09, 0.07, "triangle", 1980);
  },
  spin: (): void => {
    tone(700, 0.6, 0.16, "sawtooth", 90);
    burst(0.4, 0.25, 1800, 300);
  },
  splat: (): void => {
    burst(0.3, 0.3, 2400, 300);
    tone(180, 0.25, 0.14, "sine", 60);
  },
  tier: (tier: number): void => {
    tone(500 + tier * 220, 0.09, 0.08, "triangle");
  },
  use: (kind: ItemKind): void => {
    USE_NOTES[kind]();
  },
};
