import * as THREE from "three";
import type { BrawlerDef } from "../config";

// Every brawler is assembled from a handful of primitive shapes. Geometries are
// shared across all instances (eight brawlers per roster, rebuilt on every
// match) so each distinct shape is built once and cached by its dimensions.
const geometryCache = new Map<string, THREE.BufferGeometry>();

const cachedGeometry = (key: string, build: () => THREE.BufferGeometry): THREE.BufferGeometry => {
  const hit = geometryCache.get(key);
  if (hit) {
    return hit;
  }
  const built = build();
  geometryCache.set(key, built);
  return built;
};

const sphere = (radius: number, widthSegments = 18, heightSegments = 14) =>
  cachedGeometry(
    `s${radius}_${widthSegments}_${heightSegments}`,
    () => new THREE.SphereGeometry(radius, widthSegments, heightSegments),
  );

const capsule = (radius: number, length: number) =>
  cachedGeometry(`c${radius}_${length}`, () => new THREE.CapsuleGeometry(radius, length, 5, 12));

const cylinder = (radiusTop: number, radiusBottom: number, height: number, radialSegments = 16) =>
  cachedGeometry(
    `y${radiusTop}_${radiusBottom}_${height}_${radialSegments}`,
    () => new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments),
  );

const box = (width: number, height: number, depth: number) =>
  cachedGeometry(`b${width}_${height}_${depth}`, () => new THREE.BoxGeometry(width, height, depth));

// A sphere cut off at `thetaFraction` of a half turn — hat crowns and helmets.
const dome = (radius: number, thetaFraction: number) =>
  cachedGeometry(
    `d${radius}_${thetaFraction}`,
    () => new THREE.SphereGeometry(radius, 20, 12, 0, Math.PI * 2, 0, Math.PI * thetaFraction),
  );

const torus = (radius: number, tube: number) =>
  cachedGeometry(`t${radius}_${tube}`, () => new THREE.TorusGeometry(radius, tube, 8, 24));

// Flat ground markers laid under every brawler: the team-colour ring, the
// wider translucent disc that only the player gets, and the glowing ring that
// pulses while a super is ready.
export const TEAM_RING_GEOMETRY = new THREE.RingGeometry(0.5, 0.64, 44).rotateX(-Math.PI / 2);
export const PLAYER_DISC_GEOMETRY = new THREE.CircleGeometry(0.5, 36).rotateX(-Math.PI / 2);
export const SUPER_RING_GEOMETRY = new THREE.RingGeometry(0.7, 0.8, 44).rotateX(-Math.PI / 2);

export const standardMaterial = (
  color: number,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, metalness: 0, roughness: 0.62, ...extra });

interface ModelMaterials {
  body: THREE.MeshStandardMaterial;
  accent: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
}

export type ArmRest = [rotationX: number, rotationZ: number];

// How the animation code drives the arms: a rest pose per arm, plus which
// per-kit animation (punching or a one-handed swing) applies on top.
export interface ArmPose {
  armBase: [ArmRest, ArmRest];
  swingArms: boolean;
  swingLeft: boolean;
  punch: boolean;
}

export interface BrawlerModel {
  root: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  torso: THREE.Mesh;
  legs: [THREE.Group, THREE.Group];
  arms: [THREE.Group, THREE.Group];
  weapon: THREE.Group;
  muzzles: THREE.Vector3[];
  pose: ArmPose;
  flashMats: THREE.MeshStandardMaterial[];
  allMats: THREE.MeshStandardMaterial[];
}

const addPart = (
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x = 0,
  y = 0,
  z = 0,
  scaleX = 1,
  scaleY = 1,
  scaleZ = 1,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.scale.set(scaleX, scaleY, scaleZ);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
};

interface KitParts {
  mats: ModelMaterials;
  body: THREE.Group;
  head: THREE.Group;
  skull: THREE.Mesh;
  weapon: THREE.Group;
  fuseGlow: THREE.MeshStandardMaterial;
}

interface Kit {
  muzzles: THREE.Vector3[];
  pose: ArmPose;
}

const buildLeg = (mats: ModelMaterials, side: number): THREE.Group => {
  const leg = new THREE.Group();
  leg.position.set(side * 0.13, 0.37, 0);
  addPart(leg, capsule(0.09, 0.12), mats.dark, 0, -0.13, 0);
  addPart(leg, sphere(0.11), mats.black, 0, -0.3, 0.05, 1, 0.62, 1.5);
  return leg;
};

const buildArm = (mats: ModelMaterials, side: number, isTitan: boolean): THREE.Group => {
  const arm = new THREE.Group();
  arm.position.set(side * (isTitan ? 0.38 : 0.31), 0.8, 0);
  addPart(arm, capsule(0.075, 0.15), isTitan ? mats.skin : mats.body, 0, -0.12, 0);
  const hand = addPart(
    arm,
    sphere(isTitan ? 0.165 : 0.095),
    isTitan ? mats.accent : mats.skin,
    0,
    -0.28,
    0,
    1,
    1,
    isTitan ? 1.12 : 1,
  );
  arm.userData["hand"] = hand;
  return arm;
};

const buildFace = (head: THREE.Group, mats: ModelMaterials) => {
  for (const side of [-1, 1]) {
    addPart(head, sphere(0.075), mats.white, side * 0.115, 0.03, 0.252, 1, 1.2, 0.55);
    addPart(head, sphere(0.04), mats.black, side * 0.112, 0.03, 0.29, 1, 1.2, 0.5);
    const brow = addPart(head, box(0.14, 0.036, 0.04), mats.dark, side * 0.115, 0.14, 0.268);
    brow.rotation.z = -side * 0.32;
  }
};

// Dusty: cowboy hat and a double-barrelled shotgun held at the hip.
const buildDustyKit = ({ mats, head, weapon }: KitParts): Kit => {
  addPart(head, dome(0.325, 0.56), mats.accent, 0, 0.02, -0.025);
  addPart(head, sphere(0.13), mats.accent, 0, 0.03, -0.34);
  addPart(head, sphere(0.09), mats.accent, 0, -0.1, -0.42);
  const brim = addPart(head, torus(0.295, 0.034), mats.body, 0, 0.1, 0);
  brim.rotation.x = Math.PI / 2;
  weapon.position.set(0.02, 0.63, 0.24);
  for (const side of [-1, 1]) {
    const barrel = addPart(
      weapon,
      cylinder(0.045, 0.045, 0.62, 10),
      mats.metal,
      side * 0.046,
      0.02,
      0.36,
    );
    barrel.rotation.x = Math.PI / 2;
  }
  addPart(weapon, box(0.1, 0.13, 0.34), mats.wood, 0, -0.02, -0.06);
  addPart(weapon, box(0.15, 0.085, 0.2), mats.wood, 0, -0.04, 0.3);
  return {
    muzzles: [new THREE.Vector3(0.02, 0.65, 0.95)],
    pose: {
      armBase: [
        [-1.35, 0.55],
        [-1.2, -0.4],
      ],
      punch: false,
      swingArms: false,
      swingLeft: false,
    },
  };
};

// Ace: peaked cap with a wide visor, a belt ring, and twin shoulder pistols.
const buildAceKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  addPart(head, cylinder(0.2, 0.235, 0.21), mats.accent, 0, 0.29, 0);
  addPart(head, cylinder(0.47, 0.47, 0.036, 28), mats.accent, 0, 0.19, 0, 1, 1, 0.92);
  addPart(head, cylinder(0.24, 0.24, 0.055), mats.dark, 0, 0.215, 0);
  const belt = addPart(body, torus(0.19, 0.06), mats.accent, 0, 0.87, 0.02);
  belt.rotation.x = Math.PI / 2;
  weapon.position.set(0, 0.67, 0.34);
  const muzzles: THREE.Vector3[] = [];
  for (const side of [-1, 1]) {
    const barrel = addPart(
      weapon,
      cylinder(0.035, 0.035, 0.32, 8),
      mats.metal,
      side * 0.27,
      0.025,
      0.18,
    );
    barrel.rotation.x = Math.PI / 2;
    const chamber = addPart(
      weapon,
      cylinder(0.058, 0.058, 0.09, 10),
      mats.metal,
      side * 0.27,
      0.025,
      0.03,
    );
    chamber.rotation.x = Math.PI / 2;
    addPart(weapon, box(0.06, 0.14, 0.075), mats.dark, side * 0.27, -0.055, -0.02);
    muzzles.push(new THREE.Vector3(side * 0.27, 0.7, 0.72));
  }
  return {
    muzzles,
    pose: {
      armBase: [
        [-1.45, 0.08],
        [-1.45, -0.08],
      ],
      punch: false,
      swingArms: false,
      swingLeft: false,
    },
  };
};

// Fuse: hard hat with a headlamp, a beard, and a lit bomb in the right hand.
const buildFuseKit = ({ mats, head, weapon, fuseGlow }: KitParts): Kit => {
  addPart(head, dome(0.335, 0.5), mats.accent, 0, 0.04, 0);
  addPart(head, cylinder(0.365, 0.365, 0.035, 24), mats.accent, 0, 0.06, 0.02);
  const lampHousing = addPart(head, cylinder(0.078, 0.078, 0.07, 12), mats.metal, 0, 0.2, 0.3);
  lampHousing.rotation.x = Math.PI / 2;
  const lamp = addPart(head, sphere(0.062), fuseGlow, 0, 0.2, 0.34, 1, 1, 0.4);
  lamp.castShadow = false;
  addPart(head, sphere(0.2), mats.white, 0, -0.17, 0.14, 1.12, 0.8, 0.72);
  weapon.position.set(0.31, 0.66, 0.36);
  addPart(weapon, sphere(0.15), mats.black);
  addPart(weapon, cylinder(0.035, 0.035, 0.07, 8), mats.metal, 0, 0.16, 0);
  const spark = addPart(
    weapon,
    sphere(0.045),
    standardMaterial(0x33_14_00, { emissive: 0xff_8a_2a, emissiveIntensity: 4 }),
    0.01,
    0.23,
    0,
  );
  spark.castShadow = false;
  return {
    muzzles: [new THREE.Vector3(0.31, 0.8, 0.4)],
    pose: {
      armBase: [
        [0, 0.12],
        [-1.3, -0.05],
      ],
      punch: false,
      swingArms: false,
      swingLeft: true,
    },
  };
};

// Titan: bare-knuckle heavyweight with a jaw, a mohawk and shoulder pads.
const buildTitanKit = ({ mats, body, head, skull }: KitParts): Kit => {
  addPart(head, sphere(0.2), mats.skin, 0, -0.085, 0.2, 1, 0.78, 0.5);
  addPart(head, box(0.065, 0.2, 0.44), mats.accent, 0, 0.27, -0.02);
  for (const side of [-1, 1]) {
    addPart(body, sphere(0.14), mats.accent, side * 0.37, 0.88, 0);
  }
  skull.scale.set(1, 0.96, 1);
  return {
    muzzles: [new THREE.Vector3(-0.3, 0.72, 0.55), new THREE.Vector3(0.3, 0.72, 0.55)],
    pose: {
      armBase: [
        [-0.95, 0.25],
        [-0.95, -0.25],
      ],
      punch: true,
      swingArms: false,
      swingLeft: false,
    },
  };
};

const buildKit = (def: BrawlerDef, parts: KitParts): Kit => {
  if (def.id === "dusty") {
    return buildDustyKit(parts);
  }
  if (def.id === "ace") {
    return buildAceKit(parts);
  }
  if (def.id === "fuse") {
    return buildFuseKit(parts);
  }
  return buildTitanKit(parts);
};

const buildMaterials = (def: BrawlerDef, hueShift: number): ModelMaterials => {
  const { palette } = def;
  const mats: ModelMaterials = {
    accent: standardMaterial(palette.accent),
    black: standardMaterial(0x15_15_1b, { roughness: 0.4 }),
    body: standardMaterial(palette.body),
    dark: standardMaterial(palette.dark, { roughness: 0.8 }),
    metal: standardMaterial(0x9a_a1_b2, { metalness: 0.75, roughness: 0.3 }),
    skin: standardMaterial(palette.skin, { roughness: 0.72 }),
    white: standardMaterial(0xff_ff_ff, { roughness: 0.35 }),
    wood: standardMaterial(0x7a_4a_22, { roughness: 0.75 }),
  };
  // Bots get a small hue nudge so two of the same brawler stay telling apart.
  if (hueShift !== 0) {
    mats.body.color.offsetHSL(hueShift, 0, 0);
    mats.accent.color.offsetHSL(hueShift * 0.6, 0, 0);
  }
  return mats;
};

export const buildBrawlerModel = (def: BrawlerDef, hueShift: number): BrawlerModel => {
  const mats = buildMaterials(def, hueShift);
  // Owned by the model (and disposed with it) whether or not this kit uses it.
  const fuseGlow = standardMaterial(0x33_22_00, { emissive: 0xff_d2_7a, emissiveIntensity: 3 });
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const legs: [THREE.Group, THREE.Group] = [buildLeg(mats, -1), buildLeg(mats, 1)];
  root.add(legs[0], legs[1]);

  const isTitan = def.id === "titan";
  const torso = addPart(
    body,
    capsule(0.235, 0.2),
    mats.body,
    0,
    0.6,
    0,
    isTitan ? 1.32 : 1,
    isTitan ? 1.08 : 1,
    isTitan ? 1.12 : 0.86,
  );
  addPart(
    body,
    cylinder(0.245, 0.245, 0.075),
    mats.dark,
    0,
    0.42,
    0,
    isTitan ? 1.28 : 1,
    1,
    isTitan ? 1.1 : 0.88,
  );

  const head = new THREE.Group();
  head.position.set(0, 1.07, 0);
  body.add(head);
  const skull = addPart(
    head,
    sphere(0.3, 24, 18),
    isTitan ? mats.body : mats.skin,
    0,
    0,
    0,
    1,
    0.94,
    0.97,
  );
  buildFace(head, mats);

  const arms: [THREE.Group, THREE.Group] = [
    buildArm(mats, -1, isTitan),
    buildArm(mats, 1, isTitan),
  ];
  body.add(arms[0], arms[1]);

  const weapon = new THREE.Group();
  body.add(weapon);

  const { muzzles, pose } = buildKit(def, { body, fuseGlow, head, mats, skull, weapon });
  const [leftArm, rightArm] = arms;
  const [[leftRestX, leftRestZ], [rightRestX, rightRestZ]] = pose.armBase;
  leftArm.rotation.x = leftRestX;
  leftArm.rotation.z = leftRestZ;
  rightArm.rotation.x = rightRestX;
  rightArm.rotation.z = rightRestZ;

  const flashMats = Object.values(mats);
  return {
    allMats: [...flashMats, fuseGlow],
    arms,
    body,
    flashMats,
    head,
    legs,
    muzzles,
    pose,
    root,
    torso,
    weapon,
  };
};
