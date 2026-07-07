import type { HeroName } from "./animations";

// One combo strike. `clip` is the hero's animation for this step; timings are in
// seconds; the hitbox is live during [a0, a1] and reaches `reach` px forward.
export type Swing = {
  clip: string;
  dur: number;
  a0: number;
  a1: number;
  combo: number; // earliest time the next combo input chains
  reach: number;
  dmg: number;
  kb: number;
  lunge: number;
};

// Per-hero signature ability on the special key.
export type Special =
  | { kind: "aoe"; clip: string; dur: number; a0: number; a1: number; radius: number; dmg: number; kb: number; cd: number }
  | { kind: "blink"; clip: string; outClip: string; dist: number; cd: number; iframes: number }
  | { kind: "heal"; clip: string; dur: number; cd: number; amount: number }
  | { kind: "projectile"; clip: string; dur: number; fireAt: number; cd: number; speed: number; dmg: number };

export type HeroKit = {
  swings: Swing[];
  special: Special;
  dashClip: string; // some heroes lack a dash sheet — fall back to another clip
};

export type HeroDef = {
  name: HeroName;
  title: string;
  blurb: string;
  color: number;
  kit: HeroKit;
};

// Global swing tempo. The Luneblade attack art is authored slow (~10fps), so a
// snappy 0.22s hitbox window blurred the whole swing AND cut combo steps short.
// This stretches only `dur` — the readable anim length + the combo cadence — so
// each strike plays out and chains cleanly. Crucially it does NOT scale the
// hitbox (`a0`/`a1`) or `combo`: the hit still lands EARLY (~50–140ms, snappy +
// responsive) and chaining stays forgiving; only the visual swing is slow. Tune.
const SWING_TEMPO = 4.0;
// Extra forward reach on every swing so hits land more generously in front.
const REACH_BONUS = 12;

const swing = (clip: string, o: Partial<Swing>): Swing => {
  const s: Swing = { clip, dur: 0.24, a0: 0.05, a1: 0.14, combo: 0.11, reach: 20, dmg: 1, kb: 110, lunge: 50, ...o };
  return { ...s, dur: s.dur * SWING_TEMPO, reach: s.reach + REACH_BONUS };
};

export const HEROES: Record<HeroName, HeroDef> = {
  axion: {
    name: "axion",
    title: "AXION",
    blurb: "Teal blade. Fast 3-hit combo, smashing finisher.",
    color: 0x34e5c8,
    kit: {
      dashClip: "dash",
      swings: [
        swing("attack-1", { dur: 0.22, reach: 20, dmg: 1, kb: 90, lunge: 45 }),
        swing("attack-2", { dur: 0.24, reach: 20, dmg: 1, kb: 115, lunge: 55 }),
        swing("attack-3", { dur: 0.36, a1: 0.2, combo: 99, reach: 27, dmg: 2, kb: 210, lunge: 90 }),
      ],
      special: { kind: "aoe", clip: "super-smash", dur: 0.5, a0: 0.16, a1: 0.3, radius: 34, dmg: 3, kb: 240, cd: 4 },
    },
  },
  reaper: {
    name: "reaper",
    title: "REAPER",
    blurb: "Long scythe. Wide, heavy sweeps. Reaping spin.",
    color: 0xe83fa0,
    kit: {
      dashClip: "dash",
      swings: [
        swing("slash", { dur: 0.28, a0: 0.07, a1: 0.18, reach: 30, dmg: 1, kb: 120, lunge: 40 }),
        swing("double-slash", { dur: 0.34, a0: 0.07, a1: 0.22, reach: 32, dmg: 2, kb: 150, lunge: 55 }),
        swing("attack", { dur: 0.42, a0: 0.1, a1: 0.28, combo: 99, reach: 34, dmg: 3, kb: 240, lunge: 70 }),
      ],
      special: { kind: "aoe", clip: "skill", dur: 0.6, a0: 0.14, a1: 0.42, radius: 42, dmg: 3, kb: 200, cd: 5 },
    },
  },
  riven: {
    name: "riven",
    title: "RIVEN",
    blurb: "Twin daggers. Blur-fast combo. Smoke-step blink.",
    color: 0x9b8cff,
    kit: {
      dashClip: "dash",
      swings: [
        swing("slash", { dur: 0.16, a0: 0.03, a1: 0.1, combo: 0.08, reach: 17, dmg: 1, kb: 70, lunge: 55 }),
        swing("double-slash", { dur: 0.2, a0: 0.04, a1: 0.14, combo: 0.09, reach: 18, dmg: 1, kb: 90, lunge: 60 }),
        swing("slash", { dur: 0.24, a0: 0.04, a1: 0.16, combo: 99, reach: 19, dmg: 2, kb: 150, lunge: 80 }),
      ],
      special: { kind: "blink", clip: "smoke-in", outClip: "smoke-out", dist: 78, cd: 2.6, iframes: 0.3 },
    },
  },
  mooni: {
    name: "mooni",
    title: "MOONI",
    blurb: "Moon staff. Spin sweep, lunging thrust. Self-heal.",
    color: 0xff9ecb,
    kit: {
      dashClip: "jump", // no dash sheet — reuse jump pose
      swings: [
        swing("thrust", { dur: 0.24, a0: 0.06, a1: 0.16, reach: 26, dmg: 1, kb: 110, lunge: 75 }),
        swing("spin", { dur: 0.3, a0: 0.05, a1: 0.22, reach: 24, dmg: 1, kb: 130, lunge: 30 }),
        swing("smash", { dur: 0.4, a0: 0.1, a1: 0.26, combo: 99, reach: 26, dmg: 2, kb: 200, lunge: 60 }),
      ],
      special: { kind: "heal", clip: "heal", dur: 0.7, cd: 9, amount: 2 },
    },
  },
  salamander: {
    name: "salamander",
    title: "SALAMANDER",
    blurb: "Fire fists. Heavy blows. Hurls a flame wave.",
    color: 0xff6b3d,
    kit: {
      dashClip: "dash",
      swings: [
        swing("fire-punch", { dur: 0.26, a0: 0.06, a1: 0.16, reach: 22, dmg: 1, kb: 120, lunge: 55 }),
        swing("fire-punch", { dur: 0.26, a0: 0.06, a1: 0.16, reach: 22, dmg: 1, kb: 130, lunge: 55 }),
        swing("flame-slam", { dur: 0.44, a0: 0.12, a1: 0.3, combo: 99, reach: 28, dmg: 3, kb: 250, lunge: 70 }),
      ],
      special: { kind: "projectile", clip: "flame-wave", dur: 0.5, fireAt: 0.24, cd: 2.2, speed: 210, dmg: 2 },
    },
  },
};

export const HERO_ORDER: HeroName[] = ["axion", "reaper", "riven", "mooni", "salamander"];
