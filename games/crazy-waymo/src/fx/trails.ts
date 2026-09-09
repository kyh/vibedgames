import * as THREE from "three";

import { REINHARD_GLSL } from "./reinhard";
import { SKID_LIFT } from "./skids";
import { TIER_COLORS } from "./tier";

// Drift light-trails: two glowing ribbons laid onto the road behind the rear
// wheels while sliding or boosting — the arcade "light streak" that makes a
// drift read from across the screen. One mesh, one draw call, ring-buffered
// samples, additive blend so streaks pop over dark asphalt.
//
// Color is captured per sample (white slide → tier blue → tier orange), so a
// drift that arms mid-corner leaves a visible white→blue gradient down the
// ribbon. Tier hues come from fx/tier.ts so ribbon, sparks and HUD agree.

// per ribbon
const SAMPLES = 44;
const RIBBONS = 2;
// seconds a sample stays lit
const LIFE = 0.5;
const HALF_W = 0.26;
// Above skid marks (which clear the asphalt drape's worst case: lift + bow);
// still well below the car body.
// 0.22
const LIFT = SKID_LIFT + 0.04;
// world units between samples
const MIN_STEP = 0.45;
// teleports and physics corrections cannot join two streets
const MAX_STEP = 4;
// Ribbons cover big screen area, so they sit near the bottom of the 2.2-3.4
// additive band — the shoulder still keeps stacked crossings from whiting out,
// and only dense overlaps graze the day bloom gate.
const TIER_INTENSITY = 1.2;
const SLIDE_INTENSITY = 0.85;

interface Sample {
  x: number;
  z: number;
  y: number;
  // perpendicular (unit) at capture time
  px: number;
  pz: number;
  sideRise: number;
  age: number;
  r: number;
  g: number;
  b: number;
  a: number;
  /** This sample starts a stroke; previous samples may still be fading. */
  startsStroke: boolean;
}

export class DriftTrails {
  readonly mesh: THREE.Mesh;
  private heightAt: (x: number, z: number) => number;
  private samples: Sample[][] = [];
  private heads: { x: number; z: number; connected: boolean }[] = [];
  private positions: Float32Array;
  private colors: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private tmp = new THREE.Color();

  constructor(heightAt: (x: number, z: number) => number) {
    this.heightAt = heightAt;
    for (let r = 0; r < RIBBONS; r += 1) {
      this.samples.push([]);
      this.heads.push({ connected: false, x: 0, z: 0 });
    }
    const maxVerts = RIBBONS * SAMPLES * 2;
    const maxTris = RIBBONS * (SAMPLES - 1) * 2;
    this.positions = new Float32Array(maxVerts * 3);
    this.colors = new Float32Array(maxVerts * 4);
    const index = new Uint16Array(maxTris * 3);
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.colAttr = new THREE.BufferAttribute(this.colors, 4);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.indexArray = index;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      transparent: true,
      vertexColors: true,
    });
    // Max-channel Reinhard shoulder as the last op before write: two ribbons
    // crossing (or ribbon over sparks) asymptote toward the tier hue instead
    // of clipping to white.
    mat.onBeforeCompile = (shader) => {
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${REINHARD_GLSL}`)
        .replace(
          "#include <opaque_fragment>",
          "outgoingLight = reinhardClip(outgoingLight);\n#include <opaque_fragment>",
        );
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  private indexArray: Uint16Array;

  /** Release the contact patch without erasing the previous stroke's fade. */
  break(): void {
    for (const head of this.heads) {
      head.connected = false;
    }
  }

  // Feed wheel positions while a trail-worthy state is active. `heading` gives
  // the ribbon's cross axis; hue: 0 = slide white, 1 = charged cyan, 2 = boost.
  emit(
    ribbon: number,
    x: number,
    z: number,
    heading: number,
    kind: 0 | 1 | 2,
    strength: number,
  ): void {
    const list = this.samples[ribbon];
    const head = this.heads[ribbon];
    if (!list || !head) {
      return;
    }
    const step = Math.hypot(x - head.x, z - head.z);
    const connected = head.connected && list.length > 0 && step <= MAX_STEP;
    if (connected && step < MIN_STEP) {
      return;
    }
    // Cross axis follows the MOTION direction, not the nose: during a drift
    // (and countersteer) the two diverge, and heading-aligned quads render as
    // a jagged zigzag instead of a smooth streak.
    let px: number;
    let pz: number;
    if (connected && step > 1e-4) {
      px = (z - head.z) / step;
      pz = -(x - head.x) / step;
    } else {
      px = Math.cos(heading);
      pz = -Math.sin(heading);
    }
    head.x = x;
    head.z = z;
    head.connected = true;
    if (kind === 2) {
      this.tmp.set(TIER_COLORS[1]).multiplyScalar(TIER_INTENSITY);
    } else if (kind === 1) {
      this.tmp.set(TIER_COLORS[0]).multiplyScalar(TIER_INTENSITY);
    } else {
      this.tmp.setRGB(0.8, 0.88, 1).multiplyScalar(SLIDE_INTENSITY);
    }
    const sample: Sample = {
      a: (kind === 0 ? 0.45 : 0.75) * strength,
      age: 0,
      b: this.tmp.b,
      g: this.tmp.g,
      px,
      pz,
      r: this.tmp.r,
      sideRise:
        (this.heightAt(x + px * HALF_W, z + pz * HALF_W) -
          this.heightAt(x - px * HALF_W, z - pz * HALF_W)) /
        2,
      startsStroke: !connected,
      x,
      y: this.heightAt(x, z) + LIFT,
      z,
    };
    list.push(sample);
    if (list.length > SAMPLES) {
      list.shift();
    }
  }

  update(dt: number): void {
    let anyAlive = false;
    // vertex cursor
    let vi = 0;
    // index cursor
    let ii = 0;
    for (const list of this.samples) {
      // Age out dead samples from the tail.
      while (list.length > 0) {
        const [first] = list;
        if (first && first.age > LIFE) {
          list.shift();
        } else {
          break;
        }
      }
      // first vertex PAIR index of this ribbon
      const start = vi / 3 / 2;
      for (let i = 0; i < list.length; i += 1) {
        const s = list[i];
        if (!s) {
          continue;
        }
        s.age += dt;
        anyAlive = true;
        const fade = Math.max(0, 1 - s.age / LIFE);
        // Taper: fresh end full width, old end pinched.
        const w = HALF_W * (0.4 + 0.6 * fade);
        const vx = s.x + s.px * w;
        const vz = s.z + s.pz * w;
        const wx = s.x - s.px * w;
        const wz = s.z - s.pz * w;
        this.positions[vi] = vx;
        this.positions[vi + 1] = s.y + s.sideRise * (w / HALF_W);
        this.positions[vi + 2] = vz;
        this.positions[vi + 3] = wx;
        this.positions[vi + 4] = s.y - s.sideRise * (w / HALF_W);
        this.positions[vi + 5] = wz;
        const ci = (vi / 3) * 4;
        const a = s.a * fade * fade;
        for (const off of [0, 4]) {
          this.colors[ci + off] = s.r;
          this.colors[ci + off + 1] = s.g;
          this.colors[ci + off + 2] = s.b;
          this.colors[ci + off + 3] = a;
        }
        vi += 6;
        // Stitch to the previous pair.
        if (i > 0 && !s.startsStroke) {
          const p = start + (i - 1);
          const c = start + i;
          this.indexArray[ii] = p * 2;
          ii += 1;
          this.indexArray[ii] = c * 2;
          ii += 1;
          this.indexArray[ii] = p * 2 + 1;
          ii += 1;
          this.indexArray[ii] = c * 2;
          ii += 1;
          this.indexArray[ii] = c * 2 + 1;
          ii += 1;
          this.indexArray[ii] = p * 2 + 1;
          ii += 1;
        }
      }
    }
    const geo = this.mesh.geometry;
    geo.setDrawRange(0, ii);
    this.mesh.visible = anyAlive;
    if (anyAlive) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      const idx = geo.getIndex();
      if (idx) {
        idx.needsUpdate = true;
      }
    }
  }
}
