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

// Global swing tempo. Stretches only `dur` — the swing's total commitment +
// combo cadence — never the hitbox (`a0`/`a1`) or `combo`: the hit still lands
// EARLY (~50–140ms, snappy + responsive). How the ART fills that window is
// data/clip-timing.ts's job: it retimes each clip unevenly so the measured
// contact frame displays exactly during [a0, a1] and the follow-through holds
// through the rest of `dur` (uniform stretching left the visual hit ~300-700ms
// after the damage). Tune tempo for pacing; tune STRIKE_FRAME for alignment.
const SWING_TEMPO = 4.0;
// Extra forward reach on every swing so hits land more generously in front.
const REACH_BONUS = 12;
// Damage is earned by commitment: a swing's dmg derives from its final (tempo-
// scaled) duration — the time you're locked in and vulnerable — so slower
// swings/kits hit harder and DPS stays roughly level across heroes while the
// texture differs (riven: fast safe jabs; reaper: slow heavy sweeps). Damage
// is deliberately NOT hand-authored per swing: retune SWING_TEMPO or a dur and
// its damage follows. One knob.
const DMG_PER_SEC = 1.75;

const swing = (clip: string, o: Partial<Omit<Swing, "dmg">>): Swing => {
  const s = { clip, dur: 0.24, a0: 0.05, a1: 0.14, combo: 0.11, reach: 20, kb: 110, lunge: 50, ...o };
  const dur = s.dur * SWING_TEMPO;
  return { ...s, dur, dmg: Math.max(1, Math.round(dur * DMG_PER_SEC)), reach: s.reach + REACH_BONUS };
};

export const HEROES: Record<HeroName, HeroDef> = {
  axion: {
    name: "axion",
    title: "AXION",
    blurb: "Teal blade. Fast 3-hit combo, smashing finisher.",
    color: 0x34e5c8,
    kit: {
      dashClip: "dash",
      // Combo = the three slashes of "Attack 3", one per press (see SPLITS in
      // animations.ts) — a clean 3-hit chain instead of separate 1-/2-/3-slash clips.
      swings: [
        swing("attack-3a", { dur: 0.2, a0: 0.03, a1: 0.13, reach: 20, kb: 90, lunge: 48 }),
        swing("attack-3b", { dur: 0.2, a0: 0.03, a1: 0.13, reach: 20, kb: 115, lunge: 55 }),
        swing("attack-3c", { dur: 0.26, a0: 0.04, a1: 0.16, combo: 99, reach: 27, kb: 210, lunge: 90 }),
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
        swing("slash", { dur: 0.28, a0: 0.07, a1: 0.18, reach: 30, kb: 120, lunge: 40 }),
        swing("double-slash", { dur: 0.34, a0: 0.07, a1: 0.22, reach: 32, kb: 150, lunge: 55 }),
        swing("attack", { dur: 0.42, a0: 0.1, a1: 0.28, combo: 99, reach: 34, kb: 240, lunge: 70 }),
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
        swing("slash", { dur: 0.16, a0: 0.03, a1: 0.1, combo: 0.08, reach: 17, kb: 70, lunge: 55 }),
        swing("double-slash", { dur: 0.2, a0: 0.04, a1: 0.14, combo: 0.09, reach: 18, kb: 90, lunge: 60 }),
        // Same drawing as swing 1 but its own clip name: the finisher's timing
        // differs, and retimed @kit variants are built per (clip, swing spec).
        swing("slash-heavy", { dur: 0.24, a0: 0.04, a1: 0.16, combo: 99, reach: 19, kb: 150, lunge: 80 }),
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
        swing("thrust", { dur: 0.24, a0: 0.06, a1: 0.16, reach: 26, kb: 110, lunge: 75 }),
        swing("spin", { dur: 0.3, a0: 0.05, a1: 0.22, reach: 24, kb: 130, lunge: 30 }),
        swing("smash", { dur: 0.4, a0: 0.1, a1: 0.26, combo: 99, reach: 26, kb: 200, lunge: 60 }),
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
        swing("fire-punch", { dur: 0.26, a0: 0.06, a1: 0.16, reach: 22, kb: 120, lunge: 55 }),
        swing("fire-punch", { dur: 0.26, a0: 0.06, a1: 0.16, reach: 22, kb: 130, lunge: 55 }),
        swing("flame-slam", { dur: 0.44, a0: 0.12, a1: 0.3, combo: 99, reach: 28, kb: 250, lunge: 70 }),
      ],
      special: { kind: "projectile", clip: "flame-wave", dur: 0.5, fireAt: 0.24, cd: 2.2, speed: 210, dmg: 2 },
    },
  },
};

export const HERO_ORDER: HeroName[] = ["axion", "reaper", "riven", "mooni", "salamander"];
