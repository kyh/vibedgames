import { clamp01 } from "../math/scalar-utils.js";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";

export function projectRelativePlanar(
  right,
  forward,
  originRight = 0,
  originForward = 0,
  range = 1,
  width = 1,
  height = 1,
  positiveForwardDirection = "down",
  out = { x: 0, y: 0 },
) {
  const safeRange = Math.max(1e-6, range);
  const halfWidth = Math.max(0, width) * 0.5;
  const halfHeight = Math.max(0, height) * 0.5;
  const forwardSign = positiveForwardDirection === "up" ? -1 : 1;

  out.x = halfWidth + ((right - originRight) / safeRange) * halfWidth;
  out.y = halfHeight + forwardSign * ((forward - originForward) / safeRange) * halfHeight;
  return out;
}

export class MinimapProjector2D {
  constructor({
    planarBounds: { minRight, maxRight, minForward, maxForward },
    width = 200,
    height = 200,
    padding = 0,
    invertRight = false,
    invertForward = false,
    basis = DEFAULT_WORLD_BASIS,
  }) {
    this.planarBounds = { minRight, maxRight, minForward, maxForward };
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.padding = Math.max(0, padding);
    this.invertRight = Boolean(invertRight);
    this.invertForward = Boolean(invertForward);
    this.basis = basis;
  }

  setPlanarBounds(minRight, maxRight, minForward, maxForward) {
    this.planarBounds.minRight = minRight;
    this.planarBounds.maxRight = maxRight;
    this.planarBounds.minForward = minForward;
    this.planarBounds.maxForward = maxForward;
    return this;
  }

  setPlanarBoundsFromCenterSize(centerRight, centerForward, spanRight, spanForward) {
    this.planarBounds.minRight = centerRight - spanRight * 0.5;
    this.planarBounds.maxRight = centerRight + spanRight * 0.5;
    this.planarBounds.minForward = centerForward - spanForward * 0.5;
    this.planarBounds.maxForward = centerForward + spanForward * 0.5;
    return this;
  }

  setViewport(width = this.width, height = this.height, padding = this.padding) {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    this.padding = Math.max(0, padding);
    return this;
  }

  setInvert(invertRight = this.invertRight, invertForward = this.invertForward) {
    this.invertRight = Boolean(invertRight);
    this.invertForward = Boolean(invertForward);
    return this;
  }

  setBasis(basis = DEFAULT_WORLD_BASIS) {
    this.basis = basis;
    return this;
  }

  projectPlanar(right, forward, out = { x: 0, y: 0 }) {
    const rangeRight = Math.max(1e-6, this.planarBounds.maxRight - this.planarBounds.minRight);
    const rangeForward = Math.max(
      1e-6,
      this.planarBounds.maxForward - this.planarBounds.minForward,
    );
    const normalizedRight = clamp01((right - this.planarBounds.minRight) / rangeRight);
    const normalizedForward = clamp01((forward - this.planarBounds.minForward) / rangeForward);
    const drawableWidth = Math.max(0, this.width - this.padding * 2);
    const drawableHeight = Math.max(0, this.height - this.padding * 2);

    out.x =
      this.padding + (this.invertRight ? 1 - normalizedRight : normalizedRight) * drawableWidth;
    out.y =
      this.padding +
      (this.invertForward ? normalizedForward : 1 - normalizedForward) * drawableHeight;
    return out;
  }

  project(worldPosition, out = { x: 0, y: 0 }) {
    const planar = this.basis.toPlanar(worldPosition);
    return this.projectPlanar(planar.right, planar.forward, out);
  }

  projectYaw(forwardVector) {
    const planar = this.basis.toPlanar(forwardVector);
    const right = planar.right;
    const forward = planar.forward;
    const mapDx = (this.invertRight ? -1 : 1) * right;
    const mapDy = (this.invertForward ? 1 : -1) * forward;
    return Math.atan2(mapDx, -mapDy);
  }

  projectPath(path = []) {
    return path.map((point) => this.project(point, {}));
  }

  getOrthoFrustumFromBounds() {
    return {
      left: this.planarBounds.minRight,
      right: this.planarBounds.maxRight,
      top: this.planarBounds.maxForward,
      bottom: this.planarBounds.minForward,
    };
  }
}
