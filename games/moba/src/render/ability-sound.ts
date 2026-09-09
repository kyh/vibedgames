export type FoleyKey = "buckler" | "blade" | "bowstring" | "fire" | "mechanism" | "potion";

/** Short synth gestures per spell. Shared timbres identify a champion;
 * rhythm, register and envelope identify the action. */
export interface SynthTone {
  kind: "tone";
  freq: number;
  dur: number;
  type: OscillatorType;
  gain: number;
  slideTo?: number;
  at: number;
}
export interface SynthNoise {
  kind: "noise";
  dur: number;
  gain: number;
  filter: BiquadFilterType;
  frequency: number;
  at: number;
  attack?: number;
}
export type AbilityNote = SynthTone | SynthNoise;

const tone = (
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  slideTo?: number,
  at = 0,
): SynthTone => ({ at, dur, freq, gain, kind: "tone", slideTo, type });
const air = (
  dur: number,
  gain: number,
  frequency: number,
  at = 0,
  filter: BiquadFilterType = "bandpass",
): SynthNoise => ({ at, attack: 0.004, dur, filter, frequency, gain, kind: "noise" });

const PHRASES = {
  // Buckler contact, a held ward, then the low two-part vow.
  "ironvow:Q": [
    air(0.045, 0.055, 2400, 0, "highpass"),
    tone(720, 0.12, "triangle", 0.05, 520, 0.025),
  ],
  "ironvow:W": [
    tone(330, 0.24, "triangle", 0.04, 440),
    tone(660, 0.26, "sine", 0.035, undefined, 0.055),
  ],
  "ironvow:R": [
    air(0.16, 0.07, 560),
    tone(164, 0.32, "triangle", 0.065, 82),
    tone(330, 0.28, "sine", 0.04, 220, 0.07),
  ],
  // A vanishing breath, three quick blade edges, an execution release.
  "duskblade:Q": [air(0.12, 0.05, 1800), tone(260, 0.16, "sine", 0.04, 90)],
  "duskblade:W": [
    air(0.075, 0.045, 2800),
    air(0.065, 0.035, 3600, 0.035),
    tone(920, 0.1, "triangle", 0.025, 460, 0.06),
  ],
  "duskblade:R": [
    tone(740, 0.09, "sine", 0.045, 220),
    air(0.16, 0.07, 1900, 0.045),
    tone(110, 0.27, "sine", 0.06, 55, 0.09),
  ],
  // Bow-string release, a ringing mark, rushing wind, a storm downbeat.
  "stormcaller:Q": [air(0.065, 0.04, 3200), tone(1040, 0.12, "triangle", 0.045, 1560, 0.018)],
  "stormcaller:W": [
    tone(660, 0.18, "sine", 0.04),
    tone(990, 0.26, "triangle", 0.035, undefined, 0.07),
  ],
  "stormcaller:E": [air(0.3, 0.045, 1700), tone(440, 0.22, "sine", 0.035, 880, 0.02)],
  "stormcaller:R": [
    air(0.25, 0.065, 850),
    tone(130, 0.36, "triangle", 0.055, 65),
    tone(1320, 0.24, "sine", 0.035, 660, 0.06),
  ],
  // Fireball ignition, a low fire ring, a sharp flare, a heavy conflagration.
  "emberhex:Q": [air(0.12, 0.065, 1350), tone(220, 0.16, "triangle", 0.045, 100)],
  "emberhex:W": [air(0.28, 0.055, 650, 0, "lowpass"), tone(180, 0.28, "sine", 0.055, 85)],
  "emberhex:E": [air(0.08, 0.055, 2400), tone(420, 0.17, "triangle", 0.04, 840)],
  "emberhex:R": [
    air(0.35, 0.085, 700, 0, "lowpass"),
    tone(130, 0.4, "triangle", 0.065, 48),
    tone(360, 0.22, "sine", 0.03, 120, 0.06),
  ],
  // Mechanical pin, mine latch, rocket lift and the keg's heavy fuse.
  "boomtinker:Q": [
    tone(1450, 0.025, "square", 0.028),
    air(0.07, 0.07, 2600, 0.03),
    tone(150, 0.11, "sine", 0.045, 75, 0.03),
  ],
  "boomtinker:W": [
    tone(980, 0.045, "triangle", 0.04, 490),
    tone(1470, 0.055, "square", 0.022, undefined, 0.065),
  ],
  "boomtinker:E": [air(0.19, 0.055, 2100), tone(180, 0.22, "triangle", 0.045, 720)],
  "boomtinker:R": [
    tone(740, 0.07, "square", 0.025, 370),
    air(0.25, 0.065, 750, 0.07),
    tone(95, 0.34, "sine", 0.065, 45, 0.07),
  ],
  // A poured draught, a wobbling hex, a soft ward and a resolving toast.
  "brewkeeper:Q": [tone(360, 0.1, "sine", 0.06, 600), tone(600, 0.13, "sine", 0.045, 420, 0.065)],
  "brewkeeper:W": [
    tone(520, 0.13, "sine", 0.045, 280),
    tone(310, 0.22, "triangle", 0.035, 620, 0.09),
  ],
  "brewkeeper:E": [
    tone(392, 0.24, "sine", 0.045),
    tone(588, 0.28, "sine", 0.035, undefined, 0.045),
  ],
  "brewkeeper:R": [
    tone(262, 0.32, "triangle", 0.05),
    tone(392, 0.3, "sine", 0.04, undefined, 0.07),
    tone(524, 0.34, "sine", 0.035, undefined, 0.14),
  ],
} satisfies Record<string, readonly AbilityNote[]>;
const byEffect = new Map<string, readonly AbilityNote[]>(Object.entries(PHRASES));
const fallback = [tone(440, 0.18, "triangle", 0.04, 880)];

export function abilityNotes(effect: string): readonly AbilityNote[] {
  return byEffect.get(effect) ?? fallback;
}

const accents = new Map<string, { key: FoleyKey; gain: number }>([
  ["ironvow", { gain: 0.18, key: "buckler" }],
  ["duskblade", { gain: 0.06, key: "blade" }],
  ["stormcaller", { gain: 0.15, key: "bowstring" }],
  ["emberhex", { gain: 0.06, key: "fire" }],
  ["boomtinker", { gain: 0.18, key: "mechanism" }],
  ["brewkeeper", { gain: 0.17, key: "potion" }],
]);

export function abilityFoley(effect: string) {
  return byEffect.has(effect) ? (accents.get(effect.split(":")[0] ?? "") ?? null) : null;
}
