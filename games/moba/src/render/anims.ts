import Phaser from "phaser";

// Per-sheet animation frame ranges (0-indexed, row-major over the 192px grid).
// Ranges follow Tiny Swords conventions; tune live if a pose looks off.
type AnimRange = { name: "idle" | "walk" | "attack"; start: number; end: number; fps: number; loop: boolean };

const UNIT_ANIMS: Record<string, AnimRange[]> = {
  warrior: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 6, end: 11, fps: 11, loop: true },
    { name: "attack", start: 12, end: 17, fps: 13, loop: true },
  ],
  pawn: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 6, end: 11, fps: 11, loop: true },
    { name: "attack", start: 12, end: 17, fps: 13, loop: true },
  ],
  archer: [
    { name: "idle", start: 0, end: 7, fps: 8, loop: true },
    { name: "walk", start: 8, end: 15, fps: 11, loop: true },
    { name: "attack", start: 16, end: 23, fps: 13, loop: true },
  ],
  torch: [
    { name: "idle", start: 0, end: 6, fps: 8, loop: true },
    { name: "walk", start: 7, end: 13, fps: 11, loop: true },
    { name: "attack", start: 14, end: 20, fps: 13, loop: true },
  ],
  tnt: [
    { name: "idle", start: 0, end: 6, fps: 8, loop: true },
    { name: "walk", start: 7, end: 13, fps: 11, loop: true },
    { name: "attack", start: 14, end: 20, fps: 13, loop: true },
  ],
  barrel: [
    { name: "idle", start: 0, end: 3, fps: 8, loop: true },
    { name: "walk", start: 4, end: 7, fps: 10, loop: true },
    { name: "attack", start: 8, end: 11, fps: 12, loop: true },
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
      frameRate: 20,
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
}
