import type Phaser from "phaser";

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
const ALIASES: Record<string, Record<string, string | string[]>> = {
  axion: { Smash: "super-smash" },
  reaper: { "Special Skill": "skill", "Surprise Attack": "attack" },
  riven: {
    // "slash-heavy" = the same drawing as riven's opener, re-registered so the
    // combo finisher (different swing timing) gets its own retimed @kit variant.
    "Single Slash": ["slash", "slash-heavy"],
    "Smoke Bomb In": "smoke-in",
    "Smoke Bomb Out": "smoke-out",
  },
  salamander: { Hit: ["hit", "hurt"] },
};

const slug = (tag: string): string => tag.toLowerCase().replace(/\s+/g, "-");

// Tags that are one authored multi-slash flurry we want to drive ONE hit per
// press: split into equal contiguous frame slices, each its own clip the combo
// plays in sequence. So axion's 3-slash "Attack 3" becomes three single slashes
// (J → slash 1, J → slash 2, J → slash 3) instead of one long clip per press.
const SPLITS: Record<string, Record<string, string[]>> = {
  axion: { "Attack 3": ["attack-3a", "attack-3b", "attack-3c"] },
};

// Contiguous [from,to] atlas-frame ranges for n equal slices of a tag.
function sliceRanges(from: number, to: number, n: number): [number, number][] {
  const len = to - from + 1;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    out.push([from + Math.floor((i * len) / n), from + Math.floor(((i + 1) * len) / n) - 1]);
  }
  return out;
}

type AseFrame = { filename: string; duration: number };
type AseData = {
  frames: AseFrame[];
  meta: { frameTags: { name: string; from: number; to: number }[] };
};

function isAseData(v: unknown): v is AseData {
  if (typeof v !== "object" || v === null || !("frames" in v) || !("meta" in v)) return false;
  const meta = v.meta;
  if (
    !Array.isArray(v.frames) ||
    typeof meta !== "object" ||
    meta === null ||
    !("frameTags" in meta)
  )
    return false;
  return Array.isArray(meta.frameTags);
}

// Build one animation per Aseprite tag, with the tag's exact per-frame durations.
export function buildAnimsFromAseprite(scene: Phaser.Scene, key: string): void {
  const data: unknown = scene.cache.json.get(key);
  if (!isAseData(data)) return;
  const alias = ALIASES[key] ?? {};
  for (const tag of data.meta.frameTags) {
    if (tag.name === "Good!") continue; // pack's "select-all" meta tag
    const mapped = alias[tag.name];
    const clips =
      mapped === undefined ? [slug(tag.name)] : Array.isArray(mapped) ? mapped : [mapped];

    const frames: Phaser.Types.Animations.AnimationFrame[] = [];
    let total = 0;
    for (let i = tag.from; i <= tag.to; i++) {
      const f = data.frames[i];
      if (!f) continue;
      frames.push({ key, frame: f.filename, duration: f.duration });
      total += f.duration;
    }
    if (frames.length === 0) continue;

    for (const clip of clips) {
      const animKey = `${key}:${clip}`;
      if (scene.anims.exists(animKey)) continue;
      // duration (not frameRate) + per-frame durations => Phaser honours each
      // frame's authored ms exactly (mirrors createFromAseprite / nextTick logic).
      scene.anims.create({
        key: animKey,
        frames,
        duration: total,
        repeat: LOOPING.has(clip) ? -1 : 0,
      });
    }

    const splits = SPLITS[key]?.[tag.name];
    if (splits) {
      const ranges = sliceRanges(tag.from, tag.to, splits.length);
      splits.forEach((clip, si) => {
        const animKey = `${key}:${clip}`;
        if (scene.anims.exists(animKey)) return;
        const [s, e] = ranges[si] ?? [tag.from, tag.to];
        const sf: Phaser.Types.Animations.AnimationFrame[] = [];
        let d = 0;
        for (let i = s; i <= e; i++) {
          const f = data.frames[i];
          if (!f) continue;
          sf.push({ key, frame: f.filename, duration: f.duration });
          d += f.duration;
        }
        if (sf.length > 0) scene.anims.create({ key: animKey, frames: sf, duration: d, repeat: 0 });
      });
    }
  }
}

// First real frame name for an atlas (frame 0 is a blank spacer), so a sprite has
// a sane frame before it plays.
export function firstFrame(scene: Phaser.Scene, key: string): string | undefined {
  const data: unknown = scene.cache.json.get(key);
  return isAseData(data) ? data.frames[1]?.filename : undefined;
}

export type ClipInfo = { clip: string; frames: number; ms: number; loop: boolean };

// Enumerate an atlas's clips with their authored frame count + total duration —
// the data behind the ?editor gallery (and a quick way to spot a 1-frame / wrong
// clip). Mirrors buildAnimsFromAseprite's tag→clip mapping; dedupes shared slugs.
export function clipsFor(scene: Phaser.Scene, key: string): ClipInfo[] {
  const data: unknown = scene.cache.json.get(key);
  if (!isAseData(data)) return [];
  const alias = ALIASES[key] ?? {};
  const out: ClipInfo[] = [];
  const seen = new Set<string>();
  for (const tag of data.meta.frameTags) {
    if (tag.name === "Good!") continue;
    const mapped = alias[tag.name];
    const clips =
      mapped === undefined ? [slug(tag.name)] : Array.isArray(mapped) ? mapped : [mapped];
    let frames = 0;
    let ms = 0;
    for (let i = tag.from; i <= tag.to; i++) {
      const f = data.frames[i];
      if (!f) continue;
      frames++;
      ms += f.duration;
    }
    if (frames === 0) continue;
    for (const clip of clips) {
      if (seen.has(clip)) continue;
      seen.add(clip);
      out.push({ clip, frames, ms, loop: LOOPING.has(clip) });
    }

    const splits = SPLITS[key]?.[tag.name];
    if (splits) {
      const ranges = sliceRanges(tag.from, tag.to, splits.length);
      splits.forEach((clip, si) => {
        if (seen.has(clip)) return;
        seen.add(clip);
        const [s, e] = ranges[si] ?? [tag.from, tag.to];
        let fr = 0;
        let sms = 0;
        for (let i = s; i <= e; i++) {
          const f = data.frames[i];
          if (!f) continue;
          fr++;
          sms += f.duration;
        }
        if (fr > 0) out.push({ clip, frames: fr, ms: sms, loop: false });
      });
    }
  }
  return out;
}
