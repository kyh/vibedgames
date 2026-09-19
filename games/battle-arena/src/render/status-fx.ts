// Per-unit 3D status indicators — one StatusFx per UnitView, driven each frame
// from the unit's synced `statuses` list. Budget: ≤ 2 extra draw calls per
// afflicted unit (overhead sprite / root ring / shield dome+rim; every particle
// rides the shared ParticlePools = 0 extra calls).
//
// Integration contract (Wave 2, world-view.ts):
//  - construct lazily on first status with the UnitView's PER-INSTANCE cloned
//    materials (body + weapons — weapon mats must be cloned too or empowerNext
//    glow bleeds across units sharing a weapon model);
//  - call update(u, dt, now) AFTER UnitView writes its per-frame emissive
//    hit-flash (the tints here ADD on top of that write);
//  - remove UnitView's own stealth-opacity block (StatusFx owns opacity now).
import * as THREE from "three";
import type { DamageType } from "../data/config";
import type { Status } from "../sim/types";
import { makeRuneMaterial } from "./fx-shaders";
import type { ParticlePools, SpawnOptions } from "./fx-particles";

/** Narrow view of a UnitView that StatusFx needs (constructor param). */
export interface StatusFxTarget {
  /** Unit root — feet origin, follows the smoothed render position. */
  group: THREE.Object3D;
  /** Per-instance cloned body materials (tint/opacity/emissive writes). */
  bodyMats: THREE.MeshStandardMaterial[];
  /** Per-instance cloned weapon materials (empowerNext glow). */
  weaponMats: THREE.MeshStandardMaterial[];
  /** Champion accent color (CHAMP_FX accent) — empowerNext weapon glow. */
  accent: number;
  /** True for the local player's own unit (stealth reads honest-but-faint for enemies). */
  isLocal: boolean;
}

/** Narrow view of the synced Unit fields StatusFx reads. Unit satisfies this. */
export interface StatusFxUnit {
  alive: boolean;
  statuses: Status[];
  empowerNext: number;
  vx: number;
  vy: number;
  moveSpeed: number;
}

// ── shared assets (module-level, built once) ────────────────────────────────

const drawIcon = (kind: "star" | "chain" | "mute"): THREE.CanvasTexture => {
  const c = document.createElement("canvas");
  c.width = 96;
  c.height = 96;
  const g = c.getContext("2d");
  if (!g) {
    return new THREE.CanvasTexture(c);
  }
  g.strokeStyle = "#ffffff";
  g.fillStyle = "#ffffff";
  g.lineWidth = 7;
  g.lineJoin = "round";
  g.lineCap = "round";
  g.beginPath();
  if (kind === "star") {
    // 5-point star
    for (let i = 0; i < 10; i += 1) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5;
      const r = i % 2 === 0 ? 42 : 18;
      const x = 48 + Math.cos(a) * r;
      const y = 48 + Math.sin(a) * r;
      if (i === 0) {
        g.moveTo(x, y);
      } else {
        g.lineTo(x, y);
      }
    }
    g.closePath();
    g.fill();
  } else if (kind === "chain") {
    // two interlocked links
    g.ellipse(34, 48, 16, 24, -0.5, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.ellipse(62, 48, 16, 24, 0.5, 0, Math.PI * 2);
    g.stroke();
  } else {
    // mute: speaker wedge + slash
    g.moveTo(24, 38);
    g.lineTo(40, 38);
    g.lineTo(58, 22);
    g.lineTo(58, 74);
    g.lineTo(40, 58);
    g.lineTo(24, 58);
    g.closePath();
    g.fill();
    g.beginPath();
    g.moveTo(20, 76);
    g.lineTo(76, 20);
    g.stroke();
  }
  return new THREE.CanvasTexture(c);
};

interface IconMats {
  star: THREE.SpriteMaterial;
  mute: THREE.SpriteMaterial;
  chain: THREE.SpriteMaterial;
}
let iconMats: IconMats | null = null;
const icons = (): IconMats => {
  if (iconMats) {
    return iconMats;
  }
  iconMats = {
    chain: new THREE.SpriteMaterial({
      color: 0xc8_b8_9a,
      depthWrite: false,
      map: drawIcon("chain"),
      transparent: true,
    }),
    mute: new THREE.SpriteMaterial({
      color: 0xdb_e4_ff,
      depthWrite: false,
      map: drawIcon("mute"),
      transparent: true,
    }),
    star: new THREE.SpriteMaterial({
      color: 0xff_d2_4a,
      depthWrite: false,
      map: drawIcon("star"),
      transparent: true,
    }),
  };
  return iconMats;
};

// shared geometries (materials stay per-instance — their opacity animates)
let rootRingGeo: THREE.RingGeometry | null = null;
let domeGeo: THREE.SphereGeometry | null = null;
let domeRimGeo: THREE.RingGeometry | null = null;
let runeGeo: THREE.PlaneGeometry | null = null;
const sharedRuneGeo = (): THREE.PlaneGeometry => {
  runeGeo ??= new THREE.PlaneGeometry(2, 2);
  return runeGeo;
};
const sharedRootRingGeo = (): THREE.RingGeometry => {
  rootRingGeo ??= new THREE.RingGeometry(0.7, 0.9, 28);
  return rootRingGeo;
};
const sharedDomeGeo = (): THREE.SphereGeometry => {
  domeGeo ??= new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  return domeGeo;
};
const sharedDomeRimGeo = (): THREE.RingGeometry => {
  domeRimGeo ??= new THREE.RingGeometry(0.98, 1.1, 32);
  return domeRimGeo;
};

const ICE = new THREE.Color(0x7f_d4_ff);
/** How hard a slow ices the body. 0.25 was invisible in a fight — a debuff you
 *  can't see on the character is a debuff the player learns nothing from. */
const SLOW_TINT_LERP = 0.55;
// shield bubble radius (world units)
const DOME_R = 1.1;
const scratchOpts: SpawnOptions = { life: 0.4, size: 0.3, x: 0, y: 0, z: 0 };

/** The moment a debuff LANDS is the frame the player is actually looking at, so
 *  each kind announces itself with a one-shot burst in its own colour. Steady-state
 *  tells you it's still on; the burst tells you it just happened. */
const ONSET = new Map<string, { color: number; n: number; speed: number; size: number }>(
  Object.entries({
    damageAmp: { color: 0x9a_7b_ff, n: 12, size: 0.28, speed: 2.8 },
    dot: { color: 0xff_7a_2c, n: 12, size: 0.28, speed: 2.6 },
    hex: { color: 0xd0_7b_ff, n: 16, size: 0.3, speed: 3.2 },
    root: { color: 0x9a_d4_6a, n: 12, size: 0.28, speed: 2.6 },
    silence: { color: 0xdb_e4_ff, n: 10, size: 0.26, speed: 2.6 },
    slow: { color: 0x9f_e8_ff, n: 18, size: 0.3, speed: 3 },
    stun: { color: 0xff_d2_4a, n: 14, size: 0.3, speed: 3.4 },
    taunt: { color: 0xff_5a_3c, n: 12, size: 0.28, speed: 2.8 },
  } satisfies Record<string, { color: number; n: number; speed: number; size: number }>),
);

export class StatusFx {
  // lazily-built indicator objects
  private overhead: THREE.Sprite | null = null;
  private overheadKind: "star" | "chain" | "mute" | "" = "";
  private rootRing: THREE.Mesh | null = null;
  private rootMat: THREE.MeshBasicMaterial | null = null;
  private dome: THREE.Mesh | null = null;
  private domeMat: THREE.MeshBasicMaterial | null = null;
  private domeRim: THREE.Mesh | null = null;
  private domeRimMat: THREE.MeshBasicMaterial | null = null;
  // buff rune circle (Iron Stance / Bastion / Hunter's Focus) — rotating
  // underfoot arcane ring for the buff's whole duration
  private rune: THREE.Mesh | null = null;
  private runeMat: THREE.ShaderMaterial | null = null;
  private runeAlpha = 0;
  // material-write bookkeeping (apply/restore on transitions only)
  private readonly baseColors: THREE.Color[] = [];
  private readonly accentColor: THREE.Color;
  private slowApplied = false;
  private stealthApplied = false;
  // shield lifecycle (scale-in 120ms / fade-out 150ms)
  private shieldOn = false;
  private shieldShownAt = 0;
  private shieldEndAt = 0;
  // emission throttles (ms clocks)
  private nextSlowEmit = 0;
  private nextDotEmit = 0;
  private nextHealEmit = 0;
  private nextHasteEmit = 0;
  private nextAmpEmit = 0;
  private nextEnrageEmit = 0;
  // per-frame status flags (rewritten by scan(); no allocations)
  private fStun = false;
  private fSilence = false;
  private fRoot = false;
  private fSlow = false;
  private fHeal = false;
  private fShield = false;
  private fStealth = false;
  private fHaste = false;
  private fAmp = false;
  private fAtkSpd = false;
  private fArmor = false;
  private fHex = false;
  private fTaunt = false;
  private fDot: DamageType | "" = "";
  // frost shell: a slow/chill is the one debuff you must read at a glance (it's
  // what decides whether you can disengage), so it gets a body-hugging shell
  private frost: THREE.Mesh | null = null;
  private frostMat: THREE.MeshBasicMaterial | null = null;
  private nextHexEmit = 0;
  /** Which debuff kinds were on LAST frame — the rising edge fires the onset burst. */
  private readonly wasOn = new Set<string>();

  private readonly target: StatusFxTarget;
  private readonly pools: ParticlePools;

  constructor(target: StatusFxTarget, pools: ParticlePools) {
    this.target = target;
    this.pools = pools;
    for (const m of target.bodyMats) {
      this.baseColors.push(m.color.clone());
    }
    this.accentColor = new THREE.Color(target.accent);
  }

  update(u: StatusFxUnit, dt: number, now: number): void {
    if (!u.alive) {
      this.clearWhileDead(now);
      return;
    }

    this.scan(u.statuses);
    const px = this.target.group.position.x;
    // feet (terrain + hop)
    const py = this.target.group.position.y;
    const pz = this.target.group.position.z;

    this.onsets(u.statuses, px, py, pz);

    // ── overhead sprite: one slot, hardest disable wins (stun > root > silence) ──
    this.tickOverhead(now);

    // ── root: brown-green feet ring, gentle 1Hz pulse ──
    this.tickRoot(now);

    // ── slow/chill: iced body + a frost shell + crystals shedding off it ──
    this.setSlow(this.fSlow);
    this.tickFrost(this.fSlow, dt, now);
    this.tickSlow(px, py, pz, now);

    // ── hex (polymorph): the model already swaps; the magic keeping it there
    //    should still be visible on the body ──
    this.tickHex(px, py, pz, now);

    // ── taunt: dragged into someone else's fight — angry red pulse on the body ──
    this.tickTaunt(now);

    // ── dot: torso embers colored by damage type (poison green / burn orange) ──
    this.tickDot(px, py, pz, now);

    // ── HoT: soft rising motes ──
    this.tickHeal(px, py, pz, now);

    // ── shield: translucent half-dome + additive rim, scale-in then fade-out ──
    this.tickShield(now);

    // ── buff rune: rotating arcane circle underfoot for stance/bastion/focus ──
    this.tickRune(dt);

    // ── haste: cyan footdust while actually moving ──
    this.tickHaste(u, px, py, pz, now);

    // ── damageAmp (curse): violet wisps + faint emissive tint ──
    this.tickAmp(px, py, pz, now);

    // ── attackSpeed (enrage): red rim + embers ──
    this.tickEnrage(px, py, pz, now);

    // ── stealth: animated shimmer for you, honest-but-faint for enemies ──
    this.setStealth(this.fStealth, now);

    // ── empowerNext: weapon burns with the champ accent until the hit lands ──
    this.setEmpower(u.empowerNext > 0);
  }

  dispose(): void {
    this.setSlow(false);
    this.setStealth(false, 0);
    this.setEmpower(false);
    const g = this.target.group;
    if (this.overhead) {
      g.remove(this.overhead);
      // shared SpriteMaterial — keep
    }
    if (this.rootRing) {
      g.remove(this.rootRing);
      this.rootMat?.dispose();
    }
    if (this.dome) {
      g.remove(this.dome);
      this.domeMat?.dispose();
    }
    if (this.domeRim) {
      g.remove(this.domeRim);
      this.domeRimMat?.dispose();
    }
    if (this.rune) {
      g.remove(this.rune);
      this.runeMat?.dispose();
    }
    if (this.frost) {
      g.remove(this.frost);
      this.frostMat?.dispose();
    }
    this.frost = null;
    this.frostMat = null;
    this.overhead = null;
    this.rootRing = null;
    this.dome = null;
    this.domeRim = null;
    this.rune = null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private scan(statuses: Status[]): void {
    this.fStun = false;
    this.fSilence = false;
    this.fRoot = false;
    this.fSlow = false;
    this.fHeal = false;
    this.fShield = false;
    this.fStealth = false;
    this.fHaste = false;
    this.fAmp = false;
    this.fAtkSpd = false;
    this.fArmor = false;
    this.fHex = false;
    this.fTaunt = false;
    this.fDot = "";
    for (const s of statuses) {
      switch (s.kind) {
        case "hex": {
          this.fHex = true;
          break;
        }
        case "taunt": {
          this.fTaunt = true;
          break;
        }
        case "stun": {
          this.fStun = true;
          break;
        }
        case "silence": {
          this.fSilence = true;
          break;
        }
        case "root": {
          this.fRoot = true;
          break;
        }
        case "slow": {
          this.fSlow = true;
          break;
        }
        case "dot": {
          this.fDot = s.dtype;
          break;
        }
        case "heal": {
          this.fHeal = true;
          break;
        }
        case "shield": {
          this.fShield = true;
          break;
        }
        case "stealth": {
          this.fStealth = true;
          break;
        }
        case "speed": {
          this.fHaste = true;
          break;
        }
        case "damageAmp": {
          this.fAmp = true;
          break;
        }
        case "attackSpeed": {
          this.fAtkSpd = true;
          break;
        }
        case "armor": {
          this.fArmor = true;
          break;
        }
        default: {
          break;
        }
      }
    }
  }

  private ensureOverhead(): THREE.Sprite {
    if (this.overhead) {
      return this.overhead;
    }
    const sprite = new THREE.Sprite(icons().star);
    sprite.scale.setScalar(0.55);
    sprite.renderOrder = 12;
    this.target.group.add(sprite);
    this.overhead = sprite;
    this.overheadKind = "star";
    return sprite;
  }

  private ensureRootRing(): THREE.Mesh {
    if (this.rootRing) {
      return this.rootRing;
    }
    this.rootMat = new THREE.MeshBasicMaterial({
      color: 0x6a_7a_3a,
      depthWrite: false,
      opacity: 0.5,
      side: THREE.DoubleSide,
      transparent: true,
    });
    const ring = new THREE.Mesh(sharedRootRingGeo(), this.rootMat);
    ring.rotation.x = -Math.PI / 2;
    // 0.12: clears the flagstone tops (+0.05) and camp dirt bumps (up to +0.109)
    // — roots land on camp creeps, which stand on dirt tiles
    ring.position.y = 0.12;
    this.target.group.add(ring);
    this.rootRing = ring;
    return ring;
  }

  private ensureRune(): THREE.Mesh {
    if (this.rune) {
      return this.rune;
    }
    this.runeMat = makeRuneMaterial(0xff_d7_6a);
    const rune = new THREE.Mesh(sharedRuneGeo(), this.runeMat);
    rune.rotation.x = -Math.PI / 2;
    // above the root ring (0.12), clear of tile tops/dirt
    rune.position.y = 0.15;
    rune.scale.setScalar(1.35);
    this.target.group.add(rune);
    this.rune = rune;
    return rune;
  }

  private ensureDome(): void {
    if (this.dome && this.domeRim) {
      return;
    }
    this.domeMat = new THREE.MeshBasicMaterial({
      color: 0x9f_d0_ff,
      depthWrite: false,
      opacity: 0.18,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.dome = new THREE.Mesh(sharedDomeGeo(), this.domeMat);
    this.dome.position.y = 0.05;
    this.target.group.add(this.dome);
    this.domeRimMat = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color: 0x9f_d0_ff,
      depthWrite: false,
      opacity: 0.5,
      side: THREE.DoubleSide,
      transparent: true,
    });
    this.domeRim = new THREE.Mesh(sharedDomeRimGeo(), this.domeRimMat);
    this.domeRim.rotation.x = -Math.PI / 2;
    // clear of tile tops (0.05) and dirt bumps
    this.domeRim.position.y = 0.12;
    this.target.group.add(this.domeRim);
  }

  private clearWhileDead(now: number): void {
    // clear every applied write so the death dissolve owns the materials
    this.setSlow(false);
    this.setStealth(false, now);
    this.setEmpower(false);
    if (this.overhead) {
      this.overhead.visible = false;
    }
    if (this.rootRing) {
      this.rootRing.visible = false;
    }
    this.shieldOn = false;
    this.shieldEndAt = 0;
    if (this.dome) {
      this.dome.visible = false;
    }
    if (this.domeRim) {
      this.domeRim.visible = false;
    }
    if (this.rune) {
      this.rune.visible = false;
    }
    if (this.frost) {
      this.frost.visible = false;
    }
    if (this.frostMat) {
      this.frostMat.opacity = 0;
    }
    this.runeAlpha = 0;
    // a corpse re-enters combat clean; don't replay its onsets
    this.wasOn.clear();
  }

  private tickOverhead(now: number): void {
    let wantOverhead: "star" | "chain" | "mute" | "" = "";
    if (this.fStun) {
      wantOverhead = "star";
    } else if (this.fRoot) {
      wantOverhead = "chain";
    } else if (this.fSilence) {
      wantOverhead = "mute";
    }
    if (wantOverhead !== "") {
      const sprite = this.ensureOverhead();
      if (wantOverhead !== this.overheadKind) {
        sprite.material = icons()[wantOverhead];
        this.overheadKind = wantOverhead;
      }
      // 2.2 rad/s
      const a = now * 0.0022;
      sprite.position.set(Math.cos(a) * 0.45, 2.3, Math.sin(a) * 0.45);
      sprite.visible = true;
    } else if (this.overhead) {
      this.overhead.visible = false;
    }
  }

  private tickRoot(now: number): void {
    if (this.fRoot) {
      const ring = this.ensureRootRing();
      ring.visible = true;
      if (this.rootMat) {
        this.rootMat.opacity = 0.5 * (0.85 + 0.15 * Math.sin(now * 0.00628));
      }
    } else if (this.rootRing) {
      this.rootRing.visible = false;
    }
  }

  private tickSlow(px: number, py: number, pz: number, now: number): void {
    if (this.fSlow) {
      // the ice reads even in shadow
      this.addEmissive(0.02, 0.05, 0.08);
      if (now >= this.nextSlowEmit) {
        // ~9/s — a chill you can actually see
        this.nextSlowEmit = now + 110;
        for (let i = 0; i < 2; i += 1) {
          scratchOpts.x = px + (Math.random() - 0.5) * 0.7;
          scratchOpts.y = py + 0.15 + Math.random() * 1.2;
          scratchOpts.z = pz + (Math.random() - 0.5) * 0.7;
          scratchOpts.vx = (Math.random() - 0.5) * 0.4;
          // frost SHEDS downward — it's weight
          scratchOpts.vy = -0.5 - Math.random();
          scratchOpts.vz = (Math.random() - 0.5) * 0.4;
          scratchOpts.color = 0x9f_e8_ff;
          scratchOpts.size = 0.24;
          scratchOpts.life = 0.55;
          scratchOpts.gravity = -1;
          scratchOpts.drag = 0;
          scratchOpts.stretch = true;
          scratchOpts.bright = 1;
          this.pools.spawn("add", scratchOpts);
        }
      }
    }
  }

  private tickHex(px: number, py: number, pz: number, now: number): void {
    if (this.fHex && now >= this.nextHexEmit) {
      this.nextHexEmit = now + 140;
      scratchOpts.x = px + (Math.random() - 0.5) * 0.7;
      scratchOpts.y = py + 0.2 + Math.random() * 0.7;
      scratchOpts.z = pz + (Math.random() - 0.5) * 0.7;
      scratchOpts.vx = (Math.random() - 0.5) * 0.5;
      scratchOpts.vy = 1.1 + Math.random() * 0.6;
      scratchOpts.vz = (Math.random() - 0.5) * 0.5;
      scratchOpts.color = 0xd0_7b_ff;
      scratchOpts.size = 0.26;
      scratchOpts.life = 0.6;
      scratchOpts.gravity = 0;
      scratchOpts.drag = 0;
      scratchOpts.stretch = false;
      scratchOpts.bright = 1;
      this.pools.spawn("add", scratchOpts);
    }
  }

  private tickTaunt(now: number): void {
    if (this.fTaunt) {
      const p = 0.5 + 0.5 * Math.sin(now * 0.012);
      this.addEmissive(0.14 * p, 0.02 * p, 0.01 * p);
    }
  }

  private tickDot(px: number, py: number, pz: number, now: number): void {
    if (this.fDot !== "" && now >= this.nextDotEmit) {
      this.nextDotEmit = now + 200;
      const color = this.fDot === "magic" ? 0x7f_ff_8e : 0xff_7a_2c;
      for (let i = 0; i < 2; i += 1) {
        scratchOpts.x = px + (Math.random() - 0.5) * 0.5;
        scratchOpts.y = py + 0.9 + Math.random() * 0.5;
        scratchOpts.z = pz + (Math.random() - 0.5) * 0.5;
        scratchOpts.vx = (Math.random() - 0.5) * 0.6;
        scratchOpts.vy = 1.4 + Math.random();
        scratchOpts.vz = (Math.random() - 0.5) * 0.6;
        scratchOpts.color = color;
        scratchOpts.size = 0.26;
        scratchOpts.life = 0.35 + Math.random() * 0.2;
        scratchOpts.gravity = -1;
        scratchOpts.drag = 0;
        scratchOpts.stretch = false;
        scratchOpts.bright = 1;
        this.pools.spawn("add", scratchOpts);
      }
    }
  }

  private tickHeal(px: number, py: number, pz: number, now: number): void {
    if (this.fHeal && now >= this.nextHealEmit) {
      this.nextHealEmit = now + 300;
      for (let i = 0; i < 3; i += 1) {
        scratchOpts.x = px + (Math.random() - 0.5) * 0.9;
        scratchOpts.y = py + 0.3 + Math.random() * 0.6;
        scratchOpts.z = pz + (Math.random() - 0.5) * 0.9;
        scratchOpts.vx = 0;
        // rise 2 u/s
        scratchOpts.vy = 2;
        scratchOpts.vz = 0;
        scratchOpts.color = 0x6b_ff_8e;
        scratchOpts.size = 0.24;
        scratchOpts.life = 0.5 + Math.random() * 0.3;
        scratchOpts.gravity = 0;
        scratchOpts.drag = 0;
        scratchOpts.stretch = false;
        scratchOpts.bright = 1;
        this.pools.spawn("add", scratchOpts);
      }
    }
  }

  private tickRune(dt: number): void {
    let runeColor = 0;
    if (this.fArmor) {
      runeColor = 0xff_d7_6a;
    } else if (this.fShield) {
      runeColor = 0x9f_d0_ff;
    } else if (this.fAtkSpd) {
      runeColor = 0xff_e6_a0;
    }
    const wantAlpha = runeColor === 0 ? 0 : 0.75;
    this.runeAlpha += (wantAlpha - this.runeAlpha) * Math.min(1, dt * 10);
    if (runeColor !== 0 || this.runeAlpha > 0.02) {
      const rune = this.ensureRune();
      rune.visible = this.runeAlpha > 0.02;
      if (this.runeMat) {
        const { uAlpha, uColor } = this.runeMat.uniforms;
        if (uAlpha) {
          uAlpha.value = this.runeAlpha;
        }
        if (uColor && runeColor !== 0) {
          // SAFETY: makeRuneMaterial creates uColor with a THREE.Color value.
          (uColor.value as THREE.Color).setHex(runeColor);
        }
      }
    } else if (this.rune) {
      this.rune.visible = false;
    }
  }

  private tickHaste(u: StatusFxUnit, px: number, py: number, pz: number, now: number): void {
    if (this.fHaste && now >= this.nextHasteEmit && Math.hypot(u.vx, u.vy) > u.moveSpeed * 0.4) {
      this.nextHasteEmit = now + 150;
      for (let i = 0; i < 2; i += 1) {
        scratchOpts.x = px + (Math.random() - 0.5) * 0.4;
        scratchOpts.y = py + 0.2;
        scratchOpts.z = pz + (Math.random() - 0.5) * 0.4;
        scratchOpts.vx = -u.vx * 0.15 + (Math.random() - 0.5);
        scratchOpts.vy = 0.5 + Math.random() * 0.5;
        scratchOpts.vz = -u.vy * 0.15 + (Math.random() - 0.5);
        scratchOpts.color = 0x59_d8_d0;
        scratchOpts.size = 0.3;
        scratchOpts.life = 0.3 + Math.random() * 0.15;
        scratchOpts.gravity = -1.5;
        scratchOpts.drag = 2.5;
        scratchOpts.stretch = false;
        scratchOpts.bright = 1;
        scratchOpts.alpha = 0.55;
        this.pools.spawn("normal", scratchOpts);
      }
      scratchOpts.alpha = 1;
    }
  }

  private tickAmp(px: number, py: number, pz: number, now: number): void {
    if (this.fAmp) {
      if (now >= this.nextAmpEmit) {
        this.nextAmpEmit = now + 300;
        scratchOpts.x = px + (Math.random() - 0.5) * 0.6;
        scratchOpts.y = py + 0.8 + Math.random() * 0.8;
        scratchOpts.z = pz + (Math.random() - 0.5) * 0.6;
        scratchOpts.vx = 0;
        scratchOpts.vy = 1.2;
        scratchOpts.vz = 0;
        scratchOpts.color = 0x9a_7b_ff;
        scratchOpts.size = 0.26;
        scratchOpts.life = 0.7;
        scratchOpts.gravity = 0;
        scratchOpts.drag = 0;
        scratchOpts.stretch = false;
        scratchOpts.bright = 1;
        this.pools.spawn("add", scratchOpts);
      }
      // 0x30206a × 0.08
      this.addEmissive(0.015, 0.01, 0.033);
    }
  }

  private tickEnrage(px: number, py: number, pz: number, now: number): void {
    if (this.fAtkSpd) {
      if (now >= this.nextEnrageEmit) {
        this.nextEnrageEmit = now + 300;
        for (let i = 0; i < 2; i += 1) {
          scratchOpts.x = px + (Math.random() - 0.5) * 0.6;
          scratchOpts.y = py + 0.6 + Math.random() * 0.8;
          scratchOpts.z = pz + (Math.random() - 0.5) * 0.6;
          scratchOpts.vx = (Math.random() - 0.5) * 0.5;
          scratchOpts.vy = 1.2 + Math.random() * 0.8;
          scratchOpts.vz = (Math.random() - 0.5) * 0.5;
          scratchOpts.color = 0xff_44_22;
          scratchOpts.size = 0.24;
          scratchOpts.life = 0.4;
          scratchOpts.gravity = -1;
          scratchOpts.drag = 0;
          scratchOpts.stretch = false;
          scratchOpts.bright = 1;
          this.pools.spawn("add", scratchOpts);
        }
      }
      // 0xff4422 × 0.15
      this.addEmissive(0.15, 0.04, 0.02);
    }
  }
  private tickShield(now: number): void {
    if (this.fShield && !this.shieldOn) {
      this.shieldOn = true;
      this.shieldShownAt = now;
      this.shieldEndAt = 0;
      this.ensureDome();
    } else if (!this.fShield && this.shieldOn) {
      this.shieldOn = false;
      // start the 150ms fade-out
      this.shieldEndAt = now;
    }
    if (!this.dome || !this.domeRim || !this.domeMat || !this.domeRimMat) {
      return;
    }
    if (this.shieldOn) {
      // 1.15 → 1.0
      const k = Math.min(1, (now - this.shieldShownAt) / 120);
      const s = DOME_R * (1.15 - 0.15 * k);
      this.dome.scale.setScalar(s);
      this.domeRim.scale.setScalar(s / DOME_R);
      this.domeMat.opacity = 0.18;
      this.domeRimMat.opacity = 0.5;
      this.dome.visible = true;
      this.domeRim.visible = true;
    } else if (this.shieldEndAt > 0) {
      const k = (now - this.shieldEndAt) / 150;
      if (k >= 1) {
        this.shieldEndAt = 0;
        this.dome.visible = false;
        this.domeRim.visible = false;
      } else {
        this.domeMat.opacity = 0.18 * (1 - k);
        this.domeRimMat.opacity = 0.5 * (1 - k);
      }
    }
  }

  /** Fire a one-shot burst for every debuff kind that JUST landed on this unit. */
  private onsets(statuses: Status[], px: number, py: number, pz: number): void {
    for (const s of statuses) {
      const spec = ONSET.get(s.kind);
      if (!spec || this.wasOn.has(s.kind)) {
        continue;
      }
      for (let i = 0; i < spec.n; i += 1) {
        // burst outward off the torso in a rough sphere
        const a = (i / spec.n) * Math.PI * 2 + Math.random() * 0.4;
        const up = Math.random() * 0.8 + 0.2;
        scratchOpts.x = px;
        scratchOpts.y = py + 1;
        scratchOpts.z = pz;
        scratchOpts.vx = Math.cos(a) * spec.speed;
        scratchOpts.vy = up * spec.speed * 0.5;
        scratchOpts.vz = Math.sin(a) * spec.speed;
        scratchOpts.color = spec.color;
        scratchOpts.size = spec.size;
        scratchOpts.life = 0.42;
        scratchOpts.gravity = -3;
        scratchOpts.drag = 2.5;
        scratchOpts.stretch = true;
        scratchOpts.bright = 1;
        this.pools.spawn("add", scratchOpts);
      }
    }
    this.wasOn.clear();
    for (const s of statuses) {
      if (ONSET.has(s.kind)) {
        this.wasOn.add(s.kind);
      }
    }
  }

  /** Frost shell — scales on over ~120ms and holds while chilled. */
  private tickFrost(on: boolean, dt: number, now: number): void {
    if (!on && !this.frost) {
      return;
    }
    if (!this.frost) {
      // additive glass, NOT wireframe — a wireframe hemisphere reads as a birdcage
      // over the character; a low-opacity additive shell reads as ice encasing it
      this.frostMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: 0x6f_c8_ee,
        depthWrite: false,
        opacity: 0,
        side: THREE.DoubleSide,
        transparent: true,
      });
      this.frost = new THREE.Mesh(sharedDomeGeo(), this.frostMat);
      // body-shaped, not a bubble
      this.frost.scale.set(0.8, 1.45, 0.8);
      this.frost.position.y = 0.05;
      this.target.group.add(this.frost);
    }
    const mat = this.frostMat;
    if (!mat) {
      return;
    }
    const want = on ? 0.3 + 0.06 * Math.sin(now * 0.008) : 0;
    mat.opacity += (want - mat.opacity) * Math.min(1, dt * 9);
    this.frost.visible = mat.opacity > 0.02;
  }

  private setSlow(on: boolean): void {
    if (on === this.slowApplied) {
      return;
    }
    this.slowApplied = on;
    const mats = this.target.bodyMats;
    for (let i = 0; i < mats.length; i += 1) {
      const m = mats[i];
      const base = this.baseColors[i];
      if (!m || !base) {
        continue;
      }
      m.color.copy(base);
      if (on) {
        m.color.lerp(ICE, SLOW_TINT_LERP);
      }
    }
  }

  private setStealth(on: boolean, now: number): void {
    if (on) {
      const op = this.target.isLocal ? 0.32 + 0.08 * Math.sin(now * 0.006) : 0.18;
      for (const m of this.target.bodyMats) {
        m.transparent = true;
        m.opacity = op;
      }
      this.stealthApplied = true;
    } else if (this.stealthApplied) {
      this.stealthApplied = false;
      for (const m of this.target.bodyMats) {
        m.opacity = 1;
        m.transparent = false;
      }
    }
  }

  private setEmpower(on: boolean): void {
    // Per-frame overwrite (not transition-gated): UnitView rewrites the weapon
    // emissive every frame (melee windup glint is the baseline), so empower must
    // re-assert on top each frame — and needs no restore path.
    if (!on) {
      return;
    }
    for (const m of this.target.weaponMats) {
      m.emissive.copy(this.accentColor).multiplyScalar(0.8);
    }
  }

  /** Additive per-frame emissive tint — layered AFTER UnitView's flash write. */
  private addEmissive(r: number, g: number, b: number): void {
    for (const m of this.target.bodyMats) {
      m.emissive.r += r;
      m.emissive.g += g;
      m.emissive.b += b;
    }
  }
}
