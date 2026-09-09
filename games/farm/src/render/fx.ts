import type Phaser from "phaser";
import { DEPTH } from "../config";

// Lightweight juice helpers — all built from primitives so they need no art.

/** `size` (world pixels) and `life` (ms) default to every gameplay pop; a caller
 *  raises them only for a glyph that has to carry a beat on its own. */
export const floatText = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color = "#fff6d5",
  size = 11,
  life = 900,
): void => {
  const t = scene.add
    .text(x, y, text, {
      color,
      fontFamily: "ui-monospace, monospace",
      fontSize: `${size}px`,
      fontStyle: "bold",
      stroke: "#3a2a14",
      strokeThickness: Math.max(3, Math.round(size / 4)),
    })
    .setOrigin(0.5, 1)
    .setDepth(DEPTH.particles + 10);
  scene.tweens.add({
    alpha: { from: 1, to: 0 },
    duration: life,
    ease: "Cubic.easeOut",
    onComplete: () => t.destroy(),
    targets: t,
    y: y - 22,
  });
};

// burst of small colored squares (dust, leaves, sparks, droplets)
export const burst = (
  scene: Phaser.Scene,
  x: number,
  y: number,
  opts: {
    colors: number[];
    count?: number;
    speed?: number;
    gravity?: number;
    size?: number;
    up?: boolean;
    life?: number;
  },
): void => {
  const { colors } = opts;
  const count = opts.count ?? 8;
  const speed = opts.speed ?? 50;
  const gravity = opts.gravity ?? 120;
  const size = opts.size ?? 2;
  const life = opts.life ?? 520;
  for (let i = 0; i < count; i += 1) {
    const c = colors[Math.trunc(Math.random() * colors.length)];
    const r = scene.add.rectangle(x, y, size, size, c).setDepth(DEPTH.particles);
    const ang = opts.up ? -Math.PI / 2 + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
    const sp = speed * (0.4 + Math.random() * 0.9);
    const vx = Math.cos(ang) * sp;
    let vy = Math.sin(ang) * sp - (opts.up ? 30 : 0);
    const start = scene.time.now;
    const ev = scene.time.addEvent({
      callback: () => {
        const dt = 0.016;
        vy += gravity * dt;
        r.x += vx * dt;
        r.y += vy * dt;
        const age = (scene.time.now - start) / life;
        r.alpha = Math.max(0, 1 - age);
        if (age >= 1) {
          ev.remove();
          r.destroy();
        }
      },
      delay: 16,
      loop: true,
    });
  }
};

export const shake = (scene: Phaser.Scene, intensity = 0.004, duration = 120): void => {
  scene.cameras.main.shake(duration, intensity);
};

// a quick squash-stretch "pop" tween on a sprite
export const pop = (
  scene: Phaser.Scene,
  obj: Phaser.GameObjects.Components.Transform & { scaleX: number; scaleY: number },
): void => {
  const sx = obj.scaleX;
  const sy = obj.scaleY;
  scene.tweens.add({
    duration: 90,
    ease: "Quad.easeOut",
    scaleX: sx * 1.25,
    scaleY: sy * 0.8,
    targets: obj,
    yoyo: true,
  });
};
