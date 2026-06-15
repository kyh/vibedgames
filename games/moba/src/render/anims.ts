import Phaser from "phaser";

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
type AnimRange = {
  name: "idle" | "walk" | "attack" | "death";
  start: number;
  end: number;
  fps: number;
  loop: boolean;
};

const UNIT_ANIMS: Record<string, AnimRange[]> = {
  warrior: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 6, end: 11, fps: 10, loop: true },
    { name: "attack", start: 12, end: 17, fps: 14, loop: false }, // clean down-slash (rows 3-7 = more attack dirs, no death)
  ],
  pawn: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 6, end: 11, fps: 10, loop: true },
    { name: "attack", start: 12, end: 17, fps: 14, loop: false }, // rows 4-5 are idle variants, not death
  ],
  archer: [
    // 8-wide sheet: cols 7-8 of rows 0-1 are empty padding — idle/walk stop before them.
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 8, end: 13, fps: 10, loop: true },
    { name: "attack", start: 16, end: 22, fps: 16, loop: false }, // raise→draw→loose (rows 4-7 = more fire dirs, no death)
  ],
  torch: [
    // 7-wide sheet, col 7 of rows 1-4 is empty padding — ranges stop before it.
    { name: "idle", start: 0, end: 6, fps: 8, loop: true },
    { name: "walk", start: 7, end: 12, fps: 10, loop: true },
    { name: "attack", start: 14, end: 19, fps: 14, loop: false },
  ],
  tnt: [
    { name: "idle", start: 0, end: 5, fps: 8, loop: true },
    { name: "walk", start: 7, end: 12, fps: 10, loop: true },
    { name: "attack", start: 14, end: 19, fps: 14, loop: false },
  ],
  // barrel is a 6×6 grid of 128px frames (everything else is 192): row 1 = the
  // goblin peeking out (idle), row 4 = scuttling on little feet (walk), row 5 =
  // fuse lit + red flash (attack AND death — it explodes either way).
  barrel: [
    { name: "idle", start: 6, end: 11, fps: 8, loop: true },
    { name: "walk", start: 24, end: 26, fps: 10, loop: true },
    { name: "attack", start: 30, end: 32, fps: 12, loop: false },
    { name: "death", start: 30, end: 32, fps: 14, loop: false },
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
  } // one-shot fx from the particle FX sheets (full sheet, derived count)
  const oneShot = (key: string, tex: string, fps: number): void => {
    if (!scene.textures.exists(tex) || scene.anims.exists(key)) return;
    const end = scene.textures.get(tex).frameTotal - 2;
    if (end < 0) return;
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(tex, { start: 0, end }),
      frameRate: fps,
      repeat: 0,
    });
  };
  oneShot("fx-dust1", "fx-dust1", 14);
  oneShot("fx-dust2", "fx-dust2", 16);
  oneShot("fx-explode1", "fx-explode1", 16);
  oneShot("fx-explode2", "fx-explode2", 16);
  oneShot("fx-splash", "fx-splash", 11);
  oneShot("skull-pop", "skull-pop", 13); // bouncing skull on unit death, then sinks

  // ambient + neutral loops (full sheet, derived frame count)
  const loop = (key: string, tex: string, fps: number): void => {
    if (!scene.textures.exists(tex) || scene.anims.exists(key)) return;
    const end = scene.textures.get(tex).frameTotal - 2; // -1 __BASE, -1 to last index
    if (end < 0) return;
    scene.anims.create({
      key,
      frames: scene.anims.generateFrameNumbers(tex, { start: 0, end }),
      frameRate: fps,
      repeat: -1,
    });
  };
  loop("foam-loop", "foam", 9);
  for (let i = 1; i <= 3; i++) loop(`fx-flame${i}`, `fx-flame${i}`, 11);
  for (let i = 1; i <= 4; i++) loop(`deco-bush${i}-sway`, `deco-bush${i}`, 7);
  for (let i = 1; i <= 4; i++) loop(`wrock${i}-anim`, `wrock${i}`, 7);
  for (let i = 1; i <= 4; i++) loop(`ftree${i}-sway`, `ftree${i}`, 6);
  // the pine sheet's frames 0-5 are the gentle sway; the rest are hit/stump cells
  if (scene.textures.exists("t-tree") && !scene.anims.exists("tree-sway")) {
    scene.anims.create({
      key: "tree-sway",
      frames: scene.anims.generateFrameNumbers("t-tree", { start: 0, end: 5 }),
      frameRate: 5,
      repeat: -1,
    });
  }
  // spell effects: a one-shot (`<key>`) for cast bursts/impacts and a loop
  // (`<key>-loop`) for persistent ground/aura zones.
  for (const s of SPELL_SHEETS) {
    if (!scene.textures.exists(s.key)) continue;
    const end = Math.min(s.frames, scene.textures.get(s.key).frameTotal - 1) - 1;
    if (end < 0) continue;
    if (!scene.anims.exists(s.key))
      scene.anims.create({
        key: s.key,
        frames: scene.anims.generateFrameNumbers(s.key, { start: 0, end }),
        frameRate: s.fps,
        repeat: 0,
      });
    if (!scene.anims.exists(`${s.key}-loop`))
      scene.anims.create({
        key: `${s.key}-loop`,
        frames: scene.anims.generateFrameNumbers(s.key, { start: 0, end }),
        frameRate: s.fps,
        repeat: -1,
      });
  }

  // fireball PROJECTILE: just the formed-and-flying frames (3-8), looped — NOT the
  // grow-in or the explosion burst at the tail of the strip (those made it look
  // like it kept detonating mid-flight). The tail points -x, so the renderer
  // rotates it to face travel.
  if (scene.textures.exists("sp-fireball") && !scene.anims.exists("sp-fireball-fly")) {
    scene.anims.create({
      key: "sp-fireball-fly",
      // formed-ball frames only (skip the small grow-in 0-4 and the burst 9+) so
      // the projectile holds a steady size with a flickering tail instead of pulsing
      frames: scene.anims.generateFrameNumbers("sp-fireball", { start: 5, end: 8 }),
      frameRate: 16,
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
}
