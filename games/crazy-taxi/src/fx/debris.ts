import * as THREE from "three";
import type { ModelCache } from "../assets/loader";
import { DEBRIS_BIG, DEBRIS_SMALL, modelUrl } from "../assets/manifest";

// Crash debris: a fixed pool of Car Kit scrap pieces (bolts, plates, tires,
// bumpers) flung on collision. Simple ballistic sim — gravity, one ground
// bounce, then rest and fade back into the pool. Zero allocation per burst.

const POOL_SMALL = 16;
const POOL_BIG = 8;
const GRAVITY = 30;
const RESTITUTION = 0.35;
const SPIN_KEEP = 0.4; // spin retained through the bounce
const REST_SECONDS = 5; // resting time before fade-out
const FADE_SECONDS = 0.6;

type PieceState = "idle" | "flying" | "resting" | "fading";

type Piece = {
  readonly obj: THREE.Object3D;
  readonly big: boolean;
  readonly baseScale: number;
  readonly lift: number; // origin-to-bottom offset so the piece rests ON the ground
  state: PieceState;
  vx: number;
  vy: number;
  vz: number;
  sx: number; // angular velocity (rad/s) per axis
  sy: number;
  sz: number;
  bounced: boolean;
  timer: number; // resting/fading clock
  stamp: number; // activation order, for stealing the oldest
};

export class Debris {
  readonly group = new THREE.Group();
  private pieces: Piece[] = [];
  private clock = 0;

  constructor(
    cache: ModelCache,
    private heightAt: (x: number, z: number) => number,
  ) {
    for (let i = 0; i < POOL_SMALL + POOL_BIG; i++) {
      const big = i >= POOL_SMALL;
      const names = big ? DEBRIS_BIG : DEBRIS_SMALL;
      const name = names[i % names.length] ?? names[0] ?? "debris-bolt";
      const url = modelUrl("debris", name);
      const obj = cache.instance(url);
      const b = cache.bounds(url);
      const maxDim = Math.max(b.size.x, b.size.y, b.size.z, 0.0001);
      const target = 0.5 + Math.random() * 0.3; // largest dimension 0.5-0.8u
      const scale = target / maxDim;
      obj.scale.setScalar(scale);
      obj.visible = false;
      this.group.add(obj);
      this.pieces.push({
        obj,
        big,
        baseScale: scale,
        lift: -b.min.y * scale,
        state: "idle",
        vx: 0,
        vy: 0,
        vz: 0,
        sx: 0,
        sy: 0,
        sz: 0,
        bounced: false,
        timer: 0,
        stamp: 0,
      });
    }
  }

  // Fling debris away from a collision at (x, z) with contact normal (nx, nz).
  // 2-3 small pieces; hard hits (power > 20) add one big piece.
  burst(x: number, z: number, nx: number, nz: number, power: number): void {
    const smallCount = 2 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < smallCount; i++) this.launch(false, x, z, nx, nz);
    if (power > 20) this.launch(true, x, z, nx, nz);
  }

  update(dt: number): void {
    for (const p of this.pieces) {
      if (p.state === "idle") continue;
      if (p.state === "flying") {
        p.vy -= GRAVITY * dt;
        const o = p.obj;
        o.position.x += p.vx * dt;
        o.position.y += p.vy * dt;
        o.position.z += p.vz * dt;
        o.rotation.x += p.sx * dt;
        o.rotation.y += p.sy * dt;
        o.rotation.z += p.sz * dt;
        const floor = this.heightAt(o.position.x, o.position.z) + p.lift;
        if (o.position.y <= floor && p.vy < 0) {
          o.position.y = floor;
          if (!p.bounced && -p.vy > 2) {
            // First ground contact: bounce, keep some spin.
            p.bounced = true;
            p.vy = -p.vy * RESTITUTION;
            p.vx *= 0.6;
            p.vz *= 0.6;
            p.sx *= SPIN_KEEP;
            p.sy *= SPIN_KEEP;
            p.sz *= SPIN_KEEP;
          } else {
            p.state = "resting";
            p.timer = 0;
            p.vx = 0;
            p.vy = 0;
            p.vz = 0;
          }
        }
      } else if (p.state === "resting") {
        p.timer += dt;
        if (p.timer >= REST_SECONDS) {
          p.state = "fading";
          p.timer = 0;
        }
      } else {
        // fading: shrink out, then return to the pool.
        p.timer += dt;
        const f = 1 - p.timer / FADE_SECONDS;
        if (f <= 0) {
          p.state = "idle";
          p.obj.visible = false;
          p.obj.scale.setScalar(p.baseScale);
        } else {
          p.obj.scale.setScalar(p.baseScale * f);
        }
      }
    }
  }

  private launch(big: boolean, x: number, z: number, nx: number, nz: number): void {
    const p = this.acquire(big);
    if (!p) return;
    this.clock++;
    p.stamp = this.clock;
    p.state = "flying";
    p.bounced = false;
    p.timer = 0;

    const o = p.obj;
    o.visible = true;
    o.scale.setScalar(p.baseScale);
    o.position.set(x, this.heightAt(x, z) + 0.6, z);
    o.rotation.set(
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
      Math.random() * Math.PI * 2,
    );

    // Velocity: collision normal x (4-8) + scatter, up 5-9.
    const nLen = Math.hypot(nx, nz);
    const inv = nLen > 0.0001 ? 1 / nLen : 0;
    const push = 4 + Math.random() * 4;
    p.vx = nx * inv * push + (Math.random() - 0.5) * 3;
    p.vy = 5 + Math.random() * 4;
    p.vz = nz * inv * push + (Math.random() - 0.5) * 3;

    // Angular velocity: 4-12 rad/s about a random axis.
    const ax = Math.random() - 0.5;
    const ay = Math.random() - 0.5;
    const az = Math.random() - 0.5;
    const aLen = Math.hypot(ax, ay, az);
    const aInv = aLen > 0.0001 ? 1 / aLen : 0;
    const rate = 4 + Math.random() * 8;
    p.sx = ax * aInv * rate;
    p.sy = ay * aInv * rate;
    p.sz = az * aInv * rate;
  }

  // Prefer an idle piece of the right size; if the pool is dry, steal the
  // oldest active one so a fresh crash always reads.
  private acquire(big: boolean): Piece | undefined {
    let oldest: Piece | undefined;
    for (const p of this.pieces) {
      if (p.big !== big) continue;
      if (p.state === "idle") return p;
      if (!oldest || p.stamp < oldest.stamp) oldest = p;
    }
    return oldest;
  }
}
