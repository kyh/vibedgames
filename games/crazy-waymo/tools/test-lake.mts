import { Matrix4, Vector3 } from "three";

import { WORLD_H, WORLD_W } from "../src/shared/constants";
import type { CityRestPayload } from "../src/world/city";
import {
  GGP_LAKE,
  STOW_WATER_Y,
  stowBasinHeight,
  stowBasinOverlapsBox,
  stowWaterHeightAt,
} from "../src/world/lake";
import { DriveSurface } from "../src/world/surface";
import type { AuditWorld } from "./geometry-audit.mts";

type Check = (name: string, condition: boolean, detail?: string) => void;
const X = (GGP_LAKE.u - 0.5) * WORLD_W;
const Z = (GGP_LAKE.v - 0.5) * WORLD_H;

export function checkLake(check: Check, world: AuditWorld, rest: CityRestPayload): void {
  check(
    "park footprint exclusion catches edge overlap even when its centre is outside the basin",
    stowBasinOverlapsBox(X + GGP_LAKE.ru * 1.2, X + GGP_LAKE.ru * 1.8, Z - 2, Z + 2) &&
      stowBasinOverlapsBox(X - 2, X + 2, Z - 2, Z + 2) &&
      !stowBasinOverlapsBox(X + GGP_LAKE.ru * 1.31, X + GGP_LAKE.ru * 1.8, Z - 2, Z + 2),
  );
  const surface = new DriveSurface(world.terrain, world.plan, () => world.network);
  const centerDepth = STOW_WATER_Y - surface.heightAt(X, Z);
  check(
    "Stow has a submerged bed deep enough to float",
    centerDepth > 1.5,
    `${centerDepth.toFixed(2)}u`,
  );
  let maxStep = 0;
  let previous = surface.heightAt(X - GGP_LAKE.ru - 12, Z);
  let agrees = true;
  for (let x = X - GGP_LAKE.ru - 12; x <= X - 6; x += 0.5) {
    const y = surface.heightAt(x, Z);
    maxStep = Math.max(maxStep, Math.abs(y - previous));
    agrees &&= Math.abs(y - world.standAt(x, Z)) < 0.01;
    previous = y;
  }
  check(
    "Stow launch follows the drawn bank without a terrace lip",
    agrees && maxStep < 0.25,
    `max half-unit rise ${maxStep.toFixed(3)}`,
  );
  let rimMin = Infinity;
  for (let i = 0; i < 96; i++) {
    const angle = (i / 96) * Math.PI * 2;
    rimMin = Math.min(
      rimMin,
      world.standAt(X + Math.cos(angle) * GGP_LAKE.ru, Z + Math.sin(angle) * GGP_LAKE.rv),
    );
  }
  check(
    "Stow water edge meets enclosing ground",
    rimMin >= STOW_WATER_Y - 0.08,
    `lowest bank ${rimMin.toFixed(2)}u`,
  );
  check(
    "Stow landform leaves terrain outside its local bank unchanged",
    [-7, 0, 26].every((height) => stowBasinHeight(X + GGP_LAKE.ru * 2, Z, height) === height),
  );
  check(
    "Stow water sampler has one level and ends at its footprint",
    stowWaterHeightAt(X, Z) === STOW_WATER_Y && stowWaterHeightAt(X + GGP_LAKE.ru + 1, Z) === null,
  );

  const vertex = new Vector3();
  let waterVertices = 0;
  let maxError = 0;
  for (const item of rest.batchItems) {
    if (item.raw === null) continue;
    const geometry = rest.rawGeos[item.raw];
    if (!geometry || geometry.mat.color !== 0x3f6f8f) continue;
    const transform = new Matrix4().fromArray(item.m);
    for (let i = 0; i < geometry.position.length; i += 3) {
      const x = geometry.position[i],
        y = geometry.position[i + 1],
        z = geometry.position[i + 2];
      if (x === undefined || y === undefined || z === undefined) continue;
      vertex.set(x, y, z).applyMatrix4(transform);
      if (Math.hypot(vertex.x - X, vertex.z - Z) > GGP_LAKE.ru + 1) continue;
      waterVertices++;
      maxError = Math.max(maxError, Math.abs(vertex.y - STOW_WATER_Y));
    }
  }
  check(
    "installed Stow water mesh matches the flotation level",
    waterVertices >= 49 && maxError < 0.001,
    `${waterVertices} vertices, error ${maxError.toFixed(5)}u`,
  );
}
