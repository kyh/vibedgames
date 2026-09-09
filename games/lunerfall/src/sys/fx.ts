import type Phaser from "phaser";
import { BlendModes } from "phaser";

import { BASE_H, BASE_W, COLORS } from "../config";

// Lightweight VFX. Mostly texture-free shapes with auto-destroying tweens, plus a
// runtime radial-glow texture ("fx-glow") for additive neon bloom + particles.
// Pixel-art friendly and cheap on mobile.

// Build the soft radial glow once (accumulated translucent circles => falloff).
export const ensureGlow = (scene: Phaser.Scene) => {
  if (scene.textures.exists("fx-glow")) {
    return;
  }
  const R = 24;
  const g = scene.make.graphics({ x: 0, y: 0 });
  for (let i = R; i > 0; i -= 1) {
    // Taper the outer third to nothing: a flat 0.05 per ring left the texture
    // ~5% opaque at its own 48px border, and every caller scales it up and then
    // tweens 1.6x further — explosion() alone runs r/18 (3.3x for a boss kill,
    // 5.3x by the end of the tween), where an additive 5% edge reads as a hard
    // disc rim around the bloom instead of a falloff.
    g.fillStyle(0xff_ff_ff, 0.05 * Math.min(1, (R - i) / (R * 0.34)));
    g.fillCircle(R, R, i);
  }
  g.generateTexture("fx-glow", R * 2, R * 2);
  g.destroy();
};

const glow = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number,
  scale: number,
  ms: number,
  depth = 60,
) => {
  ensureGlow(scene);
  const s = scene.add
    .image(x, y, "fx-glow")
    .setTint(color)
    .setBlendMode(BlendModes.ADD)
    .setScale(scale)
    .setDepth(depth);
  scene.tweens.add({
    alpha: 0,
    duration: ms,
    ease: "Quad.easeOut",
    onComplete: () => s.destroy(),
    scale: scale * 1.6,
    targets: s,
  });
};

export const hitSpark = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number = COLORS.teal,
  n = 6,
) => {
  glow(scene, x, y, color, 0.5, 150, 61);
  for (let i = 0; i < n; i += 1) {
    const a = Math.random() * Math.PI * 2;
    const sp = 12 + Math.random() * 26;
    const len = 2 + Math.random() * 3;
    const p = scene.add.rectangle(x, y, len, 2, color).setDepth(60).setBlendMode(BlendModes.ADD);
    p.setRotation(a);
    scene.tweens.add({
      alpha: 0,
      duration: 160 + Math.random() * 150,
      ease: "Quad.easeOut",
      onComplete: () => p.destroy(),
      targets: p,
      x: x + Math.cos(a) * sp,
      y: y + Math.sin(a) * sp,
    });
  }
  const core = scene.add.circle(x, y, 3, 0xff_ff_ff, 0.95).setDepth(62);
  scene.tweens.add({
    alpha: 0,
    duration: 130,
    onComplete: () => core.destroy(),
    scale: 2.4,
    targets: core,
  });
};

// Expanding neon ring + bloom — for kills, heavy hits, and impacts.
export const impactRing = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  color: number = COLORS.teal,
  r = 20,
) => {
  glow(scene, x, y, color, 0.7, 200, 62);
  const ring = scene.add
    .circle(x, y, r * 0.4, color, 0)
    .setStrokeStyle(2, color, 0.9)
    .setDepth(62)
    .setBlendMode(BlendModes.ADD);
  scene.tweens.add({
    alpha: 0,
    duration: 300,
    ease: "Cubic.easeOut",
    onComplete: () => ring.destroy(),
    scale: 2.6,
    targets: ring,
  });
};

// Ghost trail copy of a sprite's current frame — for dashes / fast moves.
export const afterImage = (
  scene: Phaser.Scene,
  spr: Phaser.GameObjects.Sprite,
  color: number = COLORS.teal,
) => {
  const g = scene.add
    .image(spr.x, spr.y, spr.texture.key, spr.frame.name)
    .setOrigin(spr.originX, spr.originY)
    .setScale(spr.scaleX, spr.scaleY)
    .setFlipX(spr.flipX)
    .setTint(color)
    .setAlpha(0.4)
    .setBlendMode(BlendModes.ADD)
    .setDepth(spr.depth - 1);
  scene.tweens.add({
    alpha: 0,
    duration: 240,
    ease: "Quad.easeOut",
    onComplete: () => g.destroy(),
    targets: g,
  });
};

// Soft smoke puff for movement (run trails, wall-kicks). Grey + normal blend so
// it reads as kicked-up dust, not neon glow; drifts, grows, and fades.
export const smoke = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  vx: number,
  vy: number,
  size = 10,
  color = 0x7c_8a_a0,
) => {
  ensureGlow(scene);
  const s = scene.add
    .image(x, y, "fx-glow")
    .setTint(color)
    .setScale(size / 48)
    .setAlpha(0.42)
    .setDepth(18);
  scene.tweens.add({
    alpha: 0,
    duration: 340 + Math.random() * 160,
    ease: "Quad.easeOut",
    onComplete: () => s.destroy(),
    scale: (size / 48) * 2.1,
    targets: s,
    x: x + vx,
    y: y + vy,
  });
};

// Burst kicked off a wall on a wall-jump (side = the wall's direction, ±1).
export const wallSmoke = (scene: Phaser.Scene, x: number, y: number, side: number) => {
  for (let i = 0; i < 4; i += 1) {
    smoke(
      scene,
      x,
      y - i * 4,
      -side * (14 + Math.random() * 14),
      -8 + Math.random() * 14 - i * 2,
      8 + Math.random() * 6,
    );
  }
};

export const dust = (scene: Phaser.Scene, x: number, y: number) => {
  for (let i = -1; i <= 1; i += 2) {
    const p = scene.add.circle(x, y, 2, 0x9a_a6_b2, 0.5).setDepth(20);
    scene.tweens.add({
      alpha: 0,
      duration: 220,
      onComplete: () => p.destroy(),
      scale: 0.4,
      targets: p,
      x: x + i * (6 + Math.random() * 6),
      y: y - 2,
    });
  }
};

// Bigger landing burst — sideways puffs + a low glow.
export const landPuff = (scene: Phaser.Scene, x: number, y: number) => {
  for (let i = -1; i <= 1; i += 2) {
    for (let k = 0; k < 3; k += 1) {
      const p = scene.add.circle(x, y, 1 + Math.random() * 2, 0xae_b8_c4, 0.55).setDepth(20);
      scene.tweens.add({
        alpha: 0,
        duration: 240 + Math.random() * 120,
        ease: "Quad.easeOut",
        onComplete: () => p.destroy(),
        scale: 0.3,
        targets: p,
        x: x + i * (8 + Math.random() * 12),
        y: y - Math.random() * 4,
      });
    }
  }
};

export const explosion = (scene: Phaser.Scene, x: number, y: number, r: number) => {
  glow(scene, x, y, COLORS.magenta, r / 18, 240, 62);
  const flash = scene.add.circle(x, y, r * 0.55, 0xff_ff_ff, 0.9).setDepth(63);
  scene.tweens.add({
    alpha: 0,
    duration: 180,
    onComplete: () => flash.destroy(),
    scale: 1.9,
    targets: flash,
  });
  const ring = scene.add
    .circle(x, y, r, COLORS.magenta, 0)
    .setStrokeStyle(2, COLORS.magenta, 0.9)
    .setDepth(62)
    .setBlendMode(BlendModes.ADD);
  scene.tweens.add({
    alpha: 0,
    duration: 280,
    ease: "Quad.easeOut",
    onComplete: () => ring.destroy(),
    scale: 1.4,
    targets: ring,
  });
  hitSpark(scene, x, y, COLORS.magenta, 14);
};

// Slow-drifting neon embers for room ambience. Returns the emitter to destroy on
// room change.
export const ambientEmbers = (
  scene: Phaser.Scene,
  color: number = COLORS.teal,
  roomW: number = BASE_W,
  roomH: number = BASE_H,
): Phaser.GameObjects.Particles.ParticleEmitter => {
  ensureGlow(scene);
  return scene.add
    .particles(0, 0, "fx-glow", {
      alpha: { end: 0, start: 0.45 },
      blendMode: BlendModes.ADD,
      frequency: Math.max(80, 340 * (BASE_W / roomW)),
      lifespan: 4200,
      quantity: 1,
      scale: { end: 0, start: 0.11 },
      speedX: { max: 8, min: -8 },
      speedY: { max: -26, min: -10 },
      tint: color,
      x: { max: roomW, min: 0 },
      y: { max: roomH, min: roomH * 0.3 },
    })
    .setDepth(3);
};

export const popText = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color = "#f4f7fb",
) => {
  const t = scene.add
    .text(x, y, text, { color, fontFamily: "monospace", fontSize: "9px" })
    .setOrigin(0.5, 1)
    .setDepth(70);
  scene.tweens.add({
    alpha: 0,
    duration: 600,
    ease: "Quad.easeOut",
    onComplete: () => t.destroy(),
    targets: t,
    y: y - 12,
  });
};
