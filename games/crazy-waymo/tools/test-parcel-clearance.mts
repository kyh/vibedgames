import { buildParcelClearance } from "../src/world/parcel-clearance.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;

const clearFor = (coordinates: readonly number[]) => {
  const ring = Float32Array.from(coordinates);
  const xs = coordinates.filter((_, i) => i % 2 === 0);
  const zs = coordinates.filter((_, i) => i % 2 === 1);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return buildParcelClearance([
    {
      ring,
      n: ring.length / 2,
      obb: {
        cx: (minX + maxX) / 2,
        cz: (minZ + maxZ) / 2,
        halfA: (maxX - minX) / 2,
        halfB: (maxZ - minZ) / 2,
        ex: 1,
        ez: 0,
      },
    },
  ]);
};

export function checkParcelClearance(check: Check): void {
  const footprint = { x: 0, z: 0, halfWidth: 1, halfDepth: 1, yaw: 0 };

  check(
    "prop clearance rejects full containment in a building",
    !clearFor([-3, -3, 3, -3, 3, 3, -3, 3])(footprint, 0),
  );
  check(
    "prop clearance rejects narrow walls between nine-point probes",
    !clearFor([-3, 0.37, 3, 0.37, 3, 0.44, -3, 0.44])(footprint, 0),
  );
  check(
    "prop clearance rejects small parcels contained in the prop",
    !clearFor([0.3, 0.3, 0.4, 0.3, 0.4, 0.4, 0.3, 0.4])(footprint, 0),
  );
  check(
    "prop clearance handles a concave parcel finger",
    !clearFor([-3, -3, 3, -3, 3, -2, 0.4, -2, 0.4, 2, 0.3, 2, 0.3, -2, -3, -2])(footprint, 0),
  );
  const near = clearFor([-2, 1.2, 2, 1.2, 2, 3, -2, 3]);
  check(
    "prop clearance reserves the full facade margin",
    near(footprint, 0.1) && !near(footprint, 0.3),
  );
  const diagonal = clearFor([0.9, -1.1, 1.1, -1.1, 1.1, -0.9, 0.9, -0.9]);
  check(
    "prop clearance uses Three.js yaw orientation",
    !diagonal({ ...footprint, halfWidth: 2, halfDepth: 0.2, yaw: Math.PI / 4 }, 0) &&
      diagonal({ ...footprint, halfWidth: 2, halfDepth: 0.2, yaw: -Math.PI / 4 }, 0),
  );
  check(
    "prop clearance checks parcels across spatial-cell boundaries",
    !clearFor([31.9, -2, 32.1, -2, 32.1, 2, 31.9, 2])({ ...footprint, x: 30.5, halfWidth: 2 }, 0),
  );
  check(
    "prop clearance retains genuinely clear sites",
    clearFor([4, 4, 5, 4, 5, 5, 4, 5])(footprint, 0.6),
  );
}
