import { Vector3 } from "three";
import { DEFAULT_WORLD_BASIS } from "../math/world-basis.js";
import { toVec3 } from "../math/vector3-utils.js";

const EPS = 1e-6;

export class NearbyAvoidanceSteering {
  constructor({
    neighborDistance = 2.5,
    separationWeight = 1.2,
    sideStepWeight = 0.8,
    maxSteering = 2.5,
    blockerDot = 0.75,
    basis = DEFAULT_WORLD_BASIS,
  }) {
    this.neighborDistance = neighborDistance;
    this.separationWeight = separationWeight;
    this.sideStepWeight = sideStepWeight;
    this.maxSteering = maxSteering;
    this.blockerDot = blockerDot;
    this.basis = basis;
    this._toNeighbor = new Vector3();
    this._side = new Vector3();
    this._away = new Vector3();
    this._desired = new Vector3();
  }

  step({
    selfPosition,
    neighbors = [],
    desiredDirection = null,
    preferredDirection = 1,
    self = null,
  }) {
    const steering = new Vector3(0, 0, 0);
    const resolvedSelfPosition = toVec3(selfPosition);

    this._desired.copy(toVec3(desiredDirection));
    this.basis.flatten(this._desired);
    if (this._desired.lengthSq() > EPS * EPS) this._desired.normalize();

    let blockers = 0;
    const maxDistance = Math.max(EPS, this.neighborDistance);

    for (const other of neighbors) {
      if (other === self) continue;

      const otherPos = other?.position ?? other;
      if (!otherPos) continue;

      this._toNeighbor.subVectors(resolvedSelfPosition, otherPos);
      this.basis.flatten(this._toNeighbor);
      const distance = this._toNeighbor.length();
      if (distance <= EPS || distance > maxDistance) continue;

      const push = 1 - distance / maxDistance;
      const invDistance = 1 / Math.max(EPS, distance);

      this._away.copy(this._toNeighbor).multiplyScalar(invDistance * push * this.separationWeight);
      steering.add(this._away);

      this.basis
        .sideVector(this._toNeighbor, preferredDirection, this._side)
        .multiplyScalar(invDistance);
      if (this._side.lengthSq() > EPS * EPS) {
        this._side.normalize().multiplyScalar(push * this.sideStepWeight);
        steering.add(this._side);
      }

      if (this._desired.lengthSq() > EPS * EPS) {
        const desiredDot = Math.abs(
          this._toNeighbor.multiplyScalar(invDistance).dot(this._desired),
        );
        if (desiredDot > this.blockerDot) blockers += 1;
      }
    }

    if (steering.lengthSq() > this.maxSteering * this.maxSteering) {
      steering.setLength(this.maxSteering);
    }

    return {
      steering,
      blockers,
      blocked: blockers > 0,
    };
  }
}
