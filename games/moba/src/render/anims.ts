import Phaser from "phaser";

// Per-sheet animation frame ranges, taken from the Tiny Swords sheet layouts
// (design/assets.json). Using the FULL attack range (not a truncated slice) makes
// the swings read as complete motions. idle/walk loop; attack/death play once.
type AnimRange = { name: "idle" | "walk" | "attack" | "death"; start: number; end: number; fps: number; loop: boolean };

const UNIT_ANIMS: Record<string, AnimRange[]> = {
  warrior: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 6, end: 11, fps: 10, loop: true },
    { name: "attack", start: 12, end: 23, fps: 16, loop: false },
    { name: "death", start: 36, end: 47, fps: 12, loop: false },
  ],
  pawn: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 6, end: 11, fps: 10, loop: true },
    { name: "attack", start: 12, end: 17, fps: 14, loop: false },
    { name: "death", start: 24, end: 35, fps: 12, loop: false },
  ],
  archer: [
    { name: "idle", start: 0, end: 7, fps: 8, loop: true },
    { name: "walk", start: 8, end: 15, fps: 10, loop: true },
    { name: "attack", start: 16, end: 31, fps: 18, loop: false },
    { name: "death", start: 40, end: 55, fps: 12, loop: false },
  ],
  torch: [
    { name: "idle", start: 0, end: 6, fps: 8, loop: true },
    { name: "walk", start: 7, end: 13, fps: 10, loop: true },
    { name: "attack", start: 14, end: 27, fps: 16, loop: false },
    { name: "death", start: 28, end: 34, fps: 12, loop: false },
  ],
  tnt: [
    { name: "idle", start: 0, end: 6, fps: 8, loop: true },
    { name: "walk", start: 7, end: 13, fps: 10, loop: true },
    { name: "attack", start: 14, end: 20, fps: 14, loop: false },
  ],
  barrel: [
    { name: "idle", start: 0, end: 3, fps: 8, loop: true },
    { name: "walk", start: 4, end: 7, fps: 8, loop: true },
    { name: "attack", start: 8, end: 11, fps: 12, loop: false },
    { name: "death", start: 12, end: 15, fps: 10, loop: false },
  ],
};

const COLORS = ["blue", "red", "purple", "yellow"];

export function registerAnims(scene: Phaser.Scene): void {
  for (const [sheet, ranges] of Object.entries(UNIT_ANIMS)) {
    for (const color of COLORS) {
      const tex = `u-${sheet}-${color}`;
      if (!scene.textures.exists(tex)) continue;
      const total = scene.textures.get(tex).frameTotal - 1; // -1: __BASE frame
      for (const r of ranges) {
        const key = `${tex}-${r.name}`;
        if (scene.anims.exists(key)) continue;
        if (r.start > total - 1) continue; // sheet smaller than expected — skip
        const end = Math.min(r.end, total - 1);
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(tex, { start: r.start, end }),
          frameRate: r.fps,
          repeat: r.loop ? -1 : 0,
        });
      }
    }
  }

  // FX
  if (scene.textures.exists("fx-explosion") && !scene.anims.exists("fx-explode")) {
    scene.anims.create({
      key: "fx-explode",
      frames: scene.anims.generateFrameNumbers("fx-explosion", { start: 0, end: 8 }),
      frameRate: 18,
      repeat: 0,
    });
  }
  if (scene.textures.exists("fx-fire") && !scene.anims.exists("fx-fire-loop")) {
    scene.anims.create({
      key: "fx-fire-loop",
      frames: scene.anims.generateFrameNumbers("fx-fire", { start: 0, end: 6 }),
      frameRate: 12,
      repeat: -1,
    });
  }
  if (scene.textures.exists("t-foam") && !scene.anims.exists("t-foam-loop")) {
    scene.anims.create({
      key: "t-foam-loop",
      frames: scene.anims.generateFrameNumbers("t-foam", { start: 0, end: 7 }),
      frameRate: 8,
      repeat: -1,
    });
  }

  // ambient + neutral loops (full sheet, derived frame count)
  const loop = (key: string, tex: string, fps: number): void => {
    if (!scene.textures.exists(tex) || scene.anims.exists(key)) return;
    const end = scene.textures.get(tex).frameTotal - 2; // -1 __BASE, -1 to last index
    if (end < 0) return;
    scene.anims.create({ key, frames: scene.anims.generateFrameNumbers(tex, { start: 0, end }), frameRate: fps, repeat: -1 });
  };
  for (let i = 1; i <= 4; i++) loop(`wrock${i}-anim`, `wrock${i}`, 7);
  for (let i = 1; i <= 4; i++) loop(`ftree${i}-sway`, `ftree${i}`, 6);
  loop("sheep-idle", "sheep", 8);
  // enemy-pack neutrals: idle from *_idle sheet, walk from *_run/_walk sheet
  loop("e-skull-idle", "e-skull-idle", 8);
  loop("e-skull-walk", "e-skull-run", 12);
  loop("e-gnoll-idle", "e-gnoll-idle", 8);
  loop("e-gnoll-walk", "e-gnoll-walk", 12);
  loop("e-minotaur-idle", "e-minotaur-idle", 10);
  loop("e-minotaur-walk", "e-minotaur-walk", 12);
}
