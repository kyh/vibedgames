// Animation manifest. Frame counts are derived from the loaded texture at boot
// (Phaser's generateFrameNumbers reads them), so we only list clip names here
// plus a name->fps/loop heuristic. Keys are `${who}:${clip}`.

export const HERO_CLIPS = {
  axion: ["idle", "run", "jump", "fall", "dash", "hurt", "death", "attack-1", "attack-2", "attack-3", "super-smash"],
  reaper: ["idle", "idle-break", "run", "jump", "fall", "dash", "hurt", "death", "attack", "slash", "double-slash", "skill", "surprise-jump"],
  riven: ["idle", "idle-break", "run", "jump", "fall", "dash", "hurt", "death", "slash", "double-slash", "special-skill", "smoke-in", "smoke-out"],
  mooni: ["idle", "idle-break", "run", "jump", "fall", "hurt", "death", "heal", "smash", "special-skill", "spin", "thrust"],
  salamander: ["idle", "run", "jump", "fall", "dash", "hit", "death", "fire-punch", "flame-slam", "flame-wave"],
} as const;

export const ENEMY_CLIPS = {
  warrior: ["idle", "run", "spawn", "hit", "strike", "slashes", "dead"],
  bomber: ["idle", "run", "spawn", "hit", "explode", "electrocute", "death"],
  archer: ["idle", "run", "spawn", "hit", "shoot", "super-shoot", "death"],
  spearman: ["idle", "run", "spawn", "hit", "strike", "charge", "death"],
} as const;

export type HeroName = keyof typeof HERO_CLIPS;
export type EnemyName = keyof typeof ENEMY_CLIPS;

const LOOPING = new Set(["idle", "idle-break", "run", "fall"]);

const FPS: Record<string, number> = {
  idle: 7,
  "idle-break": 8,
  run: 14,
  jump: 10,
  fall: 8,
  dash: 22,
  hurt: 14,
  hit: 14,
  death: 12,
  dead: 12,
  spawn: 14,
  heal: 14,
  "smoke-in": 18,
  "smoke-out": 18,
};

// Everything else (attacks, slashes, skills) reads as an action clip.
const ACTION_FPS = 18;

export function clipFps(name: string): number {
  return FPS[name] ?? ACTION_FPS;
}

export function clipLoops(name: string): boolean {
  return LOOPING.has(name);
}
