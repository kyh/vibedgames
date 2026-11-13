// A soldier on screen: the rigged body and its carbine (soldier-rig.ts) in a
// kit (soldier-kit.ts), animated from nothing but where it is shown standing.
//
// Legs: the gait (soldier-gait.ts) blends the locomotion clips over the
// standing rest pose by the velocity it reads off the positions. Upper body:
// the carbine is not held by a clip. It sits in an aim frame of its own —
// butt in the shoulder, bore along the soldier's yaw and pitch — or, calm or
// at a run, across the body at the low ready; both arms reach it by IK, the
// chest squares up behind it and the head stays on the target. A shot kicks
// it; a hit plays the flinch; death plays a fall, arms and all, and the
// carbine drops.
//
// Hitboxes — head, torso, legs — ride the bones, so shots land where the
// body is drawn. Faces -Z at yaw 0, like the camera.
import { AnimationMixer, Euler, Group, Quaternion, Vector3 } from "three";
import type { AnimationAction, Bone, Mesh, SkinnedMesh } from "three";

import { Arm } from "./arm-ik";
import { Gait, STRIDES, STRIDE_NAMES } from "./soldier-gait";
import type { Kit } from "./soldier-kit";
import { CLIP_NAMES, soldierBody } from "./soldier-rig";
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
/** Radians the chest turns off the aim to shoulder a carbine: support side forward. */
const BLADE = -0.45;
/** The flinch and the falls are played faster than they were animated: a shot is abrupt. */
const HIT_RATE = 1.6;
const HIT_SECONDS = 0.55;
const DEATH_RATE = 1.3;
/** A crouched soldier standing still holds its crouched stride here. */
const CROUCH_HOLD = 0.2;

/** Animation rate by how the soldier was last drawn: full, then thinning with range, least unseen. */
const LOD = [
  { beyond: 55, every: 1 / 15 },
  { beyond: 28, every: 1 / 30 },
] as const;
const UNSEEN_EVERY = 1 / 8;

// Points on the carbine, in its own space: butt plate at the origin, bore
// along -Z, sights up. Where each wrist goes — behind the pistol grip, and
// under the handguard — and where it fires from.
const MUZZLE = new Vector3(0, 0, -0.78);
const GRIP_WRIST = new Vector3(0.03, -0.14, -0.15);
const FORE_WRIST = new Vector3(-0.06, -0.05, -0.4);
// How each hand lies on it, as (palm normal, fingers) in the carbine's
// space: the firing hand's palm against the grip's right side, fingers
// forward and up it; the support hand cupping the handguard from below.
const GRIP_PALM = new Vector3(-1, 0, 0);
const GRIP_FINGERS = new Vector3(0, 0.45, -0.9).normalize();
const FORE_PALM = new Vector3(0.35, 0.94, 0).normalize();
const FORE_FINGERS = new Vector3(0.75, -0.2, -0.63).normalize();
/** Which way each elbow hangs, in the soldier's own space. */
const GRIP_POLE = new Vector3(0.55, -1, 0.5);
const FORE_POLE = new Vector3(-0.45, -1, 0.1);

// The butt plate against the shoulder, from the firing arm's shoulder joint,
// in the soldier's space; and how the carbine lies at the low ready.
const SHOULDERED = new Vector3(-0.07, 0.08, -0.05);
const CARRIED = new Vector3(-0.1, -0.06, -0.1);
const CARRY_TURN = new Quaternion().setFromEuler(new Euler(-0.7, 0.75, 0.3, "YXZ"));
const DROPPED_TURN = new Quaternion().setFromEuler(new Euler(0, 0.9, Math.PI / 2, "YXZ"));

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
  private readonly carbine: Group;
  private readonly mixer: AnimationMixer;
  private readonly actions: Record<ClipName, AnimationAction>;
  private readonly spine: Bone[];
  /**
   * Every bone posed on top of its clip, with the clip's pose for it. The
   * mixer only rewrites a bone whose clip value moved, so each is put back
   * before it runs: a turn laid over last frame's result would compound.
   */
  private readonly posed: { bone: Bone; clip: Quaternion }[];
  /** The turn of whatever the hips hang from: the spine chain starts there. */
  private readonly base: Quaternion;
  /** Straight ahead, in the chest's and the head's own spaces. */
  private readonly chestAhead: Vector3;
  private readonly headAhead: Vector3;
  private readonly gripArm: Arm;
  private readonly foreArm: Arm;
  private readonly gripShoulder: Bone;
  private readonly gait = new Gait();
  private clock = 0;
  private pending = Infinity;
  /** Frames since it was last drawn, and how far off that was. */
  private unseen = 0;
  private range = 0;
  private aim = 0;
  private dead = 0;
  private deathT = 0;
  private fall: "death-back" | "death-front" = "death-back";
  private hitT = Infinity;
  private flinchSide = 1;
  private kick = 0;
  private sinceFire = Infinity;
  private dropSpeed = 0;

  constructor(kit: Kit, name: string) {
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
      // Every clip is scrubbed by hand: weights and times are set each frame.
      action.timeScale = 0;
      action.weight = 0;
      action.play();
      actions.set(clip, action);
    }
    const action = (clip: ClipName): AnimationAction => {
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
      "death-back": action("death-back"),
      "death-front": action("death-front"),
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
    body.mesh.onBeforeRender = (_renderer, _scene, camera) => {
      this.unseen = 0;
      this.range = camera.position.distanceTo(this.root.position);
    };
  }

  /** A hit from `side` (-1 left, 1 right): the body takes it and twists away. */
  flinch(side: number): void {
    this.hitT = 0;
    this.flinchSide = side < 0 ? -1 : 1;
  }

  /** It fired: the carbine kicks, and comes onto the aim if it was off it. */
  fire(): void {
    this.kick = 1;
    this.sinceFire = 0;
  }

  /** Where the carbine's muzzle is in the world. */
  muzzle(out: Vector3): Vector3 {
    this.root.updateMatrixWorld(true);
    return this.carbine.localToWorld(out.copy(MUZZLE));
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
      if (this.deathT === 0) {
        // Shot from in front it goes over backwards, mostly.
        this.fall = Math.random() < 0.65 ? "death-back" : "death-front";
      }
      this.dead = Math.min(1, this.dead + dt * 7);
      this.deathT += dt;
    }
    const on = pose.aiming && (this.gait.speed < CARRY_SPEED || this.sinceFire < FIRE_HOLD);
    this.aim = approach(this.aim, pose.alive && on ? 1 : 0, on ? 11 : 6, dt);
    const alive = 1 - ease(this.dead);
    const aim = ease(this.aim) * alive;

    this.blend(alive, dt);
    for (const { bone, clip } of this.posed) {
      bone.quaternion.copy(clip);
    }
    this.mixer.update(0);
    for (const { bone, clip } of this.posed) {
      clip.copy(bone.quaternion);
    }
    this.turnSpine(pose.pitch, aim, alive);
    this.root.updateMatrixWorld(true);
    this.holdCarbine(pose, aim, dt);
    this.gripCarbine(alive);
  }

  /** Set every clip's weight and place in time. */
  private blend(alive: number, dt: number): void {
    const { actions, gait } = this;
    const hit =
      this.hitT < HIT_SECONDS
        ? Math.min(1, this.hitT / 0.05, (HIT_SECONDS - this.hitT) / 0.2) * 0.75
        : 0;
    // Weights ease to where the gait wants them, so swapping a walk for a backpedal is a blend, not a cut.
    const k = dt > 0 ? 1 - Math.exp(-12 * dt) : 1;
    const live = (1 - hit) * alive;
    for (const name of STRIDE_NAMES) {
      const action = actions[name];
      action.weight += (gait.weights[name] * live - action.weight) * k;
      action.time = ((gait.phase + STRIDES[name].lead) % 1) * action.getClip().duration;
    }
    if (gait.speed < 0.3) {
      actions["crouch-walk"].time = CROUCH_HOLD * actions["crouch-walk"].getClip().duration;
    }
    actions.hit.weight = hit * alive;
    actions.hit.time = Math.min(this.hitT * HIT_RATE, actions.hit.getClip().duration);
    for (const name of ["death-back", "death-front"] as const) {
      actions[name].weight = name === this.fall ? 1 - alive : 0;
      actions[name].time = Math.min(this.deathT * DEATH_RATE, actions[name].getClip().duration);
    }
  }

  /**
   * Turn the hips to the legs' heading and the spine back, squaring the
   * chest up behind the carbine — wherever the clips have left it — with
   * the head on the target. The aim's pitch, breathing, the kick and the
   * flinch are laid over that.
   */
  private turnSpine(pitch: number, aim: number, alive: number): void {
    const [hips, low, mid, chest, neck, head] = this.spine;
    if (!hips || !low || !mid || !chest || !neck || !head) {
      return;
    }
    // Where the clips alone face the chest and the head, in the rig's space (it faces +Z).
    chain.copy(this.base).multiply(hips.quaternion).multiply(low.quaternion);
    chain.multiply(mid.quaternion).multiply(chest.quaternion);
    probe.copy(this.chestAhead).applyQuaternion(chain);
    const chestYaw = Math.atan2(probe.x, probe.z);
    chain.multiply(neck.quaternion).multiply(head.quaternion);
    probe.copy(this.headAhead).applyQuaternion(chain);
    const headYaw = Math.atan2(probe.x, probe.z);

    const twist = this.gait.twist * alive;
    const swing = (BLADE * aim - chestYaw) * alive;
    const back = (swing - twist) / 3;
    // Looking up is a negative turn about the rig's X.
    const lift = -pitch * aim;
    const breath = Math.sin(this.clock * 1.7) * 0.012 * alive;
    const flinch = this.hitT < 0.35 ? (1 - this.hitT / 0.35) * 0.3 * this.flinchSide * alive : 0;
    chain.copy(this.base);
    turnBone(hips, 0, twist, 0);
    turnBone(low, lift * 0.15 + 0.06 * aim, back, 0);
    turnBone(mid, lift * 0.2 + breath, back + flinch, flinch * 0.4);
    turnBone(chest, lift * 0.2 - this.kick * 0.03 * alive, back, 0);
    const look = -(headYaw + swing) * alive;
    turnBone(neck, lift * 0.2 - breath, look * 0.45, 0);
    // Cheek to the stock: the head drops and tips over the carbine.
    turnBone(head, lift * 0.25 + 0.1 * aim, look * 0.55, 0.08 * aim);
  }

  /** Shoulder the carbine along the aim, or carry it low; let it fall when its owner does. */
  private holdCarbine(pose: SoldierPose, aim: number, dt: number): void {
    const { carbine, root } = this;
    if (!pose.alive) {
      this.dropSpeed += 9.8 * dt;
      carbine.position.y = Math.max(0.03, carbine.position.y - this.dropSpeed * dt);
      carbine.quaternion.slerp(DROPPED_TURN, 1 - Math.exp(-7 * dt));
      return;
    }
    this.dropSpeed = 0;
    point.copy(this.gripShoulder.position);
    this.gripShoulder.parent?.localToWorld(point);
    root.worldToLocal(point);
    aimTurn.setFromEuler(euler.set(pose.pitch + this.kick * 0.04, 0, 0));
    carbine.quaternion.copy(CARRY_TURN).slerp(aimTurn, aim);
    carbine.position
      .copy(CARRIED)
      .lerp(SHOULDERED, aim)
      .add(point)
      // Recoil: straight back along the bore.
      .addScaledVector(probe.set(0, 0, 1).applyQuaternion(carbine.quaternion), this.kick * 0.025);
    carbine.updateMatrixWorld(true);
  }

  /** Both hands to the carbine. */
  private gripCarbine(alive: number): void {
    const { carbine, root } = this;
    if (alive <= 0) {
      return;
    }
    carbine.getWorldQuaternion(worldTurn);
    root.getWorldQuaternion(rootTurn);
    this.gripArm.solve(
      carbine.localToWorld(point.copy(GRIP_WRIST)),
      pole.copy(GRIP_POLE).applyQuaternion(rootTurn),
      palm.copy(GRIP_PALM).applyQuaternion(worldTurn),
      fingers.copy(GRIP_FINGERS).applyQuaternion(worldTurn),
      alive,
    );
    this.foreArm.solve(
      carbine.localToWorld(point.copy(FORE_WRIST)),
      pole.copy(FORE_POLE).applyQuaternion(rootTurn),
      palm.copy(FORE_PALM).applyQuaternion(worldTurn),
      fingers.copy(FORE_FINGERS).applyQuaternion(worldTurn),
      alive,
    );
  }
}
