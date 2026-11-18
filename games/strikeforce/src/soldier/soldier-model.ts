import { AnimationMixer, Euler, Group, Quaternion, Vector3 } from "three";
import type { AnimationAction, Bone, Mesh, SkinnedMesh } from "three";

import { Arm } from "./arm-ik";
import { Ragdoll } from "./ragdoll";
import { Gait, STRIDES, STRIDE_NAMES } from "./soldier-gait";
import type { Kit } from "./soldier-kit";
import { CLIP_NAMES, soldierBody } from "./soldier-rig";
import type { ClipName } from "./soldier-rig";
import type { Terrain } from "./verlet";

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

const CARRY_SPEED = 4;
const FIRE_HOLD = 0.9;
const BLADE = -0.45;
const HIT_RATE = 1.6;
const HIT_SECONDS = 0.55;
const BLOW_SECONDS = 0.5;
const BLOW_SPEED = 2.2;
const CROUCH_HOLD = 0.2;

const LOD = [
  { beyond: 55, every: 1 / 15 },
  { beyond: 28, every: 1 / 30 },
] as const;

const UNSEEN_EVERY = 1 / 8;

const MUZZLE = new Vector3(0, 0, -0.78);
const GRIP_WRIST = new Vector3(0.03, -0.14, -0.15);
const FORE_WRIST = new Vector3(-0.06, -0.05, -0.4);
const GRIP_PALM = new Vector3(-1, 0, 0);
const GRIP_FINGERS = new Vector3(0, 0.45, -0.9).normalize();
const FORE_PALM = new Vector3(0.35, 0.94, 0).normalize();
const FORE_FINGERS = new Vector3(0.75, -0.2, -0.63).normalize();
const GRIP_POLE = new Vector3(0.55, -1, 0.5);
const FORE_POLE = new Vector3(-0.45, -1, 0.1);

const SHOULDERED = new Vector3(-0.07, 0.08, -0.05);
const CARRIED = new Vector3(-0.1, -0.06, -0.1);
const CARRY_TURN = new Quaternion().setFromEuler(new Euler(-0.7, 0.75, 0.3, "YXZ"));

const SPINE = ["Hips", "Spine02", "Spine01", "Spine", "neck", "Head"] as const;

const ARMS = [
  "LeftShoulder",
  "LeftArm",
  "LeftForeArm",
  "LeftHand",
  "RightShoulder",
  "RightArm",
  "RightForeArm",
  "RightHand",
] as const;

const FORWARD = new Vector3(0, 0, 1);

const turn = new Quaternion();
const inverse = new Quaternion();
const chain = new Quaternion();
const euler = new Euler(0, 0, 0, "YXZ");
const probe = new Vector3();
const point = new Vector3();
const pole = new Vector3();
const palm = new Vector3();
const fingers = new Vector3();
const worldTurn = new Quaternion();
const rootTurn = new Quaternion();
const aimTurn = new Quaternion();
const velocity = new Vector3();

const ease = (t: number) => t * t * (3 - 2 * t);

const approach = (from: number, to: number, rate: number, dt: number) =>
  from + (to - from) * (1 - Math.exp(-rate * dt));

const turnBone = (bone: Bone, x: number, y: number, z: number) => {
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
  private readonly carbine: Group;
  private readonly mixer: AnimationMixer;
  private readonly actions: Record<ClipName, AnimationAction>;
  private readonly spine: Bone[];
  private readonly posed: { bone: Bone; clip: Quaternion }[];
  private readonly base: Quaternion;
  private readonly chestAhead: Vector3;
  private readonly headAhead: Vector3;
  private readonly gripArm: Arm;
  private readonly foreArm: Arm;
  private readonly gripShoulder: Bone;
  private readonly gait = new Gait();
  private readonly ragdoll: Ragdoll;
  private readonly blowAt = new Vector3();
  private readonly blowDir = new Vector3();
  private clock = 0;
  private pending = Infinity;
  private unseen = 0;
  private range = 0;
  private aim = 0;
  private hitT = Infinity;
  private flinchSide = 1;
  private kick = 0;
  private sinceFire = Infinity;

  constructor(kit: Kit, name: string, terrain: Terrain) {
    const body = soldierBody(kit);
    this.rig = body.rig;
    this.skin = body.mesh;
    this.carbine = body.carbine;
    this.hitboxes = body.hitboxes;
    this.root.add(body.rig, body.carbine);
    this.root.name = `soldier:${name}`;
    this.root.updateMatrixWorld(true);

    this.mixer = new AnimationMixer(body.rig);
    const actions = new Map<ClipName, AnimationAction>();

    for (const clip of CLIP_NAMES) {
      const action = this.mixer.clipAction(body.clips[clip]);
      action.timeScale = 0;
      action.weight = 0;
      action.play();
      actions.set(clip, action);
    }

    const action = (clip: ClipName) => {
      const found = actions.get(clip);

      if (!found) {
        throw new Error(`soldier: no action "${clip}"`);
      }

      return found;
    };

    this.actions = {
      back: action("back"),
      "crouch-back": action("crouch-back"),
      "crouch-left": action("crouch-left"),
      "crouch-right": action("crouch-right"),
      "crouch-walk": action("crouch-walk"),
      hit: action("hit"),
      jog: action("jog"),
      sprint: action("sprint"),
      "strafe-left": action("strafe-left"),
      "strafe-right": action("strafe-right"),
      walk: action("walk"),
    };

    this.spine = SPINE.map((bone) => body.bone(bone));
    this.posed = [...this.spine, ...ARMS.map((bone) => body.bone(bone))].map((bone) => ({
      bone,
      clip: bone.quaternion.clone(),
    }));
    this.base = body.bone("Hips").parent?.quaternion.clone() ?? new Quaternion();
    chain.copy(this.base);

    for (const bone of this.spine.slice(0, 4)) {
      chain.multiply(bone.quaternion);
    }

    this.chestAhead = FORWARD.clone().applyQuaternion(inverse.copy(chain).invert());

    for (const bone of this.spine.slice(4)) {
      chain.multiply(bone.quaternion);
    }

    this.headAhead = FORWARD.clone().applyQuaternion(inverse.copy(chain).invert());

    this.gripShoulder = body.bone("RightArm");
    this.gripArm = new Arm(
      this.gripShoulder,
      body.bone("RightForeArm"),
      body.bone("RightHand"),
      this.root,
      1,
    );
    this.foreArm = new Arm(
      body.bone("LeftArm"),
      body.bone("LeftForeArm"),
      body.bone("LeftHand"),
      this.root,
      -1,
    );
    this.ragdoll = new Ragdoll(body.bone, this.root, body.carbine, terrain);
    body.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      this.unseen = 0;
      this.range = camera.position.distanceTo(this.root.position);
    };
  }

  /**
   * A shot along `dir` struck it at `at`. Alive, the body takes it and
   * twists away; if it is the one that kills, the body is thrown by it.
   */
  hit(at: Vector3, dir: Vector3) {
    this.hitT = 0;
    const yaw = this.root.rotation.y;
    this.flinchSide = dir.x * Math.cos(yaw) - dir.z * Math.sin(yaw) > 0 ? -1 : 1;
    this.blowAt.copy(at);
    this.blowDir.copy(dir).normalize();

    if (this.ragdoll.down) {
      this.ragdoll.shove(this.blowAt, this.blowDir, BLOW_SPEED);
    }
  }

  /** It fired: the carbine kicks, and comes onto the aim if it was off it. */
  fire() {
    this.kick = 1;
    this.sinceFire = 0;
  }

  /** Where the carbine's muzzle is in the world. */
  muzzle(out: Vector3) {
    this.root.updateMatrixWorld(true);

    return this.carbine.localToWorld(out.copy(MUZZLE));
  }

  update(pose: SoldierPose, dt: number) {
    const { down } = this.ragdoll;

    if (pose.alive || !down) {
      this.root.position.set(pose.x, pose.y, pose.z);
      this.root.rotation.y = pose.yaw;
    }

    this.gait.update(pose.x, pose.z, pose.yaw, pose.crouch, dt);
    this.pending += dt;
    this.unseen += 1;

    if (pose.alive !== down && this.pending < this.interval()) {
      return;
    }

    const step = Number.isFinite(this.pending) ? this.pending : 0;
    this.pending = 0;
    this.animate(pose, step);
  }

  /** Leave the scene. Geometry, materials and clips are the rig's, shared. */
  dispose() {
    this.root.removeFromParent();
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.rig);
    this.skin.skeleton.dispose();
  }

  private interval() {
    if (this.unseen > 2) {
      return UNSEEN_EVERY;
    }

    return LOD.find((lod) => this.range > lod.beyond)?.every ?? 0;
  }

  private animate(pose: SoldierPose, dt: number) {
    this.clock += dt;
    this.sinceFire += dt;
    this.hitT += dt;
    this.kick *= Math.exp(-16 * dt);

    if (!pose.alive) {
      this.fall(dt);

      return;
    }

    if (this.ragdoll.down) {
      this.ragdoll.rise();
    }

    const on = pose.aiming && (this.gait.speed < CARRY_SPEED || this.sinceFire < FIRE_HOLD);
    this.aim = approach(this.aim, on ? 1 : 0, on ? 11 : 6, dt);
    const aim = ease(this.aim);

    this.blend(dt);

    for (const { bone, clip } of this.posed) {
      bone.quaternion.copy(clip);
    }

    this.mixer.update(0);

    for (const { bone, clip } of this.posed) {
      clip.copy(bone.quaternion);
    }

    this.turnSpine(pose.pitch, aim);
    this.root.updateMatrixWorld(true);
    this.holdCarbine(pose, aim);
    this.gripCarbine();
  }

  private fall(dt: number) {
    const { ragdoll, gait } = this;

    if (!ragdoll.down) {
      this.aim = 0;
      ragdoll.drop(velocity.set(gait.vx, 0, gait.vz));

      if (this.hitT < BLOW_SECONDS) {
        ragdoll.shove(this.blowAt, this.blowDir, BLOW_SPEED);
      }
    }

    ragdoll.update(dt);
  }

  private blend(dt: number) {
    const { actions, gait } = this;

    const hit =
      this.hitT < HIT_SECONDS
        ? Math.min(1, this.hitT / 0.05, (HIT_SECONDS - this.hitT) / 0.2) * 0.75
        : 0;

    const k = dt > 0 ? 1 - Math.exp(-12 * dt) : 1;
    const live = 1 - hit;

    for (const name of STRIDE_NAMES) {
      const action = actions[name];
      action.weight += (gait.weights[name] * live - action.weight) * k;
      action.time = ((gait.phase + STRIDES[name].lead) % 1) * action.getClip().duration;
    }

    if (gait.speed < 0.3) {
      actions["crouch-walk"].time = CROUCH_HOLD * actions["crouch-walk"].getClip().duration;
    }

    actions.hit.weight = hit;
    actions.hit.time = Math.min(this.hitT * HIT_RATE, actions.hit.getClip().duration);
  }

  private turnSpine(pitch: number, aim: number) {
    const [hips, low, mid, chest, neck, head] = this.spine;

    if (!hips || !low || !mid || !chest || !neck || !head) {
      return;
    }

    chain.copy(this.base).multiply(hips.quaternion).multiply(low.quaternion);
    chain.multiply(mid.quaternion).multiply(chest.quaternion);
    probe.copy(this.chestAhead).applyQuaternion(chain);
    const chestYaw = Math.atan2(probe.x, probe.z);
    chain.multiply(neck.quaternion).multiply(head.quaternion);
    probe.copy(this.headAhead).applyQuaternion(chain);
    const headYaw = Math.atan2(probe.x, probe.z);

    const { twist } = this.gait;
    const swing = BLADE * aim - chestYaw;
    const back = (swing - twist) / 3;
    const lift = -pitch * aim;
    const breath = Math.sin(this.clock * 1.7) * 0.012;
    const flinch = this.hitT < 0.35 ? (1 - this.hitT / 0.35) * 0.3 * this.flinchSide : 0;
    chain.copy(this.base);
    turnBone(hips, 0, twist, 0);
    turnBone(low, lift * 0.15 + 0.06 * aim, back, 0);
    turnBone(mid, lift * 0.2 + breath, back + flinch, flinch * 0.4);
    turnBone(chest, lift * 0.2 - this.kick * 0.03, back, 0);
    const look = -(headYaw + swing);
    turnBone(neck, lift * 0.2 - breath, look * 0.45, 0);
    turnBone(head, lift * 0.25 + 0.1 * aim, look * 0.55, 0.08 * aim);
  }

  private holdCarbine(pose: SoldierPose, aim: number) {
    const { carbine, root } = this;
    point.copy(this.gripShoulder.position);
    this.gripShoulder.parent?.localToWorld(point);
    root.worldToLocal(point);
    aimTurn.setFromEuler(euler.set(pose.pitch + this.kick * 0.04, 0, 0));
    carbine.quaternion.copy(CARRY_TURN).slerp(aimTurn, aim);
    carbine.position
      .copy(CARRIED)
      .lerp(SHOULDERED, aim)
      .add(point)
      .addScaledVector(probe.set(0, 0, 1).applyQuaternion(carbine.quaternion), this.kick * 0.025);
    carbine.updateMatrixWorld(true);
  }

  private gripCarbine() {
    const { carbine, root } = this;
    carbine.getWorldQuaternion(worldTurn);
    root.getWorldQuaternion(rootTurn);
    this.gripArm.solve(
      carbine.localToWorld(point.copy(GRIP_WRIST)),
      pole.copy(GRIP_POLE).applyQuaternion(rootTurn),
      palm.copy(GRIP_PALM).applyQuaternion(worldTurn),
      fingers.copy(GRIP_FINGERS).applyQuaternion(worldTurn),
      1,
    );
    this.foreArm.solve(
      carbine.localToWorld(point.copy(FORE_WRIST)),
      pole.copy(FORE_POLE).applyQuaternion(rootTurn),
      palm.copy(FORE_PALM).applyQuaternion(worldTurn),
      fingers.copy(FORE_FINGERS).applyQuaternion(worldTurn),
      1,
    );
  }
}
