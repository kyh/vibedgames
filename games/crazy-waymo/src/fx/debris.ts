import * as THREE from "three";
import type { ModelCache } from "../assets/loader";
import { DEBRIS_BIG, DEBRIS_SMALL, modelUrl } from "../assets/manifest";

const POOL_SMALL = 16;
const POOL_BIG = 8;
const GRAVITY = 30;
const RESTITUTION = 0.35;
const SPIN_KEEP = 0.4;
const REST_SECONDS = 5;
const FADE_SECONDS = 0.6;

type PieceState = "idle" | "flying" | "resting" | "fading";

interface Piece {
  readonly obj: THREE.Object3D;
  readonly big: boolean;
  readonly baseScale: number;
  readonly lift: number;
  state: PieceState;
  vx: number;
  vy: number;
  vz: number;
  sx: number;
  sy: number;
  sz: number;
  bounced: boolean;
  timer: number;
  stamp: number;
}

export class Debris {
  readonly group = new THREE.Group();
  private readonly pieces: Piece[] = [];
  private clock = 0;
  private readonly heightAt: (x: number, z: number) => number;

  constructor(cache: ModelCache, heightAt: (x: number, z: number) => number) {
    this.heightAt = heightAt;

    for (let i = 0; i < POOL_SMALL + POOL_BIG; i += 1) {
      const big = i >= POOL_SMALL;
      const names = big ? DEBRIS_BIG : DEBRIS_SMALL;
      const name = names[i % names.length] ?? names[0] ?? "debris-bolt";
      const url = modelUrl("debris", name);
      const obj = cache.instance(url);
      const b = cache.bounds(url);
      const maxDim = Math.max(b.size.x, b.size.y, b.size.z, 0.0001);
      const target = 0.5 + Math.random() * 0.3;
      const scale = target / maxDim;
      obj.scale.setScalar(scale);
      obj.visible = false;
      this.group.add(obj);
      this.pieces.push({
        baseScale: scale,
        big,
        bounced: false,
        lift: -b.min.y * scale,
        obj,
        stamp: 0,
        state: "idle",
        sx: 0,
        sy: 0,
        sz: 0,
        timer: 0,
        vx: 0,
        vy: 0,
        vz: 0,
      });
    }
  }

  burst(x: number, z: number, nx: number, nz: number, power: number) {
    const smallCount = 2 + (Math.random() < 0.5 ? 1 : 0);

    for (let i = 0; i < smallCount; i += 1) {
      this.launch(false, x, z, nx, nz);
    }

    if (power > 20) {
      this.launch(true, x, z, nx, nz);
    }
  }

  update(dt: number) {
    for (const p of this.pieces) {
      if (p.state === "idle") {
        continue;
      }

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

  private launch(big: boolean, x: number, z: number, nx: number, nz: number) {
    const p = this.acquire(big);

    if (!p) {
      return;
    }

    this.clock += 1;
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

    const nLen = Math.hypot(nx, nz);
    const inv = nLen > 0.0001 ? 1 / nLen : 0;
    const push = 4 + Math.random() * 4;
    p.vx = nx * inv * push + (Math.random() - 0.5) * 3;
    p.vy = 5 + Math.random() * 4;
    p.vz = nz * inv * push + (Math.random() - 0.5) * 3;

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

  private acquire(big: boolean) {
    let oldest: Piece | undefined;

    for (const p of this.pieces) {
      if (p.big !== big) {
        continue;
      }

      if (p.state === "idle") {
        return p;
      }

      if (!oldest || p.stamp < oldest.stamp) {
        oldest = p;
      }
    }

    return oldest;
  }
}
