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

const drawIcon = (kind: "star" | "chain" | "mute") => {
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
    g.ellipse(34, 48, 16, 24, -0.5, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.ellipse(62, 48, 16, 24, 0.5, 0, Math.PI * 2);
    g.stroke();
  } else {
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

const icons = () => {
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

let rootRingGeo: THREE.RingGeometry | null = null;
let domeGeo: THREE.SphereGeometry | null = null;
let domeRimGeo: THREE.RingGeometry | null = null;
let runeGeo: THREE.PlaneGeometry | null = null;

const sharedRuneGeo = () => {
  runeGeo ??= new THREE.PlaneGeometry(2, 2);

  return runeGeo;
};

const sharedRootRingGeo = () => {
  rootRingGeo ??= new THREE.RingGeometry(0.7, 0.9, 28);

  return rootRingGeo;
};

const sharedDomeGeo = () => {
  domeGeo ??= new THREE.SphereGeometry(1, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);

  return domeGeo;
};

const sharedDomeRimGeo = () => {
  domeRimGeo ??= new THREE.RingGeometry(0.98, 1.1, 32);

  return domeRimGeo;
};

const ICE = new THREE.Color(0x7f_d4_ff);
const SLOW_TINT_LERP = 0.55;
const DOME_R = 1.1;
const scratchOpts: SpawnOptions = { life: 0.4, size: 0.3, x: 0, y: 0, z: 0 };

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
  private overhead: THREE.Sprite | null = null;
  private overheadKind: "star" | "chain" | "mute" | "" = "";
  private rootRing: THREE.Mesh | null = null;
  private rootMat: THREE.MeshBasicMaterial | null = null;
  private dome: THREE.Mesh | null = null;
  private domeMat: THREE.MeshBasicMaterial | null = null;
  private domeRim: THREE.Mesh | null = null;
  private domeRimMat: THREE.MeshBasicMaterial | null = null;
  private rune: THREE.Mesh | null = null;
  private runeMat: THREE.ShaderMaterial | null = null;
  private runeAlpha = 0;
  private readonly baseColors: THREE.Color[] = [];
  private readonly accentColor: THREE.Color;
  private slowApplied = false;
  private stealthApplied = false;
  private shieldOn = false;
  private shieldShownAt = 0;
  private shieldEndAt = 0;
  private nextSlowEmit = 0;
  private nextDotEmit = 0;
  private nextHealEmit = 0;
  private nextHasteEmit = 0;
  private nextAmpEmit = 0;
  private nextEnrageEmit = 0;
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
  private frost: THREE.Mesh | null = null;
  private frostMat: THREE.MeshBasicMaterial | null = null;
  private nextHexEmit = 0;
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

  update(u: StatusFxUnit, dt: number, now: number) {
    if (!u.alive) {
      this.clearWhileDead(now);

      return;
    }

    this.scan(u.statuses);
    const px = this.target.group.position.x;
    const py = this.target.group.position.y;
    const pz = this.target.group.position.z;

    this.onsets(u.statuses, px, py, pz);

    this.tickOverhead(now);

    this.tickRoot(now);

    this.setSlow(this.fSlow);
    this.tickFrost(this.fSlow, dt, now);
    this.tickSlow(px, py, pz, now);

    this.tickHex(px, py, pz, now);

    this.tickTaunt(now);

    this.tickDot(px, py, pz, now);

    this.tickHeal(px, py, pz, now);

    this.tickShield(now);

    this.tickRune(dt);

    this.tickHaste(u, px, py, pz, now);

    this.tickAmp(px, py, pz, now);

    this.tickEnrage(px, py, pz, now);

    this.setStealth(this.fStealth, now);

    this.setEmpower(u.empowerNext > 0);
  }

  dispose() {
    this.setSlow(false);
    this.setStealth(false, 0);
    this.setEmpower(false);
    const g = this.target.group;

    if (this.overhead) {
      g.remove(this.overhead);
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

  private scan(statuses: Status[]) {
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

  private ensureOverhead() {
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

  private ensureRootRing() {
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
    ring.position.y = 0.12;
    this.target.group.add(ring);
    this.rootRing = ring;

    return ring;
  }

  private ensureRune() {
    if (this.rune) {
      return this.rune;
    }

    this.runeMat = makeRuneMaterial(0xff_d7_6a);
    const rune = new THREE.Mesh(sharedRuneGeo(), this.runeMat);
    rune.rotation.x = -Math.PI / 2;
    rune.position.y = 0.15;
    rune.scale.setScalar(1.35);
    this.target.group.add(rune);
    this.rune = rune;

    return rune;
  }

  private ensureDome() {
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
    this.domeRim.position.y = 0.12;
    this.target.group.add(this.domeRim);
  }

  private clearWhileDead(now: number) {
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
    this.wasOn.clear();
  }

  private tickOverhead(now: number) {
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

      const a = now * 0.0022;
      sprite.position.set(Math.cos(a) * 0.45, 2.3, Math.sin(a) * 0.45);
      sprite.visible = true;
    } else if (this.overhead) {
      this.overhead.visible = false;
    }
  }

  private tickRoot(now: number) {
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

  private tickSlow(px: number, py: number, pz: number, now: number) {
    if (this.fSlow) {
      this.addEmissive(0.02, 0.05, 0.08);

      if (now >= this.nextSlowEmit) {
        this.nextSlowEmit = now + 110;

        for (let i = 0; i < 2; i += 1) {
          scratchOpts.x = px + (Math.random() - 0.5) * 0.7;
          scratchOpts.y = py + 0.15 + Math.random() * 1.2;
          scratchOpts.z = pz + (Math.random() - 0.5) * 0.7;
          scratchOpts.vx = (Math.random() - 0.5) * 0.4;
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

  private tickHex(px: number, py: number, pz: number, now: number) {
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

  private tickTaunt(now: number) {
    if (this.fTaunt) {
      const p = 0.5 + 0.5 * Math.sin(now * 0.012);
      this.addEmissive(0.14 * p, 0.02 * p, 0.01 * p);
    }
  }

  private tickDot(px: number, py: number, pz: number, now: number) {
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

  private tickHeal(px: number, py: number, pz: number, now: number) {
    if (this.fHeal && now >= this.nextHealEmit) {
      this.nextHealEmit = now + 300;

      for (let i = 0; i < 3; i += 1) {
        scratchOpts.x = px + (Math.random() - 0.5) * 0.9;
        scratchOpts.y = py + 0.3 + Math.random() * 0.6;
        scratchOpts.z = pz + (Math.random() - 0.5) * 0.9;
        scratchOpts.vx = 0;
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

  private tickRune(dt: number) {
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
          (uColor.value as THREE.Color).setHex(runeColor);
        }
      }
    } else if (this.rune) {
      this.rune.visible = false;
    }
  }

  private tickHaste(u: StatusFxUnit, px: number, py: number, pz: number, now: number) {
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

  private tickAmp(px: number, py: number, pz: number, now: number) {
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

      this.addEmissive(0.015, 0.01, 0.033);
    }
  }

  private tickEnrage(px: number, py: number, pz: number, now: number) {
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

      this.addEmissive(0.15, 0.04, 0.02);
    }
  }
  private tickShield(now: number) {
    if (this.fShield && !this.shieldOn) {
      this.shieldOn = true;
      this.shieldShownAt = now;
      this.shieldEndAt = 0;
      this.ensureDome();
    } else if (!this.fShield && this.shieldOn) {
      this.shieldOn = false;
      this.shieldEndAt = now;
    }

    if (!this.dome || !this.domeRim || !this.domeMat || !this.domeRimMat) {
      return;
    }

    if (this.shieldOn) {
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

  private onsets(statuses: Status[], px: number, py: number, pz: number) {
    for (const s of statuses) {
      const spec = ONSET.get(s.kind);

      if (!spec || this.wasOn.has(s.kind)) {
        continue;
      }

      for (let i = 0; i < spec.n; i += 1) {
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

  private tickFrost(on: boolean, dt: number, now: number) {
    if (!on && !this.frost) {
      return;
    }

    if (!this.frost) {
      this.frostMat = new THREE.MeshBasicMaterial({
        blending: THREE.AdditiveBlending,
        color: 0x6f_c8_ee,
        depthWrite: false,
        opacity: 0,
        side: THREE.DoubleSide,
        transparent: true,
      });
      this.frost = new THREE.Mesh(sharedDomeGeo(), this.frostMat);
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

  private setSlow(on: boolean) {
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

  private setStealth(on: boolean, now: number) {
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

  private setEmpower(on: boolean) {
    if (!on) {
      return;
    }

    for (const m of this.target.weaponMats) {
      m.emissive.copy(this.accentColor).multiplyScalar(0.8);
    }
  }

  private addEmissive(r: number, g: number, b: number) {
    for (const m of this.target.bodyMats) {
      m.emissive.r += r;
      m.emissive.g += g;
      m.emissive.b += b;
    }
  }
}
