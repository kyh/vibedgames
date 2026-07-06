import Phaser from "phaser";

import { BASE_H, BASE_W, COLORS } from "../config";

// Lightweight VFX. Mostly texture-free shapes with auto-destroying tweens, plus a
// runtime radial-glow texture ("fx-glow") for additive neon bloom + particles.
// Pixel-art friendly and cheap on mobile.

// Build the soft radial glow once (accumulated translucent circles => falloff).
export function ensureGlow(scene: Phaser.Scene) {
  if (scene.textures.exists("fx-glow")) return;
  const R = 24;
  const g = scene.make.graphics({ x: 0, y: 0 });
  for (let i = R; i > 0; i--) {
    g.fillStyle(0xffffff, 0.05);
    g.fillCircle(R, R, i);
  }
  g.generateTexture("fx-glow", R * 2, R * 2);
  g.destroy();
}

function glow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  scale: number,
  ms: number,
  depth = 60,
) {
  ensureGlow(scene);
  const s = scene.add
    .image(x, y, "fx-glow")
    .setTint(color)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setScale(scale)
    .setDepth(depth);
  scene.tweens.add({
    targets: s,
    scale: scale * 1.6,
    alpha: 0,
    duration: ms,
    ease: "Quad.easeOut",
    onComplete: () => s.destroy(),
  });
}

export function hitSpark(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number = COLORS.teal,
  n = 6,
) {
  glow(scene, x, y, color, 0.5, 150, 61);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 12 + Math.random() * 26;
    const len = 2 + Math.random() * 3;
    const p = scene.add
      .rectangle(x, y, len, 2, color)
      .setDepth(60)
      .setBlendMode(Phaser.BlendModes.ADD);
    p.setRotation(a);
    scene.tweens.add({
      targets: p,
      x: x + Math.cos(a) * sp,
      y: y + Math.sin(a) * sp,
      alpha: 0,
      duration: 160 + Math.random() * 150,
      ease: "Quad.easeOut",
      onComplete: () => p.destroy(),
    });
  }
  const core = scene.add.circle(x, y, 3, 0xffffff, 0.95).setDepth(62);
  scene.tweens.add({
    targets: core,
    scale: 2.4,
    alpha: 0,
    duration: 130,
    onComplete: () => core.destroy(),
  });
}

// Expanding neon ring + bloom — for kills, heavy hits, and impacts.
export function impactRing(
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number = COLORS.teal,
  r = 20,
) {
  glow(scene, x, y, color, 0.7, 200, 62);
  const ring = scene.add
    .circle(x, y, r * 0.4, color, 0)
    .setStrokeStyle(2, color, 0.9)
    .setDepth(62)
    .setBlendMode(Phaser.BlendModes.ADD);
  scene.tweens.add({
    targets: ring,
    scale: 2.6,
    alpha: 0,
    duration: 300,
    ease: "Cubic.easeOut",
    onComplete: () => ring.destroy(),
  });
}

// A crescent blade arc that sweeps through the strike, not a round blob. Two
// stacked arcs (colored body + white leading edge) drawn at the origin then
// positioned + mirrored by facing, so they read as a directional slash.
export function slash(
  scene: Phaser.Scene,
  x: number,
  y: number,
  facing: number,
  reach: number,
  color: number = COLORS.white,
) {
  const cx = x + facing * reach * 0.5;
  const start = Phaser.Math.DegToRad(-58);
  const end = Phaser.Math.DegToRad(58);
  const crescent = (r: number, w: number, col: number, alpha: number, depth: number) => {
    const g = scene.add.graphics({ x: cx, y }).setDepth(depth).setBlendMode(Phaser.BlendModes.ADD);
    g.lineStyle(w, col, alpha);
    g.beginPath();
    g.arc(0, 0, r, start, end, false);
    g.strokePath();
    g.setScale(facing, 1); // mirror for a left-facing swing
    g.setRotation(-0.55);
    scene.tweens.add({
      targets: g,
      rotation: 0.6,
      alpha: 0,
      duration: 130,
      ease: "Quad.easeOut",
      onComplete: () => g.destroy(),
    });
    return g;
  };
  crescent(reach, 3, color, 0.9, 59); // colored body
  crescent(reach * 0.94, 1.5, 0xffffff, 0.85, 60); // bright leading edge
  // a small tip spark for punch — no fat round glow (that read as "a circle")
  hitSpark(scene, cx + facing * reach * 0.55, y - reach * 0.25, color, 3);
}

// Ghost trail copy of a sprite's current frame — for dashes / fast moves.
export function afterImage(
  scene: Phaser.Scene,
  spr: Phaser.GameObjects.Sprite,
  color: number = COLORS.teal,
) {
  const g = scene.add
    .image(spr.x, spr.y, spr.texture.key, spr.frame.name)
    .setOrigin(spr.originX, spr.originY)
    .setScale(spr.scaleX, spr.scaleY)
    .setFlipX(spr.flipX)
    .setTint(color)
    .setAlpha(0.4)
    .setBlendMode(Phaser.BlendModes.ADD)
    .setDepth(spr.depth - 1);
  scene.tweens.add({
    targets: g,
    alpha: 0,
    duration: 240,
    ease: "Quad.easeOut",
    onComplete: () => g.destroy(),
  });
}

export function dust(scene: Phaser.Scene, x: number, y: number) {
  for (let i = -1; i <= 1; i += 2) {
    const p = scene.add.circle(x, y, 2, 0x9aa6b2, 0.5).setDepth(20);
    scene.tweens.add({
      targets: p,
      x: x + i * (6 + Math.random() * 6),
      y: y - 2,
      alpha: 0,
      scale: 0.4,
      duration: 220,
      onComplete: () => p.destroy(),
    });
  }
}

// Bigger landing burst — sideways puffs + a low glow.
export function landPuff(scene: Phaser.Scene, x: number, y: number) {
  for (let i = -1; i <= 1; i += 2) {
    for (let k = 0; k < 3; k++) {
      const p = scene.add.circle(x, y, 1 + Math.random() * 2, 0xaeb8c4, 0.55).setDepth(20);
      scene.tweens.add({
        targets: p,
        x: x + i * (8 + Math.random() * 12),
        y: y - Math.random() * 4,
        alpha: 0,
        scale: 0.3,
        duration: 240 + Math.random() * 120,
        ease: "Quad.easeOut",
        onComplete: () => p.destroy(),
      });
    }
  }
}

export function explosion(scene: Phaser.Scene, x: number, y: number, r: number) {
  glow(scene, x, y, COLORS.magenta, r / 18, 240, 62);
  const flash = scene.add.circle(x, y, r * 0.55, 0xffffff, 0.9).setDepth(63);
  scene.tweens.add({
    targets: flash,
    scale: 1.9,
    alpha: 0,
    duration: 180,
    onComplete: () => flash.destroy(),
  });
  const ring = scene.add
    .circle(x, y, r, COLORS.magenta, 0)
    .setStrokeStyle(2, COLORS.magenta, 0.9)
    .setDepth(62)
    .setBlendMode(Phaser.BlendModes.ADD);
  scene.tweens.add({
    targets: ring,
    scale: 1.4,
    alpha: 0,
    duration: 280,
    ease: "Quad.easeOut",
    onComplete: () => ring.destroy(),
  });
  hitSpark(scene, x, y, COLORS.magenta, 14);
}

// Slow-drifting neon embers for room ambience. Returns the emitter to destroy on
// room change.
export function ambientEmbers(
  scene: Phaser.Scene,
  color: number = COLORS.teal,
): Phaser.GameObjects.Particles.ParticleEmitter {
  ensureGlow(scene);
  return scene.add
    .particles(0, 0, "fx-glow", {
      x: { min: 0, max: BASE_W },
      y: { min: BASE_H * 0.3, max: BASE_H },
      lifespan: 4200,
      speedY: { min: -10, max: -26 },
      speedX: { min: -8, max: 8 },
      scale: { start: 0.11, end: 0 },
      alpha: { start: 0.45, end: 0 },
      frequency: 340,
      quantity: 1,
      tint: color,
      blendMode: Phaser.BlendModes.ADD,
    })
    .setDepth(3);
}

export function popText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color = "#f4f7fb",
) {
  const t = scene.add
    .text(x, y, text, { fontFamily: "monospace", fontSize: "9px", color })
    .setOrigin(0.5, 1)
    .setDepth(70);
  scene.tweens.add({
    targets: t,
    y: y - 12,
    alpha: 0,
    duration: 600,
    ease: "Quad.easeOut",
    onComplete: () => t.destroy(),
  });
}
