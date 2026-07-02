// Combat FX orchestrator: drains the World's one-shot fx events each frame,
// spawns everything transient (particles via the 2-draw-call instanced pools,
// rings/beams/cones/domes via pre-built mesh pools), owns the shader ground
// telegraphs, the two-stage hit-stop clock, trauma/kick/FOV-punch routing, and
// the floating damage numbers. HUD-bound events (kill feed, toasts) are queued
// for the HUD to read.
import * as THREE from "three";
import type { FxEvent, GroundEffect, World } from "../sim/types";
import { Audio } from "./audio";
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
  barbarian: { primary: 0xff8a3c, secondary: 0xd8985a, accent: 0xff4422 }, // rage-orange / earth / blood
  necromancer: { primary: 0x7affb0, secondary: 0xcfd8e0, accent: 0x9a7bff }, // soul-green / bone-white / curse-violet
  paladin: { primary: 0xffd76a, secondary: 0xfff2c0, accent: 0xffe6a0 }, // gold / white-gold / dawn
  blackknight: { primary: 0x8a4a5f, secondary: 0xc03050, accent: 0x6a5a6f }, // dead-purple / crimson / smoke
  vampire: { primary: 0xd6304a, secondary: 0xff5a52, accent: 0xff8090 }, // blood / scarlet / pale-red
  witch: { primary: 0x7fe08a, secondary: 0xb98ae0, accent: 0x4a7a3a }, // bog-green / hex-violet / moss
};

// ── mesh-pool sizing (transient draw-call budget: 16+4+8+4 = 32 worst case) ──
const RING_POOL = 16;
const BEAM_POOL = 4;
const CONE_POOL = 8; // flat sector fans + sector rims share this pool
const DOME_POOL = 4;
const BEAM_H = 7; // unit beam height the pool geometry is built at

type Ring = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; maxR: number; opacity: number };
type Beam = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; h: number; r: number };
type ConeDecal = { pivot: THREE.Group; mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; opacity: number; grow: number; s0: number };
type Dome = { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number; maxLife: number; opacity: number; r: number };
type Delayed = { at: number; run: () => void };
type ZoneAnim = { next: number; next2: number; phase: number; seenAt: number };

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
  private rings: Ring[] = [];
  private beams: Beam[] = [];
  private cones: ConeDecal[] = [];
  private domes: Dome[] = [];
  private coneGeoCache = new Map<number, THREE.CircleGeometry>();
  private rimGeoCache = new Map<number, THREE.RingGeometry>();
  private ringGeo: THREE.RingGeometry;
  private delayed: Delayed[] = [];
  private clock = 0; // accumulated REAL seconds (drives the delay queue)
  private nowMs = 0; // last-seen sim clock (w.now)
  private dmgLayer: HTMLDivElement;
  readonly audio = new Audio(); // HUD + game-scene trigger UI sounds through this
  private zoneAnim = new Map<string, ZoneAnim>();
  private zoneSweepAt = 0;
  // queued for the HUD
  readonly feed: { killerName: string; victimName: string; leader?: boolean; killer: string; victim: string }[] = [];
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
  // necromancer R soul-return window (hits within 150ms stream back to caster)
  private necroR: { x: number; y: number; at: number } | null = null;

  constructor(
    private scene: THREE.Scene,
    private view: View,
  ) {
    this.pools = new ParticlePools(scene);
    this.telegraphs = new Telegraphs(scene);
    this.ringGeo = new THREE.RingGeometry(0.78, 1, 40);

    for (let i = 0; i < RING_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      scene.add(mesh);
      this.rings.push({ mesh, mat, life: 0, maxLife: 1, maxR: 1, opacity: 1 });
    }
    const beamGeo = new THREE.CylinderGeometry(0.55, 0.9, BEAM_H, 12, 1, true);
    for (let i = 0; i < BEAM_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false });
      const mesh = new THREE.Mesh(beamGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.beams.push({ mesh, mat, life: 0, maxLife: 1, h: BEAM_H, r: 1 });
    }
    for (let i = 0; i < CONE_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.NormalBlending, side: THREE.DoubleSide, depthWrite: false });
      const pivot = new THREE.Group();
      const mesh = new THREE.Mesh(this.coneGeo(0.61), mat);
      pivot.add(mesh);
      pivot.visible = false;
      scene.add(pivot);
      this.cones.push({ pivot, mesh, mat, life: 0, maxLife: 1, opacity: 1, grow: 1, s0: 1 });
    }
    const domeGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    for (let i = 0; i < DOME_POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.NormalBlending, wireframe: true, depthWrite: false });
      const mesh = new THREE.Mesh(domeGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      this.domes.push({ mesh, mat, life: 0, maxLife: 1, opacity: 1, r: 1 });
    }

    this.dmgLayer = document.createElement("div");
    this.dmgLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:6;overflow:hidden;";
    document.body.appendChild(this.dmgLayer);
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
      let ms = this.hitsThisFrame >= 3 ? 85 : this.hitsThisFrame === 2 ? 65 : this.localMelee ? 40 : 25;
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

    // visuals advance on the freeze-scaled clock so impacts genuinely hang
    const vdt = dt * this.scaleNow();
    this.pools.update(vdt);
    this.stepRings(vdt);
    this.stepBeams(vdt);
    this.stepCones(vdt);
    this.stepDomes(vdt);
    this.telegraphs.update(w.now);

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
        // de-escalated basics so abilities outrank them; heavies keep the works
        this.flash(e.x, 1.1, e.y, 0xffffff, heavy ? 1.5 : 0.9, 2.2);
        this.impactRing(e.x, e.y, color, heavy ? 2.1 : 1.3);
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
        // necromancer R soul return: hits inside the window stream to the caster
        if (this.necroR && this.clock - this.necroR.at < 0.15) this.soulStreak(e.x, e.y, this.necroR.x, this.necroR.y);
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
      case "damage":
        this.hitNumber(e.x, e.y, Math.round(e.amount), e.dtype, e.crit ?? false, e.by);
        break;
      case "explosion": {
        const color =
          e.kind === "frost" ? 0x7fd4ff
          : e.kind === "meteor" ? 0xff5a2c
          : e.kind === "trap" ? 0x9affc0
          : e.kind === "execute" ? 0xff3060
          : e.kind === "sanguine" ? 0xd6304a
          : e.kind === "judgement" ? 0xffd76a
          : e.kind === "soulburst" ? 0x7affb0
          : e.kind === "hex" ? 0x7fe08a
          : 0xffa030;
        const big = e.kind === "meteor";
        this.flash(e.x, 0.9, e.y, 0xffffff, big ? 2.4 : 1.5, 2.4);
        this.burst(e.x, 0.8, e.y, big ? 26 : 16, color, big ? 9 : 7, 0.5);
        this.shockwave(e.x, e.y, color, e.radius);
        if (e.kind === "frost") {
          this.fountain(e.x, e.y, 10, 0x9fe8ff); // icy shards up
          this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.85, 0x7fd4ff, 1.2);
        } else if (e.kind === "hex") {
          // hex burst + spore ring: violet implosion, green spore puffs
          this.implode(e.x, e.y, 0xb98ae0, e.radius, 10, 0.24);
          this.shockwave(e.x, e.y, 0x7fe08a, e.radius, 0.5, 0.7);
          this.debris(e.x, e.y, 5, 0x4a7a3a);
        } else if (big) {
          // meteor: the full anatomy — flash → blast → pillar → debris → scorch
          this.beam(e.x, e.y, 0xff8040, 9, 1.2);
          this.debris(e.x, e.y, 6, 0x804030);
          this.smoke(e.x, e.y, 8);
          this.telegraphs.spawnResidue(e.x, e.y, e.radius * 0.8, 0x1a0f0a, 4);
        } else {
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
        if (e.champId === "necromancer" && e.key === "R") this.necroR = { x: e.x, y: e.y, at: this.clock };
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
        this.spawnNumber(e.x, e.y, `+${Math.round(e.amount)}`, 15, 800, "#6bff8e", 40, 0.6, "");
        break;
      case "blink":
        this.implode(e.x, e.y, 0x9a7bff, 1.6, 8, 0.22); // inward = vanish
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
          this.spawnNumber(e.x, e.y, "PERFECT", 16, 900, "#66ffe0", 44, 0.6, "letter-spacing:1px;");
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
        this.spawnNumber(e.x, e.y, `+${e.gold}`, 19, 900, "#ffd24a", 46, 0.7, "text-shadow:0 0 8px #ffd24a,0 2px 3px #000;");
        this.view.addTrauma(0.12);
        this.audio.coin();
        break;
      case "kill": {
        this.feed.push({ killerName: e.killerName, victimName: e.victimName, leader: e.leader, killer: e.killer, victim: e.victim });
        if (e.victim === this.localOwnerId) this.lastDeath = { killerName: e.killerName, at: this.nowMs };
        if (e.killer !== "" && e.killer === this.localOwnerId) {
          const streak = this.bestStreak; // updated from the synced unit each frame
          if (streak >= 3) this.audio.stinger(streak >= 9 ? 3 : streak >= 7 ? 2 : streak >= 5 ? 1 : 0);
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

  // ── per-ability signature casts (10 champs × QWER, layered A/C/S/L) ──
  private signatureCast(tag: string, x: number, y: number, dx: number, dy: number): void {
    switch (tag) {
      // KNIGHT — heavy steel, white-hot edges
      case "knight:Q": this.sectorRim(x, y, dx, dy, 0xeaf2ff, 3.2, 0.61); this.castCone(x, y, dx, dy, 0x8fd0ff, 3.2, 0.61); this.sparks(x + dx, 1.2, y + dy, dx, dy, 10, 0xeaf2ff); this.dust(x, y, 3); break;
      case "knight:W": this.castStreak(x, y, dx, dy, 0x9fd0ff, 16, 14, 0.18); this.footDust(x, y, -dx, -dy); this.flash(x, 1.1, y, 0xbfe0ff, 1.0, 1.6); break;
      case "knight:E": this.implode(x, y, 0xeaf2ff, 2.2, 8, 0.26); this.castDome(x, y, 0x9fd0ff, 2.2); break;
      case "knight:R": this.implode(x, y, 0xbfe0ff, 3, 12, 0.26); this.shockwave(x, y, 0xeaf2ff, 4); this.shockwave(x, y, 0xbfe0ff, 5.5, 0.5); this.burst(x, 1.2, y, 16, 0xbfe0ff, 8, 0.4); this.view.addTrauma(0.14); break;
      // RANGER — verdant precision, gold arrows
      case "ranger:Q": this.crossGlint(x + dx * 0.6, 1.3, y + dy * 0.6, dx, dy, 0xffe6a0, 0.9); this.castStreak(x, y, dx, dy, 0xffe6a0, 20, 12, 0.45); this.flash(x + dx, 1.3, y + dy, 0xffffff, 0.9, 1.6); break;
      case "ranger:W": this.castStreak(x, y, dx, dy, 0x9fffe0, 12, 8, 0.1); this.smoke(x, y, 3); this.impactRing(x, y, 0x66ffcc, 1.6); this.footDust(x, y, -dx, -dy); this.footDust(x, y, -dx, -dy); break;
      case "ranger:E": this.flash(x + dx, 0.5, y + dy, 0x9affc0, 0.7); this.sparks(x + dx, 0.9, y + dy, 0, -1, 6, 0x9affc0); break;
      case "ranger:R": this.beam(x, y, 0xffe6a0); this.implode(x, y, 0xffe6a0, 3, 10, 0.28); this.flash(x, 4.5, y, 0xffe6a0, 2.0, 1.6); break;
      // MAGE — fire primary, frost/arcane separated
      case "mage:Q": this.castStreak(x, y, dx, dy, 0xffa030, 14, 12, 0.22); this.flash(x + dx, 1.3, y + dy, 0xffd060, 1.2, 2.0); break;
      case "mage:W": this.castDome(x, y, 0x7fd4ff, 1.8, 0.34); this.iceShards(x, y, 10); this.telegraphs.spawnResidue(x, y, 3.2, 0x7fd4ff, 1.2); break;
      case "mage:E": this.implode(x, y, 0x9a7bff, 1.8, 8, 0.22); this.flash(x, 1.2, y, 0xc0a0ff, 0.9, 1.8); break;
      case "mage:R": this.beam(x, y, 0xff5a2c); this.flash(x, 4.0, y, 0xff8040, 2.0, 2.2); this.castStreak(x, y, 0, 1, 0xff5a2c, 3, 8, 1.2); break;
      // ROGUE — crimson violence out of violet shadow
      case "rogue:Q": this.castStreak(x, y, dx, dy, 0x7fff8e, 14, 12, 0.2); this.smoke(x, y, 2); break;
      case "rogue:W": this.castStreak(x, y, dx, dy, 0x9a7bff, 16, 12, 0.16); this.smoke(x, y, 5); break;
      case "rogue:E": this.smoke(x, y, 10); this.castDome(x, y, 0x6a5a9a, 2.4, 0.5); this.telegraphs.spawnResidue(x, y, 2.4, 0x201830, 2); break;
      case "rogue:R": this.castStreak(x, y, dx, dy, 0xff3060, 22, 14, 0.14); this.flash(x + dx * 2, 1.2, y + dy * 2, 0xff5070, 1.3, 2.0); this.crossGlint(x + dx * 2, 1.2, y + dy * 2, dx, dy, 0xff3060, 1.6); this.impactRing(x + dx * 2, y + dy * 2, 0xff3060, 2.4); this.debris(x + dx * 2, y + dy * 2, 4, 0x801020); if (this.within(x, y, 10)) this.bumpFreeze(35); break;
      // BARBARIAN — earth and blood, widest shapes
      case "barbarian:Q": this.sectorRim(x, y, dx, dy, 0xffb060, 3.4, 0.96); this.castCone(x, y, dx, dy, 0xd8985a, 3.4, 0.96); this.sparks(x + dx, 1.1, y + dy, dx, dy, 8, 0xffb060); this.dust(x, y, 4); break;
      case "barbarian:W": this.fountain(x, y, 14, 0x9a7050); this.shockwave(x, y, 0xc08040, 2.6, 0.3); this.footDust(x, y, dx, dy); break;
      case "barbarian:E": this.castDome(x, y, 0xff6a4a, 2.0, 0.45); this.fountain(x, y, 8, 0xffaa44); break;
      case "barbarian:R": this.implode(x, y, 0xff4422, 3, 14, 0.26); this.castDome(x, y, 0xff4422, 2.6, 0.5); this.shockwave(x, y, 0xff5a2c, 3.5); this.shockwave(x, y, 0xff8a3c, 4, 0.5); this.burst(x, 1.2, y, 16, 0xff4422, 8, 0.4); if (this.within(x, y, 10)) this.bumpFreeze(50); this.view.addTrauma(0.16); break;
      // NECROMANCER — souls flow, bone pierces
      case "necromancer:Q": this.castStreak(x, y, dx, dy, 0xcfd8e0, 16, 10, 0.1); this.sparks(x + dx, 1.2, y + dy, dx, dy, 6, 0xeef2f6); break;
      case "necromancer:W": this.castDome(x, y, 0x9a7bff, 1.6, 0.34); this.fallingWisps(x, y, 8, 0x9a7bff); break;
      case "necromancer:E": this.fountain(x, y, 10, 0x7affa0); this.smoke(x, y, 4); break;
      case "necromancer:R": this.implode(x, y, 0x7affa0, 5, 16, 0.3); this.castDome(x, y, 0x7affa0, 2.8, 0.5); this.shockwave(x, y, 0x7affa0, 3.5); this.fountain(x, y, 14, 0xaeffd0); break;
      // PALADIN — gold and white, holy verticals
      case "paladin:Q": this.sectorRim(x, y, dx, dy, 0xfff2c0, 3.4, 0.65); this.castCone(x, y, dx, dy, 0xffd76a, 3.4, 0.65); this.sparks(x + dx, 1.2, y + dy, dx, dy, 10, 0xfff2c0); break;
      case "paladin:W": this.shockwave(x, y, 0xffd76a, 3.6, 0.5); this.castDome(x, y, 0xffe6a0, 3.4, 0.5); break;
      case "paladin:E": this.castDome(x, y, 0xfff2c0, 2.2); this.fountain(x, y, 8, 0xffd76a); break;
      case "paladin:R": this.implode(x, y, 0xfff2c0, 4, 12, 0.26); this.beam(x, y, 0xffd76a); this.shockwave(x, y, 0xfff2c0, 5.5); this.flash(x, 3.5, y, 0xffe6a0, 2.0, 2.0); this.view.addTrauma(0.14); break;
      // BLACK KNIGHT — dead purple, crimson edge, smoke
      case "blackknight:Q": this.sectorRim(x, y, dx, dy, 0xc03050, 3.8, 0.96); this.castCone(x, y, dx, dy, 0x8a4a5f, 3.8, 0.96); this.smoke(x, y, 3); break;
      case "blackknight:W": this.castStreak(x, y, dx, dy, 0x8a4a5f, 14, 12, 0.2); this.footDust(x, y, -dx, -dy); break;
      case "blackknight:E": this.castDome(x, y, 0x6a5a6f, 2.4, 0.5); this.sparks(x, 0.4, y, 0, 1, 8, 0xc0a0b0); break;
      case "blackknight:R": this.implode(x, y, 0xc03050, 4, 12, 0.24); this.shockwave(x, y, 0xc03050, 5.5); this.shockwave(x, y, 0x8a4a5f, 4, 0.5); this.burst(x, 1.2, y, 20, 0xc03050, 9, 0.4); this.smoke(x, y, 6); this.debris(x, y, 5, 0x3a2a34); if (this.within(x, y, 10)) this.bumpFreeze(60); this.view.addTrauma(0.18); break;
      // VAMPIRE — blood reds, drinking motion
      case "vampire:Q": this.castCone(x, y, dx, dy, 0xd6304a, 3.2, 0.78); this.sparks(x + dx, 1.2, y + dy, dx, dy, 8, 0xff8090); break;
      case "vampire:W": this.castStreak(x, y, dx, dy, 0xd6304a, 18, 12, 0.14); this.smoke(x, y, 4); break;
      case "vampire:E": this.impactRing(x, y, 0xff5a52, 2.0); this.fountain(x, y, 8, 0xd6304a); break;
      case "vampire:R": this.castDome(x, y, 0xd6304a, 2.8, 0.5); this.shockwave(x, y, 0xff5a52, 5.5); this.fountain(x, y, 14, 0xd6304a); if (this.within(x, y, 10)) this.bumpFreeze(40); break;
      // WITCH — bog-green hexcraft
      case "witch:Q": this.castStreak(x, y, dx, dy, 0x7fe08a, 16, 10, 0.12); this.crossGlint(x + dx * 0.6, 1.3, y + dy * 0.6, dx, dy, 0x7fe08a, 0.8); this.flash(x + dx, 1.3, y + dy, 0xb0ffb8, 0.9, 1.6); break;
      case "witch:W": this.castDome(x, y, 0x7fe08a, 1.8, 0.35); this.bubbles(x, y, 6, 0x7fe08a); break;
      case "witch:E": this.castStreak(x, y, dx, dy, 0xb98ae0, 20, 12, 0.14); this.footDust(x, y, -dx, -dy); this.smoke(x, y, 2); break;
      case "witch:R": this.implode(x, y, 0xb98ae0, 3, 12, 0.26); this.castDome(x, y, 0x7fe08a, 2.4, 0.45); this.shockwave(x, y, 0x7fe08a, 4); this.bubbles(x, y, 8, 0x9fefa8); break;
      default: this.flash(x, 1.3, y, 0x9fd0ff, 0.9); this.burst(x, 1.2, y, 6, 0x9fd0ff, 3, 0.3);
    }
  }

  // ── zone ambience (called per live GroundEffect from world-view) ──
  zoneAmbient(g: GroundEffect, now: number): void {
    let st = this.zoneAnim.get(g.id);
    if (!st) {
      st = { next: 0, next2: 0, phase: Math.random() * 6, seenAt: now };
      this.zoneAnim.set(g.id, st);
    }
    st.seenAt = now;
    const r = g.radius;
    switch (g.effect) {
      case "whirlwind": {
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
      case "consecrate": {
        if (now < st.next) return;
        st.next = now + 300;
        for (let i = 0; i < 3; i++) {
          const a = Math.random() * Math.PI * 2;
          const rr = Math.sqrt(Math.random()) * r;
          const o = sp(g.x + Math.cos(a) * rr, 0.25, g.y + Math.sin(a) * rr);
          o.vy = 1.8;
          o.color = 0xffe6a0;
          o.size = 0.22;
          o.life = 0.6;
          this.pools.spawn("add", o);
        }
        break;
      }
      case "brew": {
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

  /** One ember on a unit standing in a hostile zone (silent-tick ambience). */
  zoneEmber(x: number, y: number, color: number): void {
    const o = sp(x + (Math.random() - 0.5) * 0.5, 0.9 + Math.random() * 0.6, y + (Math.random() - 0.5) * 0.5);
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

  // ── world-view helper packets (respawn / dodge / landing juice) ──

  /** Respawn beam + converge + ring at a hero's revive point. */
  respawnBurst(x: number, y: number, color: number, isLocal: boolean): void {
    this.beam(x, y, color, 10, 1.1);
    this.implode(x, y, color, 2.5, 12, 0.3);
    this.delay(0.15, () => this.shockwave(x, y, color, 2.5));
    if (isLocal) this.view.addTrauma(0.1);
  }

  /** Dodge-roll juice: back-kicked dust + speed-lines + the dodge whoosh. */
  dodgeJuice(x: number, y: number, dvx: number, dvy: number): void {
    const l = Math.hypot(dvx, dvy) || 1;
    const dx = dvx / l;
    const dy = dvy / l;
    this.footDust(x, y, -dx, -dy);
    this.footDust(x, y, -dx, -dy);
    this.castStreak(x, y, -dx, -dy, 0xcfe8ff, 10, 8, 0.15);
    this.audio.dodge();
  }

  /** Landing puffs + thud for the generic hop. */
  landJuice(x: number, y: number): void {
    this.footDust(x, y, 1, 0);
    this.footDust(x, y, -0.5, 0.87);
    this.footDust(x, y, -0.5, -0.87);
    this.audio.land();
  }

  /** Heavy leap landing (barbarian W): ring + dust + radial sparks + trauma. */
  landingThump(x: number, y: number): void {
    this.impactRing(x, y, 0xc08040, 2.8);
    this.dust(x, y, 6);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      this.sparks(x, 0.4, y, Math.cos(a), Math.sin(a), 1, 0xffb060);
    }
    this.view.addTrauma(0.1 * this.att(x, y));
  }

  /** Per-champ basic-attack whoosh (delegates to the audio timbre table). */
  attackSound(champId: string, x: number, y: number): void {
    this.audio.attack(champId, x, y);
  }

  // ── particle spawners (public signatures preserved from the mesh-pool era) ──

  /** Omnidirectional energy burst (fire/magic) — additive. */
  burst(x: number, y: number, z: number, n: number, color: number, speed: number, life: number): void {
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
  mote(x: number, h: number, y: number, color: number, vy: number, life: number, size: number): void {
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
  castStreak(x: number, y: number, dx: number, dy: number, color: number, speed: number, n: number, spread = 0.25): void {
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

  /** Two stretched glints perpendicular to the aim — a muzzle-flash star. */
  crossGlint(x: number, y: number, z: number, dx: number, dy: number, color: number, s = 0.9): void {
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

  /** Falling wisps (curse) — falling = negative, free information. */
  private fallingWisps(x: number, y: number, n: number, color: number): void {
    for (let i = 0; i < n; i++) {
      const o = sp(x + (Math.random() - 0.5) * 2.4, 2.5, y + (Math.random() - 0.5) * 2.4);
      o.vy = -2;
      o.life = 0.6 + Math.random() * 0.3;
      o.size = 0.3;
      o.color = color;
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

  /** Soul streak: one stretched particle flying from a hit victim to a point. */
  private soulStreak(x: number, y: number, tx: number, ty: number): void {
    const dx = tx - x;
    const dy = ty - y;
    const d = Math.hypot(dx, dy) || 1;
    const o = sp(x, 1.2, y);
    o.vx = (dx / d) * 14;
    o.vz = (dy / d) * 14;
    o.life = Math.min(0.6, d / 14);
    o.size = 0.4;
    o.stretch = true;
    o.color = 0x7affb0;
    this.pools.spawn("add", o);
  }

  // ── pooled transient meshes ──

  /** Expanding ground shockwave ring — additive, cubic-out, pooled. */
  shockwave(x: number, y: number, color: number, maxR: number, life = 0.38, opacity = 0.85): void {
    const r = this.rings.find((e) => e.life <= 0);
    if (!r) return; // saturated — drop (scale-of-importance budget)
    r.life = r.maxLife = life;
    r.maxR = maxR;
    r.opacity = opacity;
    r.mat.color.setHex(color);
    r.mat.opacity = opacity;
    r.mesh.position.set(x, 0.12, y);
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
      r.mat.opacity = r.opacity * (1 - t);
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
    b.mesh.position.set(x, (h / BEAM_H) * 3.2, y);
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
  castCone(x: number, y: number, dx: number, dy: number, color: number, reach: number, half: number): void {
    const c = this.acquireCone();
    if (!c) return;
    c.mesh.geometry = this.coneGeo(half);
    c.mat.blending = THREE.NormalBlending;
    c.mat.color.setHex(color);
    c.life = c.maxLife = 0.26;
    c.opacity = 0.85;
    c.grow = reach * 1.12;
    c.s0 = reach * 0.5;
    c.pivot.position.set(x, 0.14, y);
    c.pivot.rotation.set(0, Math.atan2(-dy, dx), 0);
    c.pivot.rotateX(-Math.PI / 2);
    c.pivot.scale.setScalar(c.s0);
    c.pivot.visible = true;
  }

  /** A bright additive rim marking the exact reach edge of a cleave sector. */
  sectorRim(x: number, y: number, dx: number, dy: number, color: number, reach: number, half: number): void {
    const c = this.acquireCone();
    if (!c) return;
    c.mesh.geometry = this.rimGeo(half);
    c.mat.blending = THREE.AdditiveBlending;
    c.mat.color.setHex(color).multiplyScalar(1.6);
    c.life = c.maxLife = 0.22;
    c.opacity = 0.9;
    c.grow = reach;
    c.s0 = reach;
    c.pivot.position.set(x, 0.15, y);
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

  /** A wireframe hemisphere shell that pops around the caster — shields/buffs. */
  castDome(x: number, y: number, color: number, r: number, life = 0.4): void {
    const d = this.domes.find((e) => e.life <= 0);
    if (d) {
      d.life = d.maxLife = life;
      d.opacity = 0.8;
      d.r = r;
      d.mat.color.setHex(color);
      d.mat.opacity = 0.8;
      d.mesh.position.set(x, 0.1, y);
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

  private hitNumber(x: number, y: number, amount: number, dtype: string, heavy: boolean, by: string): void {
    const mine = by !== "" && by === this.localId;
    if (mine && heavy) {
      const size = Math.min(30, 27 + amount / 150);
      this.spawnNumber(x, y, `${amount}`, size, 900, "#ff7a3c", 30, 0.55, "-webkit-text-stroke:1px #401800;", 1.7);
      return;
    }
    if (mine) {
      const size = Math.min(26, 13 + amount / 35);
      this.spawnNumber(x, y, `${amount}`, size, 800, dtype === "magic" ? "#c98bff" : "#fff2d0", 54, 0.6, "");
      return;
    }
    const onMe = (x - this.lx) ** 2 + (y - this.ly) ** 2 < 1.44;
    if (onMe) {
      this.spawnNumber(x, y, `−${amount}`, 15, 800, "#ff6a5e", 40, 0.6, "");
      return;
    }
    if (amount < 50) return; // bystander chip damage: culled — kill the number wall
    this.spawnNumber(x, y, `${amount}`, 11, 700, "#e8e2d4", 34, 0.5, "opacity:0.55;");
  }

  private spawnNumber(x: number, y: number, text: string, size: number, weight: number, color: string, rise: number, dur: number, extra: string, pop = 1): void {
    const s = this.view.worldToScreen(x, y);
    if (!s.visible) return;
    const el = document.createElement("div");
    el.textContent = text;
    const jitter = (Math.random() - 0.5) * 26;
    const drift = pop > 1 ? 0 : jitter * 0.4;
    el.style.cssText =
      `position:absolute;left:${s.x + jitter}px;top:${s.y - 18}px;` +
      `transform:translate(-50%,-50%) scale(${pop});` +
      `color:${color};font:${weight} ${Math.round(size)}px ui-monospace,monospace;` +
      `text-shadow:0 2px 3px #000;${extra}will-change:transform,opacity;` +
      `transition:transform ${dur}s cubic-bezier(.17,.84,.44,1),opacity ${dur}s ease-out;`;
    this.dmgLayer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = `translate(-50%,-50%) scale(1) translate(${drift}px,-${rise}px)`;
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), dur * 1000 + 80);
  }

  dispose(): void {
    this.dmgLayer.remove();
    this.pools.dispose();
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
    for (const g of this.coneGeoCache.values()) g.dispose();
    for (const g of this.rimGeoCache.values()) g.dispose();
    this.ringGeo.dispose();
  }
}
