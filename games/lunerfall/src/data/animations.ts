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
  riven: { "Single Slash": "slash", "Smoke Bomb In": "smoke-in", "Smoke Bomb Out": "smoke-out" },
  salamander: { Hit: ["hit", "hurt"] },
};

const slug = (tag: string): string => tag.toLowerCase().replace(/\s+/g, "-");

type AseFrame = { filename: string; duration: number };
type AseData = { frames: AseFrame[]; meta: { frameTags: { name: string; from: number; to: number }[] } };

function isAseData(v: unknown): v is AseData {
  if (typeof v !== "object" || v === null || !("frames" in v) || !("meta" in v)) return false;
  const meta = v.meta;
  if (!Array.isArray(v.frames) || typeof meta !== "object" || meta === null || !("frameTags" in meta)) return false;
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
    const clips = mapped === undefined ? [slug(tag.name)] : Array.isArray(mapped) ? mapped : [mapped];

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
      scene.anims.create({ key: animKey, frames, duration: total, repeat: LOOPING.has(clip) ? -1 : 0 });
    }
  }
}

// First real frame name for an atlas (frame 0 is a blank spacer), so a sprite has
// a sane frame before it plays.
export function firstFrame(scene: Phaser.Scene, key: string): string | undefined {
  const data: unknown = scene.cache.json.get(key);
  return isAseData(data) ? data.frames[1]?.filename : undefined;
}
