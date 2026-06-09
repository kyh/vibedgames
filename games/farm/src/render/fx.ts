import Phaser from "phaser";
import { DEPTH } from "../config";

// Lightweight juice helpers — all built from primitives so they need no art.

export function floatText(
  scene: Phaser.Scene,
  x: number,
  y: number,
  text: string,
  color = "#fff6d5",
): void {
  const t = scene.add
    .text(x, y, text, {
      fontFamily: "ui-monospace, monospace",
      fontSize: "11px",
      fontStyle: "bold",
      color,
      stroke: "#3a2a14",
      strokeThickness: 3,
    })
    .setOrigin(0.5, 1)
    .setDepth(DEPTH.particles + 10);
  scene.tweens.add({
    targets: t,
    y: y - 22,
    alpha: { from: 1, to: 0 },
    duration: 900,
    ease: "Cubic.easeOut",
    onComplete: () => t.destroy(),
  });
}

// burst of small colored squares (dust, leaves, sparks, droplets)
export function burst(
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
): void {
  const { colors } = opts;
  const count = opts.count ?? 8;
  const speed = opts.speed ?? 50;
  const gravity = opts.gravity ?? 120;
  const size = opts.size ?? 2;
  const life = opts.life ?? 520;
  for (let i = 0; i < count; i++) {
    const c = colors[(Math.random() * colors.length) | 0];
    const r = scene.add.rectangle(x, y, size, size, c).setDepth(DEPTH.particles);
    const ang = opts.up ? -Math.PI / 2 + (Math.random() - 0.5) * 1.6 : Math.random() * Math.PI * 2;
    const sp = speed * (0.4 + Math.random() * 0.9);
    const vx = Math.cos(ang) * sp;
    let vy = Math.sin(ang) * sp - (opts.up ? 30 : 0);
    const start = scene.time.now;
    const ev = scene.time.addEvent({
      delay: 16,
      loop: true,
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
    });
  }
}

export function shake(scene: Phaser.Scene, intensity = 0.004, duration = 120): void {
  scene.cameras.main.shake(duration, intensity);
}

// a quick squash-stretch "pop" tween on a sprite
export function pop(
  scene: Phaser.Scene,
  obj: Phaser.GameObjects.Components.Transform & { scaleX: number; scaleY: number },
): void {
  const sx = obj.scaleX,
    sy = obj.scaleY;
  scene.tweens.add({
    targets: obj,
    scaleX: sx * 1.25,
    scaleY: sy * 0.8,
    duration: 90,
    yoyo: true,
    ease: "Quad.easeOut",
  });
}
