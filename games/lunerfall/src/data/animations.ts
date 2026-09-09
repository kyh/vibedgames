import type Phaser from "phaser";

import { isJsonObject } from "../net/json";
import type { JsonValue } from "../net/json";

// Animation manifest, driven entirely by the Aseprite exports in
// public/sprites/ase. Each atlas carries the artist's authored per-frame
// durations + frame tags, so we build one Phaser animation per tag with EXACT
// timings — no hand-guessed FPS (the old approach played run/dash/attacks 40-120%
// too fast, which is what read as "not smooth"). Boss reuses the "salamander"
// atlas. Anim keys are `${atlas}:${clip}`.

export const HERO_NAMES = ["axion", "reaper", "riven", "mooni", "salamander"] as const;
export const ENEMY_NAMES = ["warrior", "bomber", "archer", "spearman"] as const;
export type HeroName = (typeof HERO_NAMES)[number];
export type EnemyName = (typeof ENEMY_NAMES)[number];

// Every atlas we load.aseprite() at boot.
export const ATLAS_KEYS: readonly string[] = [...HERO_NAMES, ...ENEMY_NAMES];

// Clips that repeat forever; everything else plays once and holds its last frame.
const LOOPING = new Set(["idle", "idle-break", "run", "fall"]);

// Per-atlas aliases: Aseprite tag name -> the clip slug(s) the game code plays.
// A tag maps to several names when one drawing serves two logical clips
// (salamander's "Hit" is both the boss hurt clip and the playable-hero hurt clip).
const ALIASES = new Map<string, Record<string, string | string[]>>([
  ["axion", { Smash: "super-smash" }],
  ["reaper", { "Special Skill": "skill", "Surprise Attack": "attack" }],
  [
    "riven",
    {
      // "slash-heavy" = the same drawing as riven's opener, re-registered so the
      // combo finisher (different swing timing) gets its own retimed @kit variant.
      "Single Slash": ["slash", "slash-heavy"],
      "Smoke Bomb In": "smoke-in",
      "Smoke Bomb Out": "smoke-out",
    },
  ],
  ["salamander", { Hit: ["hit", "hurt"] }],
]);

const slug = (tag: string): string => tag.toLowerCase().replaceAll(/\s+/gu, "-");

const clipNames = (tagName: string, mapped: string | string[] | undefined): string[] => {
  if (mapped === undefined) {
    return [slug(tagName)];
  }
  return Array.isArray(mapped) ? mapped : [mapped];
};

// Tags that are one authored multi-slash flurry we want to drive ONE hit per
// press: split into equal contiguous frame slices, each its own clip the combo
// plays in sequence. So axion's 3-slash "Attack 3" becomes three single slashes
// (J → slash 1, J → slash 2, J → slash 3) instead of one long clip per press.
const SPLITS = new Map<string, Record<string, string[]>>([
  ["axion", { "Attack 3": ["attack-3a", "attack-3b", "attack-3c"] }],
]);

// Contiguous [from,to] atlas-frame ranges for n equal slices of a tag.
const sliceRanges = (from: number, to: number, n: number): [number, number][] => {
  const len = to - from + 1;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i += 1) {
    out.push([from + Math.floor((i * len) / n), from + Math.floor(((i + 1) * len) / n) - 1]);
  }
  return out;
};

type AseFrame = {
  filename: string;
  duration: number;
};
type AseData = {
  frames: AseFrame[];
  meta: { frameTags: { name: string; from: number; to: number }[] };
};

const isAseData = (v: JsonValue): v is AseData => {
  if (!isJsonObject(v) || !("frames" in v) || !("meta" in v)) {
    return false;
  }
  const { meta } = v;
  if (!Array.isArray(v.frames) || !isJsonObject(meta) || !("frameTags" in meta)) {
    return false;
  }
  return Array.isArray(meta.frameTags);
};

// Build one animation per Aseprite tag, with the tag's exact per-frame durations.
export const buildAnimsFromAseprite = (scene: Phaser.Scene, key: string): void => {
  const data: JsonValue = scene.cache.json.get(key);
  if (!isAseData(data)) {
    return;
  }
  const alias = ALIASES.get(key) ?? {};
  for (const tag of data.meta.frameTags) {
    if (tag.name === "Good!") {
      continue;
      // pack's "select-all" meta tag
    }
    const clips = clipNames(tag.name, alias[tag.name]);

    const frames: Phaser.Types.Animations.AnimationFrame[] = [];
    let total = 0;
    for (let i = tag.from; i <= tag.to; i += 1) {
      const f = data.frames[i];
      if (!f) {
        continue;
      }
      frames.push({ duration: f.duration, frame: f.filename, key });
      total += f.duration;
    }
    if (frames.length === 0) {
      continue;
    }

    for (const clip of clips) {
      const animKey = `${key}:${clip}`;
      if (scene.anims.exists(animKey)) {
        continue;
      }
      // duration (not frameRate) + per-frame durations => Phaser honours each
      // frame's authored ms exactly (mirrors createFromAseprite / nextTick logic).
      scene.anims.create({
        duration: total,
        frames,
        key: animKey,
        repeat: LOOPING.has(clip) ? -1 : 0,
      });
    }

    const splits = SPLITS.get(key)?.[tag.name];
    if (splits) {
      const ranges = sliceRanges(tag.from, tag.to, splits.length);
      for (const [si, clip] of splits.entries()) {
        const animKey = `${key}:${clip}`;
        if (scene.anims.exists(animKey)) {
          continue;
        }
        const [s, e] = ranges[si] ?? [tag.from, tag.to];
        const sf: Phaser.Types.Animations.AnimationFrame[] = [];
        let d = 0;
        for (let i = s; i <= e; i += 1) {
          const f = data.frames[i];
          if (!f) {
            continue;
          }
          sf.push({ duration: f.duration, frame: f.filename, key });
          d += f.duration;
        }
        if (sf.length > 0) {
          scene.anims.create({ duration: d, frames: sf, key: animKey, repeat: 0 });
        }
      }
    }
  }
};

// First real frame name for an atlas (frame 0 is a blank spacer), so a sprite has
// a sane frame before it plays.
export const firstFrame = (scene: Phaser.Scene, key: string): string | undefined => {
  const data: JsonValue = scene.cache.json.get(key);
  return isAseData(data) ? data.frames[1]?.filename : undefined;
};

export interface ClipInfo {
  clip: string;
  frames: number;
  ms: number;
  loop: boolean;
}

// Enumerate an atlas's clips with their authored frame count + total duration —
// the data behind the ?viewer page (and a quick way to spot a 1-frame / wrong
// clip). Mirrors buildAnimsFromAseprite's tag→clip mapping; dedupes shared slugs.
export const clipsFor = (scene: Phaser.Scene, key: string): ClipInfo[] => {
  const data: JsonValue = scene.cache.json.get(key);
  if (!isAseData(data)) {
    return [];
  }
  const alias = ALIASES.get(key) ?? {};
  const out: ClipInfo[] = [];
  const seen = new Set<string>();
  for (const tag of data.meta.frameTags) {
    if (tag.name === "Good!") {
      continue;
    }
    const clips = clipNames(tag.name, alias[tag.name]);
    let frames = 0;
    let ms = 0;
    for (let i = tag.from; i <= tag.to; i += 1) {
      const f = data.frames[i];
      if (!f) {
        continue;
      }
      frames += 1;
      ms += f.duration;
    }
    if (frames === 0) {
      continue;
    }
    for (const clip of clips) {
      if (seen.has(clip)) {
        continue;
      }
      seen.add(clip);
      out.push({ clip, frames, loop: LOOPING.has(clip), ms });
    }

    const splits = SPLITS.get(key)?.[tag.name];
    if (splits) {
      const ranges = sliceRanges(tag.from, tag.to, splits.length);
      for (const [si, clip] of splits.entries()) {
        if (seen.has(clip)) {
          continue;
        }
        seen.add(clip);
        const [s, e] = ranges[si] ?? [tag.from, tag.to];
        let fr = 0;
        let sms = 0;
        for (let i = s; i <= e; i += 1) {
          const f = data.frames[i];
          if (!f) {
            continue;
          }
          fr += 1;
          sms += f.duration;
        }
        if (fr > 0) {
          out.push({ clip, frames: fr, loop: false, ms: sms });
        }
      }
    }
  }
  return out;
};
