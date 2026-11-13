// The soldier itself: one GLB (public/models/soldier.glb, packed by
// tools/build-soldier.mjs) holding the textured mesh, its skeleton and the
// animation clips, loaded once before the game boots. Every soldier is a
// `SkeletonUtils.clone` of the template built here: geometry, materials and
// clips are shared, only the bones are its own.
//
// The mesh was generated holding its carbine at the low ready, and rigged in
// that pose: the carbine and both arms are one piece with the chest. So the
// arms are never animated, and the muzzle is a point that rides the chest.
import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SkinnedMesh,
  Sphere,
  Vector3,
} from "three";
import type { AnimationClip, Material } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

import { kitMaterial } from "./soldier-kit";
import type { Kit } from "./soldier-kit";

export type ClipName = "walk" | "jog" | "sprint" | "back" | "crouch-walk" | "hit" | "death";

const BODY = "soldier-body";
const MUZZLE = "soldier-muzzle";
const HITBOX = "soldier-hitbox";

/**
 * Where the carbine's barrel ends, and which way it points, in the pose the
 * mesh was rigged in: the rig's own space (metres, feet at 0, facing +Z).
 * It hangs at the low ready, 35° to the support side and 19° down.
 */
const BARREL_TIP = new Vector3(0.373, 1.089, 0.557);
export const BARREL_ALONG = new Vector3(0.542, -0.334, 0.771).normalize();

/** The rig stands a little behind its origin, leaning into the carbine; this centres its hips. */
const HIPS_BACK = 0.12;

// Hitboxes as they stand in the bind pose, in the rig's space: the bone each
// rides, its part, size and centre.
interface HitboxSpec {
  bone: string;
  part: "head" | "body";
  size: readonly [number, number, number];
  at: readonly [number, number, number];
}
const HITBOXES: readonly HitboxSpec[] = [
  { at: [-0.02, 1.665, -0.07], bone: "Head", part: "head", size: [0.3, 0.33, 0.32] },
  { at: [0, 1.27, -0.1], bone: "Spine01", part: "body", size: [0.54, 0.6, 0.42] },
  { at: [0.02, 0.49, -0.17], bone: "Hips", part: "body", size: [0.56, 0.98, 0.56] },
];

const HIT_MATERIAL = new MeshBasicMaterial();

interface Rig {
  /** Facing -Z: the skinned body, its bones, the hitboxes and muzzle on them. Clone it, never pose it. */
  template: Group;
  clips: Record<ClipName, AnimationClip>;
  materials: Record<Kit, Material>;
}

let loaded: Rig | null = null;

const boneIn = (root: Object3D, name: string): Bone => {
  const found = root.getObjectByName(name);
  if (!(found instanceof Bone)) {
    throw new Error(`soldier rig: no bone "${name}"`);
  }
  return found;
};

const CLOTH = /^(?:Left|Right)(?:UpLeg|Leg|Arm)$/u;
const HEAD = /^(?:Head|head_end|headfront)$/u;
const BAND = { bone: "LeftArm", from: 0.3, radius: 0.13, to: 0.62, toward: "LeftForeArm" };
/** Above this the head's vertices are helmet. */
const HELMET_Y = 1.675;

/**
 * Mark what a kit colours (soldier-kit.ts): `dye` on fatigues — the vertices
 * the thighs, shins and upper arms move — and the helmet; `band` on a ring
 * round the left upper arm.
 */
const markKit = (mesh: SkinnedMesh): void => {
  const { geometry, skeleton } = mesh;
  const joints = geometry.getAttribute("skinIndex");
  const weights = geometry.getAttribute("skinWeight");
  const { count } = geometry.getAttribute("position");
  const cloth = skeleton.bones.map((bone) => CLOTH.test(bone.name));
  const head = skeleton.bones.map((bone) => HEAD.test(bone.name));
  const from = boneIn(mesh.parent ?? mesh, BAND.bone).getWorldPosition(new Vector3());
  const along = boneIn(mesh.parent ?? mesh, BAND.toward)
    .getWorldPosition(new Vector3())
    .sub(from);
  const length = along.length();
  along.normalize();
  const dye = new Float32Array(count);
  const band = new Float32Array(count);
  const p = new Vector3();
  for (let i = 0; i < count; i += 1) {
    mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld);
    let worn = 0;
    for (let k = 0; k < 4; k += 1) {
      const joint = joints.getComponent(i, k);
      const weight = weights.getComponent(i, k);
      if (cloth[joint] || (head[joint] && p.y > HELMET_Y)) {
        worn += weight;
      }
    }
    dye[i] = worn;
    const t = p.sub(from).dot(along) / length;
    const off = p.addScaledVector(along, -t * length).length();
    band[i] = t > BAND.from && t < BAND.to && off < BAND.radius ? 1 : 0;
  }
  geometry.setAttribute("dye", new BufferAttribute(dye, 1));
  geometry.setAttribute("band", new BufferAttribute(band, 1));
};

/** Hang the hitboxes and the muzzle on their bones, where they stand in the bind pose. */
const fit = (scene: Object3D): void => {
  for (const [i, spec] of HITBOXES.entries()) {
    const box = new Mesh(new BoxGeometry(...spec.size), HIT_MATERIAL);
    box.name = `${HITBOX}-${i}`;
    box.position.set(...spec.at);
    box.userData.part = spec.part;
    // Raycasts ignore `visible`, so hidden boxes still take hits.
    box.visible = false;
    scene.add(box);
    boneIn(scene, spec.bone).attach(box);
  }
  const muzzle = new Object3D();
  muzzle.name = MUZZLE;
  muzzle.position.copy(BARREL_TIP);
  scene.add(muzzle);
  boneIn(scene, "Spine").attach(muzzle);
};

const build = (scene: Object3D, animations: readonly AnimationClip[]): Rig => {
  let mesh: SkinnedMesh | null = null;
  scene.traverse((o) => {
    if (o instanceof SkinnedMesh) {
      mesh = o;
    }
  });
  if (!mesh) {
    throw new Error("soldier rig: no skinned mesh");
  }
  const body: SkinnedMesh = mesh;
  const atlas = body.material instanceof MeshStandardMaterial ? body.material.map : null;
  if (!atlas) {
    throw new Error("soldier rig: no atlas");
  }
  scene.updateMatrixWorld(true);
  body.name = BODY;
  markKit(body);
  fit(scene);

  const template = new Group();
  scene.position.z = HIPS_BACK;
  template.rotation.y = Math.PI;
  template.add(scene);

  const clip = (name: ClipName): AnimationClip => {
    const found = animations.find((a) => a.name === name);
    if (!found) {
      throw new Error(`soldier rig: no clip "${name}"`);
    }
    return found;
  };
  return {
    clips: {
      back: clip("back"),
      "crouch-walk": clip("crouch-walk"),
      death: clip("death"),
      hit: clip("hit"),
      jog: clip("jog"),
      sprint: clip("sprint"),
      walk: clip("walk"),
    },
    materials: {
      garrison: kitMaterial("garrison", atlas),
      operator: kitMaterial("operator", atlas),
    },
    template,
  };
};

/** Fetch and fit the rig. The game awaits this before it boots. */
export const loadSoldierRig = async (): Promise<void> => {
  if (loaded) {
    return;
  }
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/soldier.glb`);
  loaded = build(gltf.scene, gltf.animations);
};

export interface SoldierBody {
  /** Facing -Z; add it to the soldier's root. */
  rig: Group;
  mesh: SkinnedMesh;
  /** The end of the carbine's barrel. */
  muzzle: Object3D;
  hitboxes: Mesh[];
  clips: Record<ClipName, AnimationClip>;
  bone: (name: string) => Bone;
}

/** A body of its own for one soldier, sharing everything but its bones. */
export const soldierBody = (kit: Kit): SoldierBody => {
  if (!loaded) {
    throw new Error("soldier rig: loadSoldierRig() has not finished");
  }
  const rig = cloneSkinned(loaded.template);
  const mesh = rig.getObjectByName(BODY);
  const muzzle = rig.getObjectByName(MUZZLE);
  if (!(rig instanceof Group) || !(mesh instanceof SkinnedMesh) || !muzzle) {
    throw new Error("soldier rig: clone lost its body");
  }
  mesh.material = loaded.materials[kit];
  mesh.castShadow = true;
  // A skinned mesh is culled by this sphere, not its geometry's. It is in the
  // mesh's own space, which the armature scales: wide enough, in those units,
  // for a body lying where it fell.
  rig.updateMatrixWorld(true);
  const unit = mesh.getWorldScale(new Vector3()).x;
  mesh.boundingSphere = new Sphere(new Vector3(0, 0.9 / unit, 0), 2.4 / unit);
  const hitboxes: Mesh[] = [];
  rig.traverse((o) => {
    if (o instanceof Mesh && o.name.startsWith(HITBOX)) {
      hitboxes.push(o);
    }
  });
  return { bone: (name) => boneIn(rig, name), clips: loaded.clips, hitboxes, mesh, muzzle, rig };
};
