import * as THREE from "three";
import type { BrawlerDef, BrawlerId } from "../config";
import { batchBrawlerParts } from "./brawler-batching";
import {
  cylinder,
  dome,
  plate,
  profile,
  roundedBox,
  sphere,
  sweep,
  torus,
} from "./brawler-geometry";
import { sampleMeleePose } from "./melee-pose";

export const TEAM_RING_GEOMETRY = new THREE.RingGeometry(0.5, 0.64, 44).rotateX(-Math.PI / 2);
export const PLAYER_DISC_GEOMETRY = new THREE.CircleGeometry(0.5, 36).rotateX(-Math.PI / 2);
export const SUPER_RING_GEOMETRY = new THREE.RingGeometry(0.7, 0.8, 44).rotateX(-Math.PI / 2);

export const standardMaterial = (
  color: number,
  extra: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, metalness: 0, roughness: 0.78, ...extra });

interface ModelMaterials {
  accent: THREE.MeshStandardMaterial;
  black: THREE.MeshStandardMaterial;
  body: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  gold: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  skinShade: THREE.MeshStandardMaterial;
  white: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
}

export type ArmRest = [rotationX: number, rotationZ: number];
export interface ArmPose {
  armBase: [ArmRest, ArmRest];
  swingArms: boolean;
  swingLeft: boolean;
  punch: boolean;
}

export interface BrawlerModel {
  root: THREE.Group;
  rig: THREE.Group;
  body: THREE.Group;
  head: THREE.Group;
  overheadHeight: number;
  legs: [THREE.Group, THREE.Group];
  arms: [THREE.Group, THREE.Group];
  weapon: THREE.Group;
  offhand: THREE.Group | null;
  loadedProjectile: THREE.Group | null;
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
  weapon: THREE.Group;
  spellGlow: THREE.MeshStandardMaterial;
}

interface Kit {
  loadedProjectile?: THREE.Group;
  shield?: THREE.Group;
  offhand?: THREE.Group;
  muzzles: THREE.Vector3[];
  pose: ArmPose;
}

const restPose = (left: ArmRest, right: ArmRest, swingLeft = true): ArmPose => ({
  armBase: [left, right],
  punch: false,
  swingArms: false,
  swingLeft,
});

const FACE = profile(
  "face",
  [
    [-0.25, 0.025, 0.04, 0.01],
    [-0.235, 0.12, 0.12, 0.025],
    [-0.2, 0.2, 0.185, 0.028],
    [-0.15, 0.25, 0.225, 0.02],
    [-0.075, 0.284, 0.253, 0.005],
    [0, 0.29, 0.267, -0.008],
    [0.08, 0.285, 0.261, -0.015],
    [0.17, 0.252, 0.235, -0.025],
    [0.22, 0.2, 0.193, -0.03],
    [0.25, 0.145, 0.15, -0.03],
    [0.28, 0.005, 0.005, -0.03],
  ],
  0.93,
);
const TUNIC = profile(
  "tunic",
  [
    [-0.25, 0.225, 0.16, 0],
    [-0.2, 0.25, 0.18, 0],
    [-0.08, 0.195, 0.16, 0],
    [0.09, 0.24, 0.18, 0],
    [0.2, 0.275, 0.175, 0],
    [0.27, 0.12, 0.105, 0],
    [0.28, 0.02, 0.02, 0],
  ],
  0.9,
);
const HAND = profile(
  "glove",
  [
    [-0.085, 0.043, 0.055, 0.025],
    [-0.06, 0.065, 0.07, 0.016],
    [0.025, 0.071, 0.063, 0],
    [0.08, 0.045, 0.043, 0],
  ],
  0.7,
);
const BOOT = profile(
  "boot",
  [
    [0, 0.105, 0.15, 0.055],
    [0.025, 0.11, 0.155, 0.055],
    [0.08, 0.105, 0.145, 0.06],
    [0.12, 0.085, 0.09, 0.005],
    [0.23, 0.08, 0.075, 0],
  ],
  0.75,
);
const SHIELD = plate(
  "kite-shield",
  [
    [-0.22, 0.25],
    [0.22, 0.25],
    [0.245, 0.02],
    [0.17, -0.19],
    [0, -0.35],
    [-0.17, -0.19],
    [-0.245, 0.02],
  ],
  0.055,
);
const LEAF = plate(
  "leaf",
  [
    [0, 0.23],
    [0.11, 0.08],
    [0.105, -0.07],
    [0, -0.2],
    [-0.105, -0.07],
    [-0.11, 0.08],
  ],
  0.025,
  0.015,
);

const buildLeg = (mats: ModelMaterials, side: number, armored: boolean): THREE.Group => {
  const leg = new THREE.Group();
  leg.position.set(side * 0.13, 0.37, 0);
  addPart(leg, cylinder(0.09, 0.073, 0.23), mats.dark, 0, -0.1, 0);
  addPart(leg, BOOT, armored ? mats.metal : mats.wood, 0, -0.35, 0, 1.12, 1, 1.1);
  addPart(leg, roundedBox(0.25, 0.032, 0.345), mats.dark, 0, -0.345, 0.06);
  addPart(
    leg,
    cylinder(0.113, 0.104, 0.055),
    armored ? mats.gold : mats.wood,
    0,
    -0.15,
    0,
    1,
    1,
    0.9,
  );
  if (armored) {
    addPart(leg, sphere(0.108, 12, 8), mats.gold, 0, -0.095, 0.075, 1, 0.87, 0.55);
    addPart(leg, sphere(0.08, 12, 8), mats.metal, 0, -0.091, 0.115, 1, 0.82, 0.4);
  } else {
    addPart(leg, roundedBox(0.15, 0.045, 0.025), mats.gold, 0, -0.175, 0.087);
  }
  return leg;
};

const buildArm = (
  mats: ModelMaterials,
  side: number,
  broad: boolean,
  armored: boolean,
): THREE.Group => {
  const arm = new THREE.Group();
  arm.position.set(side * (broad ? 0.38 : 0.31), 0.8, 0);
  const sleeve = addPart(
    arm,
    profile(
      "sleeve",
      [
        [-0.23, 0.078, 0.08, 0],
        [-0.17, 0.095, 0.095, 0],
        [-0.05, 0.103, 0.1, 0],
        [0.035, 0.125, 0.118, 0],
        [0.085, 0.075, 0.075, 0],
      ],
      0.85,
    ),
    armored ? mats.metal : mats.body,
  );
  sleeve.scale.setScalar(broad ? 1.12 : 1);
  addPart(arm, cylinder(0.097, 0.09, 0.06), armored ? mats.gold : mats.wood, 0, -0.22, 0);
  if (armored) {
    const shoulderSize = broad ? 1.2 : 1;
    addPart(arm, sphere(0.176), mats.gold, side * 0.035, 0.015, 0, shoulderSize, 0.7, 1.08);
    addPart(arm, sphere(0.156), mats.metal, side * 0.035, 0.046, 0, shoulderSize, 0.7, 1.08);
  }
  addPart(
    arm,
    HAND,
    armored ? mats.metal : mats.skin,
    0,
    -0.29,
    0.005,
    broad ? 1.4 : 1.17,
    1.12,
    broad ? 1.3 : 1.12,
  );
  addPart(
    arm,
    sphere(0.034),
    armored ? mats.metal : mats.skin,
    -side * 0.063,
    -0.27,
    0.04,
    0.85,
    1.4,
    0.95,
  );
  return arm;
};

interface FaceFeatures {
  width: number;
  eyeSize: number;
  eyeSpacing: number;
  browTilt: number;
  smile: number;
}

const FACES: Record<BrawlerId, FaceFeatures> = {
  ace: { browTilt: 0.18, eyeSize: 1.02, eyeSpacing: 0.112, smile: 0.15, width: 0.97 },
  dusty: { browTilt: 0.25, eyeSize: 1, eyeSpacing: 0.12, smile: -0.2, width: 1.04 },
  flint: { browTilt: 0.22, eyeSize: 0.85, eyeSpacing: 0.125, smile: 0, width: 1.08 },
  fuse: { browTilt: 0.17, eyeSize: 1.08, eyeSpacing: 0.114, smile: 0.2, width: 1 },
  moss: { browTilt: -0.12, eyeSize: 0.8, eyeSpacing: 0.117, smile: 0.1, width: 1.04 },
  nyx: { browTilt: 0.3, eyeSize: 0.96, eyeSpacing: 0.108, smile: 0.28, width: 0.94 },
  pip: { browTilt: -0.08, eyeSize: 1.12, eyeSpacing: 0.117, smile: 0.08, width: 1.05 },
  rowan: { browTilt: 0.2, eyeSize: 1, eyeSpacing: 0.114, smile: -0.1, width: 0.99 },
  titan: { browTilt: 0.25, eyeSize: 0.85, eyeSpacing: 0.12, smile: 0, width: 1.06 },
};

const buildFace = (head: THREE.Group, mats: ModelMaterials, id: BrawlerId): void => {
  const face = FACES[id];
  addPart(head, FACE, mats.skin, 0, 0, 0, face.width, 1, 1);
  for (const side of [-1, 1]) {
    addPart(
      head,
      sphere(0.068, 12, 8),
      mats.skin,
      side * 0.277 * face.width,
      -0.065,
      0.015,
      0.75,
      1.1,
      0.7,
    );
    addPart(
      head,
      sphere(0.034, 10, 8),
      mats.skinShade,
      side * 0.306 * face.width,
      -0.066,
      0.043,
      0.4,
      1.1,
      0.4,
    );
    const eyeX = side * face.eyeSpacing;
    addPart(
      head,
      sphere(0.046),
      mats.black,
      eyeX,
      -0.009,
      0.248,
      0.76 * face.eyeSize,
      1.18 * face.eyeSize,
      0.47,
    );
    addPart(head, sphere(0.012, 10, 8), mats.white, eyeX - 0.009, 0.008, 0.268, 0.8, 1, 0.35);
    const brow = addPart(
      head,
      sweep(
        "brow",
        [
          [-0.041, 0, 0, 0.006],
          [-0.015, 0.009, 0.003, 0.014],
          [0.023, 0.006, 0.003, 0.013],
          [0.047, -0.002, 0, 0.003],
        ],
        0.7,
      ),
      mats.hair,
      eyeX,
      0.091,
      0.255,
    );
    brow.rotation.z = side * face.browTilt;
  }
  addPart(head, sphere(0.032, 12, 8), mats.skin, 0, -0.066, 0.258, 1, 0.8, 0.7);
  const mouth = addPart(
    head,
    sweep(
      "smile",
      [
        [-0.028, 0.004, 0, 0.004],
        [0, -0.005, 0.006, 0.006],
        [0.029, 0.006, 0, 0.003],
      ],
      0.7,
    ),
    mats.black,
    0,
    -0.143,
    0.245,
  );
  mouth.rotation.z = face.smile;
};

const collar = (body: THREE.Group, mats: ModelMaterials): void => {
  const cuff = addPart(body, torus(0.137, 0.042), mats.white, 0, 0.85, 0);
  cuff.rotation.x = Math.PI / 2;
};

const cape = (body: THREE.Group, material: THREE.Material, width = 1, length = 1): void => {
  const cloth = addPart(
    body,
    plate(
      "cape",
      [
        [-0.16, 0.27],
        [0.16, 0.27],
        [0.26, -0.25],
        [0.08, -0.2],
        [0, -0.27],
        [-0.26, -0.25],
      ],
      0.035,
      0.02,
    ),
    material,
    0,
    0.56,
    -0.24,
    width,
    length,
    1,
  );
  cloth.rotation.x = -0.2;
  for (const side of [-1, 1]) {
    addPart(
      body,
      sweep(
        "cape-fold",
        [
          [0, 0.26, 0, 0.035],
          [0.015, 0, -0.03, 0.032],
          [0.055, -0.24, -0.02, 0.008],
        ],
        0.45,
      ),
      material,
      side * 0.09,
      0.56,
      -0.27,
      side,
      length,
      1,
    );
  }
};

const hairLock = (
  head: THREE.Group,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  rotation = 0,
  scale = 1,
): void => {
  const lock = addPart(
    head,
    sweep(
      "hair-lock",
      [
        [-0.065, 0.15, -0.04, 0.05],
        [-0.025, 0.115, 0.035, 0.105],
        [0.048, 0.04, 0.075, 0.11],
        [0.073, -0.055, 0.085, 0.065],
        [0.02, -0.135, 0.06, 0.002],
      ],
      0.7,
    ),
    material,
    x,
    y,
    z,
    scale,
    scale,
    scale,
  );
  lock.rotation.z = rotation;
};

const fringe = (head: THREE.Group, mats: ModelMaterials): void => {
  addPart(head, sphere(0.29, 20, 14), mats.hair, 0, -0.015, -0.105, 0.98, 0.9, 0.68);
  addPart(head, dome(0.305, 0.48), mats.hair, 0, 0.045, -0.035, 1, 1.02, 1);
  hairLock(head, mats.hair, -0.16, 0.145, 0.16, -0.5, 0.75);
  hairLock(head, mats.hair, -0.01, 0.17, 0.18, -0.5, 0.85);
  hairLock(head, mats.hair, 0.15, 0.18, 0.13, -0.35, 0.68);
};

const belt = (body: THREE.Group, mats: ModelMaterials, width: number): void => {
  addPart(body, cylinder(0.211, 0.216, 0.075), mats.wood, 0, 0.47, 0, width, 1, 0.84);
  addPart(body, roundedBox(0.1, 0.09, 0.045), mats.gold, 0, 0.47, 0.178);
  addPart(body, roundedBox(0.04, 0.039, 0.05), mats.dark, 0, 0.47, 0.19);
};

const sword = (weapon: THREE.Group, mats: ModelMaterials, short = false): void => {
  addPart(weapon, cylinder(0.034, 0.04, 0.19, 8), mats.wood, 0, 0.02, 0);
  addPart(weapon, sphere(0.058, 10, 8), mats.gold, 0, -0.095, 0, 1, 0.8, 0.8);
  const guard = addPart(
    weapon,
    sweep(
      "sword-guard",
      [
        [-0.19, 0.032, 0, 0.03],
        [-0.1, 0, 0, 0.043],
        [0.1, 0, 0, 0.043],
        [0.19, 0.032, 0, 0.03],
      ],
      1,
    ),
    mats.gold,
    0,
    0.125,
    0,
  );
  guard.scale.x = short ? 0.75 : 1;
  addPart(
    weapon,
    plate(
      short ? "dagger" : "sword",
      short
        ? [
            [-0.065, 0.15],
            [0.065, 0.15],
            [0.075, 0.39],
            [0, 0.65],
            [-0.075, 0.39],
          ]
        : [
            [-0.115, 0.17],
            [0.115, 0.17],
            [0.108, 0.7],
            [0, 0.96],
            [-0.108, 0.7],
          ],
      0.055,
      0.015,
    ),
    mats.metal,
  );
  addPart(
    weapon,
    roundedBox(0.019, short ? 0.31 : 0.56, 0.068),
    mats.metal,
    0,
    short ? 0.32 : 0.43,
    0,
  );
};

const breastplate = (body: THREE.Group, mats: ModelMaterials): void => {
  addPart(
    body,
    profile("knight-breastplate", [
      [-0.17, 0.207, 0.163, 0],
      [-0.115, 0.239, 0.205, 0.014],
      [-0.01, 0.263, 0.23, 0.018],
      [0.1, 0.251, 0.208, 0.006],
      [0.17, 0.198, 0.153, 0],
      [0.21, 0.125, 0.11, 0],
    ]),
    mats.metal,
    0,
    0.665,
    0,
  );
  addPart(body, cylinder(0.226, 0.223, 0.045, 20), mats.gold, 0, 0.51, 0.012, 1, 1, 0.81);
  addPart(body, LEAF, mats.gold, 0, 0.66, 0.265, 0.4, 0.4, 0.65);
  for (const side of [-1, 1]) {
    const skirt = addPart(body, SHIELD, mats.metal, side * 0.135, 0.385, 0.105, 0.51, 0.32, 0.9);
    skirt.rotation.set(-0.22, side * 0.25, -side * 0.12);
  }
};

const buildBriarKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  addPart(head, sphere(0.285), mats.hair, 0, -0.075, -0.125, 0.95, 0.56, 0.62);
  addPart(head, dome(0.323, 0.49), mats.metal, 0, 0.085, -0.034, 1, 0.97, 1.01);
  addPart(
    head,
    sweep(
      "helm-ridge",
      [
        [0, 0.36, -0.14, 0.025],
        [0, 0.39, 0.02, 0.03],
        [0, 0.26, 0.29, 0.025],
      ],
      0.75,
    ),
    mats.gold,
  );
  addPart(
    head,
    sweep(
      "briar-plume",
      [
        [0, 0.36, -0.06, 0.07],
        [0, 0.55, -0.19, 0.12],
        [0, 0.57, -0.36, 0.125],
        [0, 0.43, -0.52, 0.105],
        [0, 0.3, -0.55, 0.004],
      ],
      0.72,
    ),
    mats.body,
  );
  for (const side of [-1, 1]) {
    addPart(
      head,
      plate(
        "cheek-guard",
        [
          [-0.045, 0.11],
          [0.07, 0.12],
          [0.065, -0.13],
          [-0.04, -0.1],
        ],
        0.085,
      ),
      mats.metal,
      side * 0.258,
      -0.035,
      0.094,
      side,
      1,
      1,
    );
    addPart(head, sphere(0.044, 10, 8), mats.gold, side * 0.298, -0.005, 0.147, 0.55, 1, 1);
  }
  addPart(
    head,
    sweep(
      "briar-brow-plate",
      [
        [-0.277, 0.11, 0.115, 0.044],
        [-0.2, 0.095, 0.242, 0.046],
        [0, 0.069, 0.305, 0.048],
        [0.2, 0.095, 0.242, 0.046],
        [0.277, 0.11, 0.115, 0.044],
      ],
      0.65,
    ),
    mats.metal,
  );
  breastplate(body, mats);
  cape(body, mats.body);
  collar(body, mats);
  const shield = new THREE.Group();
  shield.scale.setScalar(1.14);
  addPart(shield, SHIELD, mats.gold);
  addPart(shield, SHIELD, mats.metal, 0, 0, 0.027, 0.95, 0.95, 0.8);
  addPart(shield, SHIELD, mats.body, 0, 0, 0.063, 0.79, 0.8, 0.5);
  addPart(shield, LEAF, mats.gold, 0, -0.015, 0.096, 0.73, 0.75, 0.65);
  addPart(shield, roundedBox(0.024, 0.27, 0.032), mats.metal, 0, -0.015, 0.12);
  sword(weapon, mats);
  return {
    muzzles: [new THREE.Vector3(0.36, 0.7, 0.6)],
    pose: restPose([-0.45, -0.2], [-0.65, 0.3]),
    shield,
  };
};

const buildWrenKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  addPart(head, sphere(0.305, 20, 14), mats.body, 0, -0.005, -0.135, 1, 0.88, 0.7);
  addPart(head, dome(0.337, 0.55), mats.body, 0, 0.065, -0.07, 1.02, 1.05, 1);
  addPart(
    head,
    sweep(
      "hood-tip",
      [
        [0, 0.2, -0.08, 0.22],
        [0, 0.35, -0.2, 0.17],
        [0, 0.41, -0.39, 0.003],
      ],
      0.8,
    ),
    mats.body,
  );
  addPart(
    head,
    sweep(
      "hood-bang",
      [
        [-0.16, 0.19, 0.19, 0.045],
        [-0.12, 0.11, 0.255, 0.058],
        [-0.15, 0.03, 0.278, 0.037],
        [-0.21, -0.02, 0.25, 0.002],
      ],
      0.55,
    ),
    mats.hair,
  );
  for (const side of [-1, 1]) {
    hairLock(head, mats.hair, side * 0.24, -0.018, 0.01, -side * 0.3, 0.82);
    addPart(
      head,
      sweep(
        "hood-rim",
        [
          [0.01, 0.28, 0, 0.047],
          [0.22, 0.12, 0.03, 0.042],
          [0.27, -0.12, -0.01, 0.038],
          [0.13, -0.25, -0.06, 0.025],
        ],
        0.8,
      ),
      mats.accent,
      0,
      0,
      0.075,
      side,
      1,
      1,
    );
  }
  cape(body, mats.body, 1.15, 1.13);
  collar(body, mats);
  for (const side of [-1, 1]) {
    addPart(body, LEAF, mats.body, side * 0.145, 0.76, 0.15, 0.9, 0.64, 1).rotation.z = side * 0.72;
    addPart(body, LEAF, mats.body, side * 0.12, 0.36, 0.13, 0.85, 0.6, 1).rotation.z = side * 0.25;
  }
  const strap = addPart(body, roundedBox(0.07, 0.5, 0.043), mats.wood, 0, 0.66, 0.18);
  strap.rotation.z = -0.6;
  addPart(body, cylinder(0.105, 0.09, 0.44), mats.wood, -0.23, 0.69, -0.26);
  for (const offset of [-0.06, 0, 0.06]) {
    addPart(body, cylinder(0.01, 0.01, 0.36, 5), mats.accent, -0.23 + offset, 0.98, -0.26);
    addPart(
      body,
      plate(
        "fletching",
        [
          [-0.028, -0.035],
          [0, 0.06],
          [0.028, -0.035],
        ],
        0.008,
        0.005,
      ),
      mats.white,
      -0.23 + offset,
      1.12,
      -0.26,
    );
  }
  weapon.position.set(0.1, 0.77, 0.42);
  addPart(
    weapon,
    sweep("longbow", [
      [0.13, -0.48, -0.08, 0.02],
      [0.29, -0.3, 0.035, 0.037],
      [0.36, 0, 0.13, 0.044],
      [0.29, 0.3, 0.035, 0.037],
      [0.13, 0.48, -0.08, 0.02],
    ]),
    mats.wood,
  );
  addPart(weapon, cylinder(0.007, 0.007, 0.96, 4), mats.white, 0.13, 0, -0.08);
  addPart(weapon, roundedBox(0.09, 0.16, 0.09), mats.gold, 0.35, 0, 0.12);
  const loadedProjectile = new THREE.Group();
  weapon.add(loadedProjectile);
  const arrow = addPart(
    loadedProjectile,
    cylinder(0.012, 0.012, 0.76, 5),
    mats.accent,
    0.13,
    0,
    0.18,
  );
  arrow.rotation.x = Math.PI / 2;
  const arrowhead = addPart(
    loadedProjectile,
    cylinder(0, 0.04, 0.13, 4),
    mats.metal,
    0.13,
    0,
    0.62,
  );
  arrowhead.rotation.x = Math.PI / 2;
  return {
    loadedProjectile,
    muzzles: [new THREE.Vector3(0.23, 0.77, 1.04)],
    pose: restPose([-1.45, 0.55], [-1.3, -0.3], false),
  };
};

const buildEmberKit = ({ mats, body, head, weapon, spellGlow }: KitParts): Kit => {
  for (const side of [-1, 1]) {
    hairLock(head, mats.hair, side * 0.255, -0.1, -0.02, side * 0.12, 1.3);
    hairLock(head, mats.hair, side * 0.25, -0.065, -0.145, -side * 0.25, 1.45);
  }
  fringe(head, mats);
  addPart(
    body,
    profile(
      "robe",
      [
        [-0.3, 0.29, 0.225, 0],
        [-0.24, 0.3, 0.24, 0],
        [0, 0.2, 0.15, 0],
        [0.2, 0.24, 0.18, 0],
      ],
      0.9,
    ),
    mats.body,
    0,
    0.53,
    0,
  );
  const hem = addPart(body, torus(0.293, 0.026), mats.accent, 0, 0.24, 0, 1, 0.78, 1);
  hem.rotation.x = Math.PI / 2;
  addPart(
    head,
    profile(
      "witch-brim",
      [
        [-0.025, 0.41, 0.35, 0],
        [0, 0.475, 0.41, 0],
        [0.035, 0.43, 0.37, 0],
      ],
      0.92,
    ),
    mats.body,
    0,
    0.22,
    -0.025,
  );
  addPart(
    head,
    sweep(
      "witch-hat",
      [
        [0, 0.29, -0.03, 0.275],
        [0.01, 0.52, -0.04, 0.19],
        [0.065, 0.73, -0.04, 0.095],
        [0.18, 0.83, -0.035, 0.04],
        [0.3, 0.76, -0.03, 0.002],
      ],
      0.94,
    ),
    mats.body,
  );
  addPart(head, cylinder(0.248, 0.277, 0.07, 20), mats.gold, 0.005, 0.3, -0.03);
  addPart(
    head,
    plate(
      "moon-brooch",
      [
        [0.045, 0.085],
        [0, 0.07],
        [-0.025, 0.033],
        [-0.012, -0.01],
        [0.025, -0.034],
        [0.066, -0.028],
        [0.037, -0.065],
        [-0.012, -0.076],
        [-0.062, -0.045],
        [-0.077, 0.005],
        [-0.052, 0.06],
        [0, 0.088],
      ],
      0.016,
      0.007,
    ),
    mats.gold,
    0.04,
    0.42,
    0.193,
  );
  collar(body, mats);
  addPart(body, LEAF, mats.accent, 0, 0.8, 0.19, 0.38, 0.35, 0.7);
  weapon.position.set(0.4, 0.65, 0.26);
  addPart(
    weapon,
    sweep("ember-staff", [
      [0.03, -0.47, 0, 0.037],
      [-0.025, 0.08, 0, 0.044],
      [0.015, 0.5, 0, 0.035],
      [0, 0.69, 0, 0.031],
    ]),
    mats.gold,
  );
  addPart(weapon, cylinder(0.055, 0.055, 0.16, 8), mats.wood, 0, -0.05, 0);
  for (const side of [-1, 1]) {
    addPart(
      weapon,
      sweep("staff-crook", [
        [0, 0.57, 0, 0.035],
        [0.145, 0.68, 0, 0.035],
        [0.12, 0.89, 0, 0.021],
        [0.06, 0.95, 0, 0.006],
      ]),
      mats.gold,
      0,
      0,
      0,
      side,
      1,
      1,
    );
  }
  addPart(weapon, sphere(0.112, 16, 12), spellGlow, 0, 0.8, 0);
  return {
    muzzles: [new THREE.Vector3(0.4, 1.46, 0.3)],
    pose: restPose([0, 0.15], [-0.85, -0.22]),
  };
};

const buildRookKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  addPart(
    head,
    profile(
      "rook-helm",
      [
        [-0.2, 0.25, 0.27, 0],
        [-0.13, 0.325, 0.315, 0],
        [0.17, 0.33, 0.31, 0],
        [0.29, 0.245, 0.235, -0.01],
        [0.33, 0.005, 0.005, -0.015],
      ],
      0.64,
    ),
    mats.metal,
  );
  addPart(head, roundedBox(0.4, 0.068, 0.035), mats.dark, 0, 0.04, 0.315);
  addPart(head, roundedBox(0.052, 0.25, 0.055), mats.gold, 0, 0.012, 0.338);
  for (const side of [-1, 1]) {
    addPart(
      head,
      sweep(
        "helm-fin",
        [
          [0, 0.2, 0.2, 0.025],
          [0, 0.37, 0.03, 0.043],
          [0, 0.29, -0.24, 0.02],
        ],
        0.6,
      ),
      mats.gold,
      side * 0.18,
      0,
      0,
    );
    addPart(head, roundedBox(0.045, 0.065, 0.033), mats.dark, side * 0.145, -0.095, 0.313);
    addPart(body, SHIELD, mats.metal, side * 0.18, 0.41, 0.18, 0.48, 0.42, 0.8);
  }
  addPart(
    body,
    profile(
      "cuirass",
      [
        [-0.2, 0.22, 0.18, 0],
        [-0.12, 0.275, 0.22, 0],
        [0.07, 0.325, 0.23, 0],
        [0.16, 0.28, 0.2, 0],
        [0.23, 0.115, 0.09, 0],
      ],
      0.7,
    ),
    mats.metal,
    0,
    0.68,
    0.025,
  );
  addPart(
    body,
    plate(
      "rook-emblem",
      [
        [-0.075, 0.11],
        [0.075, 0.11],
        [0.075, -0.07],
        [0, -0.13],
        [-0.075, -0.07],
      ],
      0.025,
    ),
    mats.gold,
    0,
    0.67,
    0.266,
  );
  cape(body, mats.body, 1.35, 1.15);
  addPart(weapon, cylinder(0.043, 0.055, 0.86, 10), mats.wood, 0, 0.23, 0);
  addPart(weapon, cylinder(0.058, 0.058, 0.2, 10), mats.dark, 0, -0.04, 0);
  addPart(weapon, roundedBox(0.64, 0.31, 0.32), mats.metal, 0, 0.71, 0);
  addPart(weapon, roundedBox(0.17, 0.345, 0.36), mats.gold, 0, 0.71, 0);
  for (const side of [-1, 1]) {
    addPart(weapon, roundedBox(0.085, 0.3, 0.3), mats.dark, side * 0.315, 0.71, 0);
    addPart(weapon, roundedBox(0.092, 0.21, 0.21), mats.metal, side * 0.345, 0.71, 0);
  }
  return {
    muzzles: [new THREE.Vector3(0.46, 1.25, 0.4)],
    pose: restPose([-0.45, -0.3], [-0.7, 0.3]),
  };
};

const buildRowanKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  addPart(head, sphere(0.285), mats.hair, 0, -0.075, -0.125, 0.95, 0.56, 0.62);
  addPart(head, dome(0.318, 0.47), mats.metal, 0, 0.072, -0.045);
  addPart(
    head,
    sweep(
      "lancer-crest",
      [
        [0, 0.24, 0.24, 0.045],
        [0, 0.5, 0.06, 0.12],
        [0, 0.47, -0.23, 0.13],
        [0, 0.18, -0.37, 0.004],
      ],
      0.47,
    ),
    mats.hair,
  );
  for (const side of [-1, 1]) {
    addPart(
      head,
      plate(
        "lancer-cheek",
        [
          [-0.045, 0.1],
          [0.065, 0.15],
          [0.06, -0.11],
          [-0.025, -0.15],
        ],
        0.047,
      ),
      mats.gold,
      side * 0.27,
      -0.04,
      0.04,
      side,
      1,
      1,
    );
    addPart(head, sphere(0.04, 10, 8), mats.gold, side * 0.288, 0.025, 0.1, 0.5, 1, 1);
  }
  addPart(
    head,
    sweep(
      "lancer-brow",
      [
        [-0.28, 0.1, 0.105, 0.029],
        [-0.19, 0.085, 0.25, 0.034],
        [0, 0.1, 0.29, 0.034],
        [0.19, 0.085, 0.25, 0.034],
        [0.28, 0.1, 0.105, 0.029],
      ],
      0.7,
    ),
    mats.gold,
  );
  breastplate(body, mats);
  cape(body, mats.hair, 0.85, 1.1);
  collar(body, mats);
  const pose = restPose([-0.55, -0.2], [-2.05, 0.22]);
  const [, rightRest] = pose.armBase;
  weapon.position.copy(
    new THREE.Vector3(0, -0.28, 0)
      .applyEuler(new THREE.Euler(rightRest[0], 0, rightRest[1]))
      .add(new THREE.Vector3(0.31, 0.8, 0)),
  );
  weapon.rotation.set(1.25, 0, -0.12);
  // A throwing grip balances the shaft, with the butt behind the shoulder.
  const javelin = new THREE.Group();
  javelin.position.y = -0.45;
  weapon.add(javelin);
  addPart(javelin, cylinder(0.027, 0.034, 1.31, 10), mats.wood, 0, 0.29, 0);
  addPart(javelin, cylinder(0.045, 0.045, 0.18, 10), mats.dark, 0, 0.015, 0);
  addPart(javelin, cylinder(0.038, 0.04, 0.16, 10), mats.gold, 0, 0.9, 0);
  addPart(
    javelin,
    plate(
      "spearhead",
      [
        [0, 1.41],
        [0.13, 1.09],
        [0.04, 0.96],
        [-0.04, 0.96],
        [-0.13, 1.09],
      ],
      0.032,
      0.013,
    ),
    mats.metal,
  );
  addPart(javelin, roundedBox(0.017, 0.31, 0.065), mats.gold, 0, 1.135, 0);
  const pennant = addPart(
    javelin,
    plate(
      "pennant",
      [
        [0, 0.12],
        [0.35, 0.075],
        [0.22, -0.01],
        [0.34, -0.1],
        [0, -0.08],
      ],
      0.013,
      0.012,
    ),
    mats.hair,
    0.03,
    0.81,
    0,
  );
  pennant.rotation.y = -0.4;
  return {
    muzzles: [new THREE.Vector3(0, 0.96, 0).applyEuler(weapon.rotation).add(weapon.position)],
    pose,
  };
};

const buildNyxKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  fringe(head, mats);
  hairLock(head, mats.hair, -0.2, 0.01, 0.075, -0.18, 1.5);
  hairLock(head, mats.hair, 0.2, 0.15, -0.03, 0.45, 1.1);
  hairLock(head, mats.hair, 0.19, 0.1, -0.18, 0.7, 1.1);
  addPart(
    head,
    sweep(
      "nyx-crest",
      [
        [-0.22, 0.21, -0.13, 0.11],
        [-0.05, 0.4, -0.06, 0.15],
        [0.19, 0.33, 0.08, 0.11],
        [0.31, 0.13, 0.12, 0.002],
      ],
      0.65,
    ),
    mats.hair,
  );
  addPart(head, torus(0.035, 0.009), mats.accent, 0.3, -0.1, 0.018);
  const scarf = addPart(body, torus(0.18, 0.06), mats.accent, 0, 0.86, 0);
  scarf.rotation.x = Math.PI / 2;
  const tail = addPart(
    body,
    plate(
      "scarf-tail",
      [
        [-0.045, 0.22],
        [0.045, 0.24],
        [0.18, -0.12],
        [0.11, -0.24],
        [0.08, -0.19],
        [0.025, -0.23],
      ],
      0.018,
    ),
    mats.accent,
    -0.18,
    0.7,
    -0.27,
  );
  tail.rotation.z = -0.42;
  addPart(
    body,
    profile("rogue-vest", [
      [-0.18, 0.2, 0.163, 0],
      [-0.1, 0.204, 0.179, 0],
      [0.08, 0.238, 0.19, 0],
      [0.18, 0.2, 0.15, 0],
      [0.21, 0.12, 0.095, 0],
    ]),
    mats.dark,
    0,
    0.66,
    0.016,
  );
  for (const side of [-1, 1]) {
    const strap = addPart(body, roundedBox(0.037, 0.34, 0.06), mats.wood, side * 0.11, 0.67, 0.18);
    strap.rotation.z = side * 0.3;
    addPart(body, roundedBox(0.12, 0.19, 0.13), mats.dark, side * 0.235, 0.42, -0.035);
  }
  sword(weapon, mats, true);
  const offhand = new THREE.Group();
  sword(offhand, mats, true);
  return {
    muzzles: [new THREE.Vector3(0.35, 0.75, 0.6)],
    offhand,
    pose: restPose([-0.8, -0.3], [-0.8, 0.3], false),
  };
};

const buildMossKit = ({ mats, body, head, weapon, spellGlow }: KitParts): Kit => {
  fringe(head, mats);
  for (const side of [-1, 1]) {
    hairLock(head, mats.hair, side * 0.215, -0.05, -0.05, side * 0.15, 1.13);
    addPart(
      head,
      sweep("antler", [
        [0, 0.16, -0.02, 0.044],
        [0.15, 0.38, -0.06, 0.039],
        [0.24, 0.56, -0.02, 0.025],
        [0.2, 0.69, 0.02, 0.002],
      ]),
      mats.wood,
      side * 0.2,
      0,
      0,
      side,
      1,
      1,
    );
    addPart(
      head,
      sweep("antler-tine", [
        [0, 0, 0, 0.027],
        [0.14, 0.06, -0.04, 0.021],
        [0.16, 0.19, -0.03, 0.002],
      ]),
      mats.wood,
      side * 0.34,
      0.35,
      -0.035,
      side,
      1,
      1,
    );
    addPart(head, LEAF, mats.body, side * 0.24, 0.19, 0.08, 0.48, 0.42, 0.8).rotation.z =
      side * 0.8;
  }
  addPart(
    head,
    sweep(
      "druid-beard",
      [
        [0, -0.12, 0.2, 0.12],
        [0, -0.25, 0.22, 0.145],
        [0.07, -0.39, 0.2, 0.015],
      ],
      0.55,
    ),
    mats.hair,
  );
  cape(body, mats.body, 1.2, 1.2);
  for (let i = 0; i < 7; i += 1) {
    const angle = (i / 7) * Math.PI * 2;
    const leaf = addPart(
      body,
      LEAF,
      i % 2 === 0 ? mats.body : mats.accent,
      Math.cos(angle) * 0.21,
      0.76,
      Math.sin(angle) * 0.17,
      0.9,
      0.8,
      1,
    );
    leaf.rotation.set(-0.2, -angle + Math.PI / 2, Math.cos(angle) * 0.35);
  }
  weapon.position.set(0.4, 0.65, 0.26);
  addPart(
    weapon,
    sweep("root-staff", [
      [0.035, -0.47, 0, 0.05],
      [-0.04, -0.1, 0, 0.035],
      [0.04, 0.37, 0, 0.038],
      [-0.06, 0.65, 0, 0.046],
      [0.1, 0.81, 0, 0.04],
      [0.22, 0.7, 0, 0.02],
      [0.1, 0.57, 0, 0.003],
    ]),
    mats.wood,
  );
  addPart(weapon, LEAF, mats.body, -0.04, 0.76, 0, 0.65, 0.6, 1).rotation.z = 0.7;
  spellGlow.color.setHex(0xc6_e6_85);
  spellGlow.emissive.setHex(0x50_77_22);
  addPart(weapon, sphere(0.075, 10, 8), spellGlow, 0.105, 0.66, 0);
  return {
    muzzles: [new THREE.Vector3(0.5, 1.31, 0.3)],
    pose: restPose([-0.3, -0.17], [-0.85, -0.22]),
  };
};

const buildFlintKit = ({ mats, body, head, weapon }: KitParts): Kit => {
  addPart(head, sphere(0.31, 20, 14), mats.wood, 0, -0.005, -0.145, 1, 0.8, 0.64);
  addPart(head, dome(0.336, 0.54), mats.wood, 0, 0.06, -0.065, 1.09, 0.96, 1.02);
  for (const side of [-1, 1]) {
    addPart(
      head,
      plate(
        "hood-flap",
        [
          [-0.07, 0.14],
          [0.09, 0.17],
          [0.085, -0.2],
          [-0.05, -0.14],
        ],
        0.045,
      ),
      mats.wood,
      side * 0.275,
      -0.01,
      -0.03,
      side,
      1,
      1,
    );
    hairLock(head, mats.hair, side * 0.12, -0.15, 0.19, -side * 0.45, 0.8);
    addPart(body, roundedBox(0.19, 0.18, 0.24), mats.metal, side * 0.3, 0.8, 0);
  }
  addPart(
    head,
    sweep(
      "hood-bang",
      [
        [-0.16, 0.19, 0.19, 0.045],
        [-0.12, 0.11, 0.255, 0.058],
        [-0.15, 0.03, 0.278, 0.037],
        [-0.21, -0.02, 0.25, 0.002],
      ],
      0.55,
    ),
    mats.hair,
  );
  addPart(
    head,
    sweep(
      "flint-beard",
      [
        [0, -0.13, 0.19, 0.095],
        [0, -0.23, 0.22, 0.1],
        [0, -0.32, 0.225, 0.05],
        [0, -0.37, 0.21, 0.003],
      ],
      0.55,
    ),
    mats.hair,
  );
  addPart(head, roundedBox(0.46, 0.055, 0.047), mats.accent, 0, 0.19, 0.218);
  addPart(body, roundedBox(0.36, 0.3, 0.07), mats.wood, 0, 0.63, 0.175);
  collar(body, mats);
  for (const x of [-0.1, 0, 0.1]) {
    addPart(body, roundedBox(0.062, 0.16, 0.07), mats.accent, x, 0.64, 0.23);
  }
  weapon.position.set(0.06, 0.69, 0.34);
  addPart(weapon, roundedBox(0.13, 0.13, 0.68), mats.wood, 0, 0, 0.17);
  addPart(weapon, roundedBox(0.17, 0.045, 0.43), mats.metal, 0, 0.084, 0.24);
  addPart(
    weapon,
    sweep(
      "crossbow-limb",
      [
        [-0.45, 0, 0.22, 0.026],
        [-0.29, 0, 0.37, 0.039],
        [0, 0, 0.44, 0.049],
        [0.29, 0, 0.37, 0.039],
        [0.45, 0, 0.22, 0.026],
      ],
      0.75,
    ),
    mats.metal,
  );
  addPart(
    weapon,
    sweep("crossbow-string", [
      [-0.45, 0, 0.22, 0.006],
      [0, 0, -0.09, 0.006],
      [0.45, 0, 0.22, 0.006],
    ]),
    mats.white,
  );
  const loadedProjectile = new THREE.Group();
  weapon.add(loadedProjectile);
  const bolt = addPart(
    loadedProjectile,
    cylinder(0.016, 0.016, 0.63, 5),
    mats.accent,
    0,
    0.123,
    0.21,
  );
  bolt.rotation.x = Math.PI / 2;
  addPart(weapon, roundedBox(0.075, 0.19, 0.085), mats.wood, 0, -0.125, -0.035).rotation.x = -0.2;
  return {
    loadedProjectile,
    muzzles: [new THREE.Vector3(0.06, 0.81, 0.88)],
    pose: restPose([-1.35, 0.4], [-1.1, -0.35], false),
  };
};

const buildFlask = (
  parent: THREE.Group,
  mats: ModelMaterials,
  glow: THREE.MeshStandardMaterial,
  x = 0,
  y = 0,
  z = 0,
  size = 1,
): void => {
  addPart(
    parent,
    profile(
      "flask",
      [
        [-0.15, 0.025, 0.025, 0],
        [-0.13, 0.105, 0.095, 0],
        [-0.055, 0.13, 0.12, 0],
        [0.035, 0.09, 0.08, 0],
        [0.075, 0.035, 0.035, 0],
        [0.13, 0.035, 0.035, 0],
      ],
      0.95,
    ),
    glow,
    x,
    y,
    z,
    size,
    size,
    size,
  );
  addPart(
    parent,
    cylinder(0.049, 0.047, 0.045, 10),
    mats.accent,
    x,
    y + 0.11 * size,
    z,
    size,
    size,
    size,
  );
  addPart(
    parent,
    cylinder(0.026, 0.032, 0.047, 10),
    mats.wood,
    x,
    y + 0.15 * size,
    z,
    size,
    size,
    size,
  );
  addPart(
    parent,
    sphere(0.027),
    mats.white,
    x - 0.045 * size,
    y - 0.025 * size,
    z + 0.101 * size,
    0.38 * size,
    size,
    0.25 * size,
  );
};

const buildPipKit = ({ mats, body, head, weapon, spellGlow }: KitParts): Kit => {
  fringe(head, mats);
  hairLock(head, mats.hair, -0.215, 0.04, -0.08, -0.15, 1.15);
  for (const side of [-1, 1]) {
    addPart(head, sphere(0.144), mats.hair, side * 0.265, 0.22, -0.13, 0.98, 1.03, 1);
    hairLock(head, mats.hair, side * 0.295, 0.26, -0.1, side * 0.7, 0.7);
    addPart(head, torus(0.082, 0.021), mats.gold, side * 0.117, 0.004, 0.29);
    addPart(head, sphere(0.072), mats.black, side * 0.117, 0.004, 0.285, 1, 1, 0.42);
    addPart(
      head,
      sphere(0.018, 10, 8),
      mats.white,
      side * 0.117 - 0.02,
      0.023,
      0.314,
      0.75,
      1,
      0.2,
    );
  }
  addPart(head, roundedBox(0.08, 0.022, 0.024), mats.gold, 0, 0.006, 0.3);
  collar(body, mats);
  addPart(
    body,
    plate(
      "apron",
      [
        [-0.1, 0.2],
        [0.12, 0.2],
        [0.16, -0.2],
        [-0.18, -0.2],
      ],
      0.03,
    ),
    mats.white,
    0,
    0.55,
    0.195,
  );
  addPart(body, roundedBox(0.15, 0.12, 0.02), mats.body, -0.025, 0.44, 0.228).rotation.z = -0.15;
  addPart(body, roundedBox(0.085, 0.075, 0.023), mats.accent, 0.078, 0.68, 0.226).rotation.z = 0.13;
  const strap = addPart(body, roundedBox(0.055, 0.5, 0.052), mats.wood, 0, 0.65, 0.23);
  strap.rotation.z = 0.63;
  addPart(body, roundedBox(0.26, 0.25, 0.15), mats.wood, -0.27, 0.46, -0.025);
  addPart(body, roundedBox(0.27, 0.11, 0.17), mats.wood, -0.27, 0.56, -0.02);
  addPart(body, roundedBox(0.048, 0.062, 0.025), mats.gold, -0.27, 0.52, 0.07);
  spellGlow.color.setHex(0x6d_c8_b5);
  spellGlow.emissive.setHex(0x18_46_3b);
  buildFlask(body, mats, spellGlow, 0.24, 0.5, 0.11, 0.48);
  weapon.position.set(0.34, 0.65, 0.28);
  buildFlask(weapon, mats, spellGlow);
  return {
    muzzles: [new THREE.Vector3(0.34, 0.84, 0.34)],
    pose: restPose([-0.35, -0.3], [-1, -0.1]),
  };
};

const KIT_BUILDERS: Record<BrawlerId, (parts: KitParts) => Kit> = {
  ace: buildWrenKit,
  dusty: buildBriarKit,
  flint: buildFlintKit,
  fuse: buildEmberKit,
  moss: buildMossKit,
  nyx: buildNyxKit,
  pip: buildPipKit,
  rowan: buildRowanKit,
  titan: buildRookKit,
};
const HAIR_COLORS: Record<BrawlerId, number> = {
  ace: 0x8c_55_2c,
  dusty: 0x6e_43_2e,
  flint: 0x94_56_37,
  fuse: 0xc8_6a_45,
  moss: 0xbe_c3_9a,
  nyx: 0x85_5d_b4,
  pip: 0x68_3e_2b,
  rowan: 0xa5_37_2f,
  titan: 0x6a_62_51,
};

const buildMaterials = (def: BrawlerDef, hueShift: number): ModelMaterials => {
  const { palette } = def;
  const mats: ModelMaterials = {
    accent: standardMaterial(palette.accent, { roughness: 0.62 }),
    black: standardMaterial(0x13_10_17, { roughness: 0.19 }),
    body: standardMaterial(palette.body, { roughness: 0.7 }),
    dark: standardMaterial(palette.dark, { roughness: 0.75 }),
    gold: standardMaterial(0xf2_c4_61, { metalness: 0.62, roughness: 0.27 }),
    hair: standardMaterial(HAIR_COLORS[def.id], { roughness: 0.48 }),
    metal: standardMaterial(0xd9_e3_eb, { metalness: 0.62, roughness: 0.25 }),
    skin: standardMaterial(palette.skin, { roughness: 0.6 }),
    skinShade: standardMaterial(palette.skin, { roughness: 0.83 }),
    white: standardMaterial(0xf1_e4_c7, { roughness: 0.83 }),
    wood: standardMaterial(0x76_42_29, { roughness: 0.65 }),
  };
  mats.body.color.offsetHSL(0, 0.08, -0.018);
  mats.skinShade.color.multiplyScalar(0.62);
  if (hueShift !== 0) {
    mats.body.color.offsetHSL(hueShift, 0, 0);
    mats.accent.color.offsetHSL(hueShift * 0.6, 0, 0);
  }
  return mats;
};

export const buildBrawlerModel = (def: BrawlerDef, hueShift: number): BrawlerModel => {
  const mats = buildMaterials(def, hueShift);
  const spellGlow = standardMaterial(0xff_b4_54, {
    emissive: 0xb8_4b_19,
    emissiveIntensity: 0.45,
    roughness: 0.3,
  });
  const root = new THREE.Group();
  const rig = new THREE.Group();
  root.add(rig);
  const body = new THREE.Group();
  rig.add(body);
  const armored = def.id === "dusty" || def.id === "titan" || def.id === "rowan";
  const broad = def.id === "titan";
  const legs: [THREE.Group, THREE.Group] = [
    buildLeg(mats, -1, armored),
    buildLeg(mats, 1, armored),
  ];
  rig.add(legs[0], legs[1]);
  let width = 1;
  if (broad) {
    width = 1.27;
  } else if (def.id === "flint") {
    width = 1.1;
  }
  addPart(body, TUNIC, mats.body, 0, 0.59, 0, width, 1, broad ? 1.17 : 1);
  belt(body, mats, width);
  const head = new THREE.Group();
  head.position.set(0, 1.105, 0);
  head.scale.setScalar(broad ? 1.1 : 1.16);
  body.add(head);
  buildFace(head, mats, def.id);
  const arms: [THREE.Group, THREE.Group] = [
    buildArm(mats, -1, broad, armored),
    buildArm(mats, 1, broad, armored),
  ];
  body.add(arms[0], arms[1]);
  const weapon = new THREE.Group();
  body.add(weapon);
  const {
    muzzles,
    pose,
    shield,
    offhand = null,
    loadedProjectile = null,
  } = KIT_BUILDERS[def.id]({ body, head, mats, spellGlow, weapon });
  const [leftArm, rightArm] = arms;
  const [[leftRestX, leftRestZ], [rightRestX, rightRestZ]] = pose.armBase;
  leftArm.rotation.set(leftRestX, 0, leftRestZ);
  rightArm.rotation.set(rightRestX, 0, rightRestZ);
  if (def.attack.kind === "melee") {
    const rest = sampleMeleePose(null, def.attack.style);
    rightArm.add(weapon);
    weapon.position.set(0, -0.28, 0);
    weapon.quaternion
      .copy(rightArm.quaternion)
      .invert()
      .multiply(
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(rest.weaponPitch, rest.weaponYaw, rest.weaponRoll, "YXZ"),
        ),
      );
    if (offhand) {
      leftArm.add(offhand);
      offhand.position.set(0, -0.28, 0);
      offhand.quaternion
        .copy(leftArm.quaternion)
        .invert()
        .multiply(
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(rest.weaponPitch, -rest.weaponYaw, -rest.weaponRoll, "YXZ"),
          ),
        );
    }
  }
  if (shield) {
    leftArm.add(shield);
    shield.position.set(0, -0.28, 0.07);
    shield.quaternion.copy(leftArm.quaternion).invert();
  }
  const flashMats = Object.values(mats);
  batchBrawlerParts(root, def.id);
  root.updateMatrixWorld(true);
  const overheadHeight = new THREE.Box3().setFromObject(head).max.y + 0.14;
  return {
    allMats: [...flashMats, spellGlow],
    arms,
    body,
    flashMats,
    head,
    legs,
    loadedProjectile,
    muzzles,
    offhand,
    overheadHeight,
    pose,
    rig,
    root,
    weapon,
  };
};
