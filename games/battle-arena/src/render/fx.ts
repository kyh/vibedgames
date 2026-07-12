// Combat FX orchestrator: drains the World's one-shot fx events each frame,
// spawns everything transient (particles via the 2-draw-call instanced pools,
// rings/beams/cones/domes via pre-built mesh pools), owns the shader ground
// telegraphs, the two-stage hit-stop clock, trauma/kick/FOV-punch routing, and
// the floating damage numbers. HUD-bound events (kill feed, toasts) are queued
// for the HUD to read.
import * as THREE from "three";
import { HOP_HEIGHT } from "../data/config";
import { terrainHeight } from "../data/terrain";
import type { FxEvent, GroundEffect, World } from "../sim/types";
import { Audio } from "./audio";
import { ChunkPool } from "./fx-chunks";
import { DamageNumbers } from "./damage-numbers";
import {
  energyBallMaterial,
  makeCrackMaterial,
  makeRingMaterial,
  makeSlashMaterial,
  makeVortexMaterial,
  tickFxShaders,
} from "./fx-shaders";
import { fxTex, preloadFxTextures } from "./fx-textures";
import { SpikePool } from "./fx-spikes";
import { HDR_BRIGHT, ParticlePools, type SpawnOptions } from "./fx-particles";
import { Telegraphs, groundFxColor } from "./telegraph";
import type { View } from "./view";

// ── champion effect palettes (one dominant hue per champ — instant attribution)
export type FxPalette = { primary: number; secondary: number; accent: number };
export const CHAMP_FX: Record<string, FxPalette> = {
  knight: { primary: 0x8fd0ff, secondary: 0xeaf2ff, accent: 0xffd24a }, // steel / white / gold-trim
  ranger: { primary: 0x7dffb0, secondary: 0xffe6a0, accent: 0x2c8f5e }, // verdant / gold-arrow / deep-green
  mage: { primary: 0xff8040, secondary: 0xffd060, accent: 0x9a7bff }, // ember / flare / arcane
  rogue: { primary: 0xff3060, secondary: 0x6a5a9a, accent: 0x7fff8e }, // crimson / shadow-violet / poison
  blackknight: { primary: 0xffd76a, secondary: 0xfff2c0, accent: 0xffe6a0 }, // dawn-gold / white-gold / halo
  witch: { primary: 0x7fe08a, secondary: 0xb98ae0, accent: 0x4a7a3a }, // bog-green / hex-violet / moss
};

// ── mesh-pool sizing (transient draw-call budget: 16+4+8+4+10 = 42 worst case) ──
const RING_POOL = 16;
const BEAM_POOL = 4;
const CONE_POOL = 8; // flat sector fans + sector rims share this pool
const DOME_POOL = 4;
const SLASH_POOL = 10; // crescent sword arcs
const FLARE_POOL = 10; // camera-facing star/burst sprites

/** Authored slash-sprite registrations: sheet window + spin that puts the
 *  crescent's opening along the quad's local +X (tuned by eye in the viewer). */
const SLASH_SPRITES = {
  white: { tex: "slash-white", off: [0, 0], scale: [1, 1], rot: 0 }, // single bold crescent
  arc: { tex: "slash-arc", off: [0, 0.5], scale: [0.52, 0.5], rot: 0 }, // top-left crescent of the sheet
  spin: { tex: "slash-spin", off: [0, 0], scale: [1, 1], rot: 0 }, // full spiral swirl (whirls)
  wind: { tex: "slash-wind", off: [0, 0], scale: [1, 1], rot: 0 }, // magenta energy bolt (executes)
} as const;
export type SlashTex = keyof typeof SLASH_SPRITES;
const CRACK_POOL = 6; // ground-fissure decals
const BEAM_H = 7; // unit beam height the pool geometry is built at

type Ring = {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  maxLife: number;
  maxR: number;
  opacity: number;
};
// zone-driven set pieces (whirlwind vortex drum, falling meteor comet) —
// created on first sight of a zone id, culled when the zone stops appearing.
// ownMat: material to dispose on cull; null = shared/cached, leave it alone.
type ZonePiece = { obj: THREE.Object3D; ownMat: THREE.Material | null; seenAt: number };
type Beam = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  h: number;
  r: number;
};
type ConeDecal = {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  opacity: number;
  grow: number;
  s0: number;
};
type Dome = {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  life: number;
  maxLife: number;
  opacity: number;
  r: number;
};
type Slash = {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  life: number;
  maxLife: number;
};
type Crack = { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; life: number; maxLife: number };
type Delayed = { at: number; run: () => void };
type ZoneAnim = { next: number; next2: number; phase: number; seenAt: number; born: boolean };

const scratch: SpawnOptions = { x: 0, y: 0, z: 0, size: 0.5, life: 0.3 };

/** Reset the shared spawn scratch to neutral defaults before each use. */
function sp(x: number, y: number, z: number): SpawnOptions {
  scratch.x = x;
  scratch.y = y;
  scratch.z = z;
  scratch.vx = 0;
  scratch.vy = 0;
  scratch.vz = 0;
  scratch.color = 0xffffff;
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
  return scratch;
}

export class Fx {
  readonly pools: ParticlePools;
  readonly telegraphs: Telegraphs;
  readonly chunks: ChunkPool;
  readonly spikes: SpikePool;
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  private cones: ConeDecal[] = [];
  private domes: Dome[] = [];
  private slashes: Slash[] = [];
  private flares: {
    sprite: THREE.Sprite;
    mat: THREE.SpriteMaterial;
    life: number;
    maxLife: number;
    s0: number;
    grow: number;
  }[] = [];
  private cracks: Crack[] = [];
  private coneGeoCache = new Map<number, THREE.CircleGeometry>();
  private rimGeoCache = new Map<number, THREE.RingGeometry>();
  private ringPlane = new THREE.PlaneGeometry(2, 2);
  private zonePieces = new Map<string, ZonePiece>();
  private vortexGeo = new THREE.CylinderGeometry(1, 0.72, 1, 20, 1, true);
  private cometGeo = new THREE.SphereGeometry(1, 12, 12);
  private delayed: Delayed[] = [];
  private clock = 0; // accumulated REAL seconds (drives the delay queue)
  private nowMs = 0; // last-seen sim clock (w.now)
  private numbers: DamageNumbers;
  readonly audio = new Audio(); // HUD + game-scene trigger UI sounds through this
  private zoneAnim = new Map<string, ZoneAnim>();
  private zoneSweepAt = 0;
  // queued for the HUD
  readonly feed: {
    killerName: string;
    victimName: string;
    leader?: boolean;
    killer: string;
    victim: string;
  }[] = [];
  readonly toasts: { text: string; kind: string }[] = [];
  localId = ""; // local UNIT id — set by the scene (kick/hit-stop on YOUR hits only)
  localOwnerId = ""; // local OWNER id (death/kill attribution); auto-derived if unset
  /** Set when the local player dies — the death screen reads the killer. */
  lastDeath: { killerName: string; at: number } | null = null;
  /** Drained by the reticle: one entry per landed local hit. */
  readonly localHits: { crit: boolean }[] = [];
  /** Best kill streak this match (end-card stat). */
  bestStreak = 0;
  // cached local-player state (distance falloff, melee/ranged freeze table)
  private lx = 0;
  private ly = 0;
  private localTeam = "";
  private localMelee = true;
  // per-frame local-hit accumulation → one hardFreeze application per frame
  private hitsThisFrame = 0;
  private heavyThisFrame = false;

  constructor(
    private scene: THREE.Scene,
    private view: View,
  ) {
    this.pools = new ParticlePools(scene);
    this.telegraphs = new Telegraphs(scene);
    this.chunks = new ChunkPool(scene);
    this.spikes = new SpikePool(scene);

    for (let i = 0; i < RING_POOL; i++) {
      // shader annulus: noise-broken rim + hot edge (see fx-shaders makeRingMaterial)
      const mat = makeRingMaterial();
      const mesh = new THREE.Mesh(this.ringPlane, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, mat, life: 0, maxLife: 1, maxR: 1, opacity: 1 });
    }
    const beamGeo = new THREE.CylinderGeometry(0.55, 0.9, BEAM_H, 12, 1, true);
    for (let i = 0; i < BEAM_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.beams.push({ mesh, mat, life: 0, maxLife: 1, h: BEAM_H, r: 1 });
    }
    for (let i = 0; i < CONE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.NormalBlending,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(this.coneGeo(0.61), mat);
      pivot.add(mesh);
      pivot.visible = false;
      scene.add(pivot);
      this.cones.push({ pivot, mesh, mat, life: 0, maxLife: 1, opacity: 1, grow: 1, s0: 1 });
    }
    for (let i = 0; i < SLASH_POOL; i++) {
      const mat = makeSlashMaterial();
      const mesh = new THREE.Mesh(this.ringPlane, mat); // shared 2×2 quad
      const pivot = new THREE.Group();
      pivot.add(mesh);
      pivot.visible = false;
      scene.add(pivot);
      this.slashes.push({ pivot, mesh, mat, life: 0, maxLife: 1 });
    }
    preloadFxTextures();
    for (let i = 0; i < FLARE_POOL; i++) {
      const mat = new THREE.SpriteMaterial({
        map: fxTex("flare-star"),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const sprite = new THREE.Sprite(mat);
      sprite.visible = false;
      scene.add(sprite);
      this.flares.push({ sprite, mat, life: 0, maxLife: 1, s0: 1, grow: 1 });
    }
    for (let i = 0; i < CRACK_POOL; i++) {
      const mat = makeCrackMaterial();
      const mesh = new THREE.Mesh(this.ringPlane, mat); // shared 2×2 quad, laid flat
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.cracks.push({ mesh, mat, life: 0, maxLife: 1 });
    }
    const domeGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    for (let i = 0; i < DOME_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        blending: THREE.NormalBlending,
        wireframe: true,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(domeGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.domes.push({ mesh, mat, life: 0, maxLife: 1, opacity: 1, r: 1 });
    }

    this.numbers = new DamageNumbers(view);
  }

  update(w: World, dt: number): void {
    this.nowMs = w.now;
    const me = w.units.get(this.localId);
    if (me) {
      this.lx = me.x;
      this.ly = me.y;
      this.localTeam = me.team;
      this.localMelee = me.attackType === "melee";
      if (!this.localOwnerId) this.localOwnerId = me.ownerId;
      if (me.killStreak > this.bestStreak) this.bestStreak = me.killStreak;
      this.audio.setListener(me.x, me.y, me.aimX, me.aimY);
    }

    this.hitsThisFrame = 0;
    this.heavyThisFrame = false;
    for (const e of w.fx) this.handle(e);
    w.fx.length = 0;
    // per-frame local-hit accumulation → ONE hard-freeze write (Smash-style table)
    if (this.hitsThisFrame > 0) {
      let ms =
        this.hitsThisFrame >= 3 ? 85 : this.hitsThisFrame === 2 ? 65 : this.localMelee ? 40 : 25;
      if (this.heavyThisFrame) ms = Math.min(110, ms + 30);
      this.bumpFreeze(ms);
    }

    // delay queue (anticipation → core sequencing without setTimeout)
    this.clock += dt;
    for (let i = this.delayed.length - 1; i >= 0; i--) {
      const d = this.delayed[i]!;
      if (this.clock >= d.at) {
        const last = this.delayed[this.delayed.length - 1]!;
        this.delayed[i] = last;
        this.delayed.pop();
        d.run();
      }
    }

    // numbers arc on the freeze-scaled clock too — a crit that hangs in the air
    // during its own hit-stop is exactly the beat you're meant to read it on
    const vdt = dt * this.scaleNow();
    this.numbers.update(vdt);
    tickFxShaders(vdt); // the shared shader clock freezes with everything else
    this.pools.update(vdt);
    this.chunks.update(vdt);
    this.spikes.update(vdt);
    this.stepRings(vdt);
    this.stepBeams(vdt);
    this.stepCones(vdt);
    this.stepDomes(vdt);
    this.stepSlashes(vdt);
    this.stepCracks(vdt);
    this.stepFlares(vdt);
    this.stepTexActors(vdt);
    this.telegraphs.update(w.now);

    // cull zone set pieces whose zone stopped appearing (ended/detonated)
    for (const [id, p] of this.zonePieces) {
      if (w.now - p.seenAt > 250) {
        this.scene.remove(p.obj);
        p.ownMat?.dispose();
        this.zonePieces.delete(id);
      }
    }

    // prune stale zone-ambience throttles (zone ids are monotonic)
    if (this.clock >= this.zoneSweepAt) {
      this.zoneSweepAt = this.clock + 2;
      for (const [id, st] of this.zoneAnim) if (w.now - st.seenAt > 1500) this.zoneAnim.delete(id);
    }

    // tick the hit-stop clocks down on REAL dt (after stepping, so the first
    // frozen frame renders frozen)
    this.hardFreeze = Math.max(0, this.hardFreeze - dt);
    this.slowMo = Math.max(0, this.slowMo - dt);
  }

  // ── two-stage render-only hit-stop (never touches the sim) ──
  private hardFreeze = 0; // near-total stop (scale 0.05)
  private slowMo = 0; // dramatic tail (scale 0.35)
  /** Briefly hard-freeze the visual layer (impact weight). */
  bumpFreeze(ms: number): void {
    this.hardFreeze = Math.max(this.hardFreeze, ms / 1000);
  }
  /** Visual-time multiplier the scene applies to anim/camera lerps this frame. */
  scaleNow(): number {
    return this.hardFreeze > 0 ? 0.05 : this.slowMo > 0 ? 0.35 : 1;
  }

  /** Distance attenuation from the local player: 1 at 0u → 0.2 beyond 38u. */
  private att(x: number, y: number): number {
    return Math.min(1, Math.max(0.2, 1 - Math.hypot(x - this.lx, y - this.ly) / 38));
  }

  private within(x: number, y: number, r: number): boolean {
    return (x - this.lx) ** 2 + (y - this.ly) ** 2 <= r * r;
  }

  private handle(e: FxEvent): void {
    switch (e.t) {
      case "hit": {
        const color = e.dtype === "magic" ? 0xc070ff : e.dtype === "pure" ? 0xffffff : 0xffd06a;
        const heavy = e.crit ?? false;
        const mine = e.by !== "" && e.by === this.localId;
        const onMe = e.to === this.localId;
        // de-escalated basics so abilities outrank them (and the slash arc stays
        // readable THROUGH the impact); heavies keep the works
        this.flash(e.x, 1.1, e.y, 0xffffff, heavy ? 1.2 : 0.55, heavy ? 2.2 : 1.4);
        this.impactRing(e.x, e.y, color, heavy ? 2.1 : 1.2);
        if (heavy)
          this.flare("impact-burst", e.x, 1.15, e.y, 0xfff2d0, 2.0, 0.14, Math.random() * Math.PI);
        this.sparks(e.x, 1.1, e.y, e.dx, e.dy, heavy ? 20 : 8, color);
        this.burst(e.x, 1.1, e.y, heavy ? 7 : 4, color, 5, 0.16);
        if (heavy) {
          this.impactRing(e.x, e.y, 0xffd24a, 2.8); // gold heavy ring
          this.audio.crit(e.x, e.y);
        }
        if (mine) {
          this.view.addTrauma(0.05); // the kick does the work
          this.view.kick(e.dx, e.dy, heavy ? 0.55 : 0.34);
          if (heavy) this.view.punchFov(1.8);
          this.hitsThisFrame++;
          if (heavy) this.heavyThisFrame = true;
          this.localHits.push({ crit: heavy });
        } else if (onMe) {
          this.view.addTrauma(heavy ? 0.22 : 0.16);
          this.view.kick(e.dx, e.dy, 0.5); // getting slugged moves your camera
        } else {
          this.view.addTrauma(0.06 * this.att(e.x, e.y));
        }
        this.audio.hit(e.x, e.y, e.dtype);
        this.hitNumber(e.x, e.y, e.amount, e.dx, e.dy, heavy, e.by);
        break;
      }
      case "strike":
        this.strikeFx(e.tag, e.x, e.y, e.dx, e.dy, e.r);
        break;
      case "fizzle": {
        // spent projectile dies visibly: a soft puff of drifting motes that
        // sputter down — never a silent mid-air vanish
        const fc =
          e.kind === "fireball"
            ? 0xff7a2c
            : e.kind === "arrow"
              ? 0xffe6a0
              : e.kind === "hexbolt"
                ? 0x7fe08a
                : 0xb070ff;
        for (let i = 0; i < 4; i++) {
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
        break;
      }
      case "propBreak": {
        // wood/matter palette by model; the keg's blast rides its explosion event
        const wood = e.model.includes("keg")
          ? 0x6a4a2a
          : e.model.includes("barrel")
            ? 0x7a5a34
            : 0x8a6a40;
        this.chunks.burst(
          e.x,
          e.y,
          e.model.includes("stacked") ? 10 : 7,
          wood,
          e.explosive ? 7 : 5,
        );
        this.dust(e.x, e.y, 4);
        this.sparks(e.x, 0.7, e.y, 0, 1, 5, 0xd8c090);
        this.impactRing(e.x, e.y, 0xc0a060, 1.4);
        this.view.addTrauma(0.06 * this.att(e.x, e.y));
        this.audio.hit(e.x, e.y, "physical");
        break;
      }
      case "swing": {
        if (e.melee) break; // melee swings are the weapon-trail ribbon
        const c = e.dtype === "magic" ? 0xc070ff : 0xffe6a0;
        const dx = Math.cos(e.ang);
        const dy = Math.sin(e.ang);
        this.crossGlint(e.x + dx * 0.4, 1.15, e.y + dy * 0.4, dx, dy, c, 0.7); // muzzle star
        this.flash(e.x, 1.1, e.y, c, 0.7);
        this.sparks(e.x, 1.1, e.y, dx, dy, 7, c);
        break;
      }
      case "explosion": {
        // caster BASIC splash: a light arcane pop — never the full explosion
        // stack (it fires every auto; generic trauma/flash would rattle the
        // camera nonstop)
        if (e.kind === "bolt") {
          this.flash(e.x, 1.1, e.y, 0xc8a8ff, 0.7, 1.5);
          this.implode(e.x, e.y, 0xb070ff, e.radius * 0.7, 5, 0.16);
          this.impactRing(e.x, e.y, 0xb070ff, e.radius * 0.8);
          break;
        }
        const color =
          e.kind === "nova"
            ? 0x7fd4ff
            : e.kind === "meteor"
              ? 0xff5a2c
              : e.kind === "trap"
                ? 0x9affc0
                : e.kind === "vines"
                  ? 0x4a7a3a
                  : e.kind === "smite"
                    ? 0xffd76a
                    : e.kind === "hexring"
                      ? 0x7fe08a
                      : e.kind === "keg"
                        ? 0xffb050
                        : 0xffa030;
        const big = e.kind === "meteor";
        this.flash(e.x, 0.9, e.y, 0xffffff, big ? 2.4 : 1.5, 2.4);
        this.burst(e.x, 0.8, e.y, big ? 26 : 16, color, big ? 9 : 7, 0.5);
        this.shockwave(e.x, e.y, color, e.radius);
        switch (e.kind) {
          case "nova": {
            // frost detonation: a RING OF ICE SPIKES erupts, holds frozen,
            // then shatters into crystal debris — the ARPG frost-nova image
            this.spikes.ring(e.x, e.y, e.radius * 0.7, 10, 0xbfe8ff, {
              h: 1.5,
              w: 0.42,
              holdMs: 1050,
              exitMs: 180,
            });
            this.fountain(e.x, e.y, 10, 0x9fe8ff);
            this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.85, 0x7fd4ff, 1.6);
            const nx = e.x;
            const ny = e.y;
            this.delay(1.2, () => this.chunks.burst(nx, ny, 9, 0x9fd8ff, 6));
            break;
          }
          case "hexring": {
            // grand hex seals: violet implosion, spores, and a comedy of tiny
            // mushrooms sprouting where the victims stood
            this.implode(e.x, e.y, 0xb98ae0, e.radius, 10, 0.24);
            this.shockwave(e.x, e.y, 0x7fe08a, e.radius, 0.5, 0.7);
            this.spikes.scatter(e.x, e.y, e.radius * 0.75, 6, 0xb98ae0, {
              h: 0.5,
              w: 0.75,
              holdMs: 1300,
              exitMs: 300,
              tiltOut: 0.05,
            });
            const hx = e.x;
            const hy = e.y;
            const hr = e.radius;
            this.delay(0.25, () => {
              this.spikes.scatter(hx, hy, hr * 0.7, 5, 0x7fe08a, {
                h: 0.42,
                w: 0.6,
                holdMs: 1100,
                exitMs: 300,
                tiltOut: 0.05,
              });
              this.bubbles(hx, hy, 8, 0x9fefa8, hr * 0.7);
            });
            break;
          }
          case "vines": // bog grasp: a jaw of vines SNAPS shut around the point
            this.spikes.ring(e.x, e.y, e.radius * 0.8, 9, 0x3a6a2a, {
              h: 1.6,
              w: 0.34,
              holdMs: 1000,
              exitMs: 350,
              tiltOut: -0.45,
            });
            this.spikes.scatter(e.x, e.y, e.radius * 0.5, 4, 0x5a8a3a, {
              h: 1.0,
              w: 0.28,
              holdMs: 900,
              exitMs: 300,
            });
            this.fountain(e.x, e.y, 12, 0x7fe08a);
            this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.8, 0x203018, 1.6);
            break;
          case "trap": // snare trap: green fangs bite inward — a closing jaw
            this.spikes.ring(e.x, e.y, e.radius * 0.85, 8, 0x2c5a30, {
              h: 1.3,
              w: 0.3,
              holdMs: 850,
              exitMs: 250,
              tiltOut: -0.5,
            });
            break;
          case "smite": // consecrating smite: heaven ANSWERS — bolt + cracked earth
            this.texBolt("lightning-arc", e.x, e.y, { h: 11, w: 3.2, color: 0xffe6a0, life: 0.3 });
            this.texBolt("lightning-arc", e.x, e.y, { h: 11, w: 1.8, color: 0xffffff, life: 0.42 });
            this.texDecal("ground-crack", e.x, e.y, { size: 4.4, life: 1.8, additive: false });
            this.texSprite("electric-splat", e.x, 0.8, e.y, {
              size: 3.2,
              color: 0xfff2c0,
              life: 0.3,
              grow: 1.7,
            });
            this.sparks(e.x, 0.4, e.y, 0, 1, 10, 0xfff2c0);
            this.crossGlint(e.x, 3.0, e.y, 0, 1, 0xffe6a0, 1.1);
            break;
          case "meteor": {
            // the full anatomy — flash → blast → pillar → debris → scorch →
            // and the crater KEEPS BURNING for a couple of seconds
            this.beam(e.x, e.y, 0xff8040, 9, 1.2);
            this.debris(e.x, e.y, 6, 0x804030);
            this.chunks.burst(e.x, e.y, 8, 0x5a2a18, 8);
            this.smoke(e.x, e.y, 8);
            this.texDecal("shock-burst", e.x, e.y, {
              size: 3,
              grow: 4.5,
              life: 0.5,
              color: 0xffb060,
            });
            this.texDecal("scorch-decal", e.x, e.y, {
              size: e.radius * 1.7,
              life: 2.2,
              color: 0xff8040,
            });
            for (let i = 0; i < 4; i++)
              this.texFlipbook(
                "fire-sprite",
                4,
                4,
                e.x + (Math.random() - 0.5) * e.radius,
                0.8 + Math.random(),
                e.y + (Math.random() - 0.5) * e.radius,
                { size: 1.6 + Math.random(), life: 0.55, rise: 1.4 },
              );
            this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.8, 0x1a0f0a, 4);
            const mx = e.x;
            const my = e.y;
            const mr = e.radius;
            for (const t of [0.35, 0.75, 1.2]) {
              this.delay(t, () => {
                const a = Math.random() * Math.PI * 2;
                const rr = Math.random() * mr * 0.6;
                this.burst(mx + Math.cos(a) * rr, 0.4, my + Math.sin(a) * rr, 5, 0xff8040, 4, 0.4);
                this.smoke(mx + Math.cos(a) * rr, my + Math.sin(a) * rr, 2);
              });
            }
            break;
          }
          case "fireball": // V-yx Q burst: lava teeth + authored scorch + flame lick
            this.spikes.ring(e.x, e.y, e.radius * 0.45, 5, 0xff7a2c, {
              h: 0.8,
              w: 0.3,
              holdMs: 260,
              exitMs: 200,
            });
            this.texDecal("scorch-decal", e.x, e.y, { size: 3.4, life: 1.5, color: 0xff7030 });
            this.texFlipbook("fire-sprite", 4, 4, e.x, 1.0, e.y, {
              size: 2.6,
              life: 0.55,
              rise: 1,
            });
            this.smoke(e.x, e.y, 4);
            break;
          case "keg": // powder keg — fireball + scorch + a chain-pop beat
            this.burst(e.x, 0.8, e.y, 8, 0xff8040, 7, 0.4);
            this.smoke(e.x, e.y, 6);
            this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.7, 0x1a0f0a, 3);
            if (this.within(e.x, e.y, 12)) this.bumpFreeze(40);
            break;
          case "hexbolt": // Grimelda Q splash: fat slow bog bubbles + hex swirl
            this.bubbles(e.x, e.y, 8, 0x9fefa8, e.radius * 0.7);
            this.texSprite("swirl-lines", e.x, 1.2, e.y, {
              size: 2.4,
              color: 0x9fefa8,
              life: 0.4,
              grow: 1.6,
              spin: Math.PI * 2,
            });
            break;
          default:
            this.smoke(e.x, e.y, 5);
        }
        this.view.addTrauma((big ? 0.5 : 0.22) * this.att(e.x, e.y));
        if (big && this.within(e.x, e.y, 14)) this.bumpFreeze(70);
        this.audio.explosion();
        break;
      }
      case "death": {
        this.flash(e.x, 1.0, e.y, 0xffffff, 1.2, 2.0);
        this.burst(e.x, 1.0, e.y, 16, 0x99a0b5, 6, 0.6);
        this.smoke(e.x, e.y, 4);
        if (e.by !== "" && e.by === this.localOwnerId) {
          // YOUR kill — the confirm: freeze → slow-mo tail, gold ring, punch-in
          this.hardFreeze = Math.max(this.hardFreeze, 0.1);
          this.slowMo = Math.max(this.slowMo, 0.25); // 150ms tail after the freeze
          this.view.addTrauma(0.45);
          this.view.punchFov(4.0);
          this.shockwave(e.x, e.y, 0xffd24a, 3.5);
          this.flash(e.x, 1.2, e.y, 0xffffff, 1.8, 2.6);
          this.audio.killConfirm();
        } else if (e.team === this.localTeam && this.localTeam !== "") {
          // your death — a long exhale
          this.slowMo = Math.max(this.slowMo, 0.35);
          this.view.addTrauma(0.4);
        } else {
          this.view.addTrauma(0.3 * this.att(e.x, e.y));
          if (this.within(e.x, e.y, 12)) this.bumpFreeze(50);
        }
        this.audio.death();
        break;
      }
      case "cast":
        this.signatureCast(`${e.champId}:${e.key}`, e.x, e.y, e.dx, e.dy);
        this.audio.cast(e.champId, e.key, e.x, e.y);
        if (e.key === "R" && this.within(e.x, e.y, 1.5)) this.view.punchFov(2.2); // your R
        break;
      case "levelup":
        // converge → flash → rise: the one effect allowed to run long
        this.implode(e.x, e.y, 0xffd24a, 2, 10, 0.25);
        this.delay(0.18, () => {
          this.fountain(e.x, e.y, 16, 0xffd24a);
          this.shockwave(e.x, e.y, 0xffd24a, 3);
          this.beam(e.x, e.y, 0xffd24a);
        });
        this.audio.levelup();
        break;
      case "heal":
        this.fountain(e.x, e.y, 10, 0x6bff8e);
        this.numbers.spawn(`+${Math.round(e.amount)}`, e.x, e.y, "heal", this.nowMs);
        break;
      case "blink":
        this.implode(e.x, e.y, 0x9a7bff, 1.6, 8, 0.22); // inward = vanish
        this.ghost(e.x, e.y, 0x9a7bff); // the afterimage she leaves behind
        this.burst(e.tx, 1.0, e.ty, 10, 0x9a7bff, 5, 0.35);
        this.impactRing(e.tx, e.ty, 0xb090ff, 2.2);
        this.crossGlint(e.tx, 1.3, e.ty, 0, 1, 0xc0a0ff, 1.1);
        break;
      case "itemUse":
        this.itemUseFx(e.x, e.y, e.item);
        break;
      case "perfectDodge":
        this.impactRing(e.x, e.y, 0x66ffe0, 2.2);
        this.flash(e.x, 1.1, e.y, 0x9fffe8, 1.0, 1.8);
        if (e.unit === this.localId) {
          this.slowMo = Math.max(this.slowMo, 0.2);
          this.numbers.spawn("PERFECT", e.x, e.y, "banner", this.nowMs);
        }
        break;
      case "delivery":
        this.fountain(e.x, e.y, 14, 0x66ffcc);
        this.castDome(e.x, e.y, 0x66ffcc, 1.6);
        this.audio.delivery();
        break;
      case "coinThrow":
        this.implode(e.x, e.y, 0xffd24a, 1.4, 10, 0.2);
        this.delay(0.12, () => {
          this.flash(e.x, 3.0, e.y, 0xffd24a, 1.1);
          this.burst(e.x, 3.0, e.y, 8, 0xffd24a, 5, 0.35);
          const dx = e.tx - e.x;
          const dy = e.ty - e.y;
          this.castStreak(e.x, e.y, dx, dy, 0xffd24a, 8, 8, 0.3);
        });
        break;
      case "coinGrab":
        this.fountain(e.x, e.y, 14, 0xffd24a);
        this.numbers.spawn(`+${e.gold}`, e.x, e.y, "gold", this.nowMs);
        this.view.addTrauma(0.12);
        this.audio.coin();
        break;
      case "kill": {
        this.feed.push({
          killerName: e.killerName,
          victimName: e.victimName,
          leader: e.leader,
          killer: e.killer,
          victim: e.victim,
        });
        if (e.victim === this.localOwnerId)
          this.lastDeath = { killerName: e.killerName, at: this.nowMs };
        if (e.killer !== "" && e.killer === this.localOwnerId) {
          const streak = this.bestStreak; // updated from the synced unit each frame
          if (streak >= 3)
            this.audio.stinger(streak >= 9 ? 3 : streak >= 7 ? 2 : streak >= 5 ? 1 : 0);
        }
        if (e.leader) this.audio.leaderSlain();
        break;
      }
      case "notify":
        if (e.kind === "matchend") {
          this.slowMo = Math.max(this.slowMo, 1.2); // match-end slow-mo beat
          this.audio.victory();
        } else {
          this.toasts.push({ text: e.text, kind: e.kind });
          if (e.kind === "delivery") this.audio.delivery();
          else if (e.kind === "leader" || e.kind === "streak") this.audio.alert();
        }
        break;
      default:
        break;
    }
  }

  // ── item actives (fx.ts side of the itemUse event) ──
  private itemUseFx(x: number, y: number, item: string): void {
    switch (item) {
      case "swiftboots":
        this.burst(x, 0.6, y, 8, 0x66ffee, 6, 0.3);
        this.footDust(x, y, 1, 0);
        this.footDust(x, y, -1, 0);
        break;
      case "talisman": // "chains break" — white pop + upward sparks
        this.castDome(x, y, 0xffffff, 1.6, 0.3);
        this.sparks(x, 0.6, y, 0, 1, 8, 0xffffff);
        this.fountain(x, y, 6, 0xfff2d0);
        break;
      case "bulwark":
        this.flash(x, 1.2, y, 0xffd24a, 1.0, 1.6); // bubble itself = shield status
        break;
      default:
        this.flash(x, 1.1, y, 0x9fd0ff, 0.8);
        break;
    }
  }

  // ── per-ability signature casts — the ANTICIPATION layer (wind-up, launch,
  //    channel). Impact fx for damaging abilities fire on the `strike` event
  //    when the blade/slam actually connects — see strikeFx(). ──
  private signatureCast(tag: string, x: number, y: number, dx: number, dy: number): void {
    switch (tag) {
      // KNIGHT — heavy steel, white-hot edges
      case "knight:Q":
        this.implode(x, y, 0xeaf2ff, 1.8, 7, 0.2);
        this.dust(x, y, 3);
        break; // Cleaving Blow — gather before the arc
      case "knight:W":
        this.implode(x, y, 0x8fd0ff, 1.6, 6, 0.2);
        this.footDust(x, y, -dx, -dy);
        break; // Seismic Slam — plant the feet
      case "knight:E":
        this.implode(x, y, 0xeaf2ff, 2.2, 10, 0.26);
        this.texShell("hex-shield", x, 1.25, y, {
          r: 2.0,
          color: 0x5fa0ff,
          life: 1.6,
          repeat: [4, 2],
          scrollY: 0.02,
        });
        this.shockwave(x, y, 0xeaf2ff, 2.0, 0.4, 0.8);
        this.dust(x, y, 4);
        this.sparks(x, 0.4, y, 0, 1, 4, 0xfff2c0);
        break; // Iron Stance — the hex bubble snaps up
      case "knight:R":
        this.implode(x, y, 0xbfe0ff, 3, 12, 0.26);
        this.shockwave(x, y, 0xeaf2ff, 4);
        this.shockwave(x, y, 0xbfe0ff, 5.5, 0.5);
        this.burst(x, 1.2, y, 16, 0xbfe0ff, 8, 0.4);
        this.view.addTrauma(0.14);
        break;
      // RANGER — verdant precision, gold arrows
      case "ranger:Q":
        this.implode(x, y, 0xffe6a0, 1.2, 6, 0.18);
        this.crossGlint(x + dx * 0.6, 1.3, y + dy * 0.6, dx, dy, 0xffe6a0, 0.7);
        this.sectorRim(x, y, dx, dy, 0xffe6a0, 5, 0.2);
        break; // draw — the fan flashes its real spread
      case "ranger:W":
        this.implode(x, y, 0xffe6a0, 2.0, 10, 0.26);
        this.texShell("electro-ball", x, 2.3, y, {
          r: 0.9,
          color: 0xffe6a0,
          life: 1.4,
          repeat: [2, 1],
          scrollY: 0.06,
        });
        this.fountain(x, y, 12, 0xffe6a0);
        break; // Hunter's Focus — self buff bloom
      case "ranger:E":
        this.flash(x + dx, 0.5, y + dy, 0x9affc0, 0.7);
        this.sparks(x + dx, 0.9, y + dy, 0, -1, 6, 0x9affc0);
        break;
      case "ranger:R":
        this.beam(x, y, 0xffe6a0);
        this.implode(x, y, 0xffe6a0, 3, 10, 0.28);
        this.flash(x, 4.5, y, 0xffe6a0, 2.0, 1.6);
        this.crossGlint(x, 8.0, y, dx, dy, 0xfff2c0, 1.6);
        this.crossGlint(x, 9.2, y, -dy, dx, 0xffe6a0, 1.2);
        break; // the sky glints before the volley
      // MAGE — fire primary, frost/arcane separated
      case "mage:Q":
        this.implode(x, y, 0xffa030, 1.4, 7, 0.2);
        this.mote(x + dx * 0.5, 1.3, y + dy * 0.5, 0xffd060, 0.6, 0.25, 0.5);
        break; // fireball condenses in the palm
      case "mage:W":
        this.castDome(x, y, 0x7fd4ff, 1.8, 0.34);
        this.iceShards(x, y, 6);
        break; // frost gathers — the nova detonates at the point
      case "mage:E":
        this.castStreak(x, y, dx, dy, 0xff8040, 12, 8, 0.3);
        this.flash(x + dx * 0.6, 1.3, y + dy * 0.6, 0xffb060, 1.0, 1.7);
        this.sparks(x + dx * 0.6, 1.2, y + dy * 0.6, dx, dy, 6, 0xff8040);
        break; // Cinderfall — cast ember toward the zone (zone renders at target)
      case "mage:R":
        this.beam(x, y, 0xff5a2c);
        this.flash(x, 4.0, y, 0xff8040, 2.0, 2.2);
        this.castStreak(x, y, 0, 1, 0xff5a2c, 3, 8, 1.2);
        break;
      // ROGUE — crimson violence out of violet shadow
      case "rogue:Q":
        this.castStreak(x, y, dx, dy, 0x7fff8e, 14, 12, 0.2);
        this.smoke(x, y, 2);
        break; // lunge launch — the cut lands at dash end
      case "rogue:W":
        this.implode(x, y, 0xff3060, 1.4, 6, 0.16);
        this.smoke(x, y, 2);
        break; // coil before the gash
      case "rogue:E":
        this.smoke(x, y, 10);
        this.castDome(x, y, 0x6a5a9a, 2.4, 0.5);
        this.telegraphs.spawnResidue(x, y, 2.4, 0x201830, 2);
        break;
      case "rogue:R":
        this.castStreak(x, y, dx, dy, 0xff3060, 22, 14, 0.14);
        this.texSprite("galaxy", x, 1.8, y, {
          size: 2.8,
          color: 0xc0a8ff,
          life: 0.45,
          spin: Math.PI * 2,
        });
        this.texSprite("dark-shock", x, 1.8, y, {
          size: 3.4,
          color: 0x8a5fd0,
          life: 0.45,
          grow: 1.5,
        });
        this.smoke(x, y, 3);
        break; // he steps THROUGH the dark door — the execute lands on arrival
      // AURELIUS (id blackknight) — dawn-gold consecration, white-gold edges
      case "blackknight:Q":
        this.implode(x, y, 0xfff2c0, 1.8, 7, 0.2);
        this.smoke(x, y, 2);
        break; // the great sweep winds up
      case "blackknight:W":
        this.castDome(x, y, 0xffd76a, 1.6, 0.3);
        this.flash(x, 1.2, y, 0xfff2c0, 1.1, 1.8);
        this.sparks(x, 0.4, y, 0, 1, 8, 0xfff2c0);
        this.crossGlint(x + dx, 1.4, y + dy, dx, dy, 0xffe6a0, 1.0);
        break; // Consecrating Smite — holy channel (pillar lands at target)
      case "blackknight:E":
        this.castDome(x, y, 0xffe6a0, 2.4, 0.5);
        this.sparks(x, 0.4, y, 0, 1, 8, 0xfff2c0);
        break;
      case "blackknight:R":
        this.implode(x, y, 0xfff2c0, 4, 12, 0.24);
        this.beam(x, y, 0xffd76a, 6, 0.8);
        this.texSprite("holy-wings", x, 2.4, y, {
          size: 6.5,
          color: 0xffe6a0,
          life: 1.1,
          grow: 1.25,
        });
        this.texStreak("trail-holy", x + 1.4, 0.2, y, x + 1.4, 5, y, {
          w: 0.9,
          len: 2.4,
          color: 0xffd76a,
          life: 0.8,
        });
        this.texStreak("trail-holy", x - 1.2, 0.2, y + 0.8, x - 1.2, 5, y + 0.8, {
          w: 0.9,
          len: 2.4,
          color: 0xffd76a,
          life: 0.8,
        });
        break; // the hammer RISES — it falls on the strike
      // WITCH — bog-green hexcraft
      case "witch:Q":
        this.implode(x, y, 0x7fe08a, 1.2, 6, 0.18);
        this.crossGlint(x + dx * 0.6, 1.3, y + dy * 0.6, dx, dy, 0x7fe08a, 0.8);
        break; // the bolt curdles
      case "witch:W":
        this.castDome(x, y, 0x7fe08a, 1.8, 0.35);
        this.bubbles(x, y, 6, 0x7fe08a);
        break;
      case "witch:E":
        this.castDome(x, y, 0x4a7a3a, 1.4, 0.3);
        this.crossGlint(x + dx, 1.2, y + dy, dx, dy, 0x9fefa8, 0.9);
        break; // Bog Grasp — vines gather (eruption at the point)
      case "witch:R":
        this.implode(x, y, 0xb98ae0, 3, 12, 0.26);
        this.castDome(x, y, 0x7fe08a, 2.4, 0.45);
        this.bubbles(x, y, 8, 0x9fefa8);
        break; // hex gathers — the ring seals at the point
      // ── DASH (Shift) — light launch burst; the per-frame travel trail + expiry
      //    pop live in world-view. No damage-impact layer. mage:DASH = teleport
      //    (its src→dest visual is the separate `blink` fx event).
      case "knight:DASH":
        this.castStreak(x, y, dx, dy, 0x8fd0ff, 18, 10, 0.14);
        this.flash(x + dx, 1.15, y + dy, 0xeaf2ff, 0.9, 1.6);
        this.footDust(x, y, -dx, -dy);
        this.castDome(x, y, 0xeaf2ff, 1.0, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0xeaf2ff, 0.8);
        break;
      case "ranger:DASH":
        this.castStreak(x, y, dx, dy, 0x9fffe0, 14, 8, 0.1);
        this.smoke(x, y, 3);
        this.footDust(x, y, -dx, -dy);
        this.footDust(x, y, -dx, -dy);
        this.castDome(x, y, 0x7dffb0, 1.0, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0x9fffe0, 0.7);
        break;
      case "mage:DASH":
        this.implode(x, y, 0x9a7bff, 1.6, 8, 0.22);
        this.crossGlint(x, 1.3, y, dx, dy, 0xc0a0ff, 1.0);
        break;
      case "rogue:DASH":
        this.castStreak(x, y, dx, dy, 0x6a5a9a, 16, 10, 0.14);
        this.smoke(x, y, 6);
        this.spawnResidue(x, y, 1.6, 0x201830, 2);
        this.footDust(x, y, -dx, -dy);
        break;
      case "blackknight:DASH":
        this.castStreak(x, y, dx, dy, 0xffd76a, 16, 10, 0.16);
        this.flash(x + dx, 1.15, y + dy, 0xfff2c0, 1.0, 1.6);
        this.footDust(x, y, -dx, -dy);
        this.footDust(x, y, -dx, -dy);
        this.castDome(x, y, 0xffe6a0, 1.0, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0xffd76a, 0.8);
        break;
      case "witch:DASH":
        this.castStreak(x, y, dx, dy, 0xb98ae0, 20, 12, 0.14);
        this.footDust(x, y, -dx, -dy);
        this.mote(x, 0.6, y, 0x7fe08a, 2, 0.6, 0.3);
        this.castDome(x, y, 0x7fe08a, 1.0, 0.24);
        this.crossGlint(x, 1.2, y, dx, dy, 0xb98ae0, 0.7);
        break;
      // ── JUMP (Space+click) — takeoff anticipation only; the landing blast is
      //    the strike event at the real touchdown point (see strikeFx).
      case "knight:JUMP":
        this.implode(x, y, 0xeaf2ff, 2.2, 8, 0.2);
        this.dust(x, y, 3);
        break;
      // the two AERIALs spring straight UP (they don't travel) — kick the dust
      // out all round, not backward off a leap
      case "ranger:JUMP":
        this.dust(x, y, 4);
        this.impactRing(x, y, 0xffe6a0, 1.8);
        break;
      case "mage:JUMP":
        this.dust(x, y, 4);
        this.implode(x, y, 0xff8040, 2.4, 8, 0.2);
        break;
      case "rogue:JUMP":
        this.implode(x, y, 0x6a5a9a, 1.8, 8, 0.2);
        this.smoke(x, y, 2);
        break;
      case "blackknight:JUMP":
        this.implode(x, y, 0xfff2c0, 2.6, 10, 0.22);
        this.dust(x, y, 3);
        break;
      case "witch:JUMP":
        this.implode(x, y, 0xb98ae0, 2.4, 8, 0.2);
        this.bubbles(x, y, 4, 0x9fefa8);
        break;
      default:
        this.flash(x, 1.3, y, 0x9fd0ff, 0.9);
        this.burst(x, 1.2, y, 6, 0x9fd0ff, 3, 0.3);
    }
  }

  // ── per-ability strike impacts — fired by the sim when the blow CONNECTS.
  //    (x,y) is the impact anchor (caster for melee arcs, landing point for
  //    jump slams, target for the execute); r is the shape's reach/radius. ──
  private strikeFx(tag: string, x: number, y: number, dx: number, dy: number, r: number): void {
    switch (tag) {
      // Garran's 3rd-swing whirl (basic rhythm aoe) — the weapon trail IS the
      // whirl visual; just a ground ring + sparks mark the damage tick
      case "spin":
        this.shockwave(x, y, 0x8fd0ff, r, 0.3);
        this.slashArc(x, y, Math.atan2(dy, dx), r * 1.2, 0xbfe0ff, {
          tex: "spin",
          tilt: 0,
          span: 3.1,
          life: 0.34,
          height: 1.0,
        });
        this.burst(x, 1.1, y, 12, 0xbfe0ff, 7, 0.3);
        this.dust(x, y, 5);
        if (this.within(x, y, 12)) this.view.addTrauma(0.1);
        break;
      case "knight:Q": {
        this.slashArc(x, y, Math.atan2(dy, dx), r, 0xdbe8ff, { tilt: 0.3, span: 0.85, life: 0.3 });
        this.sectorRim(x, y, dx, dy, 0xeaf2ff, r, 0.79);
        this.sparks(x + dx, 1.2, y + dy, dx, dy, 12, 0xeaf2ff);
        this.crack(x + dx * 2.0, y + dy * 2.0, Math.atan2(dy, dx), 2.2, 1.5, 0x8fd0ff, 1.8);
        this.chunks.burst(x + dx * 1.8, y + dy * 1.8, 3, 0x6a7078, 4);
        if (this.within(x, y, 12)) this.view.addTrauma(0.08);
        break;
      }
      case "knight:W": {
        // Seismic Slam: the fissure TEARS down the corridor in three beats
        const ang = Math.atan2(dy, dx);
        const kx = x;
        const ky = y;
        for (let seg = 0; seg < 3; seg++) {
          const d = 1.6 + seg * 2.3;
          this.delay(seg * 0.06, () => {
            this.crack(kx + dx * d, ky + dy * d, ang, 2.4, 1.2, 0x8fd0ff, 2.4);
            this.dust(kx + dx * d, ky + dy * d, 3);
            this.sparks(kx + dx * d, 0.4, ky + dy * d, dx, dy, 4, 0xbfe0ff);
          });
        }
        this.delay(0.14, () => {
          this.impactRing(kx + dx * 6.4, ky + dy * 6.4, 0xeaf2ff, 2.4);
          this.chunks.burst(kx + dx * 6.4, ky + dy * 6.4, 5, 0x6a7078, 5);
        });
        if (this.within(x, y, 14)) {
          this.view.kick(dx, dy, 0.4);
          this.view.addTrauma(0.1);
        }
        break;
      }
      case "ranger:Q":
        this.castStreak(x, y, dx, dy, 0xffe6a0, 20, 12, 0.45);
        this.flash(x + dx, 1.3, y + dy, 0xffffff, 0.9, 1.6);
        break; // the fan looses
      case "mage:Q":
        this.castStreak(x, y, dx, dy, 0xffa030, 14, 12, 0.22);
        this.flash(x + dx, 1.3, y + dy, 0xffd060, 1.2, 2.0);
        break; // the fireball leaves
      case "witch:Q":
        this.castStreak(x, y, dx, dy, 0x7fe08a, 16, 10, 0.12);
        this.flash(x + dx, 1.3, y + dy, 0xb0ffb8, 0.9, 1.6);
        break; // the bolt spits
      case "rogue:Q":
        this.slashArc(x, y, Math.atan2(dy, dx), 2.2, 0x7fff8e, {
          tilt: 0.45,
          span: 0.7,
          life: 0.24,
        });
        this.crossGlint(x, 1.2, y, dx, dy, 0x7fff8e, 1.2);
        this.sparks(x, 1.1, y, dx, dy, 8, 0x7fff8e);
        this.drips(x, y, 6, 0x4a9a3a);
        break; // the poisoned cut drips at dash end
      case "rogue:W":
        this.slashArc(x + dx * 2, y + dy * 2, Math.atan2(dy, dx), 2.4, 0xff5a78, {
          tilt: 0.5,
          span: 0.6,
          life: 0.26,
        });
        this.crack(x + dx * 3, y + dy * 3, Math.atan2(dy, dx), 3.4, 0.9, 0xff3060, 3.2, 1);
        this.castStreak(x, y, dx, dy, 0xff3060, 20, 12, 0.14);
        this.drips(x + dx * 3, y + dy * 3, 5, 0x8a1020);
        this.smoke(x + dx * 2, y + dy * 2, 3);
        break; // the wound stays open — the crack pulses with the bleed
      case "rogue:R": {
        // the execute: an X-cut of crossed crimson arcs + the screen flinches
        const ang = Math.atan2(dy, dx);
        this.slashArc(x, y, ang, 2.6, 0xff5a78, { tilt: 0.55, span: 0.6, life: 0.28 });
        this.slashArc(x, y, ang, 2.6, 0xff3060, { tilt: -0.55, span: 0.6, life: 0.28, dir: -1 });
        this.flash(x, 1.2, y, 0xff5070, 1.3, 2.0);
        this.crossGlint(x, 1.2, y, dx, dy, 0xff3060, 1.6);
        this.impactRing(x, y, 0xff3060, 2.4);
        this.drips(x, y, 8, 0x8a1020);
        if (this.within(x, y, 10)) {
          this.bumpFreeze(35);
          this.view.screenPulse(0.08, 0.18);
        }
        break;
      }
      case "blackknight:Q": {
        this.slashArc(x, y, Math.atan2(dy, dx), r, 0xffd76a, {
          tilt: 0.25,
          span: 1.0,
          life: 0.32,
          tex: "arc",
        });
        this.sectorRim(x, y, dx, dy, 0xfff2c0, r, 0.96);
        this.sparks(x + dx, 1.2, y + dy, dx, dy, 10, 0xfff2c0);
        const gx = x + dx * 2.2;
        const gy = y + dy * 2.2;
        this.delay(0.12, () => this.sparks(gx, 2.4, gy, 0, -1, 8, 0xffe6a0)); // gold rain falls off the arc
        break;
      }
      case "blackknight:R": {
        // Oblivion Slam: the earth stars open and the SCREEN takes the hit
        this.crack(x, y, Math.random() * Math.PI, 4.6, 4.6, 0xffd76a, 3.0);
        this.shockwave(x, y, 0xffd76a, 5.5);
        this.shockwave(x, y, 0xfff2c0, 4, 0.5);
        this.burst(x, 1.2, y, 20, 0xffd76a, 9, 0.4);
        this.chunks.burst(x, y, 10, 0x7a6238, 7);
        this.smoke(x, y, 6);
        if (this.within(x, y, 14)) {
          this.bumpFreeze(60);
          this.view.screenPulse(0.14, 0.22);
        }
        this.view.addTrauma(0.18);
        break;
      }
      // JUMP landings — the champ-flavored slam at the true touchdown point
      case "knight:JUMP":
        this.shockwave(x, y, 0x8fd0ff, r);
        this.crack(x, y, Math.random() * Math.PI, r, r, 0x8fd0ff, 2.0);
        this.sectorRim(x, y, dx, dy, 0xeaf2ff, r, 0.79);
        this.chunks.burst(x, y, 4, 0x6a7078, 5);
        this.dust(x, y, 4);
        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.12);
          this.bumpFreeze(40);
        }
        break;
      // AERIAL volleys fire from the APEX, not a touchdown — so nothing here may
      // touch the ground (no cracks, no scorch, no dust). It all rings out at hop
      // height, where the champ actually is.
      case "ranger:JUMP": {
        this.flash(x, HOP_HEIGHT, y, 0xffe6a0, 1.0, 1.7);
        this.crossGlint(x, HOP_HEIGHT, y, dx, dy, 0xfff2c0, 1.4);
        // the spin itself: a wheel of arrow streaks thrown outward
        const base = Math.atan2(dy, dx);
        for (let i = 0; i < 9; i++) {
          const a = base + (i / 9) * Math.PI * 2;
          this.sparks(x, HOP_HEIGHT, y, Math.cos(a), Math.sin(a), 3, 0xffe6a0);
        }
        this.shockwave(x, y, 0x7dffb0, r, 0.34, 0.9, HOP_HEIGHT);
        if (this.within(x, y, 12)) this.view.addTrauma(0.09);
        break;
      }
      case "mage:JUMP":
        this.flash(x, HOP_HEIGHT, y, 0xffd060, 1.5, 2.2);
        this.burst(x, HOP_HEIGHT, y, 14, 0xff8040, 7, 0.4);
        this.shockwave(x, y, 0xff8040, r, 0.36, 0.9, HOP_HEIGHT);
        this.shockwave(x, y, 0xffd060, r * 0.55, 0.26, 0.95, HOP_HEIGHT);
        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.11);
          this.bumpFreeze(40);
        }
        break;
      case "rogue:JUMP": {
        const ang = Math.atan2(dy, dx);
        this.slashArc(x, y, ang, 1.9, 0xff5a78, { tilt: 0.5, span: 0.55, life: 0.24 });
        this.slashArc(x, y, ang, 1.9, 0xff3060, { tilt: -0.5, span: 0.55, life: 0.24, dir: -1 });
        this.impactRing(x, y, 0xff3060, r);
        this.smoke(x, y, 2);
        if (this.within(x, y, 10)) this.bumpFreeze(35);
        break;
      }
      case "blackknight:JUMP":
        this.shockwave(x, y, 0xffd76a, r);
        this.crack(x, y, Math.random() * Math.PI, r, r, 0xffd76a, 2.4);
        this.beam(x, y, 0xffd76a, 8, 1.1);
        this.burst(x, 1.0, y, 14, 0xffd76a, 8, 0.4);
        this.chunks.burst(x, y, 6, 0x7a6238, 6);
        this.smoke(x, y, 4);
        if (this.within(x, y, 12)) {
          this.view.addTrauma(0.12);
          this.bumpFreeze(60);
        }
        break;
      case "witch:JUMP":
        this.castDome(x, y, 0x7fe08a, r * 0.85);
        this.impactRing(x, y, 0x9fefa8, r);
        this.bubbles(x, y, 8, 0x9fefa8, r * 0.85);
        this.spikes.scatter(x, y, r * 0.6, 3, 0x7fe08a, {
          h: 0.4,
          w: 0.55,
          holdMs: 900,
          exitMs: 250,
          tiltOut: 0.05,
        });
        if (this.within(x, y, 12)) this.view.addTrauma(0.11);
        break;
      default:
        this.impactRing(x, y, 0x9fd0ff, Math.max(1.2, r * 0.6));
    }
  }

  // ── zone ambience (called per live GroundEffect from world-view) ──
  zoneAmbient(g: GroundEffect, now: number): void {
    let st = this.zoneAnim.get(g.id);
    if (!st) {
      st = { next: 0, next2: 0, phase: Math.random() * 6, seenAt: now, born: true };
      this.zoneAnim.set(g.id, st);
    }
    st.seenAt = now;
    const r = g.radius;

    // arming runes: a rotating arcane circle over the telegraph while the
    // detonation charges (gold smite / violet grand hex / green own-team trap)
    const runeColor =
      g.effect === "smite"
        ? 0xffd76a
        : g.effect === "hexring"
          ? 0xb98ae0
          : g.effect === "trap" && g.team === this.localTeam
            ? 0x9affc0
            : 0;
    if (runeColor !== 0) {
      // AUTHORED magic circles: pentagram for the witch's grand hex, runic
      // script ring for holy/trap telegraphs (procedural ring underneath stays)
      const runeTex = g.effect === "hexring" ? "rune-circle-a" : "rune-circle-b";
      const piece = this.zonePiece(`rune:${g.id}`, () => {
        const mat = new THREE.MeshBasicMaterial({
          map: fxTex(runeTex),
          color: runeColor,
          transparent: true,
          opacity: 0.9,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(this.ringPlane, mat);
        mesh.rotation.x = -Math.PI / 2;
        return { obj: mesh, ownMat: mat };
      });
      piece.seenAt = now;
      piece.obj.position.set(g.x, terrainHeight(g.x, g.y) + 0.14, g.y); // ground-hug even on the plateau
      piece.obj.scale.setScalar(r * 1.15);
      piece.obj.rotation.z = now * 0.0008; // slow ritual spin
    }

    switch (g.effect) {
      case "whirlwind": {
        // shader vortex drum spins around the whirling knight
        const v = this.zonePiece(g.id, () => {
          const mat = makeVortexMaterial(0xbfe0ff); // per-piece material — disposable
          return { obj: new THREE.Mesh(this.vortexGeo, mat), ownMat: mat };
        });
        v.seenAt = now;
        v.obj.position.set(g.x, terrainHeight(g.x, g.y) + 1.3, g.y);
        v.obj.scale.set(r * 0.55, 2.6, r * 0.55);
        v.obj.rotation.y = now * 0.004;
        // dragged dust skirt + a tick-cadence ring pulse ground the cyclone
        if (now >= st.next2) {
          st.next2 = now + 250;
          this.shockwave(g.x, g.y, 0x8fd0ff, r * 0.9, 0.24, 0.35);
          const da = Math.random() * Math.PI * 2;
          this.footDust(
            g.x + Math.cos(da) * r * 0.8,
            g.y + Math.sin(da) * r * 0.8,
            -Math.sin(da),
            Math.cos(da),
          );
        }
        if (now < st.next) return;
        st.next = now + 120;
        for (let i = 0; i < 4; i++) {
          st.phase += 2.4;
          const rr = 0.4 + ((st.phase * 0.19) % 1) * (r - 0.4);
          const cx = g.x + Math.cos(st.phase) * rr;
          const cy = g.y + Math.sin(st.phase) * rr;
          const o = sp(cx, 0.5 + Math.random() * 1.2, cy);
          o.vx = -Math.sin(st.phase) * 8; // tangential
          o.vz = Math.cos(st.phase) * 8;
          o.vy = 0.6;
          o.drag = 2.5;
          o.color = i % 2 ? 0xeaf2ff : 0x8fd0ff;
          o.size = 0.32;
          o.life = 0.3;
          o.stretch = true;
          this.pools.spawn("add", o);
        }
        break;
      }
      case "rain": {
        if (now >= st.next) {
          st.next = now + 250;
          for (let i = 0; i < 6; i++) {
            const a = Math.random() * Math.PI * 2;
            const rr = Math.sqrt(Math.random()) * r;
            const o = sp(g.x + Math.cos(a) * rr, 6, g.y + Math.sin(a) * rr);
            o.vy = -18;
            o.color = 0xffe6a0;
            o.size = 0.3;
            o.life = 0.35;
            o.stretch = true;
            this.pools.spawn("add", o);
          }
        }
        if (now >= st.next2) {
          st.next2 = now + 500;
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r * 0.8;
          this.impactRing(g.x + Math.cos(a) * rr, g.y + Math.sin(a) * rr, 0xffe6a0, 0.8);
        }
        break;
      }
      case "meteor": {
        // the ACTUAL rock: a boiling comet dives in over the last 650ms,
        // timed to hit zero altitude exactly at detonateAt
        const remain = (g.detonateAt ?? now) - now;
        if (remain > 0 && remain < 650) {
          const c = this.zonePiece(g.id, () => {
            const mesh = new THREE.Mesh(this.cometGeo, energyBallMaterial(0xff5a2c)); // shared mat — never disposed here
            mesh.scale.setScalar(Math.min(1.4, r * 0.28));
            return { obj: mesh, ownMat: null };
          });
          c.seenAt = now;
          const k = remain / 650; // 1 → far, 0 → impact
          c.obj.position.set(g.x + k * 5, terrainHeight(g.x, g.y) + k * 17, g.y - k * 2.5); // altitude above the impact ground
          this.trailAt(c.obj.position.x, c.obj.position.y, c.obj.position.z, 0xff8040, 0.8);
          this.trailAt(c.obj.position.x, c.obj.position.y + 0.6, c.obj.position.z, 0x804030, 0.5);
        }
        // final 400ms: the ground itself panics — fast heat pulses
        if (remain > 0 && remain < 400 && now >= st.next2) {
          st.next2 = now + 130;
          this.impactRing(g.x, g.y, 0xff8040, r * 0.9);
        }
        if (now < st.next) return;
        st.next = now + 150;
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r * 0.8;
          const o = sp(g.x + Math.cos(a) * rr, 0.2, g.y + Math.sin(a) * rr);
          o.vy = 2.4;
          o.color = 0xff5a2c;
          o.size = 0.24;
          o.life = 0.5;
          this.pools.spawn("add", o);
        }
        break;
      }
      case "brew": {
        if (st.born) {
          // the cauldron tips over: a green splash + droplets before it settles
          st.born = false;
          this.castDome(g.x, g.y, 0x7fe08a, r * 0.6, 0.3);
          this.drips(g.x, g.y, 10, 0x5aa860);
          this.bubbles(g.x, g.y, 8, 0x9fefa8, r * 0.6);
        }
        if (now >= st.next) {
          st.next = now + 250;
          this.bubbles(g.x, g.y, 4, 0x7fe08a, r);
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
          this.pools.spawn("normal", o);
        }
        break;
      }
      case "cinderfall": {
        // mage E ember field — embers RAIN from above while flames lick up off
        // the scorched disc (fire falls, heat rises)
        if (now < st.next) return;
        st.next = now + 140;
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r;
          const o = sp(g.x + Math.cos(a) * rr, 0.2, g.y + Math.sin(a) * rr);
          o.vy = 2.0 + Math.random() * 1.4;
          o.color = i % 2 ? 0xff8040 : 0xffb060;
          o.size = 0.28;
          o.life = 0.5;
          o.stretch = true;
          this.pools.spawn("add", o);
        }
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r;
          const o = sp(g.x + Math.cos(a) * rr, 3.6 + Math.random() * 1.2, g.y + Math.sin(a) * rr);
          o.vy = -5 - Math.random() * 2;
          o.vx = (Math.random() - 0.5) * 1.2;
          o.color = 0xffb060;
          o.size = 0.24;
          o.life = 0.55;
          o.stretch = true;
          this.pools.spawn("add", o);
        }
        break;
      }
      case "trap":
        break; // arming shimmer only — the decal carries it
      default: {
        if (!g.enemyDps || now < st.next) return;
        st.next = now + 300;
        for (let i = 0; i < 2; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r;
          const o = sp(g.x + Math.cos(a) * rr, 0.3, g.y + Math.sin(a) * rr);
          o.vy = 1.5;
          o.color = groundFxColor(g.effect);
          o.size = 0.22;
          o.life = 0.5;
          this.pools.spawn("add", o);
        }
        break;
      }
    }
  }

  /** Get-or-create a zone set piece (vortex/comet) keyed by zone id. */
  private zonePiece(
    id: string,
    make: () => { obj: THREE.Object3D; ownMat: THREE.Material | null },
  ): ZonePiece {
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
  zoneEmber(x: number, y: number, color: number): void {
    const o = sp(
      x + (Math.random() - 0.5) * 0.5,
      0.9 + Math.random() * 0.6,
      y + (Math.random() - 0.5) * 0.5,
    );
    o.vy = 1.6;
    o.color = color;
    o.size = 0.24;
    o.life = 0.4;
    this.pools.spawn("add", o);
  }

  /** Pass-through to the telegraph residue decals (scorch/frost/smoke stains). */
  spawnResidue(x: number, y: number, r: number, color: number, life: number): void {
    this.telegraphs.spawnResidue(x, y, r, color, life);
  }

  /** Schedule `run` after `sec` seconds of real time (fx-owned delay queue). */
  delay(sec: number, run: () => void): void {
    this.delayed.push({ at: this.clock + sec, run });
  }

  // ── world-view helper packets (respawn / landing juice) ──

  /** Respawn beam + converge + ring at a hero's revive point. */
  respawnBurst(x: number, y: number, color: number, isLocal: boolean): void {
    this.beam(x, y, color, 10, 1.1);
    this.implode(x, y, color, 2.5, 12, 0.3);
    this.delay(0.15, () => this.shockwave(x, y, color, 2.5));
    if (isLocal) this.view.addTrauma(0.1);
  }

  /** Landing puffs + thud for the generic hop. */
  landJuice(x: number, y: number): void {
    this.footDust(x, y, 1, 0);
    this.footDust(x, y, -0.5, 0.87);
    this.footDust(x, y, -0.5, -0.87);
    this.audio.land();
  }

  /** Per-champ basic-attack whoosh (delegates to the audio timbre table). */
  attackSound(champId: string, x: number, y: number): void {
    this.audio.attack(champId, x, y);
  }

  // ── particle spawners (public signatures preserved from the mesh-pool era) ──

  /** Omnidirectional energy burst (fire/magic) — additive. */
  burst(
    x: number,
    y: number,
    z: number,
    n: number,
    color: number,
    speed: number,
    life: number,
  ): void {
    for (let i = 0; i < n; i++) {
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
      this.pools.spawn("add", o);
    }
  }

  /** Directional hit sparks — a cone along (dx,dz), stretched, additive. */
  sparks(x: number, y: number, z: number, dx: number, dz: number, n: number, color: number): void {
    const base = Math.atan2(dz, dx);
    for (let i = 0; i < n; i++) {
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
      this.pools.spawn("add", o);
    }
  }

  /** Rising smoke — NORMAL blend, outlives the fire. (x,z) in sim coords. */
  smoke(x: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
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
      this.pools.spawn("normal", o);
    }
  }

  /** Low ground dust kicked behind the feet on a run (kx,kz = back-kick dir). */
  footDust(x: number, z: number, kx: number, kz: number): void {
    const l = Math.hypot(kx, kz) || 1;
    for (let i = 0; i < 2; i++) {
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
      this.pools.spawn("normal", o);
    }
  }

  /** Small NORMAL-blend dust pops at ground level (cleave linger, landings). */
  dust(x: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
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
  trail(x: number, y: number, color: number): void {
    const o = sp(x, 1.1, y);
    o.life = 0.22;
    o.size = 0.45;
    o.color = color;
    this.pools.spawn("add", o);
  }

  /** Trail puff at an explicit height (coin arcs, aerial paths). */
  trailAt(x: number, h: number, y: number, color: number, size = 0.4): void {
    const o = sp(x, h, y);
    o.life = 0.25;
    o.size = size;
    o.color = color;
    this.pools.spawn("add", o);
  }

  /** A single rising additive mote (delivery helix, ult-ready gold flecks). */
  mote(
    x: number,
    h: number,
    y: number,
    color: number,
    vy: number,
    life: number,
    size: number,
  ): void {
    const o = sp(x, h, y);
    o.vy = vy;
    o.life = life;
    o.size = size;
    o.color = color;
    this.pools.spawn("add", o);
  }

  /** NORMAL-blend smoke puff at an explicit height (fireball tracer). */
  smokePuff(x: number, h: number, y: number): void {
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
    this.pools.spawn("normal", o);
  }

  /** Quick additive flash — pops big then fades. `bright` >1 blooms. */
  flash(x: number, y: number, z: number, color: number, size: number, bright = 1): void {
    const o = sp(x, y, z);
    o.life = 0.12;
    o.size = size;
    o.color = color;
    o.bright = bright > 1 ? HDR_BRIGHT : 1;
    this.pools.spawn("add", o);
  }

  fountain(x: number, y: number, n: number, color: number): void {
    for (let i = 0; i < n; i++) {
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
  ): void {
    const base = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
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
  implode(x: number, y: number, color: number, r: number, n: number, life = 0.28): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const o = sp(x + Math.cos(a) * r, 0.6 + Math.random() * 1.0, y + Math.sin(a) * r);
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
  ): void {
    const f = this.flares.find((e) => e.life <= 0);
    if (!f) return;
    f.life = f.maxLife = life;
    f.s0 = size;
    f.grow = tex === "impact-burst" ? 1.5 : 1.15;
    f.mat.map = fxTex(tex);
    f.mat.color.setHex(color);
    f.mat.rotation = spin;
    f.mat.opacity = 1;
    f.sprite.position.set(x, y, z);
    f.sprite.scale.setScalar(size * 0.6);
    f.sprite.visible = true;
  }

  private stepFlares(dt: number): void {
    for (const f of this.flares) {
      if (f.life <= 0) continue;
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

  // ── Textured one-shots (licensed-pack spell kits) ───────────────────────────
  // Transient composed actors: authored sprites/decals/bolts/shells from
  // public/fx/, each a short-lived object with its own tick. Capped — a spam
  // of casts drops the extras, never the frame rate.
  private texActors: {
    obj: THREE.Object3D;
    mats: THREE.Material[];
    life: number;
    maxLife: number;
    tick: (k: number) => void;
  }[] = [];
  private texQuad = new THREE.PlaneGeometry(1, 1);
  private texSphere = new THREE.SphereGeometry(1, 20, 12);

  private texActor(
    obj: THREE.Object3D,
    mats: THREE.Material[],
    life: number,
    tick: (k: number) => void,
  ): void {
    if (this.texActors.length >= 40) {
      for (const m of mats) m.dispose();
      return;
    }
    this.scene.add(obj);
    this.texActors.push({ obj, mats, life, maxLife: life, tick });
  }

  private stepTexActors(dt: number): void {
    for (let i = this.texActors.length - 1; i >= 0; i--) {
      const a = this.texActors[i]!;
      a.life -= dt;
      if (a.life <= 0) {
        this.scene.remove(a.obj);
        for (const m of a.mats) m.dispose();
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
  ): void {
    const {
      size = 3,
      color = 0xffffff,
      life = 1.2,
      spinRate = 0,
      grow = 1,
      additive = true,
      fade = "out",
      y = 0.07,
    } = opts;
    const mat = new THREE.MeshBasicMaterial({
      map: fxTex(tex),
      color,
      transparent: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const m = new THREE.Mesh(this.texQuad, mat);
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = Math.random() * Math.PI * 2;
    m.position.set(x, terrainHeight(x, z) + y, z); // `y` is a lift above local ground
    m.scale.setScalar(size);
    this.texActor(m, [mat], life, (k) => {
      m.rotation.z += spinRate * 0.016;
      m.scale.setScalar(size * (1 + (grow - 1) * k));
      mat.opacity = fade === "inout" ? Math.sin(Math.min(1, k * 1.05) * Math.PI) : 1 - k * k;
    });
  }

  /** Vertical crossed-plane bolt (lightning columns). */
  texBolt(
    tex: string,
    x: number,
    z: number,
    opts: { h?: number; w?: number; color?: number; life?: number } = {},
  ): void {
    const { h = 9, w = 2.2, color = 0xffffff, life = 0.32 } = opts;
    const group = new THREE.Group();
    const mats: THREE.Material[] = [];
    for (const ry of [0, Math.PI / 2]) {
      const mat = new THREE.MeshBasicMaterial({
        map: fxTex(tex),
        color,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(this.texQuad, mat);
      m.scale.set(w, h, 1);
      m.position.y = h / 2;
      m.rotation.y = ry;
      group.add(m);
      mats.push(mat);
    }
    group.position.set(x, terrainHeight(x, z), z);
    this.texActor(group, mats, life, (k) => {
      const o = (Math.random() < 0.5 ? 1 : 0.5) * (1 - k);
      for (const mt of mats) if (mt instanceof THREE.MeshBasicMaterial) mt.opacity = o;
    });
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
  ): void {
    const { size = 2, color = 0xffffff, life = 0.6, rise = 0 } = opts;
    const map = fxTex(tex).clone();
    map.repeat.set(1 / cols, 1 / rows);
    const mat = new THREE.SpriteMaterial({
      map,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
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
  ): void {
    const { r = 1.9, color = 0xffffff, life = 1.6, repeat = [3, 2], scrollY = 0 } = opts;
    const map = fxTex(tex).clone();
    map.wrapS = map.wrapT = THREE.RepeatWrapping;
    map.repeat.set(repeat[0], repeat[1]);
    const mat = new THREE.MeshBasicMaterial({
      map,
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
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
  ): void {
    const { size = 3, color = 0xffffff, life = 0.8, grow = 1.15, spin = 0 } = opts;
    const mat = new THREE.SpriteMaterial({
      map: fxTex(tex),
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      rotation: Math.random() * spin,
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
  ): void {
    const { w = 1.2, len = 5, color = 0xffffff, life = 0.45 } = opts;
    const mat = new THREE.MeshBasicMaterial({
      map: fxTex(tex),
      color,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
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
  crossGlint(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    color: number,
    s = 0.9,
  ): void {
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
  debris(x: number, y: number, n: number, color: number): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
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

  /** Frost-nova shards: stretched ice flying up and out. */
  private iceShards(x: number, y: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const o = sp(x + Math.cos(a) * 0.6, 0.5, y + Math.sin(a) * 0.6);
      o.vx = Math.cos(a) * 2;
      o.vz = Math.sin(a) * 2;
      o.vy = 3;
      o.gravity = -4;
      o.life = 0.5 + Math.random() * 0.2;
      o.size = 0.35;
      o.stretch = true;
      o.color = 0x9fe8ff;
      this.pools.spawn("add", o);
    }
  }

  /** Rising bog bubbles (witch brew / hex). */
  private bubbles(x: number, y: number, n: number, color: number, r = 1.2): void {
    for (let i = 0; i < n; i++) {
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

  // ── pooled transient meshes ──

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
  ): void {
    const r = this.rings.find((e) => e.life <= 0);
    if (!r) return; // saturated — drop (scale-of-importance budget)
    r.life = r.maxLife = life;
    r.maxR = maxR;
    r.opacity = opacity;
    const u = r.mat.uniforms;
    (u["uColor"]!.value as THREE.Color).setHex(color);
    u["uT"]!.value = 0;
    u["uAlpha"]!.value = opacity;
    u["uSeed"]!.value = Math.random() * 20;
    r.mesh.position.set(x, terrainHeight(x, y) + 0.12 + lift, y);
    r.mesh.scale.setScalar(0.2);
    r.mesh.visible = true;
  }

  /** Quick small impact ring at a hit point (snappier than a full shockwave). */
  impactRing(x: number, y: number, color: number, maxR: number): void {
    this.shockwave(x, y, color, maxR, 0.2, 0.95);
  }

  private stepRings(dt: number): void {
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      const cubicOut = 1 - Math.pow(1 - t, 3);
      r.mesh.scale.setScalar(0.2 + cubicOut * r.maxR);
      r.mat.uniforms["uT"]!.value = t; // shader handles rim fade + breakup
    }
  }

  /** A rising vertical light pillar (level-up / respawn / signature payoff). */
  beam(x: number, y: number, color: number, h = BEAM_H, r = 1): void {
    const b = this.beams.find((e) => e.life <= 0);
    if (!b) return;
    b.life = b.maxLife = 0.5;
    b.h = h;
    b.r = r;
    b.mat.color.setHex(color).multiplyScalar(1.5);
    b.mat.opacity = 0.8;
    b.mesh.position.set(x, terrainHeight(x, y) + (h / BEAM_H) * 3.2, y);
    b.mesh.scale.set(r, h / BEAM_H, r);
    b.mesh.visible = true;
  }

  private stepBeams(dt: number): void {
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.life -= dt;
      if (b.life <= 0) {
        b.mesh.visible = false;
        continue;
      }
      const t = b.life / b.maxLife;
      const g = 1 + (1 - t) * 0.6; // grows ~1.6× while it fades
      b.mesh.scale.set(b.r * g, (b.h / BEAM_H) * (1 + (1 - t) * 0.5), b.r * g);
      b.mat.opacity = 0.8 * t;
    }
  }

  private coneGeo(half: number): THREE.CircleGeometry {
    const key = Math.round(half * 100);
    let geo = this.coneGeoCache.get(key);
    if (!geo) {
      geo = new THREE.CircleGeometry(1, 28, -half, half * 2); // unit fan, scaled per use
      this.coneGeoCache.set(key, geo);
    }
    return geo;
  }

  private rimGeo(half: number): THREE.RingGeometry {
    const key = Math.round(half * 100);
    let geo = this.rimGeoCache.get(key);
    if (!geo) {
      geo = new THREE.RingGeometry(0.955, 1, 24, 1, -half, half * 2); // unit sector rim
      this.rimGeoCache.set(key, geo);
    }
    return geo;
  }

  private acquireCone(): ConeDecal | null {
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
  ): void {
    const c = this.acquireCone();
    if (!c) return;
    c.mesh.geometry = this.coneGeo(half);
    c.mat.blending = THREE.NormalBlending;
    c.mat.color.setHex(color);
    c.life = c.maxLife = 0.26;
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
  ): void {
    const c = this.acquireCone();
    if (!c) return;
    c.mesh.geometry = this.rimGeo(half);
    c.mat.blending = THREE.AdditiveBlending;
    c.mat.color.setHex(color).multiplyScalar(1.6);
    c.life = c.maxLife = 0.22;
    c.opacity = 0.9;
    c.grow = reach;
    c.s0 = reach;
    c.pivot.position.set(x, terrainHeight(x, y) + 0.15, y);
    c.pivot.rotation.set(0, Math.atan2(-dy, dx), 0);
    c.pivot.rotateX(-Math.PI / 2);
    c.pivot.scale.setScalar(reach);
    c.pivot.visible = true;
  }

  private stepCones(dt: number): void {
    for (const c of this.cones) {
      if (c.life <= 0) continue;
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
  ): void {
    const s = this.slashes.find((e) => e.life <= 0);
    if (!s) return;
    const { tilt = 0.5, span = 1.05, life = 0.26, height = 1.15, dir = 1, tex = "white" } = opts;
    const reg = SLASH_SPRITES[tex];
    s.life = s.maxLife = life;
    const u = s.mat.uniforms;
    (u["uColor"]!.value as THREE.Color).setHex(color);
    u["uT"]!.value = 0;
    u["uSpan"]!.value = span;
    u["uSeed"]!.value = Math.random() * 20;
    u["uDir"]!.value = dir;
    u["uMap"]!.value = fxTex(reg.tex, tex === "wind" ? { srgb: true } : {});
    (u["uUVOff"]!.value as THREE.Vector2).set(reg.off[0], reg.off[1]);
    (u["uUVScale"]!.value as THREE.Vector2).set(reg.scale[0], reg.scale[1]);
    u["uRot"]!.value = reg.rot;
    // pivot yaw points the quad's local +X along the sim facing; the mesh then
    // tilts around that axis so the crescent leans toward the chase camera
    s.pivot.position.set(x, terrainHeight(x, y) + height, y); // `height` is above local ground
    s.pivot.rotation.set(0, -facing, 0);
    s.mesh.rotation.set(-Math.PI / 2 + tilt, 0, 0);
    s.pivot.scale.setScalar(reach);
    s.pivot.visible = true;
  }

  private stepSlashes(dt: number): void {
    for (const s of this.slashes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.pivot.visible = false;
        continue;
      }
      s.mat.uniforms["uT"]!.value = 1 - s.life / s.maxLife;
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
  ): void {
    const c = this.cracks.find((e) => e.life <= 0);
    if (!c) return;
    c.life = c.maxLife = life;
    const u = c.mat.uniforms;
    (u["uColor"]!.value as THREE.Color).setHex(color);
    u["uT"]!.value = 0;
    u["uSeed"]!.value = Math.random() * 40;
    u["uPulse"]!.value = pulse;
    c.mesh.position.set(x, terrainHeight(x, y) + 0.09, y);
    c.mesh.rotation.z = -ang; // plane lies flat (X −90°); −ang maps local +x onto the sim aim
    c.mesh.scale.set(len, wid, 1);
    c.mesh.visible = true;
  }

  private stepCracks(dt: number): void {
    for (const c of this.cracks) {
      if (c.life <= 0) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.mesh.visible = false;
        continue;
      }
      c.mat.uniforms["uT"]!.value = 1 - c.life / c.maxLife;
    }
  }

  /** A fading body-shaped ghost at (x,y) — dash afterimages. (ADD pool fades
   *  by color, so the ghost is dimmed via its tint, not alpha.) */
  private ghostTint = new THREE.Color();
  ghost(x: number, y: number, color: number): void {
    this.ghostTint.setHex(color).multiplyScalar(0.4);
    for (const [h, size] of [
      [1.15, 1.5],
      [0.45, 1.0],
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
  drips(x: number, y: number, n: number, color: number): void {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const o = sp(
        x + (Math.random() - 0.5) * 0.8,
        1.0 + Math.random() * 0.4,
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
  castDome(x: number, y: number, color: number, r: number, life = 0.4): void {
    const d = this.domes.find((e) => e.life <= 0);
    if (d) {
      d.life = d.maxLife = life;
      d.opacity = 0.8;
      d.r = r;
      d.mat.color.setHex(color);
      d.mat.opacity = 0.8;
      d.mesh.position.set(x, terrainHeight(x, y) + 0.1, y);
      d.mesh.scale.setScalar(r);
      d.mesh.visible = true;
    }
    this.shockwave(x, y, color, r, life * 0.7, 0.7); // ground ring anchors it
  }

  private stepDomes(dt: number): void {
    for (const d of this.domes) {
      if (d.life <= 0) continue;
      d.life -= dt;
      if (d.life <= 0) {
        d.mesh.visible = false;
        continue;
      }
      const t = d.life / d.maxLife;
      d.mesh.scale.setScalar(d.r * (1 + (1 - t) * 0.08)); // slight grow as it pops
      d.mat.opacity = d.opacity * t;
    }
  }

  // ── floating numbers (ownership hierarchy: yours are the loud ones) ──

  /** Route a hit to the right number tier. The hierarchy is the point: your hits
   *  shout, hits on you warn, and everyone else's chip damage stays out of the
   *  way — a screen where every number is loud has no numbers at all. */
  private hitNumber(
    x: number,
    y: number,
    amount: number,
    dx: number,
    dy: number,
    heavy: boolean,
    by: string,
  ): void {
    const mine = by !== "" && by === this.localId;
    if (mine) {
      this.numbers.bumpCombo(this.nowMs); // only YOUR hits build the combo
      this.numbers.spawn(`${amount}`, x, y, heavy ? "crit" : "mine", this.nowMs, dx, dy);
      return;
    }
    const onMe = (x - this.lx) ** 2 + (y - this.ly) ** 2 < 1.44;
    if (onMe) {
      this.numbers.spawn(`${amount}`, x, y, "incoming", this.nowMs, dx, dy);
      return;
    }
    if (amount < 50) return; // bystander chip damage: culled — kill the number wall
    this.numbers.spawn(`${amount}`, x, y, "bystander", this.nowMs, dx, dy);
  }

  dispose(): void {
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
    this.spikes.dispose();
    for (const [, p] of this.zonePieces) {
      this.scene.remove(p.obj);
      p.ownMat?.dispose();
    }
    this.zonePieces.clear();
    for (const g of this.coneGeoCache.values()) g.dispose();
    for (const g of this.rimGeoCache.values()) g.dispose();
    this.ringPlane.dispose();
    this.vortexGeo.dispose();
    this.cometGeo.dispose();
  }
}
