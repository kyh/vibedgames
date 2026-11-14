// The soldier and its carbine: one GLB (public/models/soldier.glb, packed by
// tools/build-soldier.mjs) holding the skinned, textured body, the carbine
// as a mesh of its own, and the animation clips, loaded once before the game
// boots. Every soldier is a `SkeletonUtils.clone` of the template built
// here: geometry, materials and clips are shared, only the bones are its own.
import {
  Bone,
  BoxGeometry,
  BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  SkinnedMesh,
  Sphere,
  Vector3,
} from "three";
import type { AnimationClip, Material, Object3D } from "three";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";

import { kitMaterial } from "./soldier-kit";
import type { Kit } from "./soldier-kit";

export const CLIP_NAMES = [
  "walk",
  "jog",
  "sprint",
  "back",
  "strafe-left",
  "strafe-right",
  "crouch-walk",
  "crouch-back",
  "crouch-left",
  "crouch-right",
  "hit",
] as const;
export type ClipName = (typeof CLIP_NAMES)[number];

const BODY = "soldier";
const CARBINE = "carbine";
const HITBOX = "soldier-hitbox";

/** The rig stands a little behind its origin; this centres its hips. */
const HIPS_BACK = 0.06;

interface HitboxSpec {
  bone: string;
  part: "head" | "body";
  size: readonly [number, number, number];
  at: readonly [number, number, number];
}
// Hitboxes as they stand in the bind pose, in the rig's space (metres, feet
// at 0, facing +Z): the bone each rides, its part, size and centre.
const HITBOXES: readonly HitboxSpec[] = [
  { at: [0, 1.665, -0.06], bone: "Head", part: "head", size: [0.3, 0.33, 0.32] },
  { at: [0, 1.25, -0.08], bone: "Spine01", part: "body", size: [0.52, 0.56, 0.4] },
  { at: [0, 0.49, -0.04], bone: "Hips", part: "body", size: [0.5, 0.98, 0.42] },
];

const HIT_MATERIAL = new MeshBasicMaterial();

interface Rig {
  /** Facing -Z: the skinned body, its bones and the hitboxes on them. Clone it, never pose it. */
  template: Group;
  /** The carbine as loaded: butt plate at its origin, bore along -Z. */
  carbine: Mesh;
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

/** The armband: a ring round the left upper arm, as fractions of the way to the elbow. */
const BAND = { bone: "LeftArm", from: 0.42, radius: 0.12, to: 0.78, toward: "LeftForeArm" };

/** Mark the vertices a kit paints its band on (soldier-kit.ts). */
const markBand = (mesh: SkinnedMesh, scene: Object3D): void => {
  const { geometry } = mesh;
  const { count } = geometry.getAttribute("position");
  const from = boneIn(scene, BAND.bone).getWorldPosition(new Vector3());
  const along = boneIn(scene, BAND.toward).getWorldPosition(new Vector3()).sub(from);
  const length = along.length();
  along.normalize();
  const band = new Float32Array(count);
  const p = new Vector3();
  for (let i = 0; i < count; i += 1) {
    mesh.getVertexPosition(i, p).applyMatrix4(mesh.matrixWorld).sub(from);
    const t = p.dot(along) / length;
    const off = p.addScaledVector(along, -t * length).length();
    band[i] = t > BAND.from && t < BAND.to && off < BAND.radius ? 1 : 0;
  }
  geometry.setAttribute("band", new BufferAttribute(band, 1));
};

/** Hang the hitboxes on their bones, where they stand in the bind pose. */
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
};

const build = (scene: Object3D, animations: readonly AnimationClip[]): Rig => {
  const body = scene.getObjectByName(BODY);
  const carbine = scene.getObjectByName(CARBINE);
  if (!(body instanceof SkinnedMesh) || !(carbine instanceof Mesh)) {
    throw new Error("soldier rig: no body or no carbine");
  }
  if (!(body.material instanceof MeshStandardMaterial)) {
    throw new Error("soldier rig: unexpected body material");
  }
  carbine.removeFromParent();
  carbine.castShadow = true;
  scene.updateMatrixWorld(true);
  markBand(body, scene);
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
    carbine,
    clips: {
      back: clip("back"),
      "crouch-back": clip("crouch-back"),
      "crouch-left": clip("crouch-left"),
      "crouch-right": clip("crouch-right"),
      "crouch-walk": clip("crouch-walk"),
      hit: clip("hit"),
      jog: clip("jog"),
      sprint: clip("sprint"),
      "strafe-left": clip("strafe-left"),
      "strafe-right": clip("strafe-right"),
      walk: clip("walk"),
    },
    materials: {
      garrison: kitMaterial("garrison", body.material),
      operator: kitMaterial("operator", body.material),
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
  /** Butt plate at its origin, bore along -Z, sights up. */
  carbine: Group;
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
  if (!(rig instanceof Group) || !(mesh instanceof SkinnedMesh)) {
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
  // The mesh keeps the transform that un-quantises it; the group is the carbine's own space.
  const carbine = new Group();
  carbine.add(loaded.carbine.clone());
  return { bone: (name) => boneIn(rig, name), carbine, clips: loaded.clips, hitboxes, mesh, rig };
};
