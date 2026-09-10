import * as THREE from "three";

// Mario-Kart cartoon impact stars: on a crash, 3-5 chunky yellow stars fly
// outward-upward from the impact in a loose ring, spin, arc under gravity and
// fade. Opaque cartoon icons — NORMAL blending, not additive: a star is a
// comic-book glyph stamped over the scene, not a light source. Fixed sprite
// pool, one shared canvas texture, zero allocation per burst.

const POOL = 8;
const GRAVITY = 14;
const LIFE = 0.7;
// Fraction of life spent fully opaque before the fade-out starts.
const HOLD = 0.45;

/** 5-point star, warm yellow fill + thin white rim, generated at boot. */
const starTexture = (): THREE.CanvasTexture => {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const cx = size / 2;
    const cy = size / 2;
    const outer = size * 0.44;
    const inner = outer * 0.48;
    ctx.beginPath();
    for (let i = 0; i < 10; i += 1) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
    ctx.fillStyle = "#ffd147";
    ctx.fill();
    ctx.lineWidth = size * 0.045;
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
};

interface Star {
  readonly sprite: THREE.Sprite;
  readonly mat: THREE.SpriteMaterial;
  vx: number;
  vy: number;
  vz: number;
  // rad/s
  spin: number;
  size: number;
  // remaining; <= 0 = idle
  life: number;
  // activation order, for stealing the oldest
  stamp: number;
}

export class ImpactStars {
  readonly group = new THREE.Group();
  private stars: Star[] = [];
  private clock = 0;

  constructor() {
    const tex = starTexture();
    for (let i = 0; i < POOL; i += 1) {
      // Per-sprite material: SpriteMaterial.rotation is what spins the star.
      const mat = new THREE.SpriteMaterial({
        depthWrite: false,
        map: tex,
        opacity: 0,
        transparent: true,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      // above the car and the smoke/spark pools
      sprite.renderOrder = 12;
      this.group.add(sprite);
      this.stars.push({ life: 0, mat, size: 1, spin: 0, sprite, stamp: 0, vx: 0, vy: 0, vz: 0 });
    }
  }

  /** Crash burst at the impact point; `power` is the crash block's 0..1 p. */
  burst(x: number, y: number, z: number, power: number): void {
    const count = 3 + Math.round(Math.min(1, Math.max(0, power)) * 2);
    const base = Math.random() * Math.PI * 2;
    for (let i = 0; i < count; i += 1) {
      const star = this.claim();
      // Loose ring: even spacing plus jitter, so the burst reads as a shape
      // (the dustRing lesson: coherent ring beats noisy swarm).
      const ang = base + (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
      const out = 3.2 + power * 2.2 + Math.random() * 1.4;
      star.vx = Math.cos(ang) * out;
      star.vz = Math.sin(ang) * out;
      star.vy = 4.6 + power * 2.4 + Math.random() * 1.2;
      star.spin = (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 5);
      star.size = 0.5 + power * 0.3 + Math.random() * 0.1;
      star.life = LIFE * (0.85 + Math.random() * 0.3);
      this.clock += 1;
      star.stamp = this.clock;
      star.sprite.position.set(x, y + 0.6, z);
      star.sprite.scale.setScalar(star.size);
      star.mat.rotation = Math.random() * Math.PI * 2;
      star.mat.opacity = 1;
      star.sprite.visible = true;
    }
  }

  update(dt: number): void {
    for (const star of this.stars) {
      if (star.life <= 0) {
        continue;
      }
      star.life -= dt;
      if (star.life <= 0) {
        star.sprite.visible = false;
        star.mat.opacity = 0;
        continue;
      }
      star.vy -= GRAVITY * dt;
      star.sprite.position.x += star.vx * dt;
      star.sprite.position.y += star.vy * dt;
      star.sprite.position.z += star.vz * dt;
      star.mat.rotation += star.spin * dt;
      const frac = star.life / LIFE;
      star.mat.opacity = Math.min(1, frac / HOLD);
    }
  }

  private claim(): Star {
    let [best] = this.stars;
    let bestStamp = Infinity;
    for (const star of this.stars) {
      if (star.life <= 0) {
        return star;
      }
      if (star.stamp < bestStamp) {
        bestStamp = star.stamp;
        best = star;
      }
    }
    if (best) {
      return best;
    }
    // unreachable: POOL > 0
    throw new Error("impact-star pool is empty");
  }
}
