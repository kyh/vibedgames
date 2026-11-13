// A soldier on screen: the rigged body (soldier-rig.ts) in a kit
// (soldier-kit.ts), animated from nothing but where it is shown standing.
//
// Legs: the gait (soldier-gait.ts) blends walk, jog, sprint, backpedal and
// crouched walk over the ready stance the body was rigged in, by the speed
// it reads off the positions, and turns the hips towards the direction of
// travel. Upper body: the carbine is part of the mesh, held at the low
// ready, so aiming turns and lifts the chest until the barrel is on the aim
// — wherever the clips have left it — while the head stays on the target. A
// shot kicks the chest; a hit plays the flinch; death plays the fall.
//
// Hitboxes — head, torso, legs — ride the bones, so shots land where the
// body is drawn. Faces -Z at yaw 0, like the camera.
import { AnimationMixer, Euler, Group, Quaternion, Vector3 } from "three";
import type { AnimationAction, Bone, Mesh, Object3D, SkinnedMesh } from "three";

import { Gait, STRIDES, STRIDE_NAMES } from "./soldier-gait";
import type { Kit } from "./soldier-kit";
import { BARREL_ALONG, soldierBody } from "./soldier-rig";
import type { ClipName } from "./soldier-rig";

export type { Kit } from "./soldier-kit";

export interface SoldierPose {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** 0 standing, 1 crouched. */
  crouch: number;
  alive: boolean;
  /** Weapon on something. It comes off anyway at a run. */
  aiming: boolean;
}

/** Faster than this the carbine is carried, not aimed. */
const CARRY_SPEED = 4;
/** Seconds the carbine stays on aim after a shot, whatever the legs are doing. */
const FIRE_HOLD = 0.9;
/** How much of the barrel's droop the spine takes out when aiming; leaning back for all of it looks wrong. */
const RAISE = 0.6;
const FORWARD = new Vector3(0, 0, 1);
/** The flinch and the fall are played faster than they were animated: a shot is abrupt. */
const HIT_RATE = 1.6;
const HIT_SECONDS = 0.55;
const DEATH_RATE = 1.3;

/** Animation rate by how the soldier was last drawn: full, then thinning with range, least unseen. */
const LOD = [
  { beyond: 55, every: 1 / 15 },
  { beyond: 28, every: 1 / 30 },
] as const;
const UNSEEN_EVERY = 1 / 8;

const SPINE = ["Hips", "Spine02", "Spine01", "Spine", "neck", "Head"] as const;

const turn = new Quaternion();
const inverse = new Quaternion();
const chain = new Quaternion();
const euler = new Euler(0, 0, 0, "YXZ");
const probe = new Vector3();

const ease = (t: number): number => t * t * (3 - 2 * t);

const approach = (from: number, to: number, rate: number, dt: number): number =>
  from + (to - from) * (1 - Math.exp(-rate * dt));

/**
 * Turn `bone` in the rig's space on top of its clip pose. `chain` is its
 * parent's turn in that space going in, and its own coming out.
 */
const turnBone = (bone: Bone, x: number, y: number, z: number): void => {
  turn.setFromEuler(euler.set(x, y, z));
  inverse.copy(chain).invert();
  bone.quaternion.premultiply(chain).premultiply(turn).premultiply(inverse);
  chain.multiply(bone.quaternion);
};

export class SoldierModel {
  readonly root = new Group();
  /** Invisible boxes shots are tested against; `userData.part` is "head" or "body". */
  readonly hitboxes: Mesh[];
  private readonly rig: Group;
  private readonly skin: SkinnedMesh;
  private readonly barrel: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly actions: Record<ClipName, AnimationAction>;
  /**
   * The spine, hips to head, each with its clip pose. The mixer only
   * rewrites a bone whose clip value moved, so each is put back before it
   * runs: a turn laid over last frame's result would compound.
   */
  private readonly spine: { bone: Bone; clip: Quaternion }[];
  /** The turn of whatever the hips hang from: the spine chain starts there. */
  private readonly base: Quaternion;
  private readonly barrelAlong: Vector3;
  private readonly faceAlong: Vector3;
  private readonly gait = new Gait();
  private clock = 0;
  private pending = Infinity;
  /** Frames since it was last drawn, and how far off that was. */
  private unseen = 0;
  private range = 0;
  private aim = 0;
  private dead = 0;
  private deathT = 0;
  private hitT = Infinity;
  private flinchSide = 1;
  private kick = 0;
  private sinceFire = Infinity;

  constructor(kit: Kit, name: string) {
    const body = soldierBody(kit);
    this.rig = body.rig;
    this.skin = body.mesh;
    this.barrel = body.muzzle;
    this.hitboxes = body.hitboxes;
    this.mixer = new AnimationMixer(body.rig);
    const action = (clip: ClipName): AnimationAction => {
      const a = this.mixer.clipAction(body.clips[clip]);
      // Every clip is scrubbed by hand: weights and times are set each frame.
      a.timeScale = 0;
      a.weight = 0;
      a.play();
      return a;
    };
    this.actions = {
      back: action("back"),
      "crouch-walk": action("crouch-walk"),
      death: action("death"),
      hit: action("hit"),
      jog: action("jog"),
      sprint: action("sprint"),
      walk: action("walk"),
    };
    this.spine = SPINE.map((bone) => body.bone(bone)).map((bone) => ({
      bone,
      clip: bone.quaternion.clone(),
    }));
    this.base = body.bone("Hips").parent?.quaternion.clone() ?? new Quaternion();
    // The barrel and the face, each in the space of the bone that carries it.
    chain.copy(this.base);
    for (const { bone } of this.spine.slice(0, 4)) {
      chain.multiply(bone.quaternion);
    }
    this.barrelAlong = BARREL_ALONG.clone().applyQuaternion(inverse.copy(chain).invert());
    for (const { bone } of this.spine.slice(4)) {
      chain.multiply(bone.quaternion);
    }
    this.faceAlong = FORWARD.clone().applyQuaternion(inverse.copy(chain).invert());
    body.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      this.unseen = 0;
      this.range = camera.position.distanceTo(this.root.position);
    };
    this.root.add(body.rig);
    this.root.name = `soldier:${name}`;
  }

  /** A hit from `side` (-1 left, 1 right): the body takes it and twists away. */
  flinch(side: number): void {
    this.hitT = 0;
    this.flinchSide = side < 0 ? -1 : 1;
  }

  /** It fired: the chest takes the kick, and the carbine comes onto the aim if it was off it. */
  fire(): void {
    this.kick = 1;
    this.sinceFire = 0;
  }

  /** Where the carbine's muzzle is in the world. */
  muzzle(out: Vector3): Vector3 {
    this.root.updateMatrixWorld(true);
    return this.barrel.getWorldPosition(out);
  }

  update(pose: SoldierPose, dt: number): void {
    this.root.position.set(pose.x, pose.y, pose.z);
    this.root.rotation.y = pose.yaw;
    this.gait.update(pose.x, pose.z, pose.yaw, pose.crouch, dt);
    this.pending += dt;
    this.unseen += 1;
    if (this.pending < this.interval()) {
      return;
    }
    const step = Number.isFinite(this.pending) ? this.pending : 0;
    this.pending = 0;
    this.animate(pose, step);
  }

  /** Leave the scene. Geometry, materials and clips are the rig's, shared. */
  dispose(): void {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig);
    this.skin.skeleton.dispose();
  }

  private interval(): number {
    if (this.unseen > 2) {
      return UNSEEN_EVERY;
    }
    return LOD.find((lod) => this.range > lod.beyond)?.every ?? 0;
  }

  private animate(pose: SoldierPose, dt: number): void {
    this.clock += dt;
    this.sinceFire += dt;
    this.hitT += dt;
    this.kick *= Math.exp(-16 * dt);
    if (pose.alive) {
      this.dead = 0;
      this.deathT = 0;
    } else {
      this.dead = Math.min(1, this.dead + dt * 7);
      this.deathT += dt;
    }
    const on = pose.aiming && (this.gait.speed < CARRY_SPEED || this.sinceFire < FIRE_HOLD);
    this.aim = approach(this.aim, pose.alive && on ? 1 : 0, on ? 11 : 6, dt);
    const alive = 1 - ease(this.dead);

    this.blend(alive, dt);
    for (const { bone, clip } of this.spine) {
      bone.quaternion.copy(clip);
    }
    this.mixer.update(0);
    for (const { bone, clip } of this.spine) {
      clip.copy(bone.quaternion);
    }
    this.turnSpine(pose.pitch, ease(this.aim) * alive, alive);
  }

  /** Set every clip's weight and place in time. */
  private blend(alive: number, dt: number): void {
    const { actions, gait } = this;
    const hit =
      this.hitT < HIT_SECONDS
        ? Math.min(1, this.hitT / 0.05, (HIT_SECONDS - this.hitT) / 0.2) * 0.75
        : 0;
    // Weights ease to where the gait wants them, so swapping a walk for a backpedal is a blend, not a cut.
    const k = dt > 0 ? 1 - Math.exp(-14 * dt) : 1;
    const live = (1 - hit) * alive;
    for (const name of STRIDE_NAMES) {
      const action = actions[name];
      action.weight += (gait.weights[name] * live - action.weight) * k;
    }
    actions.hit.weight = hit * alive;
    actions.hit.time = Math.min(this.hitT * HIT_RATE, actions.hit.getClip().duration);
    actions.death.weight = 1 - alive;
    actions.death.time = Math.min(this.deathT * DEATH_RATE, actions.death.getClip().duration);
    for (const name of STRIDE_NAMES) {
      actions[name].time =
        ((gait.phase + STRIDES[name].lead) % 1) * actions[name].getClip().duration;
    }
  }

  /**
   * Turn the hips to the legs' heading and the spine back. On aim, the chest
   * goes on turning and lifting until the barrel — read off wherever the
   * clips have left it — points where the soldier looks, and the head is
   * brought back onto the target. Breathing, the kick and the flinch are laid
   * over that.
   */
  private turnSpine(pitch: number, aim: number, alive: number): void {
    const [hips, low, mid, chest, neck, head] = this.spine.map((s) => s.bone);
    if (!hips || !low || !mid || !chest || !neck || !head) {
      return;
    }
    // Where the clips alone point the barrel and the face, in the rig's space (it faces +Z).
    chain.copy(this.base).multiply(hips.quaternion).multiply(low.quaternion);
    chain.multiply(mid.quaternion).multiply(chest.quaternion);
    probe.copy(this.barrelAlong).applyQuaternion(chain);
    const barrelYaw = Math.atan2(probe.x, probe.z);
    const barrelPitch = Math.asin(Math.max(-1, Math.min(1, probe.y)));
    chain.multiply(neck.quaternion).multiply(head.quaternion);
    probe.copy(this.faceAlong).applyQuaternion(chain);
    const faceYaw = Math.atan2(probe.x, probe.z);

    const twist = this.gait.twist * alive;
    const swing = -barrelYaw * aim;
    const back = (swing - twist) / 3;
    // Looking up is a negative turn about the rig's X.
    const lift = -(pitch - barrelPitch * RAISE) * aim;
    const breath = Math.sin(this.clock * 1.7) * 0.012 * alive;
    const flinch = this.hitT < 0.35 ? (1 - this.hitT / 0.35) * 0.3 * this.flinchSide * alive : 0;
    chain.copy(this.base);
    turnBone(hips, 0, twist, 0);
    turnBone(low, lift * 0.2, back, 0);
    turnBone(mid, lift * 0.3 + breath, back + flinch, flinch * 0.4);
    turnBone(chest, lift * 0.5 - this.kick * 0.04 * alive, back, 0);
    const look = -(faceYaw + swing) * aim;
    turnBone(neck, -lift * 0.4 - breath, look * 0.45, 0);
    turnBone(head, -lift * 0.6 - pitch * aim * 0.7, look * 0.55, 0);
  }
}
