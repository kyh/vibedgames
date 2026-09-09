// Ground danger decals — replaces the flat CircleGeometry zones in
// WorldView.syncGrounds. 8 pooled PlaneGeometry(2,2) shader decals (one shader
// program; per-decal uniform groups), NORMAL blend so they read on the bright
// floor, y = terrain + 0.12.
//
// Modes (all data-driven off synced GroundEffect fields):
//  - fill-sweep  g.detonateAt set (meteor): interior disc sweeps 0→1 as the
//    timer runs down; rim pulses 6Hz in the last 400ms. THE dodge moment.
//  - arming      g.telegraph && no detonateAt (traps): own team = rune ring
//    pulsing 1.5Hz at 0.4; hostile = alpha 0.12 slow shimmer (spottable, sneaky).
//  - active      everything else (rain/decay/whirlwind/consecrate): steady rim
//    + interior pulse 0.22→0.30.
//  - residue     spawnResidue(): one-shot rimless scorch/frost/smoke stain,
//    alpha 0.3 → 0 linear over its life.
// Hostility: g.team !== localTeam → rim 0xff4030; friendly → rim = effect
// color at 45%.
import * as THREE from "three";
import type { Team } from "../data/config";
import { terrainHeight } from "../data/terrain";
import type { GroundEffect } from "../sim/types";
import { NOISE_GLSL } from "./fx-noise";
import { fxClock } from "./fx-shaders";

/** Detonate-telegraph durations by effect (ms). Anything else falls back to 1200. */
export const TELEGRAPH_MS = new Map<string, number>([
  ["meteor", 1200],
  ["smite", 450],
  ["nova", 400],
  ["vines", 500],
  ["hexring", 500],
]);

const GROUND_COLORS = new Map<string, number>(
  Object.entries({
    // witch W — bubbling bog-green
    brew: 0x7f_e0_8a,
    // witch R — the sealing hex circle
    hexring: 0xb9_8a_e0,
    meteor: 0xff_44_22,
    // mage W — frost detonation
    nova: 0x7f_d4_ff,
    rain: 0xff_e0_8a,
    // paladin W — the pillar's landing mark
    smite: 0xff_d7_6a,
    trap: 0x9a_ff_c0,
    // witch E — bog eruption
    vines: 0x6a_b0_4a,
    whirlwind: 0xff_ff_ff,
  } satisfies Record<string, number>),
);

/** Interior color for a ground-effect tag (shared with any zone-ambient fx). */
export const groundFxColor = (effect: string): number => GROUND_COLORS.get(effect) ?? 0xff_aa_44;

const HOSTILE_RIM = 0xff_40_30;
const MAX_DECALS = 8;

// Shader semantics (all animation is computed CPU-side into the uniforms):
//   uFill  — interior disc radius fraction 0..1 (fill-sweep / full zones)
//   uAlpha — interior disc alpha
//   uPulse — rim band alpha
//   uColor — interior color · uRim — rim color
//   uSeed  — per-decal noise offset, so two zones never stamp identically
//   uStain — 0 for a zone, 1 for residue: swaps the crisp fill for an eroded
//            stain with a ragged boundary
//
// The RIM is deliberately left crisp and un-eroded. It is the only thing
// telling a player where a hostile zone stops, and breaking its edge to match
// the interior costs more in readability than it buys in texture.
const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAG = `
uniform vec3 uColor;
uniform vec3 uRim;
uniform float uFill;
uniform float uPulse;
uniform float uAlpha;
uniform float uTime;
uniform float uSeed;
uniform float uStain;
varying vec2 vUv;
${NOISE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;

  vec3 np = vec3(p * 2.6, uSeed);
  float grain = fbm2(np);                       // -1..1, the boundary chew
  float mottle = 0.72 + 0.28 * fbm2(np * 2.3 + vec3(0.0, 0.0, uTime * 0.08));

  float rim = (smoothstep(0.90, 0.955, d) - smoothstep(0.97, 1.0, d)) * uPulse;

  // The fill edge is a FRONT, not a step: it advances with a chewed, feathered
  // leading edge, which is what makes a detonation fuse read as something
  // spreading across the floor rather than a disc being scaled up.
  float edge = d + grain * 0.07 * mix(0.35, 1.0, uStain);
  float interior = (1.0 - smoothstep(uFill - 0.08, uFill + 0.015, edge)) * uAlpha;
  interior *= mix(1.0, mottle, uStain);

  float base = (1.0 - d) * 0.10 * max(uPulse, uAlpha);
  float a = rim + interior + base;
  if (a <= 0.004) discard;
  vec3 col = (uRim * rim + uColor * (interior + base)) / a;
  gl_FragColor = vec4(col, min(a, 1.0));
}`;

// oxlint-disable-next-line typescript/consistent-type-definitions -- must stay assignable to the JSON index-signature type; interfaces get no implicit index signature
type DecalUniforms = {
  uColor: THREE.IUniform<THREE.Color>;
  uRim: THREE.IUniform<THREE.Color>;
  uFill: THREE.IUniform<number>;
  uPulse: THREE.IUniform<number>;
  uAlpha: THREE.IUniform<number>;
  uTime: THREE.IUniform<number>;
  uSeed: THREE.IUniform<number>;
  uStain: THREE.IUniform<number>;
};

interface Decal {
  mesh: THREE.Mesh;
  uni: DecalUniforms;
  // bound GroundEffect id (zone mode)
  zoneId: string | null;
  // ms clock; residue mode when residueLife > 0
  residueBorn: number;
  // ms
  residueLife: number;
  seenFrame: number;
}

const placeDecal = (d: Decal, x: number, y: number, radius: number): void => {
  // +0.12: clears the flagstone tops (+0.05) AND the camp dirt-tile bumps
  // (up to +0.109) — a lower offset clips the rim on dirt
  d.mesh.position.set(x, terrainHeight(x, y) + 0.12, y);
  d.mesh.scale.setScalar(Math.max(0.01, radius));
  d.mesh.visible = true;
};

const styleZone = (d: Decal, g: GroundEffect, localTeam: Team, now: number): void => {
  const color = groundFxColor(g.effect);
  const hostile = g.team !== localTeam;
  d.uni.uStain.value = 0;
  d.uni.uColor.value.setHex(color);
  if (hostile) {
    d.uni.uRim.value.setHex(HOSTILE_RIM);
  } else {
    d.uni.uRim.value.setHex(color).multiplyScalar(0.45);
  }

  if (g.detonateAt !== undefined) {
    // fill-sweep: interior disc races the fuse; rim panics at 6Hz for 400ms
    const total = TELEGRAPH_MS.get(g.effect) ?? 1200;
    const remaining = g.detonateAt - now;
    d.uni.uFill.value = Math.min(1, Math.max(0, 1 - remaining / total));
    d.uni.uAlpha.value = 0.28;
    d.uni.uPulse.value = remaining < 400 ? 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(now * 0.0377)) : 0.8;
  } else if (g.enemyDps || g.allyHps) {
    // a ticking zone is ACTIVE even when flagged `telegraph` (witch brew):
    // steady rim + interior breathing 0.22→0.30
    d.uni.uFill.value = 1;
    d.uni.uAlpha.value = 0.26 + 0.04 * Math.sin(now * 0.004);
    d.uni.uPulse.value = 0.7;
  } else if (g.telegraph) {
    // arming: a rune ring, loud for you, a whisper for your victims
    d.uni.uFill.value = 0;
    d.uni.uAlpha.value = 0;
    // hostile: 0.12 slow shimmer; own: 0.4 pulse @1.5Hz
    d.uni.uPulse.value = hostile
      ? 0.12 * (0.7 + 0.3 * Math.sin(now * 0.003))
      : 0.4 * (0.65 + 0.35 * Math.sin(now * 0.00942));
  } else {
    // active zone: steady rim + interior breathing 0.22→0.30
    d.uni.uFill.value = 1;
    d.uni.uAlpha.value = 0.26 + 0.04 * Math.sin(now * 0.004);
    d.uni.uPulse.value = 0.7;
  }
};

export class Telegraphs {
  private readonly decals: Decal[] = [];
  private readonly free: number[] = [];
  private readonly zoneById = new Map<string, number>();
  private frame = 0;
  private lastNow = 0;

  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // shared; scale = zone radius
    const geo = new THREE.PlaneGeometry(2, 2);
    for (let i = 0; i < MAX_DECALS; i += 1) {
      const uni: DecalUniforms = {
        uAlpha: { value: 0 },
        uColor: { value: new THREE.Color(0xff_aa_44) },
        uFill: { value: 0 },
        uPulse: { value: 0 },
        uRim: { value: new THREE.Color(HOSTILE_RIM) },
        uSeed: { value: i * 13.77 },
        uStain: { value: 0 },
        uTime: fxClock,
      };
      const mat = new THREE.ShaderMaterial({
        blending: THREE.NormalBlending,
        depthWrite: false,
        fragmentShader: FRAG,
        side: THREE.DoubleSide,
        transparent: true,
        uniforms: uni,
        vertexShader: VERT,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.x = -Math.PI / 2;
      // above the floor + blob shadows, under particles
      mesh.renderOrder = 4;
      mesh.visible = false;
      scene.add(mesh);
      this.decals.push({ mesh, residueBorn: 0, residueLife: 0, seenFrame: 0, uni, zoneId: null });
      // pop order 0,1,2…
      this.free.push(MAX_DECALS - 1 - i);
    }
  }

  /** Drive one decal per live GroundEffect. Call every frame with `w.grounds`,
   *  the local player's team (FFA: their playerId), and `w.now` (ms). */
  sync(grounds: GroundEffect[], localTeam: Team, now: number): void {
    this.frame += 1;
    this.lastNow = now;
    for (const g of grounds) {
      let idx = this.zoneById.get(g.id);
      if (idx === undefined) {
        idx = this.acquire();
        if (idx === -1) {
          continue;
          // pool saturated — sim caps zones well below 8
        }
        this.zoneById.set(g.id, idx);
      }
      const d = this.decals[idx];
      if (!d) {
        continue;
      }
      d.zoneId = g.id;
      d.residueLife = 0;
      d.seenFrame = this.frame;
      placeDecal(d, g.x, g.y, g.radius);
      styleZone(d, g, localTeam, now);
    }
    // release decals whose zone ended (Map delete-while-iterating is safe)
    for (const [id, idx] of this.zoneById) {
      const d = this.decals[idx];
      if (!d) {
        this.zoneById.delete(id);
        continue;
      }
      if (d.seenFrame !== this.frame) {
        this.zoneById.delete(id);
        this.release(idx);
      }
    }
  }

  /** A caller-driven marker decal (coin landing sweep). Re-mark every frame to
   *  keep it alive — anything not re-marked is released by the next sync sweep.
   *  `fill` 0..1 drives the interior sweep; rim pulses hard when nearly full.
   *  MUST be called after this frame's sync() (which advances the frame stamp). */
  mark(id: string, x: number, y: number, radius: number, color: number, fill: number): void {
    let idx = this.zoneById.get(id);
    if (idx === undefined) {
      idx = this.acquire();
      if (idx === -1) {
        return;
      }
      this.zoneById.set(id, idx);
    }
    const d = this.decals[idx];
    if (!d) {
      return;
    }
    d.zoneId = id;
    d.residueLife = 0;
    d.seenFrame = this.frame;
    placeDecal(d, x, y, radius);
    d.uni.uColor.value.setHex(color);
    d.uni.uRim.value.setHex(color);
    d.uni.uStain.value = 0;
    d.uni.uFill.value = Math.min(1, Math.max(0, fill));
    d.uni.uAlpha.value = 0.24;
    d.uni.uPulse.value =
      fill > 0.8 ? 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(this.lastNow * 0.0377)) : 0.8;
  }

  /** One-shot rimless stain (meteor scorch 0x1a0f0a 4s, frost floor 0x7fd4ff
   *  1.2s, rogue smoke pool 0x201830 2s). `life` in seconds. */
  spawnResidue(x: number, y: number, r: number, color: number, life: number): void {
    const idx = this.acquire();
    if (idx === -1) {
      return;
    }
    const d = this.decals[idx];
    if (!d) {
      return;
    }
    d.zoneId = null;
    d.residueBorn = this.lastNow;
    d.residueLife = life * 1000;
    placeDecal(d, x, y, r);
    d.uni.uColor.value.setHex(color);
    d.uni.uFill.value = 0;
    // no rim
    d.uni.uPulse.value = 0;
    d.uni.uAlpha.value = 0.3;
    d.uni.uStain.value = 1;
    d.uni.uSeed.value = Math.random() * 50;
  }

  /** Step residue fades. `now` = the same ms clock passed to sync (w.now). */
  update(now: number): void {
    this.lastNow = now;
    for (let i = 0; i < this.decals.length; i += 1) {
      const d = this.decals[i];
      if (!d || d.residueLife <= 0) {
        continue;
      }
      const k = (now - d.residueBorn) / d.residueLife;
      if (k >= 1) {
        this.release(i);
        continue;
      }
      // The stain races out to full radius over the opening beat, then fades.
      // A frost floor or a scorch that arrives already at full size reads as a
      // sticker; one that spreads reads as the floor being changed.
      d.uni.uFill.value = Math.min(1, k / 0.18);
      // linear 0.3 → 0
      d.uni.uAlpha.value = 0.3 * (1 - k);
    }
  }

  clear(): void {
    this.zoneById.clear();
    this.free.length = 0;
    this.lastNow = 0;
    this.frame = 0;
    for (const [index, decal] of this.decals.entries()) {
      decal.mesh.visible = false;
      decal.zoneId = null;
      decal.residueLife = 0;
      decal.seenFrame = 0;
      this.free.push(index);
    }
  }

  dispose(): void {
    for (const d of this.decals) {
      this.scene.remove(d.mesh);
      const m = d.mesh.material;
      if (Array.isArray(m)) {
        for (const mm of m) {
          mm.dispose();
        }
      } else {
        m.dispose();
      }
    }
    const [first] = this.decals;
    if (first) {
      first.mesh.geometry.dispose();
      // shared plane
    }
    this.decals.length = 0;
    this.zoneById.clear();
    this.free.length = 0;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private acquire(): number {
    const idx = this.free.pop();
    return idx === undefined ? -1 : idx;
  }

  private release(idx: number): void {
    const d = this.decals[idx];
    if (!d) {
      return;
    }
    d.mesh.visible = false;
    d.zoneId = null;
    d.residueLife = 0;
    this.free.push(idx);
  }
}
