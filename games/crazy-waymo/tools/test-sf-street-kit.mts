import * as THREE from "three";

import { createMuniShelterModel, getMuniShelterKit } from "../src/world/sf-street-kit.ts";
import type { CityRestPayload } from "../src/world/city.ts";
import { buildParcelClearance } from "../src/world/parcel-clearance.ts";
import type { ParcelPlan } from "../src/world/parcel-plan.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

export function checkSfStreetKit(check: Check): void {
  const kit = getMuniShelterKit();
  const repeated = getMuniShelterKit();
  const bounds = new THREE.Box3();
  let triangles = 0;
  let finite = true;
  for (const part of kit) {
    const positions = part.geo.getAttribute("position");
    const normals = part.geo.getAttribute("normal");
    triangles += (part.geo.getIndex()?.count ?? positions.count) / 3;
    part.geo.computeBoundingBox();
    if (part.geo.boundingBox) bounds.union(part.geo.boundingBox);
    for (const attribute of [positions, normals]) {
      for (let i = 0; i < attribute.count; i++) {
        finite &&=
          Number.isFinite(attribute.getX(i)) &&
          Number.isFinite(attribute.getY(i)) &&
          Number.isFinite(attribute.getZ(i));
      }
    }
  }
  const size = bounds.getSize(new THREE.Vector3());
  check(
    "shelters share six material batches",
    kit.length === 6 &&
      new Set(kit.map((part) => part.mat)).size === 6 &&
      kit.every(
        (part, index) => part.geo === repeated[index]?.geo && part.mat === repeated[index]?.mat,
      ),
  );
  check(
    "shelter geometry stays below 10,000 triangles",
    triangles > 0 && triangles < 10_000,
    `${triangles} triangles`,
  );
  check(
    "shelter fits its placement envelope with finite geometry",
    finite &&
      Math.abs(bounds.min.y) < 1e-6 &&
      Math.abs(size.x - 4.4) < 0.001 &&
      size.y <= 2.8 &&
      Math.abs(size.z - 1.9) < 0.001,
  );
  const preview = createMuniShelterModel();
  let glass = 0;
  let frameShadows = 0;
  let validGlass = true;
  preview.traverse((node) => {
    if (!(node instanceof THREE.Mesh) || !(node.material instanceof THREE.MeshStandardMaterial)) {
      return;
    }
    if (node.material.transparent) {
      glass++;
      validGlass &&= !node.castShadow && !node.material.depthWrite;
    } else if (node.castShadow) {
      frameShadows++;
    }
  });
  check(
    "shelter preview glass preserves transparent depth and shadows",
    glass > 0 && frameShadows > 0 && validGlass,
  );
}

/** The installed artifact must preserve the same whole-footprint clearance. */
export function checkBakedShelterClearance(
  check: Check,
  rest: CityRestPayload,
  plans: readonly ParcelPlan[],
): void {
  const glazing = getMuniShelterKit().find((part) => part.mat.transparent);
  if (!glazing) throw new Error("Shelter kit must retain its identifiable glass batch");
  const glassGeometries = new Set<number>();
  rest.rawGeos.forEach((geo, index) => {
    if (geo.mat.transparent && geo.mat.color === glazing.mat.color.getHex()) {
      glassGeometries.add(index);
    }
  });
  const clear = buildParcelClearance(plans);
  let count = 0;
  const blocked: string[] = [];
  for (const item of rest.batchItems) {
    if (item.raw === null || !glassGeometries.has(item.raw)) continue;
    count++;
    const m = item.m;
    const x = m[12] ?? 0;
    const z = m[14] ?? 0;
    const widthScale = Math.hypot(m[0] ?? 0, m[1] ?? 0, m[2] ?? 0);
    const depthScale = Math.hypot(m[8] ?? 0, m[9] ?? 0, m[10] ?? 0);
    if (
      !clear(
        {
          x,
          z,
          halfWidth: 2.2 * widthScale,
          halfDepth: 0.95 * depthScale,
          yaw: Math.atan2(m[8] ?? 0, m[10] ?? 0),
        },
        0.6,
      )
    ) {
      blocked.push(`${x.toFixed(2)},${z.toFixed(2)}`);
    }
  }
  check("installed world retains Muni shelters", count > 0, `${count} shelters`);
  check(
    "baked shelter envelopes clear parcel walls and projecting facades",
    blocked.length === 0,
    `${blocked.length}/${count} blocked${blocked.length ? `: ${blocked.join("; ")}` : ""}`,
  );
}
