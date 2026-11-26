import * as THREE from "three";
import { HOP_HEIGHT } from "../data/config";
import { terrainHeight } from "../data/terrain";
import type { FxEvent, GroundEffect, World } from "../sim/types";
import { Audio } from "./audio";
import { ChunkPool } from "./fx-chunks";
import { DamageNumbers } from "./damage-numbers";
import {
  makeCrackMaterial,
  makeRingMaterial,
  makeSlashMaterial,
  makeVortexMaterial,
  fxClock,
  tickFxShaders,
} from "./fx-shaders";
import type { CrackMaterial } from "./fx-shaders";
import { fxTex, preloadFxTextures, uploadFxTextures, whenFxTexturesReady } from "./fx-textures";
import { createRockGeometry } from "./fx-geometry";
import { createBurningRockMaterial } from "./fx-rock";
import { createBeamMaterial } from "./fx-beam";
import type { BeamMaterial } from "./fx-beam";
import { SpikePool } from "./fx-spikes";
import { BoltPool } from "./fx-bolt";
import { PillarPool } from "./fx-pillar";
import { VoidPool } from "./fx-void";
import { RibbonPool } from "./fx-ribbon";
import { createBrewPoolMaterial } from "./fx-pool";
import type { BrewPoolMaterial } from "./fx-pool";
import { HDR_BRIGHT, ParticlePools } from "./fx-particles";
import type { ParticlePriority, SpawnOptions } from "./fx-particles";
import { Telegraphs, groundFxColor } from "./telegraph";
import type { View } from "./view";

type FxOf<T extends FxEvent["t"]> = Extract<FxEvent, { t: T }>;

const uniform = (mat: THREE.ShaderMaterial, name: string) => {
  const u = mat.uniforms[name];

  if (!u) {
    throw new Error(`fx: shader material has no uniform ${name}`);
  }

  return u;
};

const uniformColor = (mat: THREE.ShaderMaterial, name: string) => {
  const v: unknown = uniform(mat, name).value;

  if (!(v instanceof THREE.Color)) {
    throw new TypeError(`fx: uniform ${name} is not a Color`);
  }

  return v;
};

const uniformVec2 = (mat: THREE.ShaderMaterial, name: string) => {
  const v: unknown = uniform(mat, name).value;

  if (!(v instanceof THREE.Vector2)) {
    throw new TypeError(`fx: uniform ${name} is not a Vector2`);
  }

  return v;
};

const compileQuietly = async (
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
) => {
  await renderer.compileAsync(scene, camera).catch(() => null);
};

const localHitFreezeMs = (hits: number, melee: boolean) => {
  if (hits >= 3) {
    return 85;
  }

  if (hits === 2) {
    return 65;
  }

  return melee ? 40 : 25;
};

const FIZZLE_COLOR = new Map<string, number>([
  ["arrow", 0xff_e6_a0],
  ["fireball", 0xff_7a_2c],
  ["hexbolt", 0x7f_e0_8a],
]);

const EXPLOSION_COLOR = new Map<string, number>([
  ["hexring", 0x7f_e0_8a],
  ["keg", 0xff_b0_50],
  ["meteor", 0xff_5a_2c],
  ["nova", 0x7f_d4_ff],
  ["smite", 0xff_d7_6a],
  ["trap", 0x9a_ff_c0],
  ["vines", 0x4a_7a_3a],
]);

const RUNE_COLOR = new Map<string, number>([
  ["hexring", 0xb9_8a_e0],
  ["smite", 0xff_d7_6a],
]);

const propWoodColor = (model: string) => {
  if (model.includes("keg")) {
    return 0x6a_4a_2a;
  }

  return model.includes("barrel") ? 0x7a_5a_34 : 0x8a_6a_40;
};

const streakStingerTier: (streak: number) => 0 | 1 | 2 | 3 = (streak) => {
  if (streak >= 9) {
    return 3;
  }

  if (streak >= 7) {
    return 2;
  }

  return streak >= 5 ? 1 : 0;
};

const hitColor = (dtype: string, primary: number | undefined) => {
  if (dtype === "magic") {
    return primary ?? 0xc0_70_ff;
  }

  return dtype === "pure" ? 0xff_ff_ff : 0xff_d0_6a;
};

export interface FxPalette {
  primary: number;
  secondary: number;
  accent: number;
}

export const CHAMP_FX = new Map<string, FxPalette>(
  Object.entries({
    blackknight: { accent: 0xff_e6_a0, primary: 0xff_d7_6a, secondary: 0xff_f2_c0 },
    knight: { accent: 0xff_d2_4a, primary: 0x8f_d0_ff, secondary: 0xea_f2_ff },
    mage: { accent: 0x9a_7b_ff, primary: 0xff_80_40, secondary: 0xff_d0_60 },
    ranger: { accent: 0x2c_8f_5e, primary: 0x7d_ff_b0, secondary: 0xff_e6_a0 },
    rogue: { accent: 0x7f_ff_8e, primary: 0xff_30_60, secondary: 0x6a_5a_9a },
    witch: { accent: 0x4a_7a_3a, primary: 0x7f_e0_8a, secondary: 0xb9_8a_e0 },
  } satisfies Record<string, FxPalette>),
);

const RING_POOL = 16;
const BEAM_POOL = 4;
const CONE_POOL = 8;
const DOME_POOL = 4;
const SLASH_POOL = 10;
const FLARE_POOL = 10;

const SLASH_SPRITES = {
  arc: { off: [0, 0.5], rot: 0, scale: [0.52, 0.5], tex: "slash-arc" },
  spin: { off: [0, 0], rot: 0, scale: [1, 1], tex: "slash-spin" },
  white: { off: [0, 0], rot: 0, scale: [1, 1], tex: "slash-white" },
  wind: { off: [0, 0], rot: 0, scale: [1, 1], tex: "slash-wind" },
} as const;

export type SlashTex = keyof typeof SLASH_SPRITES;

const CRACK_POOL = 6;
const BEAM_H = 7;

interface Ring {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  maxLife: number;
  maxR: number;
  opacity: number;
}

interface ZonePiece {
  obj: THREE.Object3D;
  ownMat: THREE.Material | null;
  seenAt: number;
}

interface Beam {
  mesh: THREE.Mesh;
  mat: BeamMaterial;
  life: number;
  maxLife: number;
  h: number;
  r: number;
}

interface ConeDecal {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  opacity: number;
  grow: number;
  s0: number;
}

interface Dome {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  opacity: number;
  r: number;
}

interface Slash {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  maxLife: number;
}

interface Crack {
  mesh: THREE.Mesh;
  mat: CrackMaterial;
  life: number;
  maxLife: number;
}

interface Delayed {
  at: number;
  run: () => void;
}

interface ZoneAnim {
  next: number;
  next2: number;
  phase: number;
  seenAt: number;
  bornAt: number;
  born: boolean;
}

const scratch: SpawnOptions = { life: 0.3, size: 0.5, x: 0, y: 0, z: 0 };

const sp = (x: number, y: number, z: number) => {
  scratch.x = x;
  scratch.y = y;
  scratch.z = z;
  scratch.vx = 0;
  scratch.vy = 0;
  scratch.vz = 0;
  scratch.color = 0xff_ff_ff;
  scratch.cr = undefined;
  scratch.cg = undefined;
  scratch.cb = undefined;
  scratch.size = 0.5;
  scratch.life = 0.3;
  scratch.gravity = 0;
  scratch.drag = 0;
  scratch.stretch = false;
  scratch.bright = 1;
  scratch.alpha = 1;
  scratch.priority = "impact";

  return scratch;
};

export class Fx {
  readonly pools: ParticlePools;
  readonly telegraphs: Telegraphs;
  readonly chunks: ChunkPool;
  readonly spikes: SpikePool;
  readonly bolts: BoltPool;
  readonly pillars: PillarPool;
  readonly voids: VoidPool;
  readonly ribbons: RibbonPool;
  private readonly rings: Ring[] = [];
  private readonly beams: Beam[] = [];
  private readonly cones: ConeDecal[] = [];
  private readonly domes: Dome[] = [];
  private readonly slashes: Slash[] = [];
  private readonly flares: {
    sprite: THREE.Sprite;
    mat: THREE.SpriteMaterial;
    life: number;
    maxLife: number;
    s0: number;
    grow: number;
  }[] = [];
  private readonly cracks: Crack[] = [];
  private readonly coneGeoCache = new Map<number, THREE.CircleGeometry>();
  private readonly rimGeoCache = new Map<number, THREE.RingGeometry>();
  private readonly ringPlane = new THREE.PlaneGeometry(2, 2);
  private readonly zonePieces = new Map<string, ZonePiece>();
  private readonly brewPools = new Map<string, BrewPoolMaterial>();
  private readonly vortexGeo = new THREE.CylinderGeometry(1, 0.72, 1, 20, 1, true);
  private readonly cometGeo = createRockGeometry({ craters: 6, cuts: 8, detail: 2, seed: 4 });
  private readonly rockMat = createBurningRockMaterial(fxClock);
  private pendingWarm: { renderer: THREE.WebGLRenderer; camera: THREE.Camera } | null = null;
  private readonly warmParked: { mesh: THREE.Mesh; ownMat: boolean }[] = [];
  private texturesReady = false;
  private readonly boltFrom = new THREE.Vector3();
  private readonly boltTo = new THREE.Vector3();
  private delayed: Delayed[] = [];
  private clock = 0;
  private nowMs = 0;
  private readonly numbers: DamageNumbers;
  readonly audio = new Audio();
  private readonly zoneAnim = new Map<string, ZoneAnim>();
  private zoneSweepAt = 0;
  readonly feed: {
    killerName: string;
    victimName: string;
    leader?: boolean;
    killer: string;
    victim: string;
  }[] = [];
  readonly toasts: { text: string; kind: string }[] = [];
  localId = "";
  localOwnerId = "";
  /** Set when the local player dies — the death screen reads the killer. */
  lastDeath: { killerName: string; at: number } | null = null;
  /** Drained by the reticle: one entry per landed local hit. */
  readonly localHits: { crit: boolean }[] = [];
  /** Best kill streak this match (end-card stat). */
  bestStreak = 0;
  private lx = 0;
  private ly = 0;
  private localTeam = "";
  private localMelee = true;
  private hitsThisFrame = 0;
  private heavyThisFrame = false;
  private flashGain = 1;

  private readonly scene: THREE.Scene;
  private readonly view: View;

  constructor(scene: THREE.Scene, view: View) {
    this.scene = scene;
    this.view = view;
    this.pools = new ParticlePools(scene);
    this.telegraphs = new Telegraphs(scene);
    this.chunks = new ChunkPool(scene);
    this.spikes = new SpikePool(scene);
    this.bolts = new BoltPool(scene, fxClock);
    this.pillars = new PillarPool(scene, fxClock);
    this.voids = new VoidPool(scene, fxClock);
    this.ribbons = new RibbonPool(scene, fxClock);

    for (let i = 0; i < RING_POOL; i += 1) {
      const mat = makeRingMaterial();
      const mesh = new THREE.Mesh(this.ringPlane, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ life: 0, mat, maxLife: 1, maxR: 1, mesh, opacity: 1 });
    }

    const beamGeo = new THREE.CylinderGeometry(0.55, 0.9, BEAM_H, 16, 12, true);

    for (let i = 0; i < BEAM_POOL; i += 1) {
      const mat = createBeamMaterial(fxClock);
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.beams.push({ h: BEAM_H, life: 0, mat, maxLife: 1, mesh, r: 1 });
    }

    for (let i = 0; i < CONE_POOL; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        blending: THREE.NormalBlending,
        color: 0xff_ff_ff,
        depthWrite: false,
        side: THREE.DoubleSide,
        transparent: true,
      });

      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(this.coneGeo(0.61), mat);
      pivot.add(mesh);
      pivot.visible = false;
      scene.add(pivot);
      this.cones.push({ grow: 1, life: 0, mat, maxLife: 1, mesh, opacity: 1, pivot, s0: 1 });
    }

    for (let i = 0; i < SLASH_POOL; i += 1) {
      const mat = makeSlashMaterial();
      const mesh = new THREE.Mesh(this.ringPlane, mat);
      const pivot = new THREE.Group();
      pivot.add(mesh);
      pivot.visible = false;
      scene.add(pivot);
      this.slashes.push({ life: 0, mat, maxLife: 1, mesh, pivot });
    }

    preloadFxTextures();
    this.warmRig(scene);

    for (let i = 0; i < FLARE_POOL; i += 1) {
      const mat = new THREE.SpriteMaterial({
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        map: fxTex("flare-star"),
        transparent: true,
      });

      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.flares.push({ grow: 1, life: 0, mat, maxLife: 1, s0: 1, sprite });
    }

    for (let i = 0; i < CRACK_POOL; i += 1) {
      const mat = makeCrackMaterial();
      const mesh = new THREE.Mesh(this.ringPlane, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.cracks.push({ life: 0, mat, maxLife: 1, mesh });
    }

    const domeGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);

    for (let i = 0; i < DOME_POOL; i += 1) {
      const mat = new THREE.MeshBasicMaterial({
        blending: THREE.NormalBlending,
        color: 0xff_ff_ff,
        depthWrite: false,
        transparent: true,
        wireframe: true,
      });

      const mesh = new THREE.Mesh(domeGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.domes.push({ life: 0, mat, maxLife: 1, mesh, opacity: 1, r: 1 });
    }

    this.numbers = new DamageNumbers(view);
  }

  /**
   * Compile every pooled FX program before a match starts.
   *
   * Three's `compile()` walks the whole graph, not just what is visible, so one
   * call warms all of these pools while they sit parked. Without it the first
   * frost nova of a match cost a 416ms hard freeze on this machine (measured —
   * tools/fx-perf.mjs) while the crystal shader compiled mid-fight; the same
   * program costs ~6ms once warm.
   *
   * Fire-and-forget: with KHR_parallel_shader_compile the work is off-thread,
   * and anything still compiling when the match starts is no worse off than it
   * would have been without this.
   */
  warm(renderer: THREE.WebGLRenderer, camera: THREE.Camera) {
    this.pendingWarm = { camera, renderer };
    void this.markTexturesReady(renderer);
  }

  private async markTexturesReady(renderer: THREE.WebGLRenderer) {
    await whenFxTexturesReady();
    uploadFxTextures(renderer);
    this.texturesReady = true;
  }

  private flushWarm() {
    const w = this.pendingWarm;

    if (!w || !this.texturesReady) {
      return;
    }

    this.pendingWarm = null;
    void compileQuietly(w.renderer, this.scene, w.camera);
  }

  private warmRig(scene: THREE.Scene) {
    const park = (mesh: THREE.Mesh, ownMat: boolean) => {
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.position.set(0, -1000, 0);
      scene.add(mesh);
      this.warmParked.push({ mesh, ownMat });
    };

    park(new THREE.Mesh(this.cometGeo, this.rockMat), false);
    park(new THREE.Mesh(this.ringPlane, createBrewPoolMaterial(fxClock)), true);

    for (const blending of [THREE.AdditiveBlending, THREE.NormalBlending]) {
      park(
        new THREE.Mesh(
          this.texQuad,
          new THREE.MeshBasicMaterial({
            blending,
            depthWrite: false,
            map: fxTex("glow-soft"),
            side: THREE.DoubleSide,
            transparent: true,
          }),
        ),
        true,
      );
    }
  }

  setFlashGain(gain: number) {
    this.flashGain = gain;
    this.pools.setAddGain(gain);
  }

  update(w: World, dt: number) {
    this.flushWarm();
    this.nowMs = w.now;
    const me = w.units.get(this.localId);

    if (me) {
      this.lx = me.x;
      this.ly = me.y;
      this.localTeam = me.team;
      this.localMelee = me.attackType === "melee";

      if (!this.localOwnerId) {
        this.localOwnerId = me.ownerId;
      }

      if (me.killStreak > this.bestStreak) {
        this.bestStreak = me.killStreak;
      }

      this.audio.setListener(me.x, me.y, me.aimX, me.aimY);
    }

    this.hitsThisFrame = 0;
    this.heavyThisFrame = false;

    for (const e of w.fx) {
      this.handle(e, w);
    }

    w.fx.length = 0;

    if (this.hitsThisFrame > 0) {
      let ms = localHitFreezeMs(this.hitsThisFrame, this.localMelee);

      if (this.heavyThisFrame) {
        ms = Math.min(110, ms + 30);
      }

      this.bumpFreeze(ms);
    }

    this.clock += dt;

    for (let i = this.delayed.length - 1; i >= 0; i -= 1) {
      const d = this.delayed[i];

      if (d && this.clock >= d.at) {
        const last = this.delayed.pop();

        if (last && last !== d) {
          this.delayed[i] = last;
        }

        d.run();
      }
    }

    const vdt = dt * this.scaleNow();
    this.numbers.update(vdt);
    tickFxShaders(vdt);
    this.pools.update(vdt);
    this.chunks.update(vdt);
    this.spikes.update(vdt);
    this.bolts.update(vdt);
    this.pillars.update(vdt);
    this.voids.update(vdt);
    this.ribbons.update(vdt);
    this.stepRings(vdt);
    this.stepBeams(vdt);
    this.stepCones(vdt);
    this.stepDomes(vdt);
    this.stepSlashes(vdt);
    this.stepCracks(vdt);
    this.stepFlares(vdt);
    this.stepTexActors(vdt);
    this.telegraphs.update(w.now);

    for (const [id, p] of this.zonePieces) {
      if (w.now - p.seenAt > 250) {
        this.scene.remove(p.obj);
        p.ownMat?.dispose();
        this.zonePieces.delete(id);
        this.brewPools.delete(id);
      }
    }

    if (this.clock >= this.zoneSweepAt) {
      this.zoneSweepAt = this.clock + 2;

      for (const [id, st] of this.zoneAnim) {
        if (w.now - st.seenAt > 1500) {
          this.zoneAnim.delete(id);
        }
      }
    }

    this.hardFreeze = Math.max(0, this.hardFreeze - dt);
    this.slowMo = Math.max(0, this.slowMo - dt);
  }

  private hardFreeze = 0;
  private slowMo = 0;
  /** Briefly hard-freeze the visual layer (impact weight). */
  bumpFreeze(ms: number) {
    this.hardFreeze = Math.max(this.hardFreeze, ms / 1000);
  }
  /** Visual-time multiplier the scene applies to anim/camera lerps this frame. */
  scaleNow() {
    if (this.hardFreeze > 0) {
      return 0.05;
    }

    return this.slowMo > 0 ? 0.35 : 1;
  }

  private att(x: number, y: number) {
    return Math.min(1, Math.max(0.2, 1 - Math.hypot(x - this.lx, y - this.ly) / 38));
  }

  private within(x: number, y: number, r: number) {
    return (x - this.lx) ** 2 + (y - this.ly) ** 2 <= r * r;
  }

  private handle(e: FxEvent, w: World) {
    switch (e.t) {
      case "hit": {
        this.hitFx(e, w);
        break;
      }

      case "strike": {
        this.strikeFx(e.tag, e.x, e.y, e.dx, e.dy, e.r);
        break;
      }

      case "fizzle": {
        this.fizzleFx(e);
        break;
      }

      case "propBreak": {
        this.propBreakFx(e);
        break;
      }

      case "swing": {
        this.swingFx(e);
        break;
      }

      case "explosion": {
        this.explosionFx(e);
        break;
      }

      case "death": {
        this.deathFx(e);
        break;
      }

      case "cast": {
        this.castFx(e);
        break;
      }

      case "levelup": {
        this.levelupFx(e);
        break;
      }

      case "heal": {
        this.fountain(e.x, e.y, 10, 0x6b_ff_8e);
        this.numbers.spawn(`+${Math.round(e.amount)}`, e.x, e.y, "heal", this.nowMs);
        break;
      }

      case "blink": {
        this.blinkFx(e);
        break;
      }

      case "itemUse": {
        this.itemUseFx(e.x, e.y, e.item);
        break;
      }

      case "perfectDodge": {
        this.perfectDodgeFx(e);
        break;
      }

      case "delivery": {
        this.fountain(e.x, e.y, 14, 0x66_ff_cc);
        this.castDome(e.x, e.y, 0x66_ff_cc, 1.6);
        this.audio.delivery();
        break;
      }

      case "coinThrow": {
        this.coinThrowFx(e);
        break;
      }

      case "coinGrab": {
        this.fountain(e.x, e.y, 14, 0xff_d2_4a);
        this.numbers.spawn(`+${e.gold}`, e.x, e.y, "gold", this.nowMs);
        this.view.addTrauma(0.12);
        this.audio.coin();
        break;
      }

      case "kill": {
        this.killFx(e);
        break;
      }

      case "notify": {
        this.notifyFx(e);
        break;
      }

      default: {
        break;
      }
    }
  }

  private castFx(e: FxOf<"cast">) {
    this.signatureCast(`${e.champId}:${e.key}`, e.x, e.y, e.dx, e.dy);
    this.audio.cast(e.champId, e.key, e.x, e.y, e.unitId === this.localId);

    if (e.key === "R" && this.within(e.x, e.y, 1.5)) {
      this.view.punchFov(2.2);
    }
  }

  private perfectDodgeFx(e: FxOf<"perfectDodge">) {
    this.impactRing(e.x, e.y, 0x66_ff_e0, 2.2);
    this.flash(e.x, 1.1, e.y, 0x9f_ff_e8, 1, 1.8);

    if (e.unit === this.localId) {
      this.slowMo = Math.max(this.slowMo, 0.2);
      this.numbers.spawn("PERFECT", e.x, e.y, "banner", this.nowMs);
    }
  }

  private hitFx(e: FxOf<"hit">, w: World) {
    const attacker = w.units.get(e.by);
    const palette = attacker ? CHAMP_FX.get(attacker.champId) : undefined;
    const color = hitColor(e.dtype, palette?.primary);
    const heavy = e.crit ?? false;
    const mine = e.by !== "" && e.by === this.localId;
    const onMe = e.to === this.localId;
    const distantBasic = !mine && !onMe && !heavy && !this.within(e.x, e.y, 14);
    const priority: ParticlePriority = mine || onMe || heavy ? "major" : "impact";
    this.hitVisuals(e, { color, distantBasic, heavy, priority });

    if (heavy) {
      this.audio.crit(e.x, e.y, onMe);
    }

    this.hitFeel(e, { distantBasic, heavy, mine, onMe });
    this.audio.hit(e.x, e.y, e.dtype, onMe);
    this.hitNumber(e.x, e.y, e.amount, e.dx, e.dy, heavy, e.by);
  }

  private hitVisuals(
    e: FxOf<"hit">,
    o: { color: number; distantBasic: boolean; heavy: boolean; priority: ParticlePriority },
  ) {
    const { color, distantBasic, heavy, priority } = o;

    if (!distantBasic) {
      this.flash(e.x, 1.1, e.y, 0xff_ff_ff, heavy ? 1.2 : 0.55, heavy ? 2.2 : 1.4, priority);
      this.impactRing(e.x, e.y, color, heavy ? 2.1 : 1.2);
    }

    if (heavy) {
      this.flare("impact-burst", e.x, 1.15, e.y, 0xff_f2_d0, 2, 0.14, Math.random() * Math.PI);
    }

    let sparkCount = 8;

    if (heavy) {
      sparkCount = 20;
    } else if (distantBasic) {
      sparkCount = 3;
    }

    this.sparks(e.x, 1.1, e.y, e.dx, e.dy, sparkCount, color, priority);

    if (!distantBasic) {
      this.burst(e.x, 1.1, e.y, heavy ? 7 : 4, color, 5, 0.16, priority);
    }

    if (heavy) {
      this.impactRing(e.x, e.y, 0xff_d2_4a, 2.8);
    }
  }

  private hitFeel(
    e: FxOf<"hit">,
    o: { distantBasic: boolean; heavy: boolean; mine: boolean; onMe: boolean },
  ) {
    const { distantBasic, heavy, mine, onMe } = o;

    if (mine) {
      this.view.addTrauma(0.05);
      this.view.kick(e.dx, e.dy, heavy ? 0.55 : 0.34);

      if (heavy) {
        this.view.punchFov(1.8);
      }

      this.hitsThisFrame += 1;

      if (heavy) {
        this.heavyThisFrame = true;
      }

      this.localHits.push({ crit: heavy });
    } else if (onMe) {
      this.view.addTrauma(heavy ? 0.22 : 0.16);
      this.view.kick(e.dx, e.dy, 0.5);
    } else {
      this.view.addTrauma((distantBasic ? 0.015 : 0.06) * this.att(e.x, e.y));
    }
  }

  private fizzleFx(e: FxOf<"fizzle">) {
    const fc = FIZZLE_COLOR.get(e.kind) ?? 0xb0_70_ff;

    for (let i = 0; i < 4; i += 1) {
      const o = sp(e.x + (Math.random() - 0.5) * 0.4, 1.1, e.y + (Math.random() - 0.5) * 0.4);
      o.vx = (Math.random() - 0.5) * 1.5;
      o.vz = (Math.random() - 0.5) * 1.5;
      o.vy = -0.6 - Math.random();
      o.drag = 2;
      o.life = 0.35 + Math.random() * 0.2;
      o.size = 0.28;
      o.color = fc;
      this.pools.spawn("add", o);
    }
  }

  private propBreakFx(e: FxOf<"propBreak">) {
    const wood = propWoodColor(e.model);
    this.chunks.burst(
      e.x,
      e.y,
      e.model.includes("stacked") ? 10 : 7,
      wood,
      e.explosive === true ? 7 : 5,
    );
    this.dust(e.x, e.y, 4);
    this.sparks(e.x, 0.7, e.y, 0, 1, 5, 0xd8_c0_90);
    this.impactRing(e.x, e.y, 0xc0_a0_60, 1.4);
    this.view.addTrauma(0.06 * this.att(e.x, e.y));
    this.audio.hit(e.x, e.y, "physical");
  }

  private swingFx(e: FxOf<"swing">) {
    if (e.melee) {
      return;
    }

    const c = e.dtype === "magic" ? 0xc0_70_ff : 0xff_e6_a0;
    const dx = Math.cos(e.ang);
    const dy = Math.sin(e.ang);
    this.crossGlint(e.x + dx * 0.4, 1.15, e.y + dy * 0.4, dx, dy, c, 0.7);
    this.flash(e.x, 1.1, e.y, c, 0.7);
    this.sparks(e.x, 1.1, e.y, dx, dy, 7, c);
  }

  private explosionFx(e: FxOf<"explosion">) {
    if (e.kind === "bolt") {
      this.flash(e.x, 1.1, e.y, 0xc8_a8_ff, 0.7, 1.5);
      this.implode(e.x, e.y, 0xb0_70_ff, e.radius * 0.7, 5, 0.16);
      this.impactRing(e.x, e.y, 0xb0_70_ff, e.radius * 0.8);

      return;
    }

    const color = EXPLOSION_COLOR.get(e.kind) ?? 0xff_a0_30;
    const big = e.kind === "meteor";
    this.flash(e.x, 0.9, e.y, 0xff_ff_ff, big ? 2.4 : 1.5, 2.4, "major");
    this.burst(e.x, 0.8, e.y, big ? 26 : 16, color, big ? 9 : 7, 0.5, "major");
    this.shockwave(e.x, e.y, color, e.radius);
    this.explosionKindFx(e);
    this.view.addTrauma((big ? 0.5 : 0.22) * this.att(e.x, e.y));

    if (big && this.within(e.x, e.y, 14)) {
      this.bumpFreeze(70);
    }

    this.audio.explosion();
  }

  private explosionKindFx(e: FxOf<"explosion">) {
    switch (e.kind) {
      case "nova": {
        this.spikes.erupt(e.x, e.y, e.radius * 0.7, 11, 0xbf_e8_ff, {
          exitMs: 180,
          h: 1.5,
          holdMs: 1050,
          tiltOut: 0.3,
          w: 0.62,
        });
        this.fountain(e.x, e.y, 10, 0x9f_e8_ff);
        this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.85, 0x7f_d4_ff, 1.6);
        const nx = e.x;
        const ny = e.y;
        this.delay(1.2, () => {
          this.chunks.burst(nx, ny, 9, 0x9f_d8_ff, 6);
        });
        break;
      }

      case "hexring": {
        this.voids.open(e.x, terrainHeight(e.x, e.y), e.y, e.radius, { life: 1.7 });
        this.implode(e.x, e.y, 0xb9_8a_e0, e.radius, 10, 0.24);
        this.shockwave(e.x, e.y, 0x7f_e0_8a, e.radius, 0.5, 0.7);
        this.spikes.scatter(e.x, e.y, e.radius * 0.75, 6, 0xb9_8a_e0, {
          exitMs: 300,
          h: 0.5,
          holdMs: 1300,
          tiltOut: 0.05,
          w: 0.75,
        });
        const hx = e.x;
        const hy = e.y;
        const hr = e.radius;
        this.delay(0.25, () => {
          this.spikes.scatter(hx, hy, hr * 0.7, 5, 0x7f_e0_8a, {
            exitMs: 300,
            h: 0.42,
            holdMs: 1100,
            tiltOut: 0.05,
            w: 0.6,
          });
          this.bubbles(hx, hy, 8, 0x9f_ef_a8, hr * 0.7);
        });

        for (const t of [0.45, 0.8, 1.15]) {
          this.delay(t, () => {
            this.implode(hx, hy, 0x9f_ef_a8, hr * 0.9, 8, 0.3);
          });
        }

        break;
      }

      case "vines": {
        this.spikes.erupt(e.x, e.y, e.radius * 0.8, 9, 0x3a_6a_2a, {
          exitMs: 350,
          h: 1.6,
          holdMs: 1000,
          tiltOut: -0.45,
          w: 0.46,
        });
        this.spikes.scatter(e.x, e.y, e.radius * 0.5, 4, 0x5a_8a_3a, {
          exitMs: 300,
          h: 1,
          holdMs: 900,
          w: 0.28,
        });
        this.fountain(e.x, e.y, 12, 0x7f_e0_8a);
        this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.8, 0x20_30_18, 1.6);
        break;
      }

      case "trap": {
        this.spikes.ring(e.x, e.y, e.radius * 0.85, 8, 0x2c_5a_30, {
          exitMs: 250,
          h: 1.3,
          holdMs: 850,
          tiltOut: -0.5,
          w: 0.3,
        });
        break;
      }

      case "smite": {
        this.pillars.strike(e.x, terrainHeight(e.x, e.y), e.y, e.radius);
        this.texDecal("ground-crack", e.x, e.y, { additive: false, life: 1.8, size: 4.4 });
        this.texSprite("electric-splat", e.x, 0.8, e.y, {
          color: 0xff_f2_c0,
          grow: 1.7,
          life: 0.3,
          size: 3.2,
        });
        this.sparks(e.x, 0.4, e.y, 0, 1, 10, 0xff_f2_c0);
        this.crossGlint(e.x, 3, e.y, 0, 1, 0xff_e6_a0, 1.1);
        break;
      }

      case "meteor": {
        this.beam(e.x, e.y, 0xff_80_40, 9, 1.2);
        this.debris(e.x, e.y, 6, 0x80_40_30);
        this.chunks.burst(e.x, e.y, 8, 0x5a_2a_18, 8);
        this.smoke(e.x, e.y, 8, "major");
        this.texDecal("shock-burst", e.x, e.y, {
          color: 0xff_b0_60,
          grow: 4.5,
          life: 0.5,
          size: 3,
        });
        this.texDecal("scorch-decal", e.x, e.y, {
          color: 0xff_80_40,
          life: 2.2,
          size: e.radius * 1.7,
        });

        for (let i = 0; i < 4; i += 1) {
          this.texFlipbook(
            "fire-sprite",
            4,
            4,
            e.x + (Math.random() - 0.5) * e.radius,
            0.8 + Math.random(),
            e.y + (Math.random() - 0.5) * e.radius,
            { life: 0.55, rise: 1.4, size: 1.6 + Math.random() },
          );
        }

        this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.8, 0x1a_0f_0a, 4);
        const mx = e.x;
        const my = e.y;
        const mr = e.radius;

        for (const t of [0.35, 0.75, 1.2]) {
          this.delay(t, () => {
            const a = Math.random() * Math.PI * 2;
            const rr = Math.random() * mr * 0.6;
            this.burst(mx + Math.cos(a) * rr, 0.4, my + Math.sin(a) * rr, 5, 0xff_80_40, 4, 0.4);
            this.smoke(mx + Math.cos(a) * rr, my + Math.sin(a) * rr, 2);
          });
        }

        break;
      }

      case "fireball": {
        this.spikes.ring(e.x, e.y, e.radius * 0.45, 5, 0xff_7a_2c, {
          exitMs: 200,
          h: 0.8,
          holdMs: 260,
          w: 0.3,
        });
        this.texDecal("scorch-decal", e.x, e.y, { color: 0xff_70_30, life: 1.5, size: 3.4 });
        this.texFlipbook("fire-sprite", 4, 4, e.x, 1, e.y, {
          life: 0.55,
          rise: 1,
          size: 2.6,
        });
        this.smoke(e.x, e.y, 4);
        break;
      }

      case "keg": {
        this.burst(e.x, 0.8, e.y, 8, 0xff_80_40, 7, 0.4);
        this.smoke(e.x, e.y, 6);
        this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.7, 0x1a_0f_0a, 3);

        if (this.within(e.x, e.y, 12)) {
          this.bumpFreeze(40);
        }

        break;
      }

      case "hexbolt": {
        this.bubbles(e.x, e.y, 8, 0x9f_ef_a8, e.radius * 0.7);
        this.texSprite("swirl-lines", e.x, 1.2, e.y, {
          color: 0x9f_ef_a8,
          grow: 1.6,
          life: 0.4,
          size: 2.4,
          spin: Math.PI * 2,
        });
        break;
      }

      default: {
        this.smoke(e.x, e.y, 5);
      }
    }
  }

  private deathFx(e: FxOf<"death">) {
    this.flash(e.x, 1, e.y, 0xff_ff_ff, 1.2, 2, "major");
    this.burst(e.x, 1, e.y, 16, 0x99_a0_b5, 6, 0.6, "major");
    this.smoke(e.x, e.y, 4, "major");

    if (e.by !== "" && e.by === this.localOwnerId) {
      this.hardFreeze = Math.max(this.hardFreeze, 0.1);
      this.slowMo = Math.max(this.slowMo, 0.25);
      this.view.addTrauma(0.45);
      this.view.punchFov(4);
      this.shockwave(e.x, e.y, 0xff_d2_4a, 3.5);
      this.flash(e.x, 1.2, e.y, 0xff_ff_ff, 1.8, 2.6, "major");
      this.audio.killConfirm();
    } else if (e.team === this.localTeam && this.localTeam !== "") {
      this.slowMo = Math.max(this.slowMo, 0.35);
      this.view.addTrauma(0.4);
    } else {
      this.view.addTrauma(0.3 * this.att(e.x, e.y));

      if (this.within(e.x, e.y, 12)) {
        this.bumpFreeze(50);
      }
    }

    this.audio.death();
  }

  private levelupFx(e: FxOf<"levelup">) {
    this.implode(e.x, e.y, 0xff_d2_4a, 2, 10, 0.25);
    this.delay(0.18, () => {
      this.fountain(e.x, e.y, 16, 0xff_d2_4a);
      this.shockwave(e.x, e.y, 0xff_d2_4a, 3);
      this.beam(e.x, e.y, 0xff_d2_4a);
    });
    this.audio.levelup();
  }

  private blinkFx(e: FxOf<"blink">) {
    this.implode(e.x, e.y, 0x9a_7b_ff, 1.6, 8, 0.22);
    this.ghost(e.x, e.y, 0x9a_7b_ff);
    this.burst(e.tx, 1, e.ty, 10, 0x9a_7b_ff, 5, 0.35);
    this.impactRing(e.tx, e.ty, 0xb0_90_ff, 2.2);
    this.crossGlint(e.tx, 1.3, e.ty, 0, 1, 0xc0_a0_ff, 1.1);
  }

  private coinThrowFx(e: FxOf<"coinThrow">) {
    this.implode(e.x, e.y, 0xff_d2_4a, 1.4, 10, 0.2);
    this.delay(0.12, () => {
      this.flash(e.x, 3, e.y, 0xff_d2_4a, 1.1);
      this.burst(e.x, 3, e.y, 8, 0xff_d2_4a, 5, 0.35);
      const dx = e.tx - e.x;
      const dy = e.ty - e.y;
      this.castStreak(e.x, e.y, dx, dy, 0xff_d2_4a, 8, 8, 0.3);
    });
  }

  private killFx(e: FxOf<"kill">) {
    this.feed.push({
      killer: e.killer,
      killerName: e.killerName,
      leader: e.leader,
      victim: e.victim,
      victimName: e.victimName,
    });

    if (e.victim === this.localOwnerId) {
      this.lastDeath = { at: this.nowMs, killerName: e.killerName };
    }

    if (e.killer !== "" && e.killer === this.localOwnerId) {
      const streak = this.bestStreak;

      if (streak >= 3) {
        this.audio.stinger(streakStingerTier(streak));
      }
    }

    if (e.leader === true) {
      this.audio.leaderSlain();
    }
  }

  private notifyFx(e: FxOf<"notify">) {
    if (e.kind === "matchend") {
      this.slowMo = Math.max(this.slowMo, 1.2);
    } else {
      this.toasts.push({ kind: e.kind, text: e.text });

      if (e.kind === "delivery") {
        this.audio.delivery();
      } else if (e.kind === "leader" || e.kind === "streak") {
        this.audio.alert();
      }
    }
  }

  private itemUseFx(x: number, y: number, item: string) {
    switch (item) {
      case "swiftboots": {
        this.burst(x, 0.6, y, 8, 0x66_ff_ee, 6, 0.3);
        this.footDust(x, y, 1, 0);
        this.footDust(x, y, -1, 0);
        break;
      }

      case "talisman": {
        this.castDome(x, y, 0xff_ff_ff, 1.6, 0.3);
        this.sparks(x, 0.6, y, 0, 1, 8, 0xff_ff_ff);
        this.fountain(x, y, 6, 0xff_f2_d0);
        break;
      }

      case "bulwark": {
        this.flash(x, 1.2, y, 0xff_d2_4a, 1, 1.6);
        break;
      }

      default: {
        this.flash(x, 1.1, y, 0x9f_d0_ff, 0.8);
        break;
      }
    }
  }

  private signatureCast(tag: string, x: number, y: number, dx: number, dy: number) {
    const [champ = "", key = ""] = tag.split(":");

    switch (champ) {
      case "knight": {
        this.knightCast(key, x, y, dx, dy);
        break;
      }

      case "ranger": {
        this.rangerCast(key, x, y, dx, dy);
        break;
      }

      case "mage": {
        this.mageCast(key, x, y, dx, dy);
        break;
      }

      case "rogue": {
        this.rogueCast(key, x, y, dx, dy);
        break;
      }

      case "blackknight": {
        this.blackknightCast(key, x, y, dx, dy);
        break;
      }

      case "witch": {
        this.witchCast(key, x, y, dx, dy);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private genericCast(x: number, y: number) {
    this.flash(x, 1.3, y, 0x9f_d0_ff, 0.9);
    this.burst(x, 1.2, y, 6, 0x9f_d0_ff, 3, 0.3);
  }

  private knightCast(key: string, x: number, y: number, dx: number, dy: number) {
    switch (key) {
      case "Q": {
        this.implode(x, y, 0xea_f2_ff, 1.8, 7, 0.2);
        this.dust(x, y, 3);
        break;
      }

      case "W": {
        this.implode(x, y, 0x8f_d0_ff, 1.6, 6, 0.2);
        this.footDust(x, y, -dx, -dy);
        break;
      }

      case "E": {
        this.implode(x, y, 0xea_f2_ff, 2.2, 10, 0.26);
        this.texShell("hex-shield", x, 1.25, y, {
          color: 0x5f_a0_ff,
          life: 1.6,
          r: 2,
          repeat: [4, 2],
          scrollY: 0.02,
        });
        this.shockwave(x, y, 0xea_f2_ff, 2, 0.4, 0.8);
        this.dust(x, y, 4);
        this.sparks(x, 0.4, y, 0, 1, 4, 0xff_f2_c0);
        break;
      }

      case "R": {
        this.implode(x, y, 0xbf_e0_ff, 3, 12, 0.26);
        this.shockwave(x, y, 0xea_f2_ff, 4);
        this.shockwave(x, y, 0xbf_e0_ff, 5.5, 0.5);
        this.burst(x, 1.2, y, 16, 0xbf_e0_ff, 8, 0.4);
        this.view.addTrauma(0.14);
        break;
      }

      case "DASH": {
        this.castStreak(x, y, dx, dy, 0x8f_d0_ff, 18, 10, 0.14);
        this.flash(x + dx, 1.15, y + dy, 0xea_f2_ff, 0.9, 1.6);
        this.footDust(x, y, -dx, -dy);
        this.castDome(x, y, 0xea_f2_ff, 1, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0xea_f2_ff, 0.8);
        break;
      }

      case "JUMP": {
        this.implode(x, y, 0xea_f2_ff, 2.2, 8, 0.2);
        this.dust(x, y, 3);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private rangerCast(key: string, x: number, y: number, dx: number, dy: number) {
    switch (key) {
      case "Q": {
        this.implode(x, y, 0xff_e6_a0, 1.2, 6, 0.18);
        this.crossGlint(x + dx * 0.6, 1.3, y + dy * 0.6, dx, dy, 0xff_e6_a0, 0.7);
        this.sectorRim(x, y, dx, dy, 0xff_e6_a0, 5, 0.2);
        break;
      }

      case "W": {
        this.implode(x, y, 0xff_e6_a0, 2, 10, 0.26);
        this.texShell("electro-ball", x, 2.3, y, {
          color: 0xff_e6_a0,
          life: 1.4,
          r: 0.9,
          repeat: [2, 1],
          scrollY: 0.06,
        });
        this.fountain(x, y, 12, 0xff_e6_a0);
        break;
      }

      case "E": {
        this.flash(x + dx, 0.5, y + dy, 0x9a_ff_c0, 0.7);
        this.sparks(x + dx, 0.9, y + dy, 0, -1, 6, 0x9a_ff_c0);
        break;
      }

      case "R": {
        this.beam(x, y, 0xff_e6_a0);
        this.implode(x, y, 0xff_e6_a0, 3, 10, 0.28);
        this.flash(x, 4.5, y, 0xff_e6_a0, 2, 1.6);
        this.crossGlint(x, 8, y, dx, dy, 0xff_f2_c0, 1.6);
        this.crossGlint(x, 9.2, y, -dy, dx, 0xff_e6_a0, 1.2);
        break;
      }

      case "DASH": {
        this.castStreak(x, y, dx, dy, 0x9f_ff_e0, 14, 8, 0.1);
        this.smoke(x, y, 3);
        this.footDust(x, y, -dx, -dy);
        this.footDust(x, y, -dx, -dy);
        this.castDome(x, y, 0x7d_ff_b0, 1, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0x9f_ff_e0, 0.7);
        break;
      }

      case "JUMP": {
        this.dust(x, y, 4);
        this.impactRing(x, y, 0xff_e6_a0, 1.8);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private mageCast(key: string, x: number, y: number, dx: number, dy: number) {
    switch (key) {
      case "Q": {
        this.implode(x, y, 0xff_a0_30, 1.4, 7, 0.2);
        this.mote(x + dx * 0.5, 1.3, y + dy * 0.5, 0xff_d0_60, 0.6, 0.25, 0.5);
        break;
      }

      case "W": {
        this.castDome(x, y, 0x7f_d4_ff, 1.8, 0.34);
        this.iceShards(x, y, 6);
        break;
      }

      case "E": {
        this.castStreak(x, y, dx, dy, 0xff_80_40, 12, 8, 0.3);
        this.flash(x + dx * 0.6, 1.3, y + dy * 0.6, 0xff_b0_60, 1, 1.7);
        this.sparks(x + dx * 0.6, 1.2, y + dy * 0.6, dx, dy, 6, 0xff_80_40);
        break;
      }

      case "R": {
        this.beam(x, y, 0xff_5a_2c);
        this.flash(x, 4, y, 0xff_80_40, 2, 2.2);
        this.castStreak(x, y, 0, 1, 0xff_5a_2c, 3, 8, 1.2);
        break;
      }

      case "DASH": {
        this.implode(x, y, 0x9a_7b_ff, 1.6, 8, 0.22);
        this.crossGlint(x, 1.3, y, dx, dy, 0xc0_a0_ff, 1);
        break;
      }

      case "JUMP": {
        this.dust(x, y, 4);
        this.implode(x, y, 0xff_80_40, 2.4, 8, 0.2);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private rogueCast(key: string, x: number, y: number, dx: number, dy: number) {
    switch (key) {
      case "Q": {
        this.castStreak(x, y, dx, dy, 0x7f_ff_8e, 14, 12, 0.2);
        this.smoke(x, y, 2);
        break;
      }

      case "W": {
        this.implode(x, y, 0xff_30_60, 1.4, 6, 0.16);
        this.smoke(x, y, 2);
        break;
      }

      case "E": {
        this.smoke(x, y, 10);
        this.castDome(x, y, 0x6a_5a_9a, 2.4, 0.5);
        this.telegraphs.spawnResidue(x, y, 2.4, 0x20_18_30, 2);
        break;
      }

      case "R": {
        this.castStreak(x, y, dx, dy, 0xff_30_60, 22, 14, 0.14);
        this.texSprite("galaxy", x, 1.8, y, {
          color: 0xc0_a8_ff,
          life: 0.45,
          size: 2.8,
          spin: Math.PI * 2,
        });
        this.texSprite("dark-shock", x, 1.8, y, {
          color: 0x8a_5f_d0,
          grow: 1.5,
          life: 0.45,
          size: 3.4,
        });
        this.smoke(x, y, 3);
        break;
      }

      case "DASH": {
        this.castStreak(x, y, dx, dy, 0x6a_5a_9a, 16, 10, 0.14);
        this.smoke(x, y, 6);
        this.spawnResidue(x, y, 1.6, 0x20_18_30, 2);
        this.footDust(x, y, -dx, -dy);
        break;
      }

      case "JUMP": {
        this.implode(x, y, 0x6a_5a_9a, 1.8, 8, 0.2);
        this.smoke(x, y, 2);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private blackknightCast(key: string, x: number, y: number, dx: number, dy: number) {
    switch (key) {
      case "Q": {
        this.implode(x, y, 0xff_f2_c0, 1.8, 7, 0.2);
        this.smoke(x, y, 2);
        break;
      }

      case "W": {
        this.castDome(x, y, 0xff_d7_6a, 1.6, 0.3);
        this.flash(x, 1.2, y, 0xff_f2_c0, 1.1, 1.8);
        this.sparks(x, 0.4, y, 0, 1, 8, 0xff_f2_c0);
        this.crossGlint(x + dx, 1.4, y + dy, dx, dy, 0xff_e6_a0, 1);
        break;
      }

      case "E": {
        this.castDome(x, y, 0xff_e6_a0, 2.4, 0.5);
        this.sparks(x, 0.4, y, 0, 1, 8, 0xff_f2_c0);
        break;
      }

      case "R": {
        this.implode(x, y, 0xff_f2_c0, 4, 12, 0.24);
        this.beam(x, y, 0xff_d7_6a, 6, 0.8);
        this.texSprite("holy-wings", x, 2.4, y, {
          color: 0xff_e6_a0,
          grow: 1.25,
          life: 1.1,
          size: 6.5,
        });
        this.texStreak("trail-holy", x + 1.4, 0.2, y, x + 1.4, 5, y, {
          color: 0xff_d7_6a,
          len: 2.4,
          life: 0.8,
          w: 0.9,
        });
        this.texStreak("trail-holy", x - 1.2, 0.2, y + 0.8, x - 1.2, 5, y + 0.8, {
          color: 0xff_d7_6a,
          len: 2.4,
          life: 0.8,
          w: 0.9,
        });
        break;
      }

      case "DASH": {
        this.castStreak(x, y, dx, dy, 0xff_d7_6a, 16, 10, 0.16);
        this.flash(x + dx, 1.15, y + dy, 0xff_f2_c0, 1, 1.6);
        this.footDust(x, y, -dx, -dy);
        this.footDust(x, y, -dx, -dy);
        this.castDome(x, y, 0xff_e6_a0, 1, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0xff_d7_6a, 0.8);
        break;
      }

      case "JUMP": {
        this.implode(x, y, 0xff_f2_c0, 2.6, 10, 0.22);
        this.dust(x, y, 3);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private witchCast(key: string, x: number, y: number, dx: number, dy: number) {
    switch (key) {
      case "Q": {
        this.implode(x, y, 0x7f_e0_8a, 1.2, 6, 0.18);
        this.crossGlint(x + dx * 0.6, 1.3, y + dy * 0.6, dx, dy, 0x7f_e0_8a, 0.8);
        break;
      }

      case "W": {
        this.castDome(x, y, 0x7f_e0_8a, 1.8, 0.35);
        this.bubbles(x, y, 6, 0x7f_e0_8a);
        break;
      }

      case "E": {
        this.castDome(x, y, 0x4a_7a_3a, 1.4, 0.3);
        this.crossGlint(x + dx, 1.2, y + dy, dx, dy, 0x9f_ef_a8, 0.9);
        break;
      }

      case "R": {
        this.implode(x, y, 0xb9_8a_e0, 3, 12, 0.26);
        this.castDome(x, y, 0x7f_e0_8a, 2.4, 0.45);
        this.bubbles(x, y, 8, 0x9f_ef_a8);
        break;
      }

      case "DASH": {
        this.castStreak(x, y, dx, dy, 0xb9_8a_e0, 20, 12, 0.14);
        this.footDust(x, y, -dx, -dy);
        this.mote(x, 0.6, y, 0x7f_e0_8a, 2, 0.6, 0.3);
        this.castDome(x, y, 0x7f_e0_8a, 1, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0xb9_8a_e0, 0.7);
        break;
      }

      case "JUMP": {
        this.implode(x, y, 0xb9_8a_e0, 2.4, 8, 0.2);
        this.bubbles(x, y, 4, 0x9f_ef_a8);
        break;
      }

      default: {
        this.genericCast(x, y);
      }
    }
  }

  private strikeFx(tag: string, x: number, y: number, dx: number, dy: number, r: number) {
    const [champ = "", key = ""] = tag.split(":");

    if (key === "JUMP") {
      this.jumpStrikeFx(champ, x, y, dx, dy, r);

      return;
    }

    if (champ === "rogue") {
      this.rogueStrikeFx(key, x, y, dx, dy, r);

      return;
    }

    switch (tag) {
      case "spin": {
        this.shockwave(x, y, 0x8f_d0_ff, r, 0.3);
        this.slashArc(x, y, Math.atan2(dy, dx), r * 1.2, 0xbf_e0_ff, {
          height: 1,
          life: 0.34,
          span: 3.1,
          tex: "spin",
          tilt: 0,
        });
        this.burst(x, 1.1, y, 12, 0xbf_e0_ff, 7, 0.3);
        this.dust(x, y, 5);

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.1);
        }

        break;
      }

      case "knight:Q": {
        this.slashArc(x, y, Math.atan2(dy, dx), r, 0xdb_e8_ff, {
          life: 0.3,
          span: 0.85,
          tilt: 0.3,
        });
        this.sectorRim(x, y, dx, dy, 0xea_f2_ff, r, 0.79);
        this.sparks(x + dx, 1.2, y + dy, dx, dy, 12, 0xea_f2_ff);
        this.crack(x + dx * 2, y + dy * 2, Math.atan2(dy, dx), 2.2, 1.5, 0x8f_d0_ff, 1.8);
        this.chunks.burst(x + dx * 1.8, y + dy * 1.8, 3, 0x6a_70_78, 4);

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.08);
        }

        break;
      }

      case "knight:W": {
        const ang = Math.atan2(dy, dx);
        const kx = x;
        const ky = y;

        for (let seg = 0; seg < 3; seg += 1) {
          const d = 1.6 + seg * 2.3;
          this.delay(seg * 0.06, () => {
            this.crack(kx + dx * d, ky + dy * d, ang, 2.4, 1.2, 0x8f_d0_ff, 2.4);
            this.dust(kx + dx * d, ky + dy * d, 3);
            this.sparks(kx + dx * d, 0.4, ky + dy * d, dx, dy, 4, 0xbf_e0_ff);
          });
        }

        this.delay(0.14, () => {
          this.impactRing(kx + dx * 6.4, ky + dy * 6.4, 0xea_f2_ff, 2.4);
          this.chunks.burst(kx + dx * 6.4, ky + dy * 6.4, 5, 0x6a_70_78, 5);
        });

        if (this.within(x, y, 14)) {
          this.view.kick(dx, dy, 0.4);
          this.view.addTrauma(0.1);
        }

        break;
      }

      case "ranger:Q": {
        this.castStreak(x, y, dx, dy, 0xff_e6_a0, 20, 12, 0.45);
        this.flash(x + dx, 1.3, y + dy, 0xff_ff_ff, 0.9, 1.6);
        break;
      }

      case "mage:Q": {
        this.castStreak(x, y, dx, dy, 0xff_a0_30, 14, 12, 0.22);
        this.flash(x + dx, 1.3, y + dy, 0xff_d0_60, 1.2, 2);
        break;
      }

      case "witch:Q": {
        this.castStreak(x, y, dx, dy, 0x7f_e0_8a, 16, 10, 0.12);
        this.flash(x + dx, 1.3, y + dy, 0xb0_ff_b8, 0.9, 1.6);
        break;
      }

      case "blackknight:Q": {
        this.slashArc(x, y, Math.atan2(dy, dx), r, 0xff_d7_6a, {
          life: 0.32,
          span: 1,
          tex: "arc",
          tilt: 0.25,
        });
        this.sectorRim(x, y, dx, dy, 0xff_f2_c0, r, 0.96);
        this.sparks(x + dx, 1.2, y + dy, dx, dy, 10, 0xff_f2_c0);
        const gx = x + dx * 2.2;
        const gy = y + dy * 2.2;
        this.delay(0.12, () => {
          this.sparks(gx, 2.4, gy, 0, -1, 8, 0xff_e6_a0);
        });
        break;
      }

      case "blackknight:R": {
        this.crack(x, y, Math.random() * Math.PI, 4.6, 4.6, 0xff_d7_6a, 3);
        this.shockwave(x, y, 0xff_d7_6a, 5.5);
        this.shockwave(x, y, 0xff_f2_c0, 4, 0.5);
        this.burst(x, 1.2, y, 20, 0xff_d7_6a, 9, 0.4);
        this.chunks.burst(x, y, 10, 0x7a_62_38, 7);
        this.smoke(x, y, 6);

        if (this.within(x, y, 14)) {
          this.bumpFreeze(60);
          this.view.screenPulse(0.14, 0.22);
        }

        this.view.addTrauma(0.18);
        break;
      }

      default: {
        this.impactRing(x, y, 0x9f_d0_ff, Math.max(1.2, r * 0.6));
      }
    }
  }

  private rogueStrikeFx(key: string, x: number, y: number, dx: number, dy: number, r: number) {
    switch (key) {
      case "Q": {
        this.slashArc(x, y, Math.atan2(dy, dx), 2.2, 0x7f_ff_8e, {
          life: 0.24,
          span: 0.7,
          tilt: 0.45,
        });
        this.crossGlint(x, 1.2, y, dx, dy, 0x7f_ff_8e, 1.2);
        this.sparks(x, 1.1, y, dx, dy, 8, 0x7f_ff_8e);
        this.drips(x, y, 6, 0x4a_9a_3a);
        break;
      }

      case "W": {
        this.slashArc(x + dx * 2, y + dy * 2, Math.atan2(dy, dx), 2.4, 0xff_5a_78, {
          life: 0.26,
          span: 0.6,
          tilt: 0.5,
        });
        this.crack(x + dx * 3, y + dy * 3, Math.atan2(dy, dx), 3.4, 0.9, 0xff_30_60, 3.2, 1);
        this.castStreak(x, y, dx, dy, 0xff_30_60, 20, 12, 0.14);
        this.drips(x + dx * 3, y + dy * 3, 5, 0x8a_10_20);
        this.smoke(x + dx * 2, y + dy * 2, 3);
        break;
      }

      case "R": {
        const ang = Math.atan2(dy, dx);
        this.slashArc(x, y, ang, 2.6, 0xff_5a_78, { life: 0.28, span: 0.6, tilt: 0.55 });
        this.slashArc(x, y, ang, 2.6, 0xff_30_60, { dir: -1, life: 0.28, span: 0.6, tilt: -0.55 });
        this.flash(x, 1.2, y, 0xff_50_70, 1.3, 2);
        this.crossGlint(x, 1.2, y, dx, dy, 0xff_30_60, 1.6);
        this.impactRing(x, y, 0xff_30_60, 2.4);
        this.drips(x, y, 8, 0x8a_10_20);

        if (this.within(x, y, 10)) {
          this.bumpFreeze(35);
          this.view.screenPulse(0.08, 0.18);
        }

        break;
      }

      default: {
        this.impactRing(x, y, 0x9f_d0_ff, Math.max(1.2, r * 0.6));
      }
    }
  }

  private jumpStrikeFx(champ: string, x: number, y: number, dx: number, dy: number, r: number) {
    switch (champ) {
      case "knight": {
        this.shockwave(x, y, 0x8f_d0_ff, r);
        this.crack(x, y, Math.random() * Math.PI, r, r, 0x8f_d0_ff, 2);
        this.sectorRim(x, y, dx, dy, 0xea_f2_ff, r, 0.79);
        this.chunks.burst(x, y, 4, 0x6a_70_78, 5);
        this.dust(x, y, 4);

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.12);
          this.bumpFreeze(40);
        }

        break;
      }

      case "ranger": {
        this.flash(x, HOP_HEIGHT, y, 0xff_e6_a0, 1, 1.7);
        this.crossGlint(x, HOP_HEIGHT, y, dx, dy, 0xff_f2_c0, 1.4);
        const base = Math.atan2(dy, dx);

        for (let i = 0; i < 9; i += 1) {
          const a = base + (i / 9) * Math.PI * 2;
          this.sparks(x, HOP_HEIGHT, y, Math.cos(a), Math.sin(a), 3, 0xff_e6_a0);
        }

        this.shockwave(x, y, 0x7d_ff_b0, r, 0.34, 0.9, HOP_HEIGHT);

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.09);
        }

        break;
      }

      case "mage": {
        this.flash(x, HOP_HEIGHT, y, 0xff_d0_60, 1.5, 2.2);
        this.burst(x, HOP_HEIGHT, y, 14, 0xff_80_40, 7, 0.4);
        this.shockwave(x, y, 0xff_80_40, r, 0.36, 0.9, HOP_HEIGHT);
        this.shockwave(x, y, 0xff_d0_60, r * 0.55, 0.26, 0.95, HOP_HEIGHT);

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.11);
          this.bumpFreeze(40);
        }

        break;
      }

      case "rogue": {
        const ang = Math.atan2(dy, dx);
        this.slashArc(x, y, ang, 1.9, 0xff_5a_78, { life: 0.24, span: 0.55, tilt: 0.5 });
        this.slashArc(x, y, ang, 1.9, 0xff_30_60, { dir: -1, life: 0.24, span: 0.55, tilt: -0.5 });
        this.impactRing(x, y, 0xff_30_60, r);
        this.smoke(x, y, 2);

        if (this.within(x, y, 10)) {
          this.bumpFreeze(35);
        }

        break;
      }

      case "blackknight": {
        this.shockwave(x, y, 0xff_d7_6a, r);
        this.crack(x, y, Math.random() * Math.PI, r, r, 0xff_d7_6a, 2.4);
        this.beam(x, y, 0xff_d7_6a, 8, 1.1);
        this.burst(x, 1, y, 14, 0xff_d7_6a, 8, 0.4);
        this.chunks.burst(x, y, 6, 0x7a_62_38, 6);
        this.smoke(x, y, 4);

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.12);
          this.bumpFreeze(60);
        }

        break;
      }

      case "witch": {
        this.castDome(x, y, 0x7f_e0_8a, r * 0.85);
        this.impactRing(x, y, 0x9f_ef_a8, r);
        this.bubbles(x, y, 8, 0x9f_ef_a8, r * 0.85);
        this.spikes.scatter(x, y, r * 0.6, 3, 0x7f_e0_8a, {
          exitMs: 250,
          h: 0.4,
          holdMs: 900,
          tiltOut: 0.05,
          w: 0.55,
        });

        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.11);
        }

        break;
      }

      default: {
        this.impactRing(x, y, 0x9f_d0_ff, Math.max(1.2, r * 0.6));
      }
    }
  }

  zoneAmbient(g: GroundEffect, now: number) {
    let st = this.zoneAnim.get(g.id);

    if (!st) {
      st = { born: true, bornAt: now, next: 0, next2: 0, phase: Math.random() * 6, seenAt: now };
      this.zoneAnim.set(g.id, st);
    }

    st.seenAt = now;
    const r = g.radius;

    this.zoneRunes(g, now, r);

    switch (g.effect) {
      case "whirlwind": {
        this.whirlwindAmbient(g, st, now, r);
        break;
      }

      case "rain": {
        this.rainAmbient(g, st, now, r);
        break;
      }

      case "meteor": {
        this.meteorAmbient(g, st, now, r);
        break;
      }

      case "brew": {
        this.brewAmbient(g, st, now, r);
        break;
      }

      case "cinderfall": {
        this.cinderfallAmbient(g, st, now, r);
        break;
      }

      case "trap": {
        break;
      }

      default: {
        if (g.enemyDps === undefined || g.enemyDps === 0 || now < st.next) {
          return;
        }

        st.next = now + 300;

        for (let i = 0; i < 2; i += 1) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r;
          const o = sp(g.x + Math.cos(a) * rr, 0.3, g.y + Math.sin(a) * rr);
          o.vy = 1.5;
          o.color = groundFxColor(g.effect);
          o.size = 0.22;
          o.life = 0.5;
          o.priority = "ambient";
          this.pools.spawn("add", o);
        }

        break;
      }
    }
  }

  private whirlwindAmbient(g: GroundEffect, st: ZoneAnim, now: number, r: number) {
    const v = this.zonePiece(g.id, () => {
      const mat = makeVortexMaterial(0xbf_e0_ff);

      return { obj: new THREE.Mesh(this.vortexGeo, mat), ownMat: mat };
    });

    v.seenAt = now;
    v.obj.position.set(g.x, terrainHeight(g.x, g.y) + 1.3, g.y);
    v.obj.scale.set(r * 0.55, 2.6, r * 0.55);
    v.obj.rotation.y = now * 0.004;

    if (now >= st.next2) {
      st.next2 = now + 250;
      this.shockwave(g.x, g.y, 0x8f_d0_ff, r * 0.9, 0.24, 0.35);
      const da = Math.random() * Math.PI * 2;
      this.footDust(
        g.x + Math.cos(da) * r * 0.8,
        g.y + Math.sin(da) * r * 0.8,
        -Math.sin(da),
        Math.cos(da),
      );
    }

    if (now < st.next) {
      return;
    }

    st.next = now + 120;

    for (let i = 0; i < 4; i += 1) {
      st.phase += 2.4;
      const rr = 0.4 + ((st.phase * 0.19) % 1) * (r - 0.4);
      const cx = g.x + Math.cos(st.phase) * rr;
      const cy = g.y + Math.sin(st.phase) * rr;
      const o = sp(cx, 0.5 + Math.random() * 1.2, cy);
      o.vx = -Math.sin(st.phase) * 8;
      o.vz = Math.cos(st.phase) * 8;
      o.vy = 0.6;
      o.drag = 2.5;
      o.color = i % 2 ? 0xea_f2_ff : 0x8f_d0_ff;
      o.size = 0.32;
      o.life = 0.3;
      o.stretch = true;
      o.priority = "ambient";
      this.pools.spawn("add", o);
    }
  }

  private rainAmbient(g: GroundEffect, st: ZoneAnim, now: number, r: number) {
    if (now >= st.next) {
      st.next = now + 250;

      for (let i = 0; i < 6; i += 1) {
        const a = Math.random() * Math.PI * 2;
        const rr = Math.sqrt(Math.random()) * r;
        const o = sp(g.x + Math.cos(a) * rr, 6, g.y + Math.sin(a) * rr);
        o.vy = -18;
        o.color = 0xff_e6_a0;
        o.size = 0.3;
        o.life = 0.35;
        o.stretch = true;
        o.priority = "ambient";
        this.pools.spawn("add", o);
      }
    }

    if (now >= st.next2) {
      st.next2 = now + 500;
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r * 0.8;
      this.impactRing(g.x + Math.cos(a) * rr, g.y + Math.sin(a) * rr, 0xff_e6_a0, 0.8);
    }
  }

  private meteorAmbient(g: GroundEffect, st: ZoneAnim, now: number, r: number) {
    const remain = (g.detonateAt ?? now) - now;

    if (remain > 0 && remain < 650) {
      const c = this.zonePiece(g.id, () => {
        const mesh = new THREE.Mesh(this.cometGeo, this.rockMat);
        mesh.scale.setScalar(Math.min(1.4, r * 0.28));
        mesh.castShadow = true;
        this.rockMat.setHeading(-5, -17, 2.5);

        return { obj: mesh, ownMat: null };
      });

      c.seenAt = now;
      const k = remain / 650;
      c.obj.position.set(g.x + k * 5, terrainHeight(g.x, g.y) + k * 17, g.y - k * 2.5);
      c.obj.rotation.x += 0.055;
      c.obj.rotation.z += 0.031;
      this.rockMat.setCharge(1 - k);
      this.trailAt(c.obj.position.x, c.obj.position.y, c.obj.position.z, 0xff_80_40, 0.8);
      this.trailAt(c.obj.position.x, c.obj.position.y + 0.6, c.obj.position.z, 0x80_40_30, 0.5);
    }

    if (remain > 0 && remain < 400 && now >= st.next2) {
      st.next2 = now + 130;
      this.impactRing(g.x, g.y, 0xff_80_40, r * 0.9);
    }

    if (now < st.next) {
      return;
    }

    st.next = now + 150;

    for (let i = 0; i < 2; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r * 0.8;
      const o = sp(g.x + Math.cos(a) * rr, 0.2, g.y + Math.sin(a) * rr);
      o.vy = 2.4;
      o.color = 0xff_5a_2c;
      o.size = 0.24;
      o.life = 0.5;
      o.priority = "ambient";
      this.pools.spawn("add", o);
    }
  }

  private brewAmbient(g: GroundEffect, st: ZoneAnim, now: number, r: number) {
    const pool = this.zonePiece(g.id, () => {
      const mat = createBrewPoolMaterial(fxClock);
      this.brewPools.set(g.id, mat);
      const mesh = new THREE.Mesh(this.ringPlane, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 4.5;
      mesh.position.set(g.x, terrainHeight(g.x, g.y) + 0.06, g.y);
      mesh.scale.setScalar((r * mat.quad) / 2);

      return { obj: mesh, ownMat: mat };
    });

    pool.seenAt = now;
    const brewPool = this.brewPools.get(g.id);

    if (brewPool) {
      const age = (now - st.bornAt) / 1000;
      const total = Math.max(0.5, (g.until - st.bornAt) / 1000);
      const spread = Math.min(1, age / 0.42);
      const left = (g.until - now) / 1000;
      const surge = (0.5 + 0.5 * Math.sin(age * Math.PI + st.phase)) ** 2.6;
      brewPool.sync({
        boil: surge * 0.9,
        fade: Math.min(1, Math.max(0, left / 0.5)),
        front: 1 - spread,
        grown: r * 1.25 * (1 - (1 - spread) * (1 - spread)),
        radius: r,
        spent: 1 - 0.6 * Math.min(1, age / total),
      });
    }

    if (st.born) {
      st.born = false;
      this.castDome(g.x, g.y, 0x7f_e0_8a, r * 0.6, 0.3);
      this.drips(g.x, g.y, 10, 0x5a_a8_60);
      this.bubbles(g.x, g.y, 8, 0x9f_ef_a8, r * 0.6);
    }

    if (now >= st.next) {
      st.next = now + 250;
      this.bubbles(g.x, g.y, 4, 0x7f_e0_8a, r);
    }

    if (now >= st.next2) {
      st.next2 = now + 600;
      const o = sp(g.x + (Math.random() - 0.5) * r, 0.5, g.y + (Math.random() - 0.5) * r);
      o.vy = 1.2;
      o.cr = 0.16;
      o.cg = 0.24;
      o.cb = 0.15;
      o.size = 1.2;
      o.life = 1.1;
      o.gravity = 1;
      o.drag = 1.2;
      o.alpha = 0.8;
      o.priority = "ambient";
      this.pools.spawn("normal", o);
    }
  }

  private cinderfallAmbient(g: GroundEffect, st: ZoneAnim, now: number, r: number) {
    if (now < st.next) {
      return;
    }

    st.next = now + 140;

    for (let i = 0; i < 3; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r;
      const o = sp(g.x + Math.cos(a) * rr, 0.2, g.y + Math.sin(a) * rr);
      o.vy = 2 + Math.random() * 1.4;
      o.color = i % 2 ? 0xff_80_40 : 0xff_b0_60;
      o.size = 0.28;
      o.life = 0.5;
      o.stretch = true;
      o.priority = "ambient";
      this.pools.spawn("add", o);
    }

    for (let i = 0; i < 2; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r;
      const o = sp(g.x + Math.cos(a) * rr, 3.6 + Math.random() * 1.2, g.y + Math.sin(a) * rr);
      o.vy = -5 - Math.random() * 2;
      o.vx = (Math.random() - 0.5) * 1.2;
      o.color = 0xff_b0_60;
      o.size = 0.24;
      o.life = 0.55;
      o.stretch = true;
      o.priority = "ambient";
      this.pools.spawn("add", o);
    }
  }
  private zoneRunes(g: GroundEffect, now: number, r: number) {
    const ownTrap = g.effect === "trap" && g.team === this.localTeam;
    const runeColor = ownTrap ? 0x9a_ff_c0 : (RUNE_COLOR.get(g.effect) ?? 0);

    if (runeColor !== 0) {
      const runeTex = g.effect === "hexring" ? "rune-circle-a" : "rune-circle-b";

      const piece = this.zonePiece(`rune:${g.id}`, () => {
        const mat = new THREE.MeshBasicMaterial({
          blending: THREE.AdditiveBlending,
          color: runeColor,
          depthWrite: false,
          map: fxTex(runeTex),
          opacity: 0.9,
          side: THREE.DoubleSide,
          transparent: true,
        });

        const mesh = new THREE.Mesh(this.ringPlane, mat);
        mesh.rotation.x = -Math.PI / 2;

        return { obj: mesh, ownMat: mat };
      });

      piece.seenAt = now;
      piece.obj.position.set(g.x, terrainHeight(g.x, g.y) + 0.14, g.y);
      piece.obj.scale.setScalar(r * 1.15);
      piece.obj.rotation.z = now * 0.0008;
    }
  }

  private zonePiece(
    id: string,
    make: () => { obj: THREE.Object3D; ownMat: THREE.Material | null },
  ) {
    let p = this.zonePieces.get(id);

    if (!p) {
      const m = make();
      p = { obj: m.obj, ownMat: m.ownMat, seenAt: 0 };
      this.scene.add(p.obj);
      this.zonePieces.set(id, p);
    }

    return p;
  }

  /** One ember on a unit standing in a hostile zone (silent-tick ambience). */
  zoneEmber(x: number, y: number, color: number) {
    const o = sp(
      x + (Math.random() - 0.5) * 0.5,
      0.9 + Math.random() * 0.6,
      y + (Math.random() - 0.5) * 0.5,
    );

    o.vy = 1.6;
    o.color = color;
    o.size = 0.24;
    o.life = 0.4;
    o.priority = "ambient";
    this.pools.spawn("add", o);
  }

  /** Pass-through to the telegraph residue decals (scorch/frost/smoke stains). */
  spawnResidue(x: number, y: number, r: number, color: number, life: number) {
    this.telegraphs.spawnResidue(x, y, r, color, life);
  }

  /** Schedule `run` after `sec` seconds of real time (fx-owned delay queue). */
  delay(sec: number, run: () => void) {
    this.delayed.push({ at: this.clock + sec, run });
  }

  /** Respawn beam + converge + ring at a hero's revive point. */
  respawnBurst(x: number, y: number, color: number, isLocal: boolean) {
    this.beam(x, y, color, 10, 1.1);
    this.implode(x, y, color, 2.5, 12, 0.3);
    this.delay(0.15, () => {
      this.shockwave(x, y, color, 2.5);
    });

    if (isLocal) {
      this.view.addTrauma(0.1);
    }
  }

  /** Landing puffs + thud for the generic hop. */
  landJuice(x: number, y: number) {
    this.footDust(x, y, 1, 0);
    this.footDust(x, y, -0.5, 0.87);
    this.footDust(x, y, -0.5, -0.87);
    this.audio.land();
  }

  /** Per-champ basic-attack whoosh (delegates to the audio timbre table). */
  attackSound(champId: string, x: number, y: number, local = false) {
    this.audio.attack(champId, x, y, local);
  }

  /** Omnidirectional energy burst (fire/magic) — additive. */
  burst(
    x: number,
    y: number,
    z: number,
    n: number,
    color: number,
    speed: number,
    life: number,
    priority: ParticlePriority = "impact",
  ) {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.8 + 0.2;
      const spd = speed * (0.5 + Math.random());
      const o = sp(x, y, z);
      o.vx = Math.cos(a) * spd;
      o.vz = Math.sin(a) * spd;
      o.vy = up * spd * 0.6;
      o.gravity = -10;
      o.life = life * (0.7 + Math.random() * 0.6);
      o.size = 0.5 + Math.random() * 0.7;
      o.stretch = true;
      o.color = color;
      o.priority = priority;
      this.pools.spawn("add", o);
    }
  }

  /** Directional hit sparks — a cone along (dx,dz), stretched, additive. */
  sparks(
    x: number,
    y: number,
    z: number,
    dx: number,
    dz: number,
    n: number,
    color: number,
    priority: ParticlePriority = "impact",
  ) {
    const base = Math.atan2(dz, dx);

    for (let i = 0; i < n; i += 1) {
      const a = base + (Math.random() - 0.5) * 1.1;
      const spd = 4 + Math.random() * 6;
      const o = sp(x, y, z);
      o.vx = Math.cos(a) * spd;
      o.vz = Math.sin(a) * spd;
      o.vy = Math.random() * 3 + 0.5;
      o.gravity = -14;
      o.drag = 3;
      o.life = 0.16 + Math.random() * 0.14;
      o.size = 0.35 + Math.random() * 0.4;
      o.stretch = true;
      o.color = color;
      o.priority = priority;
      this.pools.spawn("add", o);
    }
  }

  /** Rising smoke — NORMAL blend, outlives the fire. (x,z) in sim coords. */
  smoke(x: number, z: number, n: number, priority: ParticlePriority = "impact") {
    for (let i = 0; i < n; i += 1) {
      const g = 0.18 + Math.random() * 0.1;
      const a = Math.random() * Math.PI * 2;
      const o = sp(x + (Math.random() - 0.5), 0.6, z + (Math.random() - 0.5));
      o.vx = Math.cos(a) * 1.2;
      o.vz = Math.sin(a) * 1.2;
      o.vy = 1.6 + Math.random() * 1.4;
      o.gravity = 1;
      o.drag = 1.2;
      o.life = 0.9 + Math.random() * 0.7;
      o.size = 1.1 + Math.random() * 0.9;
      o.cr = g;
      o.cg = g;
      o.cb = g;
      o.priority = priority;
      this.pools.spawn("normal", o);
    }
  }

  /** Low ground dust kicked behind the feet on a run (kx,kz = back-kick dir). */
  footDust(x: number, z: number, kx: number, kz: number) {
    const l = Math.hypot(kx, kz) || 1;

    for (let i = 0; i < 2; i += 1) {
      const g = 0.22 + Math.random() * 0.08;
      const o = sp(x + (Math.random() - 0.5) * 0.4, 0.25, z + (Math.random() - 0.5) * 0.4);
      o.vx = (kx / l) * 1.1 + (Math.random() - 0.5);
      o.vz = (kz / l) * 1.1 + (Math.random() - 0.5);
      o.vy = 0.5 + Math.random() * 0.6;
      o.gravity = -1.5;
      o.drag = 2.5;
      o.life = 0.3 + Math.random() * 0.2;
      o.size = 0.35 + Math.random() * 0.25;
      o.cr = g;
      o.cg = g * 0.95;
      o.cb = g * 0.85;
      o.priority = "ambient";
      this.pools.spawn("normal", o);
    }
  }

  /** Small NORMAL-blend dust pops at ground level (cleave linger, landings). */
  dust(x: number, z: number, n: number) {
    for (let i = 0; i < n; i += 1) {
      const g = 0.24 + Math.random() * 0.08;
      const a = Math.random() * Math.PI * 2;
      const o = sp(x + (Math.random() - 0.5) * 0.8, 0.3, z + (Math.random() - 0.5) * 0.8);
      o.vx = Math.cos(a) * 1.6;
      o.vz = Math.sin(a) * 1.6;
      o.vy = 0.8 + Math.random() * 0.8;
      o.gravity = -2;
      o.drag = 2.2;
      o.life = 0.35 + Math.random() * 0.15;
      o.size = 0.4 + Math.random() * 0.3;
      o.cr = g;
      o.cg = g * 0.95;
      o.cb = g * 0.85;
      this.pools.spawn("normal", o);
    }
  }

  /** A single fading additive puff — projectiles call this each frame. */
  trail(x: number, y: number, color: number) {
    const o = sp(x, 1.1, y);
    o.life = 0.22;
    o.size = 0.45;
    o.color = color;
    o.priority = "ambient";
    this.pools.spawn("add", o);
  }

  /** Trail puff at an explicit height (coin arcs, aerial paths). */
  trailAt(x: number, h: number, y: number, color: number, size = 0.4) {
    const o = sp(x, h, y);
    o.life = 0.25;
    o.size = size;
    o.color = color;
    o.priority = "ambient";
    this.pools.spawn("add", o);
  }

  /** A single rising additive mote (delivery helix, ult-ready gold flecks). */
  mote(x: number, h: number, y: number, color: number, vy: number, life: number, size: number) {
    const o = sp(x, h, y);
    o.vy = vy;
    o.life = life;
    o.size = size;
    o.color = color;
    o.priority = "ambient";
    this.pools.spawn("add", o);
  }

  /** NORMAL-blend smoke puff at an explicit height (fireball tracer). */
  smokePuff(x: number, h: number, y: number) {
    const g = 0.2 + Math.random() * 0.08;
    const o = sp(x, h, y);
    o.vy = 0.6;
    o.gravity = 0.6;
    o.drag = 1.5;
    o.life = 0.5 + Math.random() * 0.3;
    o.size = 0.5;
    o.cr = g;
    o.cg = g;
    o.cb = g;
    o.alpha = 0.7;
    o.priority = "ambient";
    this.pools.spawn("normal", o);
  }

  /** Quick additive flash — pops big then fades. `bright` >1 blooms. */
  flash(
    x: number,
    y: number,
    z: number,
    color: number,
    size: number,
    bright = 1,
    priority: ParticlePriority = "impact",
  ) {
    const o = sp(x, y, z);
    o.life = 0.12;
    o.size = size;
    o.color = color;
    o.bright = bright > 1 ? HDR_BRIGHT : 1;
    o.priority = priority;
    this.pools.spawn("add", o);
  }

  fountain(x: number, y: number, n: number, color: number) {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const o = sp(x, 0.5, y);
      o.vx = Math.cos(a) * 1.4;
      o.vz = Math.sin(a) * 1.4;
      o.vy = 4 + Math.random() * 3;
      o.gravity = -6;
      o.life = 0.7 + Math.random() * 0.4;
      o.size = 0.5 + Math.random() * 0.5;
      o.color = color;
      this.pools.spawn("add", o);
    }
  }

  /** A jet of stretched particles thrown forward along the aim — dashes. */
  castStreak(
    x: number,
    y: number,
    dx: number,
    dy: number,
    color: number,
    speed: number,
    n: number,
    spread = 0.25,
  ) {
    const base = Math.atan2(dy, dx);

    for (let i = 0; i < n; i += 1) {
      const a = base + (Math.random() - 0.5) * spread;
      const spd = speed * (0.7 + Math.random() * 0.6);
      const o = sp(x + Math.cos(a) * 0.6, 1.15, y + Math.sin(a) * 0.6);
      o.vx = Math.cos(a) * spd;
      o.vz = Math.sin(a) * spd;
      o.vy = (Math.random() - 0.3) * 1.4;
      o.gravity = -3;
      o.drag = 2.2;
      o.life = 0.22 + Math.random() * 0.18;
      o.size = 0.5 + Math.random() * 0.5;
      o.stretch = true;
      o.color = color;
      this.pools.spawn("add", o);
    }
  }

  /** Particles converging inward from a ring — THE anticipation layer. */
  implode(x: number, y: number, color: number, r: number, n: number, life = 0.28) {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const o = sp(x + Math.cos(a) * r, 0.6 + Math.random() * 1, y + Math.sin(a) * r);
      const v = r / life;
      o.vx = -Math.cos(a) * v;
      o.vz = -Math.sin(a) * v;
      o.life = life * (0.85 + Math.random() * 0.3);
      o.size = 0.35 + Math.random() * 0.3;
      o.stretch = true;
      o.color = color;
      this.pools.spawn("add", o);
    }
  }

  /** Camera-facing authored sprite pop (flare star, impact burst): scale-pop
   *  then fade — the anime "glint" beat. */
  flare(
    tex: "flare-star" | "impact-burst" | "glow-soft",
    x: number,
    y: number,
    z: number,
    color: number,
    size = 2,
    life = 0.18,
    spin = 0,
  ) {
    const f = this.flares.find((e) => e.life <= 0);

    if (!f) {
      return;
    }

    f.maxLife = life;
    f.life = life;
    f.s0 = size;
    f.grow = tex === "impact-burst" ? 1.5 : 1.15;
    f.mat.map = fxTex(tex);
    f.mat.color.setHex(color).multiplyScalar(this.flashGain);
    f.mat.rotation = spin;
    f.mat.opacity = 1;
    f.sprite.position.set(x, y, z);
    f.sprite.scale.setScalar(size * 0.6);
    f.sprite.visible = true;
  }

  private stepFlares(dt: number) {
    for (const f of this.flares) {
      if (f.life <= 0) {
        continue;
      }

      f.life -= dt;

      if (f.life <= 0) {
        f.sprite.visible = false;
        continue;
      }

      const t = 1 - f.life / f.maxLife;
      const pop = 0.6 + 0.4 * Math.min(1, t / 0.3) + (f.grow - 1) * t;
      f.sprite.scale.setScalar(f.s0 * pop);
      f.mat.opacity = 1 - t * t;
    }
  }

  private readonly texActors: {
    obj: THREE.Object3D;
    mats: THREE.Material[];
    life: number;
    maxLife: number;
    tick: (k: number) => void;
  }[] = [];
  private readonly texQuad = new THREE.PlaneGeometry(1, 1);
  private readonly texSphere = new THREE.SphereGeometry(1, 20, 12);

  private texActor(
    obj: THREE.Object3D,
    mats: THREE.Material[],
    life: number,
    tick: (k: number) => void,
  ) {
    if (this.texActors.length >= 40) {
      for (const m of mats) {
        m.dispose();
      }

      return;
    }

    this.scene.add(obj);
    this.texActors.push({ life, mats, maxLife: life, obj, tick });
  }

  private stepTexActors(dt: number) {
    for (let i = this.texActors.length - 1; i >= 0; i -= 1) {
      const a = this.texActors[i];

      if (!a) {
        continue;
      }

      a.life -= dt;

      if (a.life <= 0) {
        this.scene.remove(a.obj);

        for (const m of a.mats) {
          m.dispose();
        }

        this.texActors.splice(i, 1);
        continue;
      }

      a.tick(1 - a.life / a.maxLife);
    }
  }

  /** Authored flat ground decal (scorch, crack, rune circle). */
  texDecal(
    tex: string,
    x: number,
    z: number,
    opts: {
      size?: number;
      color?: number;
      life?: number;
      spinRate?: number;
      grow?: number;
      additive?: boolean;
      fade?: "out" | "inout";
      y?: number;
    } = {},
  ) {
    const {
      size = 3,
      color = 0xff_ff_ff,
      life = 1.2,
      spinRate = 0,
      grow = 1,
      additive = true,
      fade = "out",
      y = 0.07,
    } = opts;

    const mat = new THREE.MeshBasicMaterial({
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      color,
      depthWrite: false,
      map: fxTex(tex),
      side: THREE.DoubleSide,
      transparent: true,
    });

    const m = new THREE.Mesh(this.texQuad, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x, terrainHeight(x, z) + y, z);
    m.scale.setScalar(size);
    this.texActor(m, [mat], life, (k) => {
      m.rotation.z += spinRate * 0.016;
      m.scale.setScalar(size * (1 + (grow - 1) * k));
      mat.opacity = fade === "inout" ? Math.sin(Math.min(1, k * 1.05) * Math.PI) : 1 - k * k;
    });
  }

  /** A bolt out of the sky onto (x,z) — smites, storm calls, spawn strikes. */
  strikeDown(
    x: number,
    z: number,
    height: number,
    color: number,
    haloColor: number,
    opts: { life?: number; scale?: number } = {},
  ) {
    const gy = terrainHeight(x, z);
    this.boltFrom.set(
      x + (Math.random() - 0.5) * 1.2,
      gy + height,
      z + (Math.random() - 0.5) * 1.2,
    );
    this.boltTo.set(x, gy + 0.1, z);
    this.bolts.strike(this.boltFrom, this.boltTo, { ...opts, color, haloColor });
  }

  /** Flipbook sprite (grid sheet) played once (flames, puffs). */
  texFlipbook(
    tex: string,
    cols: number,
    rows: number,
    x: number,
    y: number,
    z: number,
    opts: { size?: number; color?: number; life?: number; rise?: number } = {},
  ) {
    const { size = 2, color = 0xff_ff_ff, life = 0.6, rise = 0 } = opts;
    const map = fxTex(tex).clone();
    map.repeat.set(1 / cols, 1 / rows);

    const mat = new THREE.SpriteMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      map,
      transparent: true,
    });

    const spr = new THREE.Sprite(mat);
    spr.position.set(x, y, z);
    spr.scale.setScalar(size);
    const frames = cols * rows;
    this.texActor(spr, [mat], life, (k) => {
      const f = Math.min(frames - 1, Math.floor(k * frames));
      map.offset.set((f % cols) / cols, 1 - 1 / rows - Math.floor(f / cols) / rows);
      spr.position.y = y + rise * k;
      mat.opacity = Math.sin(Math.min(1, k * 1.15) * Math.PI);
    });
  }

  /** Textured shell (shield bubbles, storm orbs). */
  texShell(
    tex: string,
    x: number,
    y: number,
    z: number,
    opts: {
      r?: number;
      color?: number;
      life?: number;
      repeat?: [number, number];
      scrollY?: number;
    } = {},
  ) {
    const { r = 1.9, color = 0xff_ff_ff, life = 1.6, repeat = [3, 2], scrollY = 0 } = opts;
    const map = fxTex(tex, { wrap: true }).clone();
    map.repeat.set(repeat[0], repeat[1]);

    const mat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      map,
      side: THREE.DoubleSide,
      transparent: true,
    });

    const m = new THREE.Mesh(this.texSphere, mat);
    m.position.set(x, y, z);
    m.scale.setScalar(r);
    this.texActor(m, [mat], life, (k) => {
      map.offset.y += scrollY * 0.016;
      map.offset.x += 0.002;
      m.scale.setScalar(r * (1 + 0.04 * Math.sin(k * Math.PI * 6)));
      mat.opacity = Math.sin(Math.min(1, k * 1.02) * Math.PI) * 0.8;
    });
  }

  /** Camera-facing authored sprite with inout fade (wings, portals, swirls). */
  texSprite(
    tex: string,
    x: number,
    y: number,
    z: number,
    opts: { size?: number; color?: number; life?: number; grow?: number; spin?: number } = {},
  ) {
    const { size = 3, color = 0xff_ff_ff, life = 0.8, grow = 1.15, spin = 0 } = opts;

    const mat = new THREE.SpriteMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      map: fxTex(tex),
      rotation: Math.random() * spin,
      transparent: true,
    });

    const spr = new THREE.Sprite(mat);
    spr.position.set(x, y, z);
    spr.scale.setScalar(size);
    this.texActor(spr, [mat], life, (k) => {
      spr.scale.setScalar(size * (1 + (grow - 1) * k));
      mat.opacity = Math.sin(Math.min(1, k * 1.05) * Math.PI);
    });
  }

  /** Stretched streak flying A→B (comet tails, rising light). */
  texStreak(
    tex: string,
    x0: number,
    y0: number,
    z0: number,
    x1: number,
    y1: number,
    z1: number,
    opts: { w?: number; len?: number; color?: number; life?: number } = {},
  ) {
    const { w = 1.2, len = 5, color = 0xff_ff_ff, life = 0.45 } = opts;

    const mat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      map: fxTex(tex),
      side: THREE.DoubleSide,
      transparent: true,
    });

    const m = new THREE.Mesh(this.texQuad, mat);
    m.scale.set(len, w, 1);
    const from = new THREE.Vector3(x0, y0, z0);
    const dir = new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
    this.texActor(m, [mat], life, (k) => {
      m.position.copy(from).addScaledVector(dir, k);
      mat.opacity = Math.sin(Math.min(1, k * 1.1) * Math.PI);
    });
  }

  /** Muzzle-flash star: an authored 4-point flare sprite over two stretched
   *  glint particles (the sprite is the read, the particles are the motion). */
  crossGlint(x: number, y: number, z: number, dx: number, dy: number, color: number, s = 0.9) {
    this.flare("flare-star", x, y, z, color, s * 2.4, 0.16, Math.random() * 0.6 - 0.3);
    const l = Math.hypot(dx, dy) || 1;
    const px = -dy / l;
    const pz = dx / l;

    for (const sign of [1, -1]) {
      const o = sp(x, y, z);
      o.vx = px * 4 * sign;
      o.vz = pz * 4 * sign;
      o.drag = 4;
      o.life = 0.1;
      o.size = s;
      o.stretch = true;
      o.color = color;
      o.bright = 1.6;
      this.pools.spawn("add", o);
    }
  }

  /** Matter chunks that arc out, land, and fade — cheap permanence. */
  debris(x: number, y: number, n: number, color: number) {
    const c = new THREE.Color(color);

    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const spd = 3 + Math.random() * 3;
      const o = sp(x, 0.7, y);
      o.vx = Math.cos(a) * spd;
      o.vz = Math.sin(a) * spd;
      o.vy = 3 + Math.random() * 3;
      o.gravity = -22;
      o.life = 0.9 + Math.random() * 0.4;
      o.size = 0.3 + Math.random() * 0.2;
      o.cr = c.r;
      o.cg = c.g;
      o.cb = c.b;
      this.pools.spawn("normal", o);
    }
  }

  private iceShards(x: number, y: number, n: number) {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const o = sp(x + Math.cos(a) * 0.6, 0.5, y + Math.sin(a) * 0.6);
      o.vx = Math.cos(a) * 2;
      o.vz = Math.sin(a) * 2;
      o.vy = 3;
      o.gravity = -4;
      o.life = 0.5 + Math.random() * 0.2;
      o.size = 0.35;
      o.stretch = true;
      o.color = 0x9f_e8_ff;
      this.pools.spawn("add", o);
    }
  }

  private bubbles(x: number, y: number, n: number, color: number, r = 1.2) {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random()) * r;
      const o = sp(x + Math.cos(a) * rr, 0.25, y + Math.sin(a) * rr);
      o.vy = 1.2 + Math.random() * 0.9;
      o.life = 0.45 + Math.random() * 0.3;
      o.size = 0.2 + Math.random() * 0.15;
      o.color = color;
      this.pools.spawn("add", o);
    }
  }

  /** Expanding shockwave ring — noise-broken shader annulus, pooled. Sits on the
   *  ground unless `lift` raises it (aerial volleys ring out at hop height). */
  shockwave(
    x: number,
    y: number,
    color: number,
    maxR: number,
    life = 0.38,
    opacity = 0.85,
    lift = 0,
  ) {
    const r = this.rings.find((e) => e.life <= 0);

    if (!r) {
      return;
    }

    r.maxLife = life;
    r.life = life;
    r.maxR = maxR;
    r.opacity = opacity;
    uniformColor(r.mat, "uColor").setHex(color);
    uniform(r.mat, "uT").value = 0;
    uniform(r.mat, "uAlpha").value = opacity * this.flashGain;
    uniform(r.mat, "uSeed").value = Math.random() * 20;
    r.mesh.position.set(x, terrainHeight(x, y) + 0.12 + lift, y);
    r.mesh.scale.setScalar(0.2);
    r.mesh.visible = true;
  }

  /** Quick small impact ring at a hit point (snappier than a full shockwave). */
  impactRing(x: number, y: number, color: number, maxR: number) {
    this.shockwave(x, y, color, maxR, 0.2, 0.95);
  }

  private stepRings(dt: number) {
    for (const r of this.rings) {
      if (r.life <= 0) {
        continue;
      }

      r.life -= dt;

      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }

      const t = 1 - r.life / r.maxLife;
      const cubicOut = 1 - (1 - t) ** 3;
      r.mesh.scale.setScalar(0.2 + cubicOut * r.maxR);
      uniform(r.mat, "uT").value = t;
    }
  }

  /** A rising vertical light pillar (level-up / respawn / signature payoff). */
  beam(x: number, y: number, color: number, h = BEAM_H, r = 1) {
    const b = this.beams.find((e) => e.life <= 0);

    if (!b) {
      return;
    }

    b.maxLife = 0.5;
    b.life = 0.5;
    b.h = h;
    b.r = r;
    b.mat.setColor(0xff_ff_ff, color);
    b.mat.setOpacity(0.8 * this.flashGain);
    b.mat.reseed();
    b.mesh.position.set(x, terrainHeight(x, y) + (h / BEAM_H) * 3.2, y);
    b.mesh.scale.set(r, h / BEAM_H, r);
    b.mesh.visible = true;
  }

  private stepBeams(dt: number) {
    for (const b of this.beams) {
      if (b.life <= 0) {
        continue;
      }

      b.life -= dt;

      if (b.life <= 0) {
        b.mesh.visible = false;
        continue;
      }

      const t = b.life / b.maxLife;
      const g = 1 + (1 - t) * 0.6;
      b.mesh.scale.set(b.r * g, (b.h / BEAM_H) * (1 + (1 - t) * 0.5), b.r * g);
      b.mat.setOpacity(0.8 * t * this.flashGain);
    }
  }

  private coneGeo(half: number) {
    const key = Math.round(half * 100);
    let geo = this.coneGeoCache.get(key);

    if (!geo) {
      geo = new THREE.CircleGeometry(1, 28, -half, half * 2);
      this.coneGeoCache.set(key, geo);
    }

    return geo;
  }

  private rimGeo(half: number) {
    const key = Math.round(half * 100);
    let geo = this.rimGeoCache.get(key);

    if (!geo) {
      geo = new THREE.RingGeometry(0.955, 1, 24, 1, -half, half * 2);
      this.rimGeoCache.set(key, geo);
    }

    return geo;
  }

  private acquireCone() {
    return this.cones.find((e) => e.life <= 0) ?? null;
  }

  /** A flat filled sector fanning out along the aim — cone attacks. NORMAL blend. */
  castCone(
    x: number,
    y: number,
    dx: number,
    dy: number,
    color: number,
    reach: number,
    half: number,
  ) {
    const c = this.acquireCone();

    if (!c) {
      return;
    }

    c.mesh.geometry = this.coneGeo(half);
    c.mat.blending = THREE.NormalBlending;
    c.mat.color.setHex(color);
    c.maxLife = 0.26;
    c.life = 0.26;
    c.opacity = 0.85;
    c.grow = reach * 1.12;
    c.s0 = reach * 0.5;
    c.pivot.position.set(x, terrainHeight(x, y) + 0.14, y);
    c.pivot.rotation.set(0, Math.atan2(-dy, dx), 0);
    c.pivot.rotateX(-Math.PI / 2);
    c.pivot.scale.setScalar(c.s0);
    c.pivot.visible = true;
  }

  /** A bright additive rim marking the exact reach edge of a cleave sector. */
  sectorRim(
    x: number,
    y: number,
    dx: number,
    dy: number,
    color: number,
    reach: number,
    half: number,
  ) {
    const c = this.acquireCone();

    if (!c) {
      return;
    }

    c.mesh.geometry = this.rimGeo(half);
    c.mat.blending = THREE.AdditiveBlending;
    c.mat.color.setHex(color).multiplyScalar(1.6);
    c.maxLife = 0.22;
    c.life = 0.22;
    c.opacity = 0.9;
    c.grow = reach;
    c.s0 = reach;
    c.pivot.position.set(x, terrainHeight(x, y) + 0.15, y);
    c.pivot.rotation.set(0, Math.atan2(-dy, dx), 0);
    c.pivot.rotateX(-Math.PI / 2);
    c.pivot.scale.setScalar(reach);
    c.pivot.visible = true;
  }

  private stepCones(dt: number) {
    for (const c of this.cones) {
      if (c.life <= 0) {
        continue;
      }

      c.life -= dt;

      if (c.life <= 0) {
        c.pivot.visible = false;
        continue;
      }

      const t = c.life / c.maxLife;
      c.pivot.scale.setScalar(c.s0 + (c.grow - c.s0) * (1 - t));
      c.mat.opacity = c.opacity * t;
    }
  }

  /** Anime crescent slash: a pointed arc that sweeps open along `facing` (sim
   *  angle), holds a hot edge, and erodes. `reach` = arc radius; `tilt` lifts
   *  the arc plane off the ground toward the camera (0 = flat ring, ~0.5 =
   *  reads best from the chase cam); `dir` mirrors the sweep for off-hand cuts. */
  slashArc(
    x: number,
    y: number,
    facing: number,
    reach: number,
    color: number,
    opts: {
      tilt?: number;
      span?: number;
      life?: number;
      height?: number;
      dir?: 1 | -1;
      tex?: SlashTex;
    } = {},
  ) {
    const s = this.slashes.find((e) => e.life <= 0);

    if (!s) {
      return;
    }

    const { tilt = 0.5, span = 1.05, life = 0.26, height = 1.15, dir = 1, tex = "white" } = opts;
    const reg = SLASH_SPRITES[tex];
    s.maxLife = life;
    s.life = life;
    uniformColor(s.mat, "uColor").setHex(color);
    uniform(s.mat, "uT").value = 0;
    uniform(s.mat, "uSpan").value = span;
    uniform(s.mat, "uSeed").value = Math.random() * 20;
    uniform(s.mat, "uDir").value = dir;
    uniform(s.mat, "uMap").value = fxTex(reg.tex, tex === "wind" ? { srgb: true } : {});
    uniformVec2(s.mat, "uUVOff").set(reg.off[0], reg.off[1]);
    uniformVec2(s.mat, "uUVScale").set(reg.scale[0], reg.scale[1]);
    uniform(s.mat, "uRot").value = reg.rot;
    s.pivot.position.set(x, terrainHeight(x, y) + height, y);
    s.pivot.rotation.set(0, -facing, 0);
    s.mesh.rotation.set(-Math.PI / 2 + tilt, 0, 0);
    s.pivot.scale.setScalar(reach);
    s.pivot.visible = true;
  }

  private stepSlashes(dt: number) {
    for (const s of this.slashes) {
      if (s.life <= 0) {
        continue;
      }

      s.life -= dt;

      if (s.life <= 0) {
        s.pivot.visible = false;
        continue;
      }

      uniform(s.mat, "uT").value = 1 - s.life / s.maxLife;
    }
  }

  /** Fissure decal: radial star (`len` = radius, `wid` omitted/equal) or a
   *  directional gash (`wid` ≠ len) along sim angle `ang`. Hot seams cool over
   *  `life` seconds; `pulse` keeps them re-heating (bleed wounds). */
  crack(
    x: number,
    y: number,
    ang: number,
    len: number,
    wid: number,
    color: number,
    life = 2.2,
    pulse = 0,
  ) {
    const c = this.cracks.find((e) => e.life <= 0);

    if (!c) {
      return;
    }

    c.maxLife = life;
    c.life = life;
    c.mat.arm(color, pulse);
    c.mesh.position.set(x, terrainHeight(x, y) + 0.09, y);
    c.mesh.rotation.z = -ang;
    c.mesh.scale.set(len, wid, 1);
    c.mesh.visible = true;
  }

  private stepCracks(dt: number) {
    for (const c of this.cracks) {
      if (c.life <= 0) {
        continue;
      }

      c.life -= dt;

      if (c.life <= 0) {
        c.mesh.visible = false;
        continue;
      }

      const elapsed = c.maxLife - c.life;
      c.mat.step(elapsed / c.maxLife, Math.min(1.15, elapsed / 0.13));
    }
  }

  private readonly ghostTint = new THREE.Color();
  ghost(x: number, y: number, color: number) {
    this.ghostTint.setHex(color).multiplyScalar(0.4);

    for (const [h, size] of [
      [1.15, 1.5],
      [0.45, 1],
    ] as const) {
      const o = sp(x, h, y);
      o.life = 0.3;
      o.size = size;
      o.cr = this.ghostTint.r;
      o.cg = this.ghostTint.g;
      o.cb = this.ghostTint.b;
      this.pools.spawn("add", o);
    }
  }

  /** Falling droplets (poison/brew liquid) — NORMAL blend, gravity. */
  drips(x: number, y: number, n: number, color: number) {
    const c = new THREE.Color(color);

    for (let i = 0; i < n; i += 1) {
      const o = sp(
        x + (Math.random() - 0.5) * 0.8,
        1 + Math.random() * 0.4,
        y + (Math.random() - 0.5) * 0.8,
      );

      o.vx = (Math.random() - 0.5) * 1.2;
      o.vz = (Math.random() - 0.5) * 1.2;
      o.vy = 0.5;
      o.gravity = -16;
      o.life = 0.45 + Math.random() * 0.2;
      o.size = 0.2 + Math.random() * 0.12;
      o.cr = c.r;
      o.cg = c.g;
      o.cb = c.b;
      o.alpha = 0.85;
      this.pools.spawn("normal", o);
    }
  }

  /** A wireframe hemisphere shell that pops around the caster — shields/buffs. */
  castDome(x: number, y: number, color: number, r: number, life = 0.4) {
    const d = this.domes.find((e) => e.life <= 0);

    if (d) {
      d.maxLife = life;
      d.life = life;
      d.opacity = 0.8;
      d.r = r;
      d.mat.color.setHex(color);
      d.mat.opacity = 0.8;
      d.mesh.position.set(x, terrainHeight(x, y) + 0.1, y);
      d.mesh.scale.setScalar(r);
      d.mesh.visible = true;
    }

    this.shockwave(x, y, color, r, life * 0.7, 0.7);
  }

  private stepDomes(dt: number) {
    for (const d of this.domes) {
      if (d.life <= 0) {
        continue;
      }

      d.life -= dt;

      if (d.life <= 0) {
        d.mesh.visible = false;
        continue;
      }

      const t = d.life / d.maxLife;
      d.mesh.scale.setScalar(d.r * (1 + (1 - t) * 0.08));
      d.mat.opacity = d.opacity * t;
    }
  }

  private hitNumber(
    x: number,
    y: number,
    amount: number,
    dx: number,
    dy: number,
    heavy: boolean,
    by: string,
  ) {
    const mine = by !== "" && by === this.localId;

    if (mine) {
      this.numbers.bumpCombo(this.nowMs);
      this.numbers.spawn(`${amount}`, x, y, heavy ? "crit" : "mine", this.nowMs, dx, dy);

      return;
    }

    const onMe = (x - this.lx) ** 2 + (y - this.ly) ** 2 < 1.44;

    if (onMe) {
      this.numbers.spawn(`${amount}`, x, y, "incoming", this.nowMs, dx, dy);

      return;
    }

    if (amount < 50) {
      return;
    }

    this.numbers.spawn(`${amount}`, x, y, "bystander", this.nowMs, dx, dy);
  }

  /** Drop every floating number and reset the combo. For a hard cut in the
   *  view (trailer scene changes); gameplay never needs it. */
  clearNumbers() {
    this.numbers.clear();
  }

  /** An accepted rematch owns a fresh presentation clock, while the loaded
   * materials, fixed pools and audio context remain reusable. */
  resetMatch() {
    this.delayed.length = 0;
    this.localHits.length = 0;
    this.toasts.length = 0;
    this.feed.length = 0;
    this.zoneAnim.clear();
    this.zoneSweepAt = 0;
    this.nowMs = 0;
    this.clock = 0;
    this.slowMo = 0;
    this.hardFreeze = 0;
    this.hitsThisFrame = 0;
    this.bestStreak = 0;
    this.heavyThisFrame = false;
    this.lastDeath = null;
    this.numbers.clear();
    this.pools.clear();
    this.chunks.clear();
    this.spikes.clear();
    this.bolts.clear();
    this.pillars.clear();
    this.voids.clear();
    this.ribbons.clear();
    this.telegraphs.clear();

    for (const effect of [...this.rings, ...this.beams, ...this.domes, ...this.cracks]) {
      effect.life = 0;
      effect.mesh.visible = false;
    }

    for (const effect of [...this.cones, ...this.slashes]) {
      effect.life = 0;
      effect.pivot.visible = false;
    }

    for (const flare of this.flares) {
      flare.life = 0;
      flare.sprite.visible = false;
    }

    for (const actor of this.texActors) {
      actor.life = 0;
    }

    this.stepTexActors(0);

    for (const piece of this.zonePieces.values()) {
      this.scene.remove(piece.obj);
      piece.ownMat?.dispose();
    }

    this.zonePieces.clear();
    this.brewPools.clear();
    this.view.resetImpulses();
  }

  dispose() {
    this.pendingWarm = null;
    this.delayed.length = 0;
    this.feed.length = 0;
    this.toasts.length = 0;
    this.localHits.length = 0;
    this.zoneAnim.clear();
    this.numbers.dispose();
    this.pools.dispose();
    this.chunks.dispose();
    this.telegraphs.dispose();

    for (const r of this.rings) {
      this.scene.remove(r.mesh);
      r.mat.dispose();
    }

    for (const b of this.beams) {
      this.scene.remove(b.mesh);
      b.mesh.geometry.dispose();
      b.mat.dispose();
    }

    for (const c of this.cones) {
      this.scene.remove(c.pivot);
      c.mat.dispose();
    }

    for (const d of this.domes) {
      this.scene.remove(d.mesh);
      d.mesh.geometry.dispose();
      d.mat.dispose();
    }

    for (const s of this.slashes) {
      this.scene.remove(s.pivot);
      s.mat.dispose();
    }

    for (const c of this.cracks) {
      this.scene.remove(c.mesh);
      c.mat.dispose();
    }

    for (const flare of this.flares) {
      this.scene.remove(flare.sprite);
      flare.mat.dispose();
    }

    this.flares.length = 0;
    this.spikes.dispose();
    this.bolts.dispose();
    this.pillars.dispose();
    this.voids.dispose();
    this.ribbons.dispose();

    for (const [, p] of this.zonePieces) {
      this.scene.remove(p.obj);
      p.ownMat?.dispose();
    }

    this.zonePieces.clear();
    this.brewPools.clear();

    for (const { mesh, ownMat } of this.warmParked) {
      this.scene.remove(mesh);

      if (ownMat && mesh.material instanceof THREE.Material) {
        mesh.material.dispose();
      }
    }

    this.warmParked.length = 0;

    for (const g of this.coneGeoCache.values()) {
      g.dispose();
    }

    for (const g of this.rimGeoCache.values()) {
      g.dispose();
    }

    this.ringPlane.dispose();
    this.vortexGeo.dispose();
    this.cometGeo.dispose();
    this.rockMat.dispose();
    this.texQuad.dispose();
    this.texSphere.dispose();
  }
}
