const SOUND_KEY = "dodgem:sound";

const storageGet = () => {
  try {
    return window.localStorage.getItem(SOUND_KEY);
  } catch {
    return null;
  }
};

const storageSet = (value: string) => {
  try {
    window.localStorage.setItem(SOUND_KEY, value);

    return true;
  } catch {
    return false;
  }
};

type Bus = "mine" | "world" | "ui";

interface Rig {
  ctx: AudioContext;
  master: GainNode;
  buses: Record<Bus, GainNode>;
  engineA: OscillatorNode;
  engineB: OscillatorNode;
  engineGain: GainNode;
  engineFilter: BiquadFilterNode;
  noise: AudioBuffer;
}

const VOICE_CAP = 14;
const MASTER = 0.6;

let muted = storageGet() === "0";
let paused = false;
let rig: Rig | null = null;
let voices = 0;

export const isMuted = () => muted;

const noiseBuffer = (ctx: AudioContext) => {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.random() * 2 - 1;
  }

  return buffer;
};

const build = () => {
  if (!("AudioContext" in window)) {
    return null;
  }

  const ctx = new AudioContext();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.002;
  limiter.release.value = 0.12;
  limiter.connect(ctx.destination);
  const glue = ctx.createDynamicsCompressor();
  glue.threshold.value = -20;
  glue.knee.value = 12;
  glue.ratio.value = 4;
  glue.attack.value = 0.006;
  glue.release.value = 0.2;
  glue.connect(limiter);
  const master = ctx.createGain();
  master.gain.value = MASTER;
  master.connect(glue);

  const bus = (level: number) => {
    const gain = ctx.createGain();
    gain.gain.value = level;
    gain.connect(master);

    return gain;
  };

  const buses = { mine: bus(1), ui: bus(0.7), world: bus(0.5) };
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

  return {
    buses,
    ctx,
    engineA,
    engineB,
    engineFilter,
    engineGain,
    master,
    noise: noiseBuffer(ctx),
  };
};

const live = () => {
  if (muted || paused || rig === null) {
    return null;
  }

  return rig.ctx.state === "running" ? rig : null;
};

const applyMaster = () => {
  if (rig) {
    rig.master.gain.value = muted || paused ? 0 : MASTER;
  }
};

/** Call from any user gesture: creates or resumes the context. */
export const unlockAudio = () => {
  if (muted) {
    return;
  }

  rig ??= build();

  if (rig && rig.ctx.state === "suspended") {
    void rig.ctx.resume();
  }
};

export const setMuted = (next: boolean) => {
  muted = next;
  storageSet(next ? "0" : "1");

  if (!next) {
    unlockAudio();
  }

  applyMaster();
};

export const setAudioPaused = (next: boolean) => {
  paused = next;
  applyMaster();
};

/** Every frame: `speed` 0–1 of top speed. */
export const driveAudio = (speed: number, boosting: boolean) => {
  const r = live();

  if (!r) {
    return;
  }

  const now = r.ctx.currentTime;
  const hz = 48 + speed * 86 + (boosting ? 46 : 0);
  r.engineA.frequency.setTargetAtTime(hz, now, 0.05);
  r.engineB.frequency.setTargetAtTime(hz * 0.502, now, 0.05);
  r.engineFilter.frequency.setTargetAtTime(320 + speed * 1100 + (boosting ? 900 : 0), now, 0.08);
  r.engineGain.gain.setTargetAtTime(0.025 + speed * 0.04 + (boosting ? 0.03 : 0), now, 0.08);
};

/** Silence the engine (title screen, results, out of the round). */
export const idleAudio = () => {
  const r = live();

  if (r) {
    r.engineGain.gain.setTargetAtTime(0, r.ctx.currentTime, 0.1);
  }
};

const admit = (bus: Bus) => {
  const r = live();

  if (!r || (voices >= VOICE_CAP && bus === "world")) {
    return null;
  }

  voices += 1;

  return r;
};

const release = (node: AudioScheduledSourceNode) => {
  node.addEventListener("ended", () => {
    voices = Math.max(0, voices - 1);
  });
};

const take = () => 0.94 + Math.random() * 0.12;

interface ToneShot {
  hz: number;
  to?: number;
  seconds: number;
  volume: number;
  type?: OscillatorType;
  delay?: number;
}

const tone = (bus: Bus, shot: ToneShot) => {
  const r = admit(bus);

  if (!r) {
    return;
  }

  const at = r.ctx.currentTime + (shot.delay ?? 0);
  const pitch = take();
  const osc = r.ctx.createOscillator();
  osc.type = shot.type ?? "square";
  osc.frequency.setValueAtTime(shot.hz * pitch, at);
  osc.frequency.exponentialRampToValueAtTime(
    Math.max(20, (shot.to ?? shot.hz) * pitch),
    at + shot.seconds,
  );
  const gain = r.ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(shot.volume, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + shot.seconds);
  osc.connect(gain).connect(r.buses[bus]);
  release(osc);
  osc.start(at);
  osc.stop(at + shot.seconds + 0.02);
};

interface NoiseShot {
  from: number;
  to: number;
  seconds: number;
  volume: number;
  q?: number;
  delay?: number;
}

const noise = (bus: Bus, shot: NoiseShot) => {
  const r = admit(bus);

  if (!r) {
    return;
  }

  const at = r.ctx.currentTime + (shot.delay ?? 0);
  const source = r.ctx.createBufferSource();
  source.buffer = r.noise;
  const filter = r.ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.Q.value = shot.q ?? 0.9;
  filter.frequency.setValueAtTime(shot.from, at);
  filter.frequency.exponentialRampToValueAtTime(shot.to, at + shot.seconds);
  const gain = r.ctx.createGain();
  gain.gain.setValueAtTime(shot.volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + shot.seconds);
  source.connect(filter).connect(gain).connect(r.buses[bus]);
  release(source);
  source.start(at, Math.random() * 0.5);
  source.stop(at + shot.seconds + 0.02);
};

const side = (mine: boolean) => (mine ? "mine" : "world") satisfies Bus;

/** How loud the board itself is: turned down behind the title. */
export const setWorldLevel = (level: number) => {
  if (rig) {
    rig.buses.world.gain.value = 0.5 * level;
  }
};

export const sfx = {
  /** A shield taking a blow. */
  block: (mine: boolean) => {
    tone(side(mine), { hz: 1760, seconds: 0.22, to: 880, type: "triangle", volume: 0.2 });
    noise(side(mine), { from: 6000, q: 3, seconds: 0.12, to: 3000, volume: 0.2 });
  },
  /** A rocket, a mine or a shockwave going off. `power` 0–1. */
  boom: (power: number, mine: boolean) => {
    const bus = side(mine);
    tone(bus, {
      hz: 120 + power * 30,
      seconds: 0.4 + power * 0.2,
      to: 32,
      type: "sine",
      volume: 0.55,
    });
    noise(bus, { from: 1800, seconds: 0.3 + power * 0.2, to: 90, volume: 0.5 });
    noise(bus, { from: 5200, q: 0.4, seconds: 0.06, to: 2400, volume: 0.3 });
  },
  boost: () => {
    noise("mine", { from: 500, seconds: 0.4, to: 4800, volume: 0.22 });
    tone("mine", { hz: 180, seconds: 0.3, to: 520, type: "sawtooth", volume: 0.1 });
  },
  /** A pop bumper. */
  bounce: (mine: boolean) => {
    tone(side(mine), { hz: 520, seconds: 0.16, to: 1040, type: "triangle", volume: 0.2 });
    tone(side(mine), { delay: 0.03, hz: 1560, seconds: 0.1, type: "sine", volume: 0.08 });
  },
  clash: () => {
    tone("mine", { hz: 1480, seconds: 0.28, to: 1320, type: "triangle", volume: 0.2 });
    tone("mine", { hz: 2210, seconds: 0.2, type: "sine", volume: 0.1 });
    noise("mine", { from: 5200, q: 2, seconds: 0.08, to: 2600, volume: 0.25 });
  },
  countdown: (go: boolean) => {
    tone("ui", { hz: go ? 880 : 440, seconds: go ? 0.5 : 0.16, volume: 0.16 });
  },
  /** A power cube landing on its pad. */
  cube: () => {
    tone("world", { hz: 300, seconds: 0.14, to: 150, type: "triangle", volume: 0.2 });
    tone("world", { delay: 0.05, hz: 1320, seconds: 0.12, type: "sine", volume: 0.1 });
  },
  /** The dart leaving. */
  dash: (mine: boolean) => {
    noise(side(mine), { from: 400, q: 0.7, seconds: 0.24, to: 5200, volume: mine ? 0.34 : 0.18 });
    tone(side(mine), {
      hz: 220,
      seconds: 0.2,
      to: 660,
      type: "sawtooth",
      volume: mine ? 0.12 : 0.06,
    });
  },
  /** The ends of the board letting go. */
  drop: () => {
    noise("ui", { from: 300, seconds: 1.1, to: 60, volume: 0.4 });
    tone("ui", { hz: 110, seconds: 0.9, to: 38, type: "sawtooth", volume: 0.2 });
  },
  /** Someone going over the edge. */
  fall: (mine: boolean) => {
    tone(side(mine), { hz: 1250, seconds: 0.62, to: 240, type: "sine", volume: mine ? 0.2 : 0.12 });
  },
  /** A bumper landing. `power` 0–1 is how far the car will fly. */
  hit: (power: number, mine: boolean) => {
    const bus = side(mine);
    tone(bus, {
      hz: 190 + power * 40,
      seconds: 0.2 + power * 0.14,
      to: 44,
      type: "sine",
      volume: 0.5,
    });
    noise(bus, { from: 2600, seconds: 0.09 + power * 0.07, to: 320, volume: 0.42 });
    tone(bus, { hz: 880, seconds: 0.07, to: 220, type: "square", volume: 0.12 });
  },
  knockedOut: () => {
    for (const [i, hz] of [392, 311, 233].entries()) {
      tone("ui", { delay: i * 0.11, hz, seconds: 0.2, type: "triangle", volume: 0.16 });
    }
  },
  /** A point for the player. */
  knockOff: () => {
    for (const [i, hz] of [659, 880, 1319].entries()) {
      tone("ui", { delay: i * 0.07, hz, seconds: 0.16, type: "square", volume: 0.13 });
    }
  },
  land: (mine: boolean) => {
    tone(side(mine), { hz: 130, seconds: 0.12, to: 55, type: "sine", volume: 0.3 });
    noise(side(mine), { from: 700, seconds: 0.07, to: 200, volume: 0.16 });
  },
  /** A rocket or a seeker leaving its car. */
  launch: (mine: boolean) => {
    noise(side(mine), { from: 300, q: 0.8, seconds: 0.4, to: 3800, volume: mine ? 0.34 : 0.2 });
    tone(side(mine), {
      hz: 140,
      seconds: 0.34,
      to: 420,
      type: "sawtooth",
      volume: mine ? 0.14 : 0.08,
    });
  },
  magnet: (mine: boolean) => {
    tone(side(mine), { hz: 90, seconds: 0.5, to: 540, type: "sawtooth", volume: 0.2 });
    tone(side(mine), { hz: 180, seconds: 0.5, to: 1080, type: "sine", volume: 0.12 });
  },
  /** Growing, or a shield going up. */
  morph: (mine: boolean) => {
    for (const [i, hz] of [262, 330, 392, 523].entries()) {
      tone(side(mine), { delay: i * 0.05, hz, seconds: 0.14, type: "square", volume: 0.1 });
    }
  },
  out: () => {
    noise("world", { from: 1400, seconds: 0.22, to: 180, volume: 0.22 });
  },
  pickup: () => {
    for (const [i, hz] of [660, 880, 1175].entries()) {
      tone("ui", { delay: i * 0.06, hz, seconds: 0.1, volume: 0.12 });
    }
  },
  /** The popper's puck leaving. */
  pop: (mine: boolean) => {
    tone(side(mine), { hz: 720, seconds: 0.09, to: 180, type: "square", volume: mine ? 0.2 : 0.1 });
    noise(side(mine), { from: 3200, seconds: 0.05, to: 900, volume: mine ? 0.2 : 0.1 });
  },
  piston: () => {
    noise("world", { from: 240, seconds: 0.2, to: 1800, volume: 0.5 });
    tone("world", { hz: 90, seconds: 0.22, to: 50, type: "sawtooth", volume: 0.34 });
  },
  /** The bumper firing. */
  punch: (mine: boolean) => {
    noise(side(mine), { from: 600, q: 0.6, seconds: 0.11, to: 3400, volume: mine ? 0.3 : 0.16 });
    tone(side(mine), {
      hz: 150,
      seconds: 0.08,
      to: 300,
      type: "triangle",
      volume: mine ? 0.16 : 0.08,
    });
  },
  ram: (mine: boolean) => {
    noise(side(mine), { from: 1200, seconds: 0.09, to: 260, volume: 0.3 });
    tone(side(mine), { hz: 140, seconds: 0.1, to: 70, type: "sine", volume: 0.22 });
  },
  repair: () => {
    for (const [i, hz] of [523, 784, 1047, 1568].entries()) {
      tone("mine", { delay: i * 0.06, hz, seconds: 0.12, type: "triangle", volume: 0.14 });
    }
  },
  /** The attack is back. */
  ready: () => {
    tone("ui", { hz: 1320, seconds: 0.05, type: "triangle", volume: 0.07 });
  },
  results: (won: boolean) => {
    for (const [i, hz] of (won ? [523, 659, 784, 1047] : [523, 494, 440]).entries()) {
      tone("ui", { delay: i * 0.12, hz, seconds: 0.24, type: "triangle", volume: 0.15 });
    }
  },
  /** A mine or a slick set down. */
  set: (mine: boolean) => {
    tone(side(mine), { hz: 260, seconds: 0.1, to: 130, type: "square", volume: 0.14 });
    noise(side(mine), { from: 700, seconds: 0.08, to: 240, volume: 0.14 });
  },
  /** The brick coming down. */
  slam: (mine: boolean) => {
    tone(side(mine), { hz: 110, seconds: 0.34, to: 30, type: "sine", volume: 0.55 });
    noise(side(mine), { from: 900, seconds: 0.22, to: 80, volume: 0.4 });
  },
  /** Wheels on oil. */
  slip: (mine: boolean) => {
    tone(side(mine), { hz: 900, seconds: 0.5, to: 300, type: "sine", volume: 0.14 });
    noise(side(mine), { from: 2400, q: 2, seconds: 0.4, to: 700, volume: 0.14 });
  },
  /** Off a spring. */
  spring: (mine: boolean) => {
    tone(side(mine), { hz: 180, seconds: 0.3, to: 900, type: "triangle", volume: 0.2 });
    tone(side(mine), { delay: 0.04, hz: 360, seconds: 0.22, to: 1400, type: "sine", volume: 0.1 });
  },
  /** The sweeper's arm catching a car. */
  sweep: (mine: boolean) => {
    tone(side(mine), { hz: 240, seconds: 0.26, to: 60, type: "sawtooth", volume: 0.3 });
    noise(side(mine), { from: 1800, seconds: 0.14, to: 300, volume: 0.34 });
  },
  /** The ends are about to go. */
  warn: () => {
    tone("ui", { hz: 740, seconds: 0.12, volume: 0.13 });
    tone("ui", { delay: 0.16, hz: 740, seconds: 0.12, volume: 0.13 });
  },
  /** The twister going round. */
  whirl: (mine: boolean) => {
    noise(side(mine), { from: 500, q: 1.4, seconds: 0.36, to: 2600, volume: mine ? 0.26 : 0.14 });
    tone(side(mine), {
      hz: 300,
      seconds: 0.34,
      to: 520,
      type: "triangle",
      volume: mine ? 0.12 : 0.06,
    });
  },
  whiff: () => {
    noise("mine", { from: 2400, q: 0.5, seconds: 0.14, to: 500, volume: 0.1 });
  },
  zap: (mine: boolean) => {
    tone(side(mine), { hz: 2400, seconds: 0.3, to: 140, type: "sawtooth", volume: 0.18 });
    noise(side(mine), { from: 7000, q: 3, seconds: 0.26, to: 1200, volume: 0.26 });
  },
};
