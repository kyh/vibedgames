import type Phaser from "phaser";

import { SPELL_SHEETS } from "./fx-map";

// Per-sheet animation frame ranges. Every range was verified frame-by-frame
// against labeled contact sheets of the actual art (see /tmp/sheets): ranges stop
// before the empty padding cells that pad non-square sheets, and each range covers
// exactly one legible, complete motion. idle/walk loop; attack plays once.
//
// DEATH: the unit sheets do NOT contain a death sequence —
// the "extra" rows are idle variants or directional attacks (NOT a death). Only
// the Barrel goblin has a real death (its explosion). So death is declared ONLY
// where it genuinely exists; every other unit falls back to a procedural collapse
// (topple + sink + fade) in view.ts. Never map a non-death row to "death".
interface AnimRange {
  name: "idle" | "walk" | "attack" | "death";
  start: number;
  end: number;
  fps: number;
  loop: boolean;
}

const UNIT_ANIMS = {
  archer: [
    // 8-wide sheet: cols 7-8 of rows 0-1 are empty padding — idle/walk stop before them.
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 13, fps: 10, loop: true, name: "walk", start: 8 },
    // raise→draw→loose (rows 4-7 = more fire dirs, no death)
    { end: 22, fps: 16, loop: false, name: "attack", start: 16 },
  ],
  // barrel is a 6×6 grid of 128px frames (everything else is 192): row 1 = the
  // goblin peeking out (idle), row 4 = scuttling on little feet (walk), row 5 =
  // fuse lit + red flash (attack AND death — it explodes either way).
  barrel: [
    { end: 11, fps: 8, loop: true, name: "idle", start: 6 },
    { end: 26, fps: 10, loop: true, name: "walk", start: 24 },
    { end: 32, fps: 12, loop: false, name: "attack", start: 30 },
    { end: 32, fps: 14, loop: false, name: "death", start: 30 },
  ],
  pawn: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 11, fps: 10, loop: true, name: "walk", start: 6 },
    // rows 4-5 are idle variants, not death
    { end: 17, fps: 14, loop: false, name: "attack", start: 12 },
  ],
  tnt: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 12, fps: 10, loop: true, name: "walk", start: 7 },
    { end: 19, fps: 14, loop: false, name: "attack", start: 14 },
  ],
  torch: [
    // 7-wide sheet, col 7 of rows 1-4 is empty padding — ranges stop before it.
    { end: 6, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 12, fps: 10, loop: true, name: "walk", start: 7 },
    { end: 19, fps: 14, loop: false, name: "attack", start: 14 },
  ],
  warrior: [
    { end: 5, fps: 8, loop: true, name: "idle", start: 0 },
    { end: 11, fps: 10, loop: true, name: "walk", start: 6 },
    // clean down-slash (rows 3-7 = more attack dirs, no death)
    { end: 17, fps: 14, loop: false, name: "attack", start: 12 },
  ],
} satisfies Record<string, AnimRange[]>;

const COLORS = ["blue", "red"];

const registerUnitAnims = (scene: Phaser.Scene): void => {
  for (const [sheet, ranges] of Object.entries(UNIT_ANIMS)) {
    for (const color of COLORS) {
      const tex = `u-${sheet}-${color}`;
      if (!scene.textures.exists(tex)) {
        continue;
      }
      // -1: __BASE frame
      const total = scene.textures.get(tex).frameTotal - 1;
      for (const r of ranges) {
        const key = `${tex}-${r.name}`;
        if (scene.anims.exists(key)) {
          continue;
        }
        if (r.start > total - 1) {
          continue;
          // sheet smaller than expected — skip
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

// spell effects: a one-shot (`<key>`) for cast bursts/impacts and a loop
// (`<key>-loop`) for persistent ground/aura zones.
const registerSpellAnims = (scene: Phaser.Scene): void => {
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

export const registerAnims = (scene: Phaser.Scene): void => {
  registerUnitAnims(scene);

  // FX
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
    // one-shot fx from the particle FX sheets (full sheet, derived count)
  }
  const oneShot = (key: string, tex: string, fps: number): void => {
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
  // bouncing skull on unit death, then sinks
  oneShot("skull-pop", "skull-pop", 13);

  // ambient + neutral loops (full sheet, derived frame count)
  const loop = (key: string, tex: string, fps: number): void => {
    if (!scene.textures.exists(tex) || scene.anims.exists(key)) {
      return;
    }
    // -1 __BASE, -1 to last index
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
  // the pine sheet's frames 0-5 are the gentle sway; the rest are hit/stump cells
  if (scene.textures.exists("t-tree") && !scene.anims.exists("tree-sway")) {
    scene.anims.create({
      frameRate: 5,
      frames: scene.anims.generateFrameNumbers("t-tree", { end: 5, start: 0 }),
      key: "tree-sway",
      repeat: -1,
    });
  }
  registerSpellAnims(scene);

  // fireball PROJECTILE: just the formed-and-flying frames (3-8), looped — NOT the
  // grow-in or the explosion burst at the tail of the strip (those made it look
  // like it kept detonating mid-flight). The tail points -x, so the renderer
  // rotates it to face travel.
  if (scene.textures.exists("sp-fireball") && !scene.anims.exists("sp-fireball-fly")) {
    scene.anims.create({
      frameRate: 16,
      // formed-ball frames only (skip the small grow-in 0-4 and the burst 9+) so
      // the projectile holds a steady size with a flickering tail instead of pulsing
      frames: scene.anims.generateFrameNumbers("sp-fireball", { end: 8, start: 5 }),
      key: "sp-fireball-fly",
      repeat: -1,
    });
  }

  loop("sheep-idle", "sheep", 8);
  // enemy-pack neutrals: idle from *_idle sheet, walk from *_run/_walk sheet
  loop("e-skull-idle", "e-skull-idle", 8);
  loop("e-skull-walk", "e-skull-run", 12);
  loop("e-gnoll-idle", "e-gnoll-idle", 8);
  loop("e-gnoll-walk", "e-gnoll-walk", 12);
  loop("e-minotaur-idle", "e-minotaur-idle", 10);
  loop("e-minotaur-walk", "e-minotaur-walk", 12);
};
