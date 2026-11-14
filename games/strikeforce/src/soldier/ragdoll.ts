// A soldier gone limp. The moment it dies its skeleton is handed to a body of
// points (verlet.ts) — pelvis, chest, head, and each limb's three joints —
// taken from wherever the animation had them, moving as the soldier was. From
// then on gravity, the ground and the shot that killed it decide how it
// falls, and the bones are read back off the points: the trunk from the hip
// and shoulder lines, each limb bone swung to point at its next joint. The
// carbine is three more points of its own, so it drops and comes to lie flat.
//
// The limits are measured on the rest pose, so a body dropped mid-stride is
// held to its own proportions; what a distance cannot say — a knee folds one
// way — is said in `knees()`.
import { Matrix4, Quaternion, Vector3 } from "three";
import type { Bone, Object3D } from "three";

import { Verlet } from "./verlet";
import type { Point, Terrain } from "./verlet";

/** The carbine's butt plate, muzzle and grip, in its own space: the three it comes to rest on. */
const CARBINE = [new Vector3(0, 0, 0), new Vector3(0, 0, -0.78), new Vector3(0, -0.14, -0.15)];
const TRUNK = ["Hips", "Spine02", "Spine01", "Spine"] as const;
/** A shot moves what it strikes, and less of whatever is further off: this far, in metres. */
const SPREAD = 0.3;
const CARRIED = 0.25;
/**
 * How far behind the line from hip to ankle a knee may sit, in metres: enough
 * that a leg lying flat is left alone, since one pushed off the ground never rests.
 */
const KNEE_SLACK = 0.02;
/** How far behind its hip a knee may swing, in metres. */
const HIP_REACH = 0.12;
/** Nobody falls dead straight: the head and chest start off this fast, m/s, some way or other. */
const TOPPLE = 0.7;

/** A bone swung to keep pointing at a joint below it. */
interface Aimed {
  bone: Bone;
  /** The bone the joint sits at. */
  at: Bone;
  /** As it was posed when the body dropped, and which way the joint lay from it then. */
  local: Quaternion;
  toward: Vector3;
}

interface Limb {
  root: Point;
  mid: Point;
  end: Point;
  upper: Aimed;
  lower: Aimed;
}

interface Kept {
  bone: Bone;
  rest: Quaternion;
}

const basis = new Matrix4();
const x = new Vector3();
const y = new Vector3();
const z = new Vector3();
const up = new Vector3();
const span = new Vector3();
const ahead = new Vector3();
const line = new Vector3();
const off = new Vector3();
const spot = new Vector3();
const arc = new Quaternion();
const low = new Quaternion();
const high = new Quaternion();
const mid = new Quaternion();
const world = new Quaternion();
const parent = new Quaternion();
const pelvic = new Quaternion();
const inverse = new Quaternion();

/** The turn whose X runs along `across` and whose Y leans towards `upward`. */
const frame = (across: Vector3, upward: Vector3, out: Quaternion): Quaternion => {
  x.copy(across).normalize();
  y.copy(upward).addScaledVector(x, -upward.dot(x)).normalize();
  return out.setFromRotationMatrix(basis.makeBasis(x, y, z.crossVectors(x, y)));
};

/**
 * Turn `part`'s bone, hung from a parent turned `hung`, the least it takes
 * to point from one point at the next. `hung` comes back as the bone's own turn.
 */
const swing = (part: Aimed, hung: Quaternion, from: Point, to: Point): void => {
  world.copy(hung).multiply(part.local);
  x.copy(part.toward).applyQuaternion(world);
  y.subVectors(to.at, from.at).normalize();
  world.premultiply(arc.setFromUnitVectors(x, y));
  part.bone.quaternion.copy(inverse.copy(hung).invert()).multiply(world);
  hung.copy(world);
};

const aimed = (bone: Bone, at: Bone): Aimed => ({
  at,
  bone,
  local: new Quaternion(),
  toward: new Vector3(),
});

export class Ragdoll {
  /** Limp, and in charge of the bones. */
  down = false;
  private readonly points: Verlet;
  private readonly root: Object3D;
  private readonly carbine: Object3D;
  private readonly joints: { bone: Bone; point: Point }[] = [];
  private readonly pelvis: Point;
  private readonly chest: Point;
  private readonly head: Point;
  private readonly arms: Limb[];
  private readonly legs: Limb[];
  private readonly neck: Aimed;
  private readonly collars: Bone[];
  /** Hips to chest, with each bone's turn from the trunk's own frame at its height. */
  private readonly trunk: { bone: Bone; off: Quaternion }[];
  private readonly loose: Point[];
  private readonly carbineOff = new Quaternion();
  /** Every bone it poses, as animation left it: handed back when the soldier rises. */
  private readonly kept: Kept[];
  private readonly hips: Bone;
  private readonly hipsAt = new Vector3();
  /** The turn of whatever the hips hang from. */
  private readonly base = new Quaternion();
  /** Which side of the hip line the toes are: 1 or -1. */
  private readonly toes: number;
  private posed = false;

  /** `root` holds the body, in its rest pose with current world matrices, and the carbine. */
  constructor(bone: (name: string) => Bone, root: Object3D, carbine: Object3D, terrain: Terrain) {
    this.root = root;
    this.carbine = carbine;
    this.points = new Verlet(terrain);
    const { points } = this;
    const joint = (name: string, radius: number, mass: number): Point => {
      const point = points.add(bone(name).getWorldPosition(spot), radius, mass);
      this.joints.push({ bone: bone(name), point });
      return point;
    };
    const limb = (names: readonly [string, string, string], radius: number, mass: number): Limb => {
      const [top, middle, tip] = names;
      const made = {
        end: joint(tip, radius * 0.8, mass * 0.6),
        lower: aimed(bone(middle), bone(tip)),
        mid: joint(middle, radius, mass),
        root: joint(top, radius * 1.3, mass * 2),
        upper: aimed(bone(top), bone(middle)),
      };
      points.rod(made.root, made.mid);
      points.rod(made.mid, made.end);
      return made;
    };

    this.hips = bone("Hips");
    this.pelvis = joint("Hips", 0.11, 4);
    this.chest = joint("neck", 0.1, 4);
    this.head = joint("head_end", 0.11, 1.5);
    this.neck = aimed(bone("neck"), bone("head_end"));
    this.arms = [
      limb(["LeftArm", "LeftForeArm", "LeftHand"], 0.055, 0.7),
      limb(["RightArm", "RightForeArm", "RightHand"], 0.055, 0.7),
    ];
    this.legs = [
      limb(["LeftUpLeg", "LeftLeg", "LeftFoot"], 0.075, 1.2),
      limb(["RightUpLeg", "RightLeg", "RightFoot"], 0.075, 1.2),
    ];
    this.collars = [bone("LeftShoulder"), bone("RightShoulder")];
    this.trunk = TRUNK.map((name) => ({ bone: bone(name), off: new Quaternion() }));
    this.kept = [
      ...this.trunk.map((part) => part.bone),
      this.neck.bone,
      ...[...this.arms, ...this.legs].flatMap((part) => [part.upper.bone, part.lower.bone]),
    ].map((held) => ({ bone: held, rest: new Quaternion() }));

    const [leftArm, rightArm] = this.arms;
    const [leftLeg, rightLeg] = this.legs;
    if (!leftArm || !rightArm || !leftLeg || !rightLeg) {
      throw new Error("ragdoll: a limb is missing");
    }
    const { pelvis, chest, head } = this;
    // The trunk: a spine, the hip and shoulder lines across it, and braces
    // that let it twist and lean a little but not fold flat.
    points.rod(pelvis, chest);
    points.rod(leftLeg.root, rightLeg.root);
    points.rod(leftArm.root, rightArm.root);
    for (const side of [leftLeg, rightLeg]) {
      points.rod(pelvis, side.root);
      points.rod(chest, side.root, 0.96, 1.03);
    }
    for (const side of [leftArm, rightArm]) {
      points.rod(chest, side.root);
      points.rod(pelvis, side.root, 0.96, 1.03);
      points.rod(head, side.root, 0.82, 1.1);
    }
    points.rod(leftLeg.root, leftArm.root, 0.9, 1.06);
    points.rod(rightLeg.root, rightArm.root, 0.9, 1.06);
    points.rod(leftLeg.root, rightArm.root, 0.88, 1.08);
    points.rod(rightLeg.root, leftArm.root, 0.88, 1.08);
    points.rod(chest, head);
    // The shoulders stop the head lolling sideways; this stops it nodding right over.
    points.rod(pelvis, head, 0.9, 1.04);
    // What a body cannot pass through itself.
    points.apart(leftLeg.mid, rightLeg.mid, 0.17);
    points.apart(leftLeg.end, rightLeg.end, 0.15);
    points.apart(leftLeg.mid, rightLeg.end, 0.14);
    points.apart(rightLeg.mid, leftLeg.end, 0.14);
    for (const leg of [leftLeg, rightLeg]) {
      points.apart(leg.mid, chest, 0.45);
      points.apart(leg.end, pelvis, 0.24);
      points.apart(leg.end, leg.root, 0.26);
    }
    for (const arm of [leftArm, rightArm]) {
      points.apart(arm.end, pelvis, 0.2);
      points.apart(arm.end, chest, 0.2);
      points.apart(arm.mid, pelvis, 0.2);
      points.apart(arm.end, head, 0.16);
      points.apart(arm.end, arm.root, 0.14);
    }

    this.loose = CARBINE.map((corner) => points.add(carbine.localToWorld(spot.copy(corner)), 0.03));
    const [butt, muzzle, grip] = this.loose;
    if (butt && muzzle && grip) {
      points.rod(butt, muzzle);
      points.rod(muzzle, grip);
      points.rod(grip, butt);
    }

    const toe = bone("LeftToeBase").getWorldPosition(new Vector3());
    this.forward(1);
    this.toes = Math.sign(toe.sub(leftLeg.end.at).dot(ahead)) || 1;
  }

  /** Go limp from the pose it is in, moving at `velocity`. */
  drop(velocity: Vector3): void {
    const { points, root, carbine } = this;
    root.updateMatrixWorld(true);
    for (const { bone, point } of this.joints) {
      points.place(point, bone.getWorldPosition(spot), velocity);
    }
    for (const [i, corner] of CARBINE.entries()) {
      const point = this.loose[i];
      if (point) {
        points.place(point, carbine.localToWorld(spot.copy(corner)), velocity);
      }
    }
    for (const kept of this.kept) {
      kept.rest.copy(kept.bone.quaternion);
    }
    this.hipsAt.copy(this.hips.position);
    this.hips.parent?.getWorldQuaternion(this.base);
    this.spans(low, high);
    for (const [i, part] of this.trunk.entries()) {
      mid.slerpQuaternions(low, high, i / (this.trunk.length - 1)).invert();
      part.off.copy(mid).multiply(part.bone.getWorldQuaternion(world));
    }
    for (const part of [
      this.neck,
      ...[...this.arms, ...this.legs].flatMap((l) => [l.upper, l.lower]),
    ]) {
      part.local.copy(part.bone.quaternion);
      part.bone.worldToLocal(part.at.getWorldPosition(part.toward)).normalize();
    }
    this.carbineOff.copy(this.lie(mid)).invert().multiply(carbine.getWorldQuaternion(world));
    const way = Math.random() * Math.PI * 2;
    spot.set(Math.cos(way), 0, Math.sin(way));
    points.kick(this.chest, spot, TOPPLE);
    points.kick(this.head, spot, TOPPLE);
    this.down = true;
    this.posed = false;
  }

  /** A shot along `dir` (unit) struck at `at`: throw what it hit at `speed` m/s. */
  shove(at: Vector3, dir: Vector3, speed: number): void {
    for (const { point } of this.joints) {
      const near = Math.exp(-point.at.distanceToSquared(at) / (2 * SPREAD * SPREAD));
      this.points.kick(point, dir, speed * (CARRIED + near));
    }
  }

  /** `dt` seconds of falling. */
  update(dt: number): void {
    if (this.points.resting && this.posed) {
      return;
    }
    this.points.advance(dt, this.knees);
    this.pose();
  }

  /** Hand the bones back to the animation. */
  rise(): void {
    this.down = false;
    this.hips.position.copy(this.hipsAt);
    for (const { bone, rest } of this.kept) {
      bone.quaternion.copy(rest);
    }
  }

  /** The trunk's frames at the hips and at the shoulders. */
  private spans(hips: Quaternion, shoulders: Quaternion): void {
    const [leftArm, rightArm] = this.arms;
    const [leftLeg, rightLeg] = this.legs;
    if (!leftArm || !rightArm || !leftLeg || !rightLeg) {
      return;
    }
    up.subVectors(this.chest.at, this.pelvis.at);
    frame(span.subVectors(rightLeg.root.at, leftLeg.root.at), up, hips);
    frame(span.subVectors(rightArm.root.at, leftArm.root.at), up, shoulders);
  }

  /** The carbine's frame, off its three points. */
  private lie(out: Quaternion): Quaternion {
    const [butt, muzzle, grip] = this.loose;
    if (!butt || !muzzle || !grip) {
      return out.identity();
    }
    return frame(span.subVectors(muzzle.at, butt.at), up.subVectors(grip.at, butt.at), out);
  }

  /** Leave in `ahead` the way the body's front faces, times `sign`. */
  private forward(sign: number): void {
    const [leftLeg, rightLeg] = this.legs;
    if (!leftLeg || !rightLeg) {
      return;
    }
    span.subVectors(rightLeg.root.at, leftLeg.root.at);
    up.subVectors(this.chest.at, this.pelvis.at);
    ahead.crossVectors(span, up).normalize().multiplyScalar(sign);
  }

  /**
   * A leg swings forwards from the hip and folds forwards at the knee: a
   * thigh found too far behind the body, or a knee behind its leg's line, is
   * put back.
   */
  private readonly knees = (): void => {
    this.forward(this.toes);
    for (const leg of this.legs) {
      const behind = -HIP_REACH - spot.subVectors(leg.mid.at, leg.root.at).dot(ahead);
      if (behind > 0) {
        leg.mid.at.addScaledVector(ahead, behind * 0.6);
        leg.root.at.addScaledVector(ahead, -behind * 0.2);
      }
      line.subVectors(leg.end.at, leg.root.at).normalize();
      off.copy(ahead).addScaledVector(line, -ahead.dot(line));
      // A leg pointing straight out of the body has no front of its own.
      if (off.lengthSq() < 0.04) {
        continue;
      }
      off.normalize();
      spot.subVectors(leg.mid.at, leg.root.at);
      const short = -KNEE_SLACK - spot.dot(off);
      if (short > 0) {
        leg.mid.at.addScaledVector(off, short * 0.5);
        leg.root.at.addScaledVector(off, -short * 0.15);
        leg.end.at.addScaledVector(off, -short * 0.35);
      }
    }
  };

  /** Read the bones back off the points. */
  private pose(): void {
    const { root, carbine, hips } = this;
    this.posed = true;
    // The body is drawn, culled and ranged by its root: keep that under it.
    root.position.x = this.pelvis.at.x;
    root.position.z = this.pelvis.at.z;
    root.updateMatrixWorld(true);
    hips.parent?.worldToLocal(hips.position.copy(this.pelvis.at));

    this.spans(low, high);
    parent.copy(this.base);
    const last = this.trunk.length - 1;
    for (const [i, part] of this.trunk.entries()) {
      world.slerpQuaternions(low, high, i / last).multiply(part.off);
      part.bone.quaternion.copy(inverse.copy(parent).invert()).multiply(world);
      parent.copy(world);
      if (i === 0) {
        pelvic.copy(world);
      }
    }
    // `parent` is now the chest's own turn.
    swing(this.neck, mid.copy(parent), this.chest, this.head);
    for (const [i, arm] of this.arms.entries()) {
      const collar = this.collars[i];
      if (collar) {
        mid.copy(parent).multiply(collar.quaternion);
        swing(arm.upper, mid, arm.root, arm.mid);
        swing(arm.lower, mid, arm.mid, arm.end);
      }
    }
    for (const leg of this.legs) {
      mid.copy(pelvic);
      swing(leg.upper, mid, leg.root, leg.mid);
      swing(leg.lower, mid, leg.mid, leg.end);
    }

    root.getWorldQuaternion(inverse).invert();
    carbine.quaternion.copy(inverse).multiply(this.lie(world)).multiply(this.carbineOff);
    const [butt] = this.loose;
    if (butt) {
      root.worldToLocal(carbine.position.copy(butt.at));
    }
  }
}
