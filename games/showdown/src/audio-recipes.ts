// Every sound effect is synthesised on the fly from two primitives: a swept
// oscillator and a filtered burst of white noise. Each recipe takes the
// distance-attenuated loudness of the event; UI cues (ready, count, go, win,
// lose, click) ignore it and always play at full volume.

export interface Synth {
  noise: (
    filter: BiquadFilterType,
    fromHz: number,
    toHz: number,
    duration: number,
    gain: number,
    q?: number,
    delay?: number,
  ) => void;
  tone: (
    wave: OscillatorType,
    fromHz: number,
    toHz: number,
    duration: number,
    gain: number,
    delay?: number,
  ) => void;
}

export type Recipe = (synth: Synth, loudness: number) => void;

export const SOUND_RECIPES = {
  blast: (s, l) => {
    s.noise("lowpass", 3200, 240, 0.2, 0.85 * l);
    s.tone("sine", 170, 50, 0.16, 0.4 * l);
  },
  blastBig: (s, l) => {
    s.noise("lowpass", 3600, 160, 0.34, 1 * l);
    s.tone("sine", 150, 38, 0.3, 0.6 * l);
  },
  bolt: (s, l) => {
    s.noise("highpass", 2500, 1000, 0.1, 0.25 * l);
    s.tone("triangle", 220, 80, 0.14, 0.23 * l);
  },
  boom: (s, l) => {
    s.noise("lowpass", 1800, 70, 0.5, 1 * l);
    s.tone("sine", 110, 34, 0.45, 0.7 * l);
  },
  boomBig: (s, l) => {
    s.noise("lowpass", 2400, 50, 0.85, 1.2 * l);
    s.tone("sine", 95, 28, 0.8, 0.9 * l);
    s.noise("bandpass", 500, 200, 0.5, 0.4 * l, 0.6, 0.05);
  },
  click: (s) => {
    s.tone("triangle", 900, 600, 0.05, 0.2);
  },
  count: (s) => {
    s.tone("square", 520, 520, 0.12, 0.2);
  },
  crate: (s, l) => {
    s.noise("bandpass", 1300, 380, 0.2, 0.75 * l, 1.2);
    s.tone("square", 210, 80, 0.1, 0.12 * l);
  },
  down: (s, l) => {
    s.tone("sawtooth", 420, 60, 0.5, 0.25 * l);
    s.noise("lowpass", 1200, 100, 0.4, 0.4 * l);
  },
  gas: (s) => {
    s.noise("highpass", 3000, 1500, 0.22, 0.22);
  },
  go: (s) => {
    s.tone("square", 880, 1320, 0.3, 0.24);
    s.tone("sine", 440, 660, 0.3, 0.2);
  },
  hit: (s, l) => {
    s.tone("triangle", 720, 260, 0.06, 0.3 * l);
  },
  leap: (s, l) => {
    s.tone("sine", 200, 620, 0.35, 0.3 * l);
    s.noise("highpass", 800, 3000, 0.3, 0.2 * l);
  },
  lob: (s, l) => {
    s.tone("sine", 420, 820, 0.2, 0.22 * l);
    s.tone("triangle", 840, 1280, 0.14, 0.1 * l, 0.04);
    s.noise("highpass", 900, 1800, 0.13, 0.13 * l);
  },
  lose: (s) => {
    for (const [i, hz] of [392, 330, 262, 196].entries()) {
      s.tone("sawtooth", hz, hz * 0.97, 0.32, 0.18, i * 0.16);
    }
  },
  pickup: (s, l) => {
    for (const [i, hz] of [660, 880, 1320].entries()) {
      s.tone("triangle", hz, hz * 1.01, 0.13, 0.26 * l, i * 0.065);
    }
  },
  punch: (s, l) => {
    s.noise("bandpass", 1900, 420, 0.16, 0.4 * l, 0.7);
    s.tone("triangle", 680, 260, 0.1, 0.12 * l);
    s.tone("sine", 130, 65, 0.08, 0.16 * l);
  },
  ready: (s) => {
    for (const [i, hz] of [784, 1046, 1568].entries()) {
      s.tone("sine", hz, hz, 0.22, 0.24, i * 0.08);
    }
  },
  shot: (s, l) => {
    s.noise("highpass", 3000, 1400, 0.1, 0.2 * l);
    s.tone("triangle", 330, 140, 0.13, 0.19 * l);
  },
  shotBig: (s, l) => {
    s.noise("highpass", 2600, 1100, 0.18, 0.28 * l);
    s.tone("triangle", 440, 180, 0.18, 0.23 * l);
    s.tone("sine", 880, 660, 0.22, 0.12 * l);
  },
  splash: (s, l) => {
    s.noise("highpass", 2200, 700, 0.22, 0.28 * l);
    s.tone("sine", 520, 140, 0.16, 0.21 * l);
    s.tone("triangle", 1100, 720, 0.1, 0.1 * l, 0.025);
  },
  super: (s, l) => {
    s.noise("bandpass", 300, 3200, 0.3, 0.5 * l, 1.5);
    s.tone("sawtooth", 180, 720, 0.28, 0.13 * l);
  },
  thorns: (s, l) => {
    s.noise("bandpass", 1400, 300, 0.16, 0.24 * l, 1.2);
    s.tone("triangle", 500, 250, 0.09, 0.11 * l);
  },
  win: (s) => {
    for (const [i, hz] of [523, 659, 784, 1046, 1318].entries()) {
      s.tone("triangle", hz, hz, 0.3, 0.3, i * 0.11);
    }
  },
} satisfies Record<string, Recipe>;

export type SoundName = keyof typeof SOUND_RECIPES;

/** A name off the wire is untrusted; `SOUND_RECIPES[name]` must never be undefined. */
export const isSoundName = (name: string): name is SoundName => Object.hasOwn(SOUND_RECIPES, name);
