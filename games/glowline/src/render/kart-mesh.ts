// A kart, built from parts: floor pan, tub, nose, wings with endplates, side
// pods, engine cover and exhausts, roll hoop, a driver with a helmet and hands
// on a wheel, tyres on rims, a number plate, lights. Clear-coated in the
// driver's paint colour, with that colour glowing on the ground beneath it.
// Built facing +x from shared geometry; only the paint materials are per kart.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import { paintedPanel, softDisc } from "./textures";
import type { SurfaceMaps } from "./textures";

/** Body proportions per chassis: length, height, width. */
const CHASSIS_SCALE: readonly (readonly [number, number, number])[] = [
  [1, 1, 1],
  [0.93, 1.1, 1.13],
  [1.1, 0.92, 0.9],
];

const PAN = new RoundedBoxGeometry(2.55, 0.2, 1.12, 2, 0.07);
const TUB = new RoundedBoxGeometry(1.5, 0.44, 0.78, 3, 0.14);
const NOSE = new THREE.CylinderGeometry(0.13, 0.36, 1.05, 10).rotateZ(-Math.PI / 2);
const WING_FRONT = new RoundedBoxGeometry(0.34, 0.11, 1.72, 2, 0.04);
const WING_REAR = new RoundedBoxGeometry(0.4, 0.12, 1.5, 2, 0.045);
const ENDPLATE = new RoundedBoxGeometry(0.46, 0.4, 0.1, 2, 0.035);
const ENDPLATE_FRONT = new RoundedBoxGeometry(0.38, 0.2, 0.09, 2, 0.03);
const POD = new RoundedBoxGeometry(0.95, 0.32, 0.34, 2, 0.1);
const STRIPE = new THREE.BoxGeometry(0.7, 0.05, 0.345);
const COVER = new RoundedBoxGeometry(0.72, 0.5, 0.56, 2, 0.14);
const PIPE = new THREE.CylinderGeometry(0.07, 0.085, 0.5, 10).rotateZ(Math.PI / 2);
const STRUT = new THREE.BoxGeometry(0.08, 0.46, 0.06);
const HOOP = new THREE.TorusGeometry(0.29, 0.04, 8, 16, Math.PI).rotateY(Math.PI / 2);
const SEAT = new RoundedBoxGeometry(0.5, 0.5, 0.56, 2, 0.1);
const TORSO = new THREE.CapsuleGeometry(0.19, 0.26, 3, 10);
const HELMET = new THREE.SphereGeometry(0.27, 18, 14);
// A sphere's phi runs from -x, so the band centred on phi = π faces forward (+x).
const VISOR = new THREE.SphereGeometry(
  0.278,
  16,
  8,
  Math.PI - 0.95,
  1.9,
  Math.PI * 0.36,
  Math.PI * 0.24,
);
const ARM = new THREE.CylinderGeometry(0.05, 0.055, 0.46, 8).rotateZ(Math.PI / 2.6);
const WHEEL = new THREE.TorusGeometry(0.16, 0.028, 8, 16).rotateY(Math.PI / 2);
const TYRE = new THREE.CylinderGeometry(0.43, 0.43, 0.36, 20).rotateX(Math.PI / 2);
const TYRE_SHOULDER = new THREE.TorusGeometry(0.37, 0.07, 8, 20);
// A dished rim: an outer lip, a recessed face, five spokes and a hub cap.
const RIM = new THREE.CylinderGeometry(0.25, 0.25, 0.3, 18).rotateX(Math.PI / 2);
const RIM_LIP = new THREE.TorusGeometry(0.27, 0.035, 8, 20);
const SPOKE = new THREE.BoxGeometry(0.44, 0.07, 0.05);
// Chassis parts beyond the base kart.
const CAGE_BAR = new THREE.CylinderGeometry(0.045, 0.045, 1, 8);
const BULL_BAR = new THREE.TorusGeometry(0.42, 0.05, 8, 14, Math.PI).rotateY(Math.PI / 2);
const CRATE = new RoundedBoxGeometry(0.8, 0.62, 1.2, 2, 0.08);
const FIN = new RoundedBoxGeometry(0.7, 0.5, 0.07, 2, 0.03);
const CANARD = new RoundedBoxGeometry(0.26, 0.07, 0.5, 1, 0.025);
const SHOULDERS = new THREE.CapsuleGeometry(0.11, 0.34, 3, 8).rotateX(Math.PI / 2);
const HELMET_STRIPE = new THREE.TorusGeometry(0.272, 0.022, 6, 20, Math.PI).rotateY(Math.PI / 2);
const INTAKE = new RoundedBoxGeometry(0.34, 0.2, 0.3, 2, 0.06);
const HUB = new THREE.CylinderGeometry(0.1, 0.1, 0.4, 8).rotateX(Math.PI / 2);
const AXLE = new THREE.CylinderGeometry(0.045, 0.045, 1.7, 6).rotateX(Math.PI / 2);
const LAMP = new THREE.SphereGeometry(0.075, 10, 8);
const TAIL = new THREE.BoxGeometry(0.05, 0.07, 0.7);
const PLATE = new THREE.PlaneGeometry(0.34, 0.34).rotateX(-Math.PI / 2);
const GROUND = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const SPINE = new THREE.BoxGeometry(0.9, 0.012, 0.16);
const BOARD = new RoundedBoxGeometry(0.05, 0.44, 0.44, 1, 0.02);
const POD_DECAL = new THREE.PlaneGeometry(0.3, 0.3);
// Turned to read from behind, where the chase camera sits.
const WING_DECAL = new THREE.PlaneGeometry(0.3, 1.3).rotateX(-Math.PI / 2).rotateY(Math.PI);

let wingMap: THREE.CanvasTexture | null = null;
/** The team name across the rear wing, shared by every kart. */
const wingTexture = (): THREE.CanvasTexture => {
  if (!wingMap) {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.translate(32, 128);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = "#f4f1ea";
      ctx.font = "italic 900 44px 'Chakra Petch', 'Arial Black', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("GLOWLINE", 0, 3, 236);
    }
    wingMap = new THREE.CanvasTexture(canvas);
    wingMap.colorSpace = THREE.SRGBColorSpace;
  }
  return wingMap;
};

const CARBON = new THREE.MeshStandardMaterial({
  color: "#17171c",
  metalness: 0.3,
  roughness: 0.45,
});
const RUBBER = new THREE.MeshStandardMaterial({ color: "#0d0d10", roughness: 0.92 });
const DISH = new THREE.MeshStandardMaterial({ color: "#2a2c36", metalness: 0.7, roughness: 0.4 });
const STEEL = new THREE.MeshStandardMaterial({ color: "#b9bcc6", metalness: 0.9, roughness: 0.28 });
const SUIT = new THREE.MeshStandardMaterial({ color: "#e9e6df", roughness: 0.85 });
const GLOVE = new THREE.MeshStandardMaterial({ color: "#22222a", roughness: 0.8 });
const GLASS = new THREE.MeshStandardMaterial({ color: "#0a0f1c", metalness: 0.9, roughness: 0.08 });
const TRIM = new THREE.MeshStandardMaterial({ color: "#f4f1ea", roughness: 0.5 });
const HEADLIGHT = new THREE.MeshBasicMaterial({ color: "#fff2c4", toneMapped: false });
const TAILLIGHT = new THREE.MeshBasicMaterial({ color: "#ff2a2a", toneMapped: false });

let panels: SurfaceMaps | null = null;
const panelMaps = (): SurfaceMaps => {
  panels ??= paintedPanel();
  return panels;
};

let disc: THREE.CanvasTexture | null = null;
const discTexture = (): THREE.CanvasTexture => {
  disc ??= softDisc();
  return disc;
};

const numberPlate = (label: string): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath();
    ctx.arc(48, 48, 46, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#101018";
    ctx.font = "italic 900 60px 'Chakra Petch', 'Arial Black', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 46, 52, 80);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

/** Add one shadow-casting part to `parent`. */
const part = (
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z = 0,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
};

/** What a kart looks like this frame. */
export interface KartLook {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** -1 … 1, drives the front wheels and the driver's lean. */
  steer: number;
  /** -1 / 0 / 1. */
  drift: number;
  speed: number;
  boosting: boolean;
  /** 0 … 1 through a spin-out; 0 when not spinning. */
  spin: number;
}

export class KartMesh {
  readonly group = new THREE.Group();
  /** Everything that leans, hops and squashes; the group only places and yaws. */
  private readonly body = new THREE.Group();
  private readonly paint: THREE.MeshPhysicalMaterial;
  private readonly glow: THREE.MeshBasicMaterial;
  private readonly plate: THREE.MeshBasicMaterial;
  private readonly plateMap: THREE.CanvasTexture;
  private readonly wingLabel: THREE.MeshBasicMaterial;
  private readonly wheels: THREE.Object3D[] = [];
  private readonly steerable: THREE.Object3D[] = [];
  private readonly driver = new THREE.Group();
  private readonly color: THREE.Color;
  private readonly tall: number;
  private readonly chassis: number;
  private lean = 0;
  private hop = 0;
  private squash = 0;

  constructor(color: THREE.Color, label: string, chassis = 0) {
    this.color = color.clone();
    this.paint = new THREE.MeshPhysicalMaterial({
      clearcoat: 0.45,
      clearcoatRoughness: 0.3,
      color: color.clone().multiplyScalar(0.9),
      emissive: color,
      emissiveIntensity: 0.04,
      metalness: 0.25,
      // Scuffs and chips, so a body panel is not one flat value.
      normalMap: panelMaps().normalMap,
      normalScale: new THREE.Vector2(0.35, 0.35),
      roughness: 0.62,
      roughnessMap: panelMaps().roughnessMap,
    });
    this.glow = new THREE.MeshBasicMaterial({
      blending: THREE.AdditiveBlending,
      color,
      depthWrite: false,
      map: discTexture(),
      transparent: true,
    });
    this.plateMap = numberPlate(label);
    // Decals: blended, never written to depth, so their clear texels cannot hide what is behind.
    const decal = {
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      transparent: true,
    };
    this.plate = new THREE.MeshBasicMaterial({ ...decal, map: this.plateMap });
    this.wingLabel = new THREE.MeshBasicMaterial({ ...decal, map: wingTexture() });
    this.chassis = chassis;
    const [sx, sy, sz] = CHASSIS_SCALE[chassis] ?? [1, 1, 1];
    this.tall = sy;
    this.body.scale.set(sx, sy, sz);
    this.buildShell();
    this.buildDriver();
    this.buildWheels();
    this.group.add(this.body);

    // Grounding: a soft dark contact patch, and the kart's colour pooled under it.
    const shade = new THREE.Mesh(
      GROUND,
      new THREE.MeshBasicMaterial({
        color: "#000000",
        depthWrite: false,
        map: discTexture(),
        opacity: 0.85,
        transparent: true,
      }),
    );
    shade.scale.set(3.6 * sx, 1, 2.4 * sz);
    shade.position.y = 0.03;
    shade.renderOrder = 4;
    const pool = new THREE.Mesh(GROUND, this.glow);
    pool.scale.set(5.2, 1, 4);
    pool.position.y = 0.035;
    pool.renderOrder = 5;
    this.group.add(shade, pool);
  }

  /** A little jump: the start of a drift. */
  kick(): void {
    this.hop = 1;
  }

  /** A hit: squash down and spring back. */
  thump(): void {
    this.squash = 1;
  }

  update(look: KartLook, dt: number): void {
    this.group.position.set(look.x, look.y, look.z);
    // The model faces +x; heading turns +x towards +z, which is -Y rotation.
    this.group.rotation.set(0, -look.heading - look.drift * 0.38 - look.spin * Math.PI * 4, 0);
    const lean = look.drift === 0 ? look.steer * 0.07 : look.drift * 0.17;
    this.lean += (lean - this.lean) * Math.min(1, dt * 10);
    this.hop = Math.max(0, this.hop - dt * 4.5);
    this.squash = Math.max(0, this.squash - dt * 5);
    const squash = Math.sin(this.squash * Math.PI) * 0.22;
    this.body.rotation.set(this.lean, 0, look.boosting ? 0.045 : 0);
    this.body.position.y = Math.sin(this.hop * Math.PI) * 0.42;
    this.body.scale.y = this.tall * (1 - squash);
    this.driver.rotation.x = this.lean * 1.6;
    for (const pivot of this.steerable) {
      pivot.rotation.y = -look.steer * 0.42;
    }
    for (const wheel of this.wheels) {
      wheel.rotation.z -= look.speed * dt * 2.3;
    }
    this.glow.color.copy(this.color).multiplyScalar(look.boosting ? 0.5 : 0);
  }

  dispose(): void {
    this.paint.dispose();
    this.glow.dispose();
    this.plate.dispose();
    this.wingLabel.dispose();
    this.plateMap.dispose();
  }

  private buildShell(): void {
    const { paint } = this;
    part(this.body, PAN, CARBON, 0.02, 0.27);
    part(this.body, TUB, paint, -0.05, 0.53);
    part(this.body, NOSE, paint, 1.08, 0.47).scale.set(1, 0.72, 1.05);
    part(this.body, WING_FRONT, paint, 1.56, 0.25);
    part(this.body, COVER, CARBON, -0.78, 0.7);
    part(this.body, INTAKE, CARBON, -0.62, 1.02);
    this.buildTail();
    part(this.body, HOOP, STEEL, -0.47, 0.96);
    part(this.body, SEAT, CARBON, -0.36, 0.78);
    part(this.body, TAIL, TAILLIGHT, -1.31, 0.56);
    // The number again on a board at the back, where the chase camera reads it.
    part(this.body, BOARD, TRIM, -1.36, 0.92).castShadow = false;
    const rear = part(this.body, POD_DECAL, this.plate, -1.385, 0.92);
    rear.castShadow = false;
    rear.rotation.y = -Math.PI / 2;
    rear.scale.setScalar(1.25);
    part(this.body, AXLE, STEEL, 0.86, 0.42);
    part(this.body, AXLE, STEEL, -0.82, 0.45);
    const plate = part(this.body, PLATE, this.plate, 0.92, 0.705);
    plate.castShadow = false;
    plate.rotation.z = -0.1;
    // Livery: a pale stripe down the spine, the number on both pods, a name on the wing.
    part(this.body, SPINE, TRIM, 0.35, 0.756).castShadow = false;
    for (const side of [-1, 1]) {
      const badge = part(this.body, POD_DECAL, this.plate, -0.12, 0.48, side * 0.775);
      badge.castShadow = false;
      badge.rotation.y = side > 0 ? 0 : Math.PI;
      part(this.body, POD, paint, -0.12, 0.47, side * 0.6);
      part(this.body, STRIPE, TRIM, -0.12, 0.6, side * 0.6);
      part(this.body, ENDPLATE_FRONT, CARBON, 1.56, 0.3, side * 0.86);
      part(this.body, PIPE, STEEL, -1.22, 0.62, side * 0.2);
      part(this.body, LAMP, HEADLIGHT, 1.5, 0.42, side * 0.2).castShadow = false;
    }
  }

  /**
   * The back of the kart is what the chase camera shows, so it is where the
   * three chassis differ: Dart carries a full-width wing, Anvil a roll cage
   * over a cargo crate behind a bull bar, Wisp twin fins and front canards.
   */
  private buildTail(): void {
    const { paint } = this;
    if (this.chassis === 1) {
      part(this.body, CRATE, paint, -1.02, 0.86);
      part(this.body, BULL_BAR, STEEL, 1.5, 0.42).rotation.z = Math.PI / 2;
      for (const side of [-1, 1]) {
        for (const x of [-0.62, -1.38]) {
          part(this.body, CAGE_BAR, STEEL, x, 1.1, side * 0.56);
        }
        const rail = part(this.body, CAGE_BAR, STEEL, -1, 1.6, side * 0.56);
        rail.rotation.z = Math.PI / 2;
        rail.scale.y = 0.82;
      }
      const cross = part(this.body, CAGE_BAR, STEEL, -1.38, 1.6);
      cross.rotation.x = Math.PI / 2;
      cross.scale.y = 1.16;
      return;
    }
    if (this.chassis === 2) {
      for (const side of [-1, 1]) {
        const fin = part(this.body, FIN, paint, -1.05, 1.02, side * 0.42);
        fin.rotation.x = side * 0.28;
        part(this.body, CANARD, paint, 1.2, 0.5, side * 0.62).rotation.y = side * 0.3;
      }
      return;
    }
    part(this.body, WING_REAR, paint, -1.22, 1.2);
    part(this.body, WING_DECAL, this.wingLabel, -1.22, 1.268).castShadow = false;
    for (const side of [-1, 1]) {
      part(this.body, ENDPLATE, CARBON, -1.22, 1.08, side * 0.76);
      part(this.body, STRUT, CARBON, -1.2, 0.96, side * 0.3);
    }
  }

  private buildDriver(): void {
    const { driver } = this;
    driver.position.set(-0.3, 0.72, 0);
    part(driver, TORSO, SUIT, 0, 0.26, 0);
    part(driver, HELMET, this.paint, 0.03, 0.66, 0);
    part(driver, VISOR, GLASS, 0.03, 0.66, 0).castShadow = false;
    part(driver, HELMET_STRIPE, TRIM, 0.03, 0.66, 0).castShadow = false;
    part(driver, SHOULDERS, SUIT, 0.02, 0.4, 0);
    for (const side of [-1, 1]) {
      part(driver, ARM, GLOVE, 0.28, 0.3, side * 0.17);
    }
    part(driver, WHEEL, CARBON, 0.52, 0.34, 0);
    this.body.add(driver);
  }

  private buildWheels(): void {
    const corners: readonly (readonly [number, number, number, boolean])[] = [
      [0.86, 0.76, 0.92, true],
      [0.86, -0.76, 0.92, true],
      [-0.82, 0.8, 1.08, false],
      [-0.82, -0.8, 1.08, false],
    ];
    for (const [x, z, size, steers] of corners) {
      const pivot = new THREE.Group();
      pivot.position.set(x, 0.43 * size, z);
      pivot.scale.setScalar(size);
      const wheel = new THREE.Group();
      part(wheel, TYRE, RUBBER, 0, 0, 0);
      part(wheel, RIM, DISH, 0, 0, 0).castShadow = false;
      part(wheel, HUB, this.paint, 0, 0, 0).castShadow = false;
      for (const face of [-1, 1]) {
        part(wheel, RIM_LIP, STEEL, 0, 0, face * 0.16).castShadow = false;
        for (let spoke = 0; spoke < 5; spoke += 1) {
          const bar = part(wheel, SPOKE, STEEL, 0, 0, face * 0.165);
          bar.castShadow = false;
          bar.rotation.z = (spoke / 5) * Math.PI;
        }
      }
      for (const side of [-1, 1]) {
        part(wheel, TYRE_SHOULDER, RUBBER, 0, 0, side * 0.13).castShadow = false;
      }
      pivot.add(wheel);
      this.body.add(pivot);
      this.wheels.push(wheel);
      if (steers) {
        this.steerable.push(pivot);
      }
    }
  }
}
