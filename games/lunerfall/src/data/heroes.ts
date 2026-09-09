import type { HeroName } from "./animations";

// One combo strike. `clip` is the hero's animation for this step; timings are in
// seconds; the hitbox is live during [a0, a1] and reaches `reach` px forward.
export interface Swing {
  clip: string;
  dur: number;
  a0: number;
  a1: number;
  // earliest time the next combo input chains
  combo: number;
  reach: number;
  dmg: number;
  kb: number;
  lunge: number;
}

// Per-hero signature ability on the special key.
export type Special =
  | {
      kind: "aoe";
      clip: string;
      dur: number;
      a0: number;
      a1: number;
      radius: number;
      dmg: number;
      kb: number;
      cd: number;
    }
  | { kind: "blink"; clip: string; outClip: string; dist: number; cd: number; iframes: number }
  | { kind: "heal"; clip: string; dur: number; cd: number; amount: number }
  | {
      kind: "projectile";
      clip: string;
      dur: number;
      fireAt: number;
      cd: number;
      speed: number;
      dmg: number;
    };

export interface HeroKit {
  swings: Swing[];
  special: Special;
  // some heroes lack a dash sheet — fall back to another clip
  dashClip: string;
}

export interface HeroDef {
  name: HeroName;
  title: string;
  blurb: string;
  color: number;
  kit: HeroKit;
}

// Global swing tempo. Stretches only `dur` — the swing's total commitment +
// combo cadence — never the hitbox (`a0`/`a1`) or `combo`: the hit still lands
// EARLY (~50–140ms, snappy + responsive). How the ART fills that window is
// data/clip-timing.ts's job: it retimes each clip unevenly so the measured
// contact frame displays exactly during [a0, a1] and the follow-through holds
// through the rest of `dur` (uniform stretching left the visual hit ~300-700ms
// after the damage). Tune tempo for pacing; tune STRIKE_FRAME for alignment.
const SWING_TEMPO = 4;
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
  const s = {
    a0: 0.05,
    a1: 0.14,
    clip,
    combo: 0.11,
    dur: 0.24,
    kb: 110,
    lunge: 50,
    reach: 20,
    ...o,
  };
  const dur = s.dur * SWING_TEMPO;
  return {
    ...s,
    dmg: Math.max(1, Math.round(dur * DMG_PER_SEC)),
    dur,
    reach: s.reach + REACH_BONUS,
  };
};

export const HEROES = {
  axion: {
    blurb: "Teal blade. Fast 3-hit combo, smashing finisher.",
    color: 0x34_e5_c8,
    kit: {
      dashClip: "dash",
      special: {
        a0: 0.16,
        a1: 0.3,
        cd: 4,
        clip: "super-smash",
        dmg: 3,
        dur: 0.5,
        kb: 240,
        kind: "aoe",
        radius: 34,
      },
      // Combo = the three slashes of "Attack 3", one per press (see SPLITS in
      // animations.ts) — a clean 3-hit chain instead of separate 1-/2-/3-slash clips.
      swings: [
        swing("attack-3a", { a0: 0.03, a1: 0.13, dur: 0.2, kb: 90, lunge: 48, reach: 20 }),
        swing("attack-3b", { a0: 0.03, a1: 0.13, dur: 0.2, kb: 115, lunge: 55, reach: 20 }),
        swing("attack-3c", {
          a0: 0.04,
          a1: 0.16,
          combo: 99,
          dur: 0.26,
          kb: 210,
          lunge: 90,
          reach: 27,
        }),
      ],
    },
    name: "axion",
    title: "AXION",
  },
  mooni: {
    blurb: "Moon staff. Spin sweep, lunging thrust. Self-heal.",
    color: 0xff_9e_cb,
    kit: {
      // no dash sheet — reuse jump pose
      dashClip: "jump",
      special: { amount: 2, cd: 9, clip: "heal", dur: 0.7, kind: "heal" },
      swings: [
        swing("thrust", { a0: 0.06, a1: 0.16, dur: 0.24, kb: 110, lunge: 75, reach: 26 }),
        swing("spin", { a0: 0.05, a1: 0.22, dur: 0.3, kb: 130, lunge: 30, reach: 24 }),
        swing("smash", { a0: 0.1, a1: 0.26, combo: 99, dur: 0.4, kb: 200, lunge: 60, reach: 26 }),
      ],
    },
    name: "mooni",
    title: "MOONI",
  },
  reaper: {
    blurb: "Long scythe. Wide, heavy sweeps. Reaping spin.",
    color: 0xe8_3f_a0,
    kit: {
      dashClip: "dash",
      special: {
        a0: 0.14,
        a1: 0.42,
        cd: 5,
        clip: "skill",
        dmg: 3,
        dur: 0.6,
        kb: 200,
        kind: "aoe",
        radius: 42,
      },
      swings: [
        swing("slash", { a0: 0.07, a1: 0.18, dur: 0.28, kb: 120, lunge: 40, reach: 30 }),
        swing("double-slash", { a0: 0.07, a1: 0.22, dur: 0.34, kb: 150, lunge: 55, reach: 32 }),
        swing("attack", { a0: 0.1, a1: 0.28, combo: 99, dur: 0.42, kb: 240, lunge: 70, reach: 34 }),
      ],
    },
    name: "reaper",
    title: "REAPER",
  },
  riven: {
    blurb: "Twin daggers. Blur-fast combo. Smoke-step blink.",
    color: 0x9b_8c_ff,
    kit: {
      dashClip: "dash",
      special: {
        cd: 2.6,
        clip: "smoke-in",
        dist: 78,
        iframes: 0.3,
        kind: "blink",
        outClip: "smoke-out",
      },
      swings: [
        swing("slash", { a0: 0.03, a1: 0.1, combo: 0.08, dur: 0.16, kb: 70, lunge: 55, reach: 17 }),
        swing("double-slash", {
          a0: 0.04,
          a1: 0.14,
          combo: 0.09,
          dur: 0.2,
          kb: 90,
          lunge: 60,
          reach: 18,
        }),
        // Same drawing as swing 1 but its own clip name: the finisher's timing
        // differs, and retimed @kit variants are built per (clip, swing spec).
        swing("slash-heavy", {
          a0: 0.04,
          a1: 0.16,
          combo: 99,
          dur: 0.24,
          kb: 150,
          lunge: 80,
          reach: 19,
        }),
      ],
    },
    name: "riven",
    title: "RIVEN",
  },
  salamander: {
    blurb: "Fire fists. Heavy blows. Hurls a flame wave.",
    color: 0xff_6b_3d,
    kit: {
      dashClip: "dash",
      special: {
        cd: 2.2,
        clip: "flame-wave",
        dmg: 2,
        dur: 0.5,
        fireAt: 0.24,
        kind: "projectile",
        speed: 210,
      },
      swings: [
        swing("fire-punch", { a0: 0.06, a1: 0.16, dur: 0.26, kb: 120, lunge: 55, reach: 22 }),
        swing("fire-punch", { a0: 0.06, a1: 0.16, dur: 0.26, kb: 130, lunge: 55, reach: 22 }),
        swing("flame-slam", {
          a0: 0.12,
          a1: 0.3,
          combo: 99,
          dur: 0.44,
          kb: 250,
          lunge: 70,
          reach: 28,
        }),
      ],
    },
    name: "salamander",
    title: "SALAMANDER",
  },
} satisfies Record<HeroName, HeroDef>;

export const HERO_ORDER: HeroName[] = ["axion", "reaper", "riven", "mooni", "salamander"];
