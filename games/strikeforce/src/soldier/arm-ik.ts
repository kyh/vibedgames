import { Matrix4, Quaternion, Vector3 } from "three";
import type { Bone, Object3D } from "three";

const FORWARD = new Vector3(0, 0, -1);
const DOWN = new Vector3(0, -1, 0);

const shoulder = new Vector3();
const reach = new Vector3();
const bend = new Vector3();
const hinge = new Vector3();
const elbow = new Vector3();
const along = new Vector3();
const across = new Vector3();
const basis = new Matrix4();
const parentWorld = new Quaternion();
const upperWorld = new Quaternion();
const foreWorld = new Quaternion();
const handWorld = new Quaternion();
const local = new Quaternion();

const facing = (x: Vector3, y: Vector3, out: Quaternion) =>
  out.setFromRotationMatrix(basis.makeBasis(x, y, across.crossVectors(x, y)));

const restFrame = (bone: Bone, space: Object3D, x: Vector3, y: Vector3) => {
  const rest = bone.getWorldQuaternion(new Quaternion());
  const frame = space.getWorldQuaternion(new Quaternion()).multiply(facing(x, y, new Quaternion()));

  return frame.invert().multiply(rest);
};

export class Arm {
  private readonly upper: Bone;
  private readonly fore: Bone;
  private readonly hand: Bone;
  private readonly upperLength: number;
  private readonly foreLength: number;
  private readonly upperRest: Quaternion;
  private readonly foreRest: Quaternion;
  private readonly handRest: Quaternion;

  /**
   * `space` is the soldier's own frame (facing -Z, Y up), in which the arm
   * is at rest in a T-pose with current world matrices; `side` is -1 for its
   * left arm, 1 for its right.
   */
  constructor(upper: Bone, fore: Bone, hand: Bone, space: Object3D, side: number) {
    this.upper = upper;
    this.fore = fore;
    this.hand = hand;
    const scale = fore.getWorldScale(new Vector3()).x;
    this.upperLength = fore.position.length() * scale;
    this.foreLength = hand.position.length() * scale;
    const out = new Vector3(side, 0, 0);
    const fold = new Vector3().crossVectors(out, FORWARD);
    this.upperRest = restFrame(upper, space, fold, out);
    this.foreRest = restFrame(fore, space, fold, out);
    this.handRest = restFrame(hand, space, DOWN, out);
  }

  /**
   * Put the wrist at `wrist` with the palm facing `palm` and the fingers
   * along `fingers`, the elbow swung towards `pole` (all world space, unit
   * where directions; the upper arm's parent must have a current world
   * matrix). `weight` 0 leaves the clip's pose, 1 replaces it.
   */
  solve(wrist: Vector3, pole: Vector3, palm: Vector3, fingers: Vector3, weight: number) {
    const { parent } = this.upper;

    if (!parent || weight <= 0) {
      return;
    }

    const { upperLength: a, foreLength: b } = this;
    shoulder.copy(this.upper.position).applyMatrix4(parent.matrixWorld);
    reach.subVectors(wrist, shoulder);
    const distance = Math.max(0.05, Math.min((a + b) * 0.999, reach.length()));
    reach.normalize();
    bend.copy(pole).addScaledVector(reach, -pole.dot(reach)).normalize();
    const toElbow = (a * a - b * b + distance * distance) / (2 * distance);
    const outward = Math.sqrt(Math.max(0, a * a - toElbow * toElbow));
    elbow.copy(reach).multiplyScalar(toElbow).addScaledVector(bend, outward);
    hinge.crossVectors(bend, reach).normalize();

    parent.getWorldQuaternion(parentWorld);
    facing(hinge, along.copy(elbow).normalize(), upperWorld).multiply(this.upperRest);
    along.copy(reach).multiplyScalar(distance).sub(elbow).normalize();
    facing(hinge, along, foreWorld).multiply(this.foreRest);
    along.copy(fingers).addScaledVector(palm, -fingers.dot(palm)).normalize();
    facing(palm, along, handWorld).multiply(this.handRest);

    this.upper.quaternion.slerp(local.copy(parentWorld).invert().multiply(upperWorld), weight);
    this.fore.quaternion.slerp(local.copy(upperWorld).invert().multiply(foreWorld), weight);
    this.hand.quaternion.slerp(local.copy(foreWorld).invert().multiply(handWorld), weight);
  }
}
