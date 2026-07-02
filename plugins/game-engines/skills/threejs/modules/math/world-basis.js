import { Matrix4, Quaternion, Vector3 } from "three";

const AXES = ["x", "y", "z"];
const AXIS_EPS = 1e-9;

const DEFAULT_AXES = Object.freeze({
  right: Object.freeze({ axis: "x", sign: 1 }),
  up: Object.freeze({ axis: "y", sign: 1 }),
  forward: Object.freeze({ axis: "z", sign: -1 }),
});

function readSignal(value) {
  if (value === true) return 1;
  if (value === false || value == null) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function parseAxisDescriptor(value, label) {
  const raw =
    typeof value === "string"
      ? value
      : value?.axis
        ? `${value.sign === -1 || value.sign === "-" ? "-" : "+"}${value.axis}`
        : null;
  if (typeof raw !== "string") {
    throw new Error(`WorldBasis: ${label} must be an axis string like "+x" or "-z"`);
  }

  const trimmed = raw.trim().toLowerCase();
  const sign = trimmed.startsWith("-") ? -1 : 1;
  const axis = trimmed.replace(/^[+-]/, "");
  if (!AXES.includes(axis)) {
    throw new Error(`WorldBasis: invalid ${label} axis "${raw}"`);
  }
  return { axis, sign };
}

function validateAxes(right, up, forward) {
  const rawAxes = [right.axis, up.axis, forward.axis];
  if (new Set(rawAxes).size !== 3) {
    throw new Error("WorldBasis: right, up, and forward must use three distinct world axes");
  }

  const r = { x: 0, y: 0, z: 0 };
  const f = { x: 0, y: 0, z: 0 };
  r[right.axis] = right.sign;
  f[forward.axis] = forward.sign;
  const cross = {
    x: r.y * f.z - r.z * f.y,
    y: r.z * f.x - r.x * f.z,
    z: r.x * f.y - r.y * f.x,
  };
  if (cross[up.axis] * up.sign <= 0) {
    throw new Error("WorldBasis: right x forward must point along up");
  }
}

function readComponent(value, axis) {
  return value?.[axis] ?? 0;
}

export class WorldBasis {
  constructor(config = DEFAULT_AXES) {
    const right = parseAxisDescriptor(config.right, "right");
    const up = parseAxisDescriptor(config.up, "up");
    const forward = parseAxisDescriptor(config.forward, "forward");

    validateAxes(right, up, forward);

    this.rightAxis = Object.freeze(right);
    this.upAxis = Object.freeze(up);
    this.forwardAxis = Object.freeze(forward);

    // Control sign lookup: multiply a positive delta by these values
    // to get the signed movement or right-hand-rule rotation angle.
    this.controlSigns = Object.freeze({
      left: -1,
      right: 1,
      up: 1,
      down: -1,
      forward: 1,
      backward: -1,
      counterClockWise: 1,
      clockWise: -1,
    });
  }

  rightVector(target = new Vector3()) {
    target.set(0, 0, 0);
    target[this.rightAxis.axis] = this.rightAxis.sign;
    return target;
  }

  upVector(target = new Vector3()) {
    target.set(0, 0, 0);
    target[this.upAxis.axis] = this.upAxis.sign;
    return target;
  }

  downVector(target = new Vector3()) {
    return this.upVector(target).multiplyScalar(-1);
  }

  forwardVector(target = new Vector3()) {
    target.set(0, 0, 0);
    target[this.forwardAxis.axis] = this.forwardAxis.sign;
    return target;
  }

  rightComponent(value) {
    return readComponent(value, this.rightAxis.axis) * this.rightAxis.sign;
  }

  upComponent(value) {
    return readComponent(value, this.upAxis.axis) * this.upAxis.sign;
  }

  forwardComponent(value) {
    return readComponent(value, this.forwardAxis.axis) * this.forwardAxis.sign;
  }

  setHeight(target, height = 0) {
    target[this.upAxis.axis] = this.upAxis.sign * height;
    return target;
  }

  flatten(target) {
    return this.setHeight(target, 0);
  }

  addHeight(target, delta = 0) {
    target[this.upAxis.axis] = readComponent(target, this.upAxis.axis) + this.upAxis.sign * delta;
    return target;
  }

  hasWorldPlanarComponents(value) {
    return (
      Boolean(value) &&
      Number.isFinite(value[this.rightAxis.axis]) &&
      Number.isFinite(value[this.forwardAxis.axis])
    );
  }

  toPlanar(value, out = { right: 0, forward: 0 }) {
    out.right = this.rightComponent(value);
    out.forward = this.forwardComponent(value);
    return out;
  }

  planarDelta(to, from, out = { right: 0, forward: 0 }) {
    out.right = this.rightComponent(to) - this.rightComponent(from);
    out.forward = this.forwardComponent(to) - this.forwardComponent(from);
    return out;
  }

  fromBasisComponents(right = 0, up = 0, forward = 0, target = new Vector3()) {
    target.set(0, 0, 0);
    target[this.rightAxis.axis] = this.rightAxis.sign * right;
    target[this.upAxis.axis] = this.upAxis.sign * up;
    target[this.forwardAxis.axis] = this.forwardAxis.sign * forward;
    return target;
  }

  toBasisComponents(value, out = { right: 0, up: 0, forward: 0 }) {
    out.right = this.rightComponent(value);
    out.up = this.upComponent(value);
    out.forward = this.forwardComponent(value);
    return out;
  }

  controlSignal(direction, signal) {
    if (Object.prototype.hasOwnProperty.call(this.controlSigns, direction)) {
      return this.controlSigns[direction] * readSignal(signal);
    }
    throw new Error(`WorldBasis: unknown control direction "${direction}"`);
  }

  surfaceNormalFromSlopes(rightSlope = 0, forwardSlope = 0, target = new Vector3()) {
    // For P(r, f) = r*right + h(r,f)*up + f*forward, an up-facing normal is
    // P_f x P_r = up - h_r*right - h_f*forward.
    return this.fromBasisComponents(-rightSlope, 1, -forwardSlope, target).normalize();
  }

  // Angles are radians. Using the right-hand rule, positive rotation is
  // counter-clockwise when looking from the positive end of the rotation axis
  // toward the origin.
  // yaw is positive CCW from the +up side;
  // pitch is positive CCW from the +right side;
  // roll is positive CCW from the +forward side.
  yawPitchRollFrame(yaw = 0, pitch = 0, roll = 0) {
    const pitchCos = Math.cos(pitch);
    const forward = this.fromBasisComponents(
      -Math.sin(yaw) * pitchCos,
      Math.sin(pitch),
      Math.cos(yaw) * pitchCos,
    ).normalize();
    const right = this.fromBasisComponents(Math.cos(yaw), 0, Math.sin(yaw)).normalize();
    const up = new Vector3().crossVectors(right, forward).normalize();

    if (roll) {
      right.applyAxisAngle(forward, roll).normalize();
      up.applyAxisAngle(forward, roll).normalize();
    }

    return {
      right,
      up,
      forward,
      back: forward.clone().multiplyScalar(-1),
    };
  }

  distanceSqPlanar(a, b) {
    const dRight = this.rightComponent(a) - this.rightComponent(b);
    const dForward = this.forwardComponent(a) - this.forwardComponent(b);
    return dRight * dRight + dForward * dForward;
  }

  planarLength(value) {
    const right = this.rightComponent(value);
    const forward = this.forwardComponent(value);
    return Math.sqrt(right * right + forward * forward);
  }

  sideVector(value, preferredDirection = 1, target = new Vector3()) {
    const right = this.rightComponent(value);
    const forward = this.forwardComponent(value);
    return this.fromBasisComponents(
      forward * preferredDirection,
      0,
      -right * preferredDirection,
      target,
    );
  }

  threeObjectCanonicalToBasisQuaternion(target = new Quaternion()) {
    // Upright mesh canonical: +X <-> right, +Y <-> up, -Z <-> forward
    return target.setFromRotationMatrix(
      new Matrix4().makeBasis(
        this.rightVector(),
        this.upVector(),
        this.forwardVector().multiplyScalar(-1),
      ),
    );
  }

  threePlaneCanonicalToBasisQuaternion(target = new Quaternion()) {
    // PlaneGeometry canonical: +X <-> right, +Y <-> forward, +Z <-> up
    return target.setFromRotationMatrix(
      new Matrix4().makeBasis(this.rightVector(), this.forwardVector(), this.upVector()),
    );
  }

  forwardToYaw(forward) {
    const right = this.rightComponent(forward);
    const forwardComponent = this.forwardComponent(forward);
    if (right * right + forwardComponent * forwardComponent <= AXIS_EPS) return 0;
    return Math.atan2(-right, forwardComponent);
  }
}

export const DEFAULT_WORLD_BASIS = Object.freeze(new WorldBasis(DEFAULT_AXES));

export function createWorldBasis(config = DEFAULT_AXES) {
  return new WorldBasis(config);
}
