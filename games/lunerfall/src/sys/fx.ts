import Phaser from "phaser";

import { COLORS } from "../config";

// Lightweight, texture-free VFX: short-lived shapes with auto-destroying tweens.
// Pixel-art friendly and cheap on mobile.

export function hitSpark(scene: Phaser.Scene, x: number, y: number, color: number = COLORS.teal, n = 6) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 10 + Math.random() * 22;
    const p = scene.add.rectangle(x, y, 2, 2, color).setDepth(60);
    scene.tweens.add({
      targets: p,
      x: x + Math.cos(a) * sp,
      y: y + Math.sin(a) * sp,
      alpha: 0,
      duration: 160 + Math.random() * 140,
      ease: "Quad.easeOut",
      onComplete: () => p.destroy(),
    });
  }
  const core = scene.add.circle(x, y, 3, 0xffffff, 0.95).setDepth(61);
  scene.tweens.add({ targets: core, scale: 2.4, alpha: 0, duration: 130, onComplete: () => core.destroy() });
}

export function slash(scene: Phaser.Scene, x: number, y: number, facing: number, reach: number, color: number = COLORS.white) {
  const arc = scene.add.ellipse(x + (facing * reach) / 2, y, reach, reach * 1.4, color, 0.5).setDepth(59);
  arc.setScale(0.6, 1);
  scene.tweens.add({ targets: arc, scaleX: 1.1, alpha: 0, duration: 110, ease: "Quad.easeOut", onComplete: () => arc.destroy() });
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

export function explosion(scene: Phaser.Scene, x: number, y: number, r: number) {
  const flash = scene.add.circle(x, y, r * 0.6, 0xffffff, 0.9).setDepth(62);
  scene.tweens.add({ targets: flash, scale: 1.8, alpha: 0, duration: 180, onComplete: () => flash.destroy() });
  const ring = scene.add.circle(x, y, r, COLORS.magenta, 0).setStrokeStyle(2, COLORS.magenta, 0.9).setDepth(62);
  scene.tweens.add({ targets: ring, scale: 1.3, alpha: 0, duration: 260, ease: "Quad.easeOut", onComplete: () => ring.destroy() });
  hitSpark(scene, x, y, COLORS.magenta, 12);
}

export function popText(scene: Phaser.Scene, x: number, y: number, text: string, color = "#f4f7fb") {
  const t = scene.add
    .text(x, y, text, { fontFamily: "monospace", fontSize: "9px", color })
    .setOrigin(0.5, 1)
    .setDepth(70);
  scene.tweens.add({ targets: t, y: y - 12, alpha: 0, duration: 600, ease: "Quad.easeOut", onComplete: () => t.destroy() });
}
