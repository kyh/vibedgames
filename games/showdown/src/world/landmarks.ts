import * as THREE from "three";
import { TILE } from "../config";
import { seededRandom } from "../utils";
import { GRID, gridIndex, tileCenter } from "./grid";
import { terrainHeight } from "./terrain";

const FLOWER_CAP = 360;

interface LandmarkHost {
  group: THREE.Group;
  disposables: { dispose: () => void }[];
  seed: number;
  tiles: Uint8Array;
}

/** Tiny clustered flowers break up empty meadow; they never occupy a collision tile. */
const buildFlowers = (world: LandmarkHost): void => {
  const rng = seededRandom(world.seed + 415);
  const geometry = new THREE.IcosahedronGeometry(0.06, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xff_ef_bb, roughness: 1 });
  const flowers = new THREE.InstancedMesh(geometry, material, FLOWER_CAP);
  const matrix = new THREE.Matrix4();
  let count = 0;
  for (let i = 0; i < 180; i += 1) {
    const tx = 3 + Math.floor(rng() * (GRID - 6));
    const tz = 3 + Math.floor(rng() * (GRID - 6));
    const x = tileCenter(tx);
    const z = tileCenter(tz);
    if (world.tiles[gridIndex(tx, tz)] !== TILE.EMPTY || Math.abs(x) < 5 || Math.abs(z) < 3) {
      continue;
    }
    for (let flower = 0; flower < 3; flower += 1) {
      const px = x + rng() * 0.5 - 0.25;
      const pz = z + rng() * 0.5 - 0.25;
      matrix.makeTranslation(px, terrainHeight(px, pz) + 0.09, pz);
      flowers.setMatrixAt(count, matrix);
      count += 1;
      if (count === FLOWER_CAP) {
        break;
      }
    }
    if (count === FLOWER_CAP) {
      break;
    }
  }
  flowers.count = count;
  flowers.receiveShadow = true;
  world.group.add(flowers);
  world.disposables.push(geometry, material, flowers);
};

/** Corner keeps and heraldic banners make the meadow read as a tournament ground. */
export const buildLandmarks = (world: LandmarkHost): THREE.Mesh[] => {
  const stone = new THREE.MeshStandardMaterial({ color: 0xbc_bc_9b, roughness: 0.88 });
  const roof = new THREE.MeshStandardMaterial({ color: 0x35_67_60, roughness: 0.76 });
  const gold = new THREE.MeshStandardMaterial({
    color: 0xd8_b4_69,
    metalness: 0.25,
    roughness: 0.6,
  });
  const cloth = new THREE.MeshStandardMaterial({
    color: 0xa8_45_3e,
    roughness: 1,
    side: THREE.DoubleSide,
  });
  world.disposables.push(stone, roof, gold, cloth);
  const flags: THREE.Mesh[] = [];
  const part = (
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, terrainHeight(x, z) + y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    world.group.add(mesh);
    world.disposables.push(geometry);
    return mesh;
  };
  for (const x of [-20.5, 20.5]) {
    for (const z of [-20.5, 20.5]) {
      const height = z < 0 ? 3.1 : 2.3;
      part(new THREE.CylinderGeometry(1.05, 1.2, height, 8), stone, x, height / 2, z);
      part(new THREE.CylinderGeometry(1.23, 1.13, 0.25, 8), gold, x, height, z);
      part(new THREE.ConeGeometry(1.5, 1.6, 8), roof, x, height + 0.9, z);
      part(new THREE.CylinderGeometry(0.035, 0.04, 1.2, 6), gold, x, height + 2, z);
      const flag = part(
        new THREE.PlaneGeometry(0.95, 0.48, 6, 1),
        cloth,
        x + 0.47,
        height + 2.2,
        z,
      );
      flags.push(flag);
    }
  }
  for (const z of [-11, 11]) {
    for (const x of [-21, 21]) {
      part(new THREE.CylinderGeometry(0.045, 0.065, 3.1, 6), gold, x, 1.55, z);
      const flag = part(new THREE.PlaneGeometry(1, 1.45, 6, 2), cloth, x + 0.48, 2.25, z);
      flags.push(flag);
    }
  }
  // A worn heraldic sun in the central clearing anchors the last stand.
  const crest = part(new THREE.RingGeometry(2.3, 2.38, 48), gold, 0, 0.016, 0);
  crest.rotation.x = -Math.PI / 2;
  crest.castShadow = false;
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4;
    const ray = part(
      new THREE.BoxGeometry(0.16, 0.025, 0.65),
      gold,
      Math.sin(angle) * 1.55,
      0.025,
      Math.cos(angle) * 1.55,
    );
    ray.rotation.y = angle;
    ray.castShadow = false;
  }
  buildFlowers(world);
  return flags;
};

export const animateBanners = (flags: readonly THREE.Mesh[], elapsed: number): void => {
  for (const [index, flag] of flags.entries()) {
    const positions = flag.geometry.getAttribute("position");
    for (let i = 0; i < positions.count; i += 1) {
      const along = positions.getX(i) + 0.5;
      positions.setZ(i, Math.sin(elapsed * 2.8 + along * 5 + index) * 0.13 * along);
    }
    positions.needsUpdate = true;
    flag.geometry.computeVertexNormals();
  }
};
