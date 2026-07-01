// Particle FX, trauma screen-shake, and floating damage numbers. Drains the
// World's one-shot fx events each frame and steps a pooled particle system.
// HUD-bound events (kill feed, notifications) are queued for the HUD to read.
import * as THREE from "three";
import type { FxEvent, World } from "../sim/types";
import { Audio } from "./audio";
import type { View } from "./view";

type Particle = {
  mesh: THREE.Mesh;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  s0: number;
  gravity: number;
  stretch: boolean; // elongate along velocity (energy/sparks)
  drag: number; // velocity decay per second
};

type Ring = { mesh: THREE.Mesh; life: number; maxLife: number; maxR: number; opacity: number };
// a short-lived flat/volumetric mesh that fades (+ optional grow): cast cones, domes
type Decal = { obj: THREE.Object3D; mat: THREE.MeshBasicMaterial; geo: THREE.BufferGeometry; life: number; maxLife: number; opacity: number; grow: number; s0: number };

const POOL = 320;

export class Fx {
  private pool: Particle[] = [];
  private active: Particle[] = [];
  private free: Particle[] = [];
  private ringGeo: THREE.RingGeometry;
  private rings: Ring[] = [];
  private decals: Decal[] = [];
  private beams: { mesh: THREE.Mesh; life: number; maxLife: number }[] = [];
  private dmgLayer: HTMLDivElement;
  private audio = new Audio();
  // queued for the HUD
  readonly feed: { killerName: string; victimName: string; leader?: boolean }[] = [];
  readonly toasts: { text: string; kind: string }[] = [];
  localId = ""; // set by the scene — punches the camera on YOUR hits only

  constructor(
    private scene: THREE.Scene,
    private view: View,
  ) {
    const geo = new THREE.SphereGeometry(0.16, 8, 8);
    for (let i = 0; i < POOL; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.visible = false;
      scene.add(mesh);
      const p: Particle = { mesh, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1, s0: 1, gravity: 0, stretch: false, drag: 0 };
      this.pool.push(p);
      this.free.push(p);
    }
    this.ringGeo = new THREE.RingGeometry(0.78, 1, 40);

    this.dmgLayer = document.createElement("div");
    this.dmgLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:6;overflow:hidden;";
    document.body.appendChild(this.dmgLayer);
  }

  update(w: World, dt: number): void {
    for (const e of w.fx) this.handle(e);
    w.fx.length = 0;
    this.stepParticles(dt);
    this.stepRings(dt);
    this.stepBeams(dt);
    this.stepDecals(dt);
    this.freeze = Math.max(0, this.freeze - dt); // tick down on REAL dt
  }

  /** A rising vertical light pillar (level-up / signature payoff). */
  private beam(x: number, y: number, color: number): void {
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.5), transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, opacity: 0.8 });
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 7, 18, 1, true), mat);
    mesh.position.set(x, 3.2, y);
    this.scene.add(mesh);
    this.beams.push({ mesh, life: 0.5, maxLife: 0.5 });
  }

  private stepBeams(dt: number): void {
    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i]!;
      b.life -= dt;
      if (b.life <= 0) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        this.beams.splice(i, 1);
        continue;
      }
      const t = b.life / b.maxLife;
      b.mesh.scale.set(1 + (1 - t) * 0.6, 1 + (1 - t) * 0.5, 1 + (1 - t) * 0.6);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 0.8 * t;
    }
  }

  // ── render-only hit-stop (impact weight; never touches the sim) ──
  private freeze = 0;
  /** Briefly slow the visual layer (crit/death/meteor) so impacts land. */
  private bumpFreeze(ms: number): void {
    this.freeze = Math.max(this.freeze, ms / 1000);
  }
  /** Visual-time multiplier the scene applies to anim/camera lerps this frame. */
  scaleNow(): number {
    return this.freeze > 0 ? 0.06 : 1;
  }

  private handle(e: FxEvent): void {
    switch (e.t) {
      case "hit": {
        // white-hot core flash + impact ring pop + directional spark cone
        const color = e.dtype === "magic" ? 0xc070ff : e.dtype === "pure" ? 0xffffff : 0xffd06a;
        const crit = e.crit ?? false;
        this.flash(e.x, 1.1, e.y, 0xffffff, crit ? 1.5 : 1.05, 2.2);
        this.impactRing(e.x, e.y, color, crit ? 2.1 : 1.5);
        this.sparks(e.x, 1.1, e.y, e.dx, e.dy, crit ? 20 : 11, color);
        this.burst(e.x, 1.1, e.y, crit ? 7 : 4, color, 5, 0.16); // radial spit
        if (crit) {
          this.impactRing(e.x, e.y, 0xffd24a, 2.8); // gold crit ring
          this.bumpFreeze(55);
          this.audio.crit();
        }
        this.view.addTrauma(crit ? 0.18 : 0.07);
        // directional camera punch — only when YOU land the blow (game feel)
        if (e.by !== "" && e.by === this.localId) this.view.kick(e.dx, e.dy, crit ? 0.6 : 0.34);
        this.audio.hit();
        break;
      }
      case "swing": {
        // ranged muzzle flash + forward spark jet (melee swings are now a
        // render-side weapon trail, see render/weapon-trail.ts)
        const c = e.dtype === "magic" ? 0xc070ff : 0xffe6a0;
        this.flash(e.x, 1.1, e.y, c, 0.85);
        this.sparks(e.x, 1.1, e.y, Math.cos(e.ang), Math.sin(e.ang), 7, c);
        break;
      }
      case "damage":
        this.damageNumber(e.x, e.y, Math.round(e.amount), e.dtype, e.crit ?? false);
        break;
      case "explosion": {
        // layered: white flash → fire burst → shockwave ring → smoke (outlives)
        const color =
          e.kind === "frost" ? 0x7fd4ff : e.kind === "meteor" ? 0xff5a2c : e.kind === "trap" ? 0x9affc0 : e.kind === "execute" ? 0xff3060 : 0xffa030;
        const big = e.kind === "meteor";
        this.flash(e.x, 0.9, e.y, 0xffffff, big ? 2.4 : 1.5, 2.4);
        this.burst(e.x, 0.8, e.y, big ? 26 : 16, color, big ? 9 : 7, 0.5);
        this.shockwave(e.x, e.y, color, e.radius);
        if (e.kind === "frost") this.fountain(e.x, e.y, 10, 0x9fe8ff); // icy shards up
        else this.smoke(e.x, e.y, big ? 8 : 5);
        this.view.addTrauma(big ? 0.5 : 0.22);
        if (big) this.bumpFreeze(70);
        this.audio.explosion();
        break;
      }
      case "death":
        this.flash(e.x, 1.0, e.y, 0xffffff, 1.2, 2.0);
        this.burst(e.x, 1.0, e.y, 16, 0x99a0b5, 6, 0.6);
        this.smoke(e.x, e.y, 4);
        this.view.addTrauma(0.16);
        this.bumpFreeze(50);
        this.audio.death();
        break;
      case "cast":
        this.signatureCast(`${e.champId}:${e.key}`, e.x, e.y, e.dx, e.dy);
        this.audio.cast();
        break;
      case "levelup":
        this.fountain(e.x, e.y, 16, 0xffd24a);
        this.shockwave(e.x, e.y, 0xffd24a, 3);
        this.beam(e.x, e.y, 0xffd24a); // rising gold light pillar
        this.audio.levelup();
        break;
      case "heal":
        this.fountain(e.x, e.y, 10, 0x6bff8e);
        this.damageNumber(e.x, e.y, Math.round(e.amount), "heal", false);
        break;
      case "blink":
        this.burst(e.x, 1.0, e.y, 8, 0x9a7bff, 5, 0.3);
        this.burst(e.tx, 1.0, e.ty, 10, 0x9a7bff, 5, 0.35);
        break;
      case "coinThrow":
        this.flash(e.x, 3.0, e.y, 0xffd24a, 1.1);
        this.burst(e.x, 3.0, e.y, 8, 0xffd24a, 5, 0.35);
        break;
      case "coinGrab":
        this.fountain(e.x, e.y, 14, 0xffd24a);
        this.damageNumber(e.x, e.y, e.gold, "gold", false);
        this.view.addTrauma(0.12);
        this.audio.coin();
        break;
      case "kill":
        this.feed.push({ killerName: e.killerName, victimName: e.victimName, leader: e.leader });
        if (e.leader) this.audio.alert();
        break;
      case "notify":
        if (e.kind === "matchend") {
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

  // ── particle spawners ──
  private take(blend: THREE.Blending = THREE.AdditiveBlending): Particle | null {
    const p = this.free.pop();
    if (!p) return null;
    this.active.push(p);
    p.mesh.visible = true;
    p.stretch = false;
    p.drag = 0;
    const m = p.mesh.material as THREE.MeshBasicMaterial;
    m.blending = blend;
    return p;
  }

  /** Omnidirectional energy burst (fire/magic) — additive. */
  private burst(x: number, y: number, z: number, n: number, color: number, speed: number, life: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.take();
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.8 + 0.2;
      const sp = speed * (0.5 + Math.random());
      p.vx = Math.cos(a) * sp;
      p.vz = Math.sin(a) * sp;
      p.vy = up * sp * 0.6;
      p.gravity = -10;
      p.life = p.maxLife = life * (0.7 + Math.random() * 0.6);
      p.s0 = 0.5 + Math.random() * 0.7;
      p.stretch = true;
      p.mesh.position.set(x, y, z);
      (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
  }

  /** Directional hit sparks — a cone along (dx,dz), stretched, additive. */
  private sparks(x: number, y: number, z: number, dx: number, dz: number, n: number, color: number): void {
    const base = Math.atan2(dz, dx);
    for (let i = 0; i < n; i++) {
      const p = this.take();
      if (!p) return;
      const a = base + (Math.random() - 0.5) * 1.1;
      const sp = 4 + Math.random() * 6;
      p.vx = Math.cos(a) * sp;
      p.vz = Math.sin(a) * sp;
      p.vy = Math.random() * 3 + 0.5;
      p.gravity = -14;
      p.drag = 3;
      p.life = p.maxLife = 0.16 + Math.random() * 0.14;
      p.s0 = 0.35 + Math.random() * 0.4;
      p.stretch = true;
      p.mesh.position.set(x, y, z);
      (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
  }

  /** Rising smoke — NORMAL blend, outlives the fire. (x,z) in world coords. */
  private smoke(x: number, z: number, n: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.take(THREE.NormalBlending);
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      p.vx = Math.cos(a) * 1.2;
      p.vz = Math.sin(a) * 1.2;
      p.vy = 1.6 + Math.random() * 1.4;
      p.gravity = 1;
      p.drag = 1.2;
      p.life = p.maxLife = 0.9 + Math.random() * 0.7;
      p.s0 = 1.1 + Math.random() * 0.9;
      p.mesh.position.set(x + (Math.random() - 0.5), 0.6, z + (Math.random() - 0.5));
      const g = 0.18 + Math.random() * 0.1;
      (p.mesh.material as THREE.MeshBasicMaterial).color.setRGB(g, g, g);
    }
  }

  /** Low ground dust kicked behind the feet on a run (kx,kz = back-kick dir). */
  footDust(x: number, z: number, kx: number, kz: number): void {
    const l = Math.hypot(kx, kz) || 1;
    for (let i = 0; i < 2; i++) {
      const p = this.take(THREE.NormalBlending);
      if (!p) return;
      p.vx = (kx / l) * 1.1 + (Math.random() - 0.5);
      p.vz = (kz / l) * 1.1 + (Math.random() - 0.5);
      p.vy = 0.5 + Math.random() * 0.6;
      p.gravity = -1.5;
      p.drag = 2.5;
      p.life = p.maxLife = 0.3 + Math.random() * 0.2;
      p.s0 = 0.35 + Math.random() * 0.25;
      p.mesh.position.set(x + (Math.random() - 0.5) * 0.4, 0.25, z + (Math.random() - 0.5) * 0.4);
      const g = 0.22 + Math.random() * 0.08;
      (p.mesh.material as THREE.MeshBasicMaterial).color.setRGB(g, g * 0.95, g * 0.85);
    }
  }

  /** A single fading additive puff — projectiles call this each frame for a trail. */
  trail(x: number, y: number, color: number): void {
    const p = this.take();
    if (!p) return;
    p.vx = p.vy = p.vz = p.gravity = 0;
    p.life = p.maxLife = 0.22;
    p.s0 = 0.45;
    p.mesh.position.set(x, 1.1, y);
    (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
  }

  // ── directional / aura cast primitives (give each spell a distinct shape) ──

  private decal(obj: THREE.Object3D, mat: THREE.MeshBasicMaterial, geo: THREE.BufferGeometry, life: number, grow: number, opacity: number): void {
    obj.scale.setScalar(grow > 1 ? 0.5 : 1);
    this.scene.add(obj);
    this.decals.push({ obj, mat, geo, life, maxLife: life, opacity, grow, s0: grow > 1 ? 0.5 : 1 });
  }

  private stepDecals(dt: number): void {
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i]!;
      d.life -= dt;
      if (d.life <= 0) {
        this.scene.remove(d.obj);
        d.geo.dispose();
        d.mat.dispose();
        this.decals.splice(i, 1);
        continue;
      }
      const t = d.life / d.maxLife; // 1 → 0
      d.obj.scale.setScalar(d.s0 + (d.grow - d.s0) * (1 - t));
      d.mat.opacity = d.opacity * t;
    }
  }

  /** A flat filled sector fanning out along the aim — cone attacks (bash/cleave).
   *  NORMAL blend so the coloured fan reads crisply on the bright stone floor. */
  private castCone(x: number, y: number, dx: number, dy: number, color: number, reach: number, half: number): void {
    const geo = new THREE.CircleGeometry(reach, 28, -half, half * 2); // fan opens toward local +X
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.NormalBlending, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 });
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.14, y);
    pivot.rotation.y = Math.atan2(-dy, dx); // local +X → aim
    pivot.rotateX(-Math.PI / 2); // lay flat
    const mesh = new THREE.Mesh(geo, mat);
    pivot.add(mesh);
    this.decal(pivot, mat, geo, 0.26, 1.12, 0.85);
  }

  /** A wireframe hemisphere shell that pops around the caster — shields/auras.
   *  Wireframe + NORMAL blend so it reads as a bubble cage without blooming out
   *  to white on the bright floor. Paired with an expanding ground ring below. */
  private castDome(x: number, y: number, color: number, r: number, life = 0.4): void {
    const geo = new THREE.SphereGeometry(r, 14, 7, 0, Math.PI * 2, 0, Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.NormalBlending, wireframe: true, depthWrite: false, opacity: 0.8 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, 0.1, y);
    this.decal(mesh, mat, geo, life, 1.08, 0.8); // slight grow as it pops
    this.shockwave(x, y, color, r, life * 0.7, 0.7); // ground ring anchors it
  }

  /** A jet of stretched particles thrown forward along the aim — dashes/launches. */
  private castStreak(x: number, y: number, dx: number, dy: number, color: number, speed: number, n: number, spread = 0.25): void {
    const base = Math.atan2(dy, dx);
    for (let i = 0; i < n; i++) {
      const p = this.take();
      if (!p) return;
      const a = base + (Math.random() - 0.5) * spread;
      const sp = speed * (0.7 + Math.random() * 0.6);
      p.vx = Math.cos(a) * sp;
      p.vz = Math.sin(a) * sp;
      p.vy = (Math.random() - 0.3) * 1.4;
      p.gravity = -3;
      p.drag = 2.2;
      p.life = p.maxLife = 0.22 + Math.random() * 0.18;
      p.s0 = 0.5 + Math.random() * 0.5;
      p.stretch = true;
      p.mesh.position.set(x + Math.cos(a) * 0.6, 1.15, y + Math.sin(a) * 0.6);
      (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
  }

  /** Per-ability signature cast (replaces the generic blue puff). Keyed on
   *  `${champId}:${key}` so each spell reads distinctly by SHAPE + MOTION, not
   *  just colour — cones fan forward, dashes streak, buffs dome, ults go big.
   *  (dx,dy) is the normalized aim from the cast event. */
  private signatureCast(tag: string, x: number, y: number, dx: number, dy: number): void {
    switch (tag) {
      // KNIGHT — steel white/blue. cone bash / charge streak / shield dome / spin rings
      case "knight:Q": this.castCone(x, y, dx, dy, 0x8fd0ff, 3.2, 0.62); this.sparks(x + dx, 1.2, y + dy, dx, dy, 10, 0xeaf2ff); break;
      case "knight:W": this.castStreak(x, y, dx, dy, 0x9fd0ff, 16, 14, 0.18); this.footDust(x, y, -dx, -dy); this.flash(x, 1.1, y, 0xbfe0ff, 1.0, 1.6); break;
      case "knight:E": this.castDome(x, y, 0x9fd0ff, 2.2); this.sparks(x, 0.4, y, 0, 1, 8, 0xeaf2ff); break;
      case "knight:R": this.shockwave(x, y, 0xeaf2ff, 4); this.shockwave(x, y, 0xbfe0ff, 5.5, 0.5); this.burst(x, 1.2, y, 16, 0xbfe0ff, 8, 0.4); this.view.addTrauma(0.14); break;
      // RANGER — teal / gold arrows. arrow fan / dodge blur / trap set / arrow volley up
      case "ranger:Q": this.castStreak(x, y, dx, dy, 0xffe6a0, 20, 16, 0.5); this.flash(x + dx, 1.3, y + dy, 0xffffff, 0.9, 1.6); break;
      case "ranger:W": this.castStreak(x, y, dx, dy, 0x9fffe0, 12, 8, 0.1); this.smoke(x, y, 3); this.impactRing(x, y, 0x66ffcc, 1.6); break;
      case "ranger:E": this.castCone(x, y, dx, dy, 0x9affc0, 2.0, 0.5); this.sparks(x, 0.4, y, dx, dy, 6, 0x66ffcc); break;
      case "ranger:R": this.beam(x, y, 0xffe6a0); this.fountain(x, y, 16, 0xffe6a0); this.flash(x, 4.5, y, 0xffe6a0, 2.0, 1.6); break;
      // MAGE — fire / frost / arcane. fire launch / frost gather / arcane implode / meteor summon
      case "mage:Q": this.castStreak(x, y, dx, dy, 0xffa030, 14, 12, 0.22); this.flash(x + dx, 1.3, y + dy, 0xffd060, 1.2, 2.0); break;
      case "mage:W": this.castDome(x, y, 0x7fd4ff, 1.8, 0.34); this.fountain(x, y, 12, 0x9fe8ff); break;
      case "mage:E": this.burst(x, 1.0, y, 12, 0x9a7bff, 8, 0.3); this.impactRing(x, y, 0xb090ff, 2.2); this.flash(x, 1.2, y, 0xc0a0ff, 0.9, 1.8); break;
      case "mage:R": this.beam(x, y, 0xff5a2c); this.flash(x, 4.0, y, 0xff8040, 2.0, 2.2); this.castStreak(x, y, 0, 1, 0xff5a2c, 3, 8, 1.2); break;
      // ROGUE — shadow / poison / blood. poison lunge / shadow dash / smoke veil / crimson strike
      case "rogue:Q": this.castStreak(x, y, dx, dy, 0x7fff8e, 14, 12, 0.2); this.smoke(x, y, 2); break;
      case "rogue:W": this.castStreak(x, y, dx, dy, 0x9a7bff, 16, 12, 0.16); this.smoke(x, y, 5); break;
      case "rogue:E": this.smoke(x, y, 10); this.castDome(x, y, 0x6a5a9a, 2.4, 0.5); break;
      case "rogue:R": this.castStreak(x, y, dx, dy, 0xff3060, 22, 14, 0.14); this.flash(x + dx * 2, 1.2, y + dy * 2, 0xff5070, 1.3, 2.0); this.bumpFreeze(35); break;
      // BARBARIAN — earth / blood. wide cleave / leap takeoff / blood aura / rage
      case "barbarian:Q": this.castCone(x, y, dx, dy, 0xd8985a, 3.4, 0.96); this.smoke(x, y, 3); break;
      case "barbarian:W": this.fountain(x, y, 14, 0x9a7050); this.shockwave(x, y, 0xc08040, 2.6, 0.3); this.footDust(x, y, dx, dy); break;
      case "barbarian:E": this.castDome(x, y, 0xff6a4a, 2.0, 0.45); this.fountain(x, y, 8, 0xffaa44); break;
      case "barbarian:R": this.castDome(x, y, 0xff4422, 2.6, 0.5); this.shockwave(x, y, 0xff5a2c, 3.5); this.burst(x, 1.2, y, 16, 0xff4422, 8, 0.4); this.bumpFreeze(50); this.view.addTrauma(0.16); break;
      // NECROMANCER — bone / decay / soul. bone spear / curse gather / decay drip / soul vortex
      case "necromancer:Q": this.castStreak(x, y, dx, dy, 0xcfd8e0, 16, 10, 0.1); this.sparks(x + dx, 1.2, y + dy, dx, dy, 6, 0xeef2f6); break;
      case "necromancer:W": this.castDome(x, y, 0x9a7bff, 1.6, 0.34); this.burst(x, 1.4, y, 8, 0x9a7bff, 5, 0.3); break;
      case "necromancer:E": this.fountain(x, y, 10, 0x7affa0); this.smoke(x, y, 4); break;
      case "necromancer:R": this.castDome(x, y, 0x7affa0, 2.8, 0.5); this.shockwave(x, y, 0x7affa0, 3.5); this.fountain(x, y, 14, 0xaeffd0); break;
      default: this.flash(x, 1.3, y, 0x9fd0ff, 0.9); this.burst(x, 1.2, y, 6, 0x9fd0ff, 3, 0.3);
    }
  }

  /** Quick additive flash — pops big then fades. `bright` >1 pushes the core
   *  into HDR so it blooms (use for impact/explosion cores, not soft puffs). */
  private flash(x: number, y: number, z: number, color: number, size: number, bright = 1): void {
    const p = this.take();
    if (!p) return;
    p.vx = p.vy = p.vz = p.gravity = 0;
    p.life = p.maxLife = 0.12;
    p.s0 = size;
    p.mesh.position.set(x, y, z);
    (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color).multiplyScalar(bright);
  }

  /** Expanding ground shockwave ring — additive, Cubic-out. */
  private shockwave(x: number, y: number, color: number, maxR: number, life = 0.38, opacity = 0.85): void {
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, opacity });
    const mesh = new THREE.Mesh(this.ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.12, y);
    mesh.scale.setScalar(0.2);
    this.scene.add(mesh);
    this.rings.push({ mesh, life, maxLife: life, maxR, opacity });
  }

  /** Quick small impact ring at a hit point (snappier than a full shockwave). */
  private impactRing(x: number, y: number, color: number, maxR: number): void {
    this.shockwave(x, y, color, maxR, 0.2, 0.95);
  }

  private stepRings(dt: number): void {
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!;
      r.life -= dt;
      if (r.life <= 0) {
        this.scene.remove(r.mesh);
        (r.mesh.material as THREE.Material).dispose();
        this.rings.splice(i, 1);
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      const cubicOut = 1 - Math.pow(1 - t, 3);
      r.mesh.scale.setScalar(0.2 + cubicOut * r.maxR);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = r.opacity * (1 - t);
    }
  }

  fountain(x: number, y: number, n: number, color: number): void {
    for (let i = 0; i < n; i++) {
      const p = this.take();
      if (!p) return;
      const a = Math.random() * Math.PI * 2;
      p.vx = Math.cos(a) * 1.4;
      p.vz = Math.sin(a) * 1.4;
      p.vy = 4 + Math.random() * 3;
      p.gravity = -6;
      p.life = p.maxLife = 0.7 + Math.random() * 0.4;
      p.s0 = 0.5 + Math.random() * 0.5;
      p.mesh.position.set(x, 0.5, y);
      (p.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    }
  }

  private stepParticles(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.life -= dt;
      if (p.life <= 0) {
        p.mesh.visible = false;
        this.active.splice(i, 1);
        this.free.push(p);
        continue;
      }
      p.vy += p.gravity * dt;
      if (p.drag > 0) {
        const d = Math.max(0, 1 - p.drag * dt);
        p.vx *= d;
        p.vy *= d;
        p.vz *= d;
      }
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      const t = p.life / p.maxLife;
      const s = Math.max(0.01, p.s0 * t);
      if (p.stretch) {
        const speed = Math.hypot(p.vx, p.vy, p.vz);
        const elong = 1 + Math.min(3, speed * 0.16);
        p.mesh.scale.set(s, s, s * elong);
        p.mesh.lookAt(p.mesh.position.x + p.vx, p.mesh.position.y + p.vy, p.mesh.position.z + p.vz);
      } else {
        p.mesh.scale.setScalar(s);
      }
      (p.mesh.material as THREE.MeshBasicMaterial).opacity = t;
    }
  }

  // ── floating numbers ──
  private damageNumber(x: number, y: number, amount: number, kind: string, crit: boolean): void {
    const s = this.view.worldToScreen(x, y);
    if (!s.visible) return;
    const el = document.createElement("div");
    const color =
      kind === "magic" ? "#c98bff" : kind === "heal" ? "#6bff8e" : kind === "gold" ? "#ffd24a" : crit ? "#ff5a52" : "#fff2d0";
    const prefix = kind === "heal" || kind === "gold" ? "+" : "";
    el.textContent = `${prefix}${amount}`;
    const jitter = (Math.random() - 0.5) * 26;
    const weight = crit ? 900 : 800;
    const size = crit ? 28 : kind === "gold" ? 20 : 16;
    const ls = crit ? "letter-spacing:-1px;" : "";
    el.style.cssText = `position:absolute;left:${s.x + jitter}px;top:${s.y - 18}px;transform:translate(-50%,-50%) scale(${crit ? 1.5 : 1});color:${color};font:${weight} ${size}px ui-monospace,monospace;${ls}text-shadow:0 2px 3px #000;will-change:transform,opacity;transition:transform .7s ease-out,opacity .7s ease-out;`;
    this.dmgLayer.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = "translate(-50%,-50%) scale(1) translateY(-46px)";
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 720);
  }

  dispose(): void {
    this.dmgLayer.remove();
  }
}
