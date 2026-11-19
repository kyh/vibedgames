import type Phaser from "phaser";

import { SPELL_SHEETS } from "./fx-map";

interface AnimRange {
  name: "idle" | "walk" | "attack" | "death";
  start: number;
  end: number;
  fps: number;
  loop: boolean;
}

const UNIT_ANIMS = {
  archer: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 13, fps: 10, loop: true, name: "walk", start: 8 },
    { end: 22, fps: 16, loop: false, name: "attack", start: 16 },
  ],
  barrel: [
    { end: 11, fps: 8, loop: true, name: "idle", start: 6 },
    { end: 26, fps: 10, loop: true, name: "walk", start: 24 },
    { end: 32, fps: 12, loop: false, name: "attack", start: 30 },
    { end: 32, fps: 14, loop: false, name: "death", start: 30 },
  ],
  pawn: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 11, fps: 10, loop: true, name: "walk", start: 6 },
    { end: 17, fps: 14, loop: false, name: "attack", start: 12 },
  ],
  tnt: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 12, fps: 10, loop: true, name: "walk", start: 7 },
    { end: 19, fps: 14, loop: false, name: "attack", start: 14 },
  ],
  torch: [
    { end: 6, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 12, fps: 10, loop: true, name: "walk", start: 7 },
    { end: 19, fps: 14, loop: false, name: "attack", start: 14 },
  ],
  warrior: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 11, fps: 10, loop: true, name: "walk", start: 6 },
    { end: 17, fps: 14, loop: false, name: "attack", start: 12 },
  ],
} satisfies Record<string, AnimRange[]>;

const COLORS = ["blue", "red"];

const registerUnitAnims = (scene: Phaser.Scene) => {
  for (const [sheet, ranges] of Object.entries(UNIT_ANIMS)) {
    for (const color of COLORS) {
      const tex = `u-${sheet}-${color}`;

      if (!scene.textures.exists(tex)) {
        continue;
      }

      const total = scene.textures.get(tex).frameTotal - 1;

      for (const r of ranges) {
        const key = `${tex}-${r.name}`;

        if (scene.anims.exists(key)) {
          continue;
        }

        if (r.start > total - 1) {
          continue;
        }

        const end = Math.min(r.end, total - 1);
        scene.anims.create({
          frameRate: r.fps,
          frames: scene.anims.generateFrameNumbers(tex, { end, start: r.start }),
          key,
          repeat: r.loop ? -1 : 0,
        });
      }
    }
  }
};

const registerSpellAnims = (scene: Phaser.Scene) => {
  for (const s of SPELL_SHEETS) {
    if (!scene.textures.exists(s.key)) {
      continue;
    }

    const end = Math.min(s.frames, scene.textures.get(s.key).frameTotal - 1) - 1;

    if (end < 0) {
      continue;
    }

    if (!scene.anims.exists(s.key)) {
      scene.anims.create({
        frameRate: s.fps,
        frames: scene.anims.generateFrameNumbers(s.key, { end, start: 0 }),
        key: s.key,
        repeat: 0,
      });
    }

    if (!scene.anims.exists(`${s.key}-loop`)) {
      scene.anims.create({
        frameRate: s.fps,
        frames: scene.anims.generateFrameNumbers(s.key, { end, start: 0 }),
        key: `${s.key}-loop`,
        repeat: -1,
      });
    }
  }
};

export const registerAnims = (scene: Phaser.Scene) => {
  registerUnitAnims(scene);

  if (scene.textures.exists("fx-explosion") && !scene.anims.exists("fx-explode")) {
    scene.anims.create({
      frameRate: 18,
      frames: scene.anims.generateFrameNumbers("fx-explosion", { end: 8, start: 0 }),
      key: "fx-explode",
      repeat: 0,
    });
  }

  if (scene.textures.exists("fx-fire") && !scene.anims.exists("fx-fire-loop")) {
    scene.anims.create({
      frameRate: 12,
      frames: scene.anims.generateFrameNumbers("fx-fire", { end: 6, start: 0 }),
      key: "fx-fire-loop",
      repeat: -1,
    });
  }

  const oneShot = (key: string, tex: string, fps: number) => {
    if (!scene.textures.exists(tex) || scene.anims.exists(key)) {
      return;
    }

    const end = scene.textures.get(tex).frameTotal - 2;

    if (end < 0) {
      return;
    }

    scene.anims.create({
      frameRate: fps,
      frames: scene.anims.generateFrameNumbers(tex, { end, start: 0 }),
      key,
      repeat: 0,
    });
  };

  oneShot("fx-dust1", "fx-dust1", 14);
  oneShot("fx-dust2", "fx-dust2", 16);
  oneShot("fx-explode1", "fx-explode1", 16);
  oneShot("fx-explode2", "fx-explode2", 16);
  oneShot("fx-splash", "fx-splash", 11);
  oneShot("skull-pop", "skull-pop", 13);

  const loop = (key: string, tex: string, fps: number) => {
    if (!scene.textures.exists(tex) || scene.anims.exists(key)) {
      return;
    }

    const end = scene.textures.get(tex).frameTotal - 2;

    if (end < 0) {
      return;
    }

    scene.anims.create({
      frameRate: fps,
      frames: scene.anims.generateFrameNumbers(tex, { end, start: 0 }),
      key,
      repeat: -1,
    });
  };

  loop("foam-loop", "foam", 9);

  for (let i = 1; i <= 3; i += 1) {
    loop(`fx-flame${i}`, `fx-flame${i}`, 11);
  }

  for (let i = 1; i <= 4; i += 1) {
    loop(`deco-bush${i}-sway`, `deco-bush${i}`, 7);
  }

  for (let i = 1; i <= 4; i += 1) {
    loop(`wrock${i}-anim`, `wrock${i}`, 7);
  }

  for (let i = 1; i <= 4; i += 1) {
    loop(`ftree${i}-sway`, `ftree${i}`, 6);
  }

  if (scene.textures.exists("t-tree") && !scene.anims.exists("tree-sway")) {
    scene.anims.create({
      frameRate: 5,
      frames: scene.anims.generateFrameNumbers("t-tree", { end: 5, start: 0 }),
      key: "tree-sway",
      repeat: -1,
    });
  }

  registerSpellAnims(scene);

  if (scene.textures.exists("sp-fireball") && !scene.anims.exists("sp-fireball-fly")) {
    scene.anims.create({
      frameRate: 16,
      frames: scene.anims.generateFrameNumbers("sp-fireball", { end: 8, start: 5 }),
      key: "sp-fireball-fly",
      repeat: -1,
    });
  }

  loop("sheep-idle", "sheep", 8);
  loop("e-skull-idle", "e-skull-idle", 8);
  loop("e-skull-walk", "e-skull-run", 12);
  loop("e-gnoll-idle", "e-gnoll-idle", 8);
  loop("e-gnoll-walk", "e-gnoll-walk", 12);
  loop("e-minotaur-idle", "e-minotaur-idle", 10);
  loop("e-minotaur-walk", "e-minotaur-walk", 12);
};
