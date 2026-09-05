import * as THREE from "three";

import {
  bareSandWeight,
  createTerrainBlendTexture,
  TERRAIN_BLEND_BYTES,
  TERRAIN_BLEND_SIZE,
} from "../src/render/terrain-material.ts";
import { GRID_X, GRID_Z, ROAD_TILE, WORLD_HALF_X, WORLD_HALF_Z } from "../src/shared/constants.ts";
import { CUSTOM_MAP } from "../src/world/custom-map.ts";
import { groundBlendInto, makeGroundBlendAt, makeGroundColorAt } from "../src/world/ground.ts";
import type { CityPlan } from "../src/world/grid.ts";
import {
  type GroundCover,
  type LandClass,
  makeLandClassAt,
  wheelSurface,
} from "../src/world/land-class.ts";
import { makeTerrain } from "../src/world/sf-map.ts";

type Check = (name: string, condition: boolean, detail?: string) => void;
const blend = () => ({ turf: 0, sand: 0, stone: 0, loose: 0 });

function landFixture(cover: GroundCover, under = cover, strength = 1): LandClass {
  return {
    cover,
    under,
    strength,
    landuse: "unclassified",
    fabric: { kind: "interior" },
    parkland: { kind: "none" },
    flank: { kind: "lowland" },
    shore: { kind: "inland" },
    built: false,
  };
}

/** Material identity is tied to land semantics, never to the baked RGB palette. */
export function checkTerrainMaterials(check: Check, plan: CityPlan): void {
  const grass = blend();
  groundBlendInto(landFixture("grassland"), grass);
  const sand = blend();
  groundBlendInto(landFixture("sand"), sand);
  check(
    "golden grassland stays turf while equally warm beach ground gets sand ripples",
    grass.turf === 1 && grass.sand === 0 && sand.sand === 1 && sand.turf === 0,
  );
  const dune = blend();
  groundBlendInto(landFixture("dune"), dune);
  check(
    "dune scrub suppresses ripple relief while bare beach sand keeps it",
    bareSandWeight(dune) === 0 &&
      bareSandWeight(grass) === 0 &&
      bareSandWeight(sand) === 1 &&
      bareSandWeight({ turf: 0.07, sand: 0.85, stone: 0, loose: 0 }) > 0 &&
      bareSandWeight({ turf: 0.07, sand: 0.85, stone: 0, loose: 0 }) < 1,
  );
  const mixed = blend();
  groundBlendInto(landFixture("sand", "lawn", 0.25), mixed);
  check(
    "material cover transitions preserve the painter's underlay strength",
    mixed.turf === 0.75 && mixed.sand === 0.25 && mixed.stone === 0 && mixed.loose === 0,
  );
  const path = blend(),
    rock = blend(),
    dirt = blend(),
    paved = blend();
  groundBlendInto(landFixture("path"), path);
  groundBlendInto(landFixture("rock"), rock);
  groundBlendInto(landFixture("industrial"), dirt);
  groundBlendInto(landFixture("pavement"), paved);
  check(
    "gravel, bare rock, dirt and paved slabs retain separate material treatments",
    path.stone > 0 &&
      path.loose > 0 &&
      rock.stone === 1 &&
      rock.loose === 0 &&
      dirt.loose === 1 &&
      dirt.stone === 0 &&
      Object.values(paved).every((weight) => weight === 0),
  );

  const texture = createTerrainBlendTexture((x, z, into) => {
    into.turf = x < 0 ? 1 : 0;
    into.sand = x >= 0 && z < 0 ? 1 : 0;
    into.stone = x >= 0 && z >= 0 ? 1 : 0;
    into.loose = 0;
  });
  const data = texture.image.data;
  if (!(data instanceof Uint8Array)) throw new Error("Terrain classification stopped using RGBA8");
  const ne = (TERRAIN_BLEND_SIZE - 1) * 4;
  const sw = (TERRAIN_BLEND_SIZE - 1) * TERRAIN_BLEND_SIZE * 4;
  const se = TERRAIN_BLEND_BYTES - 4;
  check(
    "terrain texture orientation maps north to -Z and east to +X",
    data[0] === 255 &&
      data[ne + 1] === 255 &&
      data[sw] === 255 &&
      data[se + 2] === 255 &&
      data[ne] === 0 &&
      data[se + 1] === 0 &&
      !texture.flipY,
  );
  check(
    "terrain semantic map stays within 1MiB with linear non-color sampling",
    data.byteLength === 1024 * 1024 &&
      !texture.generateMipmaps &&
      texture.colorSpace === THREE.NoColorSpace &&
      texture.minFilter === THREE.LinearFilter &&
      texture.magFilter === THREE.LinearFilter,
  );
  texture.dispose();

  const terrain = makeTerrain();
  const landAt = makeLandClassAt(plan, terrain);
  const blendAt = makeGroundBlendAt(landAt);
  const value = blend();
  const sampled = new Set<string>();
  let mismatches = 0;
  let normalized = true;
  for (let gz = 0; gz < GRID_Z; gz += 2) {
    for (let gx = 0; gx < GRID_X; gx += 2) {
      const x = (gx + 0.5) * ROAD_TILE - WORLD_HALF_X;
      const z = (gz + 0.5) * ROAD_TILE - WORLD_HALF_Z;
      const land = landAt(x, z);
      blendAt(x, z, value);
      const weights = Object.values(value);
      normalized &&=
        weights.every((weight) => weight >= 0 && weight <= 1) &&
        weights.reduce((sum, weight) => sum + weight, 0) <= 1.000001;
      if (land.strength < 0.8 || land.fabric.kind === "street" || land.shore.kind !== "inland")
        continue;
      const surface = wheelSurface(land);
      sampled.add(surface);
      if (surface === "grass" && value.turf < 0.8) mismatches++;
      if (surface === "sand" && value.sand < 0.68) mismatches++;
      if (surface === "rock" && value.stone < 0.8) mismatches++;
      if (surface === "dirt" && value.loose < 0.8) mismatches++;
      if (surface === "gravel" && (value.stone < 0.56 || value.loose < 0.24)) mismatches++;
    }
  }
  check("world terrain material blends stay normalized", normalized);
  check(
    "world ground treatments agree with tire surfaces across actual SF land classes",
    mismatches === 0 &&
      sampled.has("grass") &&
      sampled.has("gravel") &&
      sampled.has("dirt") &&
      sampled.has("rock"),
    `${mismatches} mismatches; ${[...sampled].join(", ")}`,
  );

  const originalFloor = CUSTOM_MAP.floor;
  try {
    CUSTOM_MAP.floor = [
      [10, 10, "grass"],
      [10, 10, "sand"],
      [11, 10, "plaza"],
    ];
    const paintAt = makeGroundColorAt(plan, terrain, landAt);
    const paintedBlendAt = makeGroundBlendAt(landAt);
    const x = 10.5 * ROAD_TILE - WORLD_HALF_X;
    const z = 10.5 * ROAD_TILE - WORLD_HALF_Z;
    const color = new THREE.Color();
    paintAt(x, z, color);
    paintedBlendAt(x, z, value);
    const sandOverride = value.sand === 1 && value.turf === 0 && color.getHex() === 0xc7b78e;
    paintAt(x + ROAD_TILE, z, color);
    paintedBlendAt(x + ROAD_TILE, z, value);
    check(
      "painted floors override both color and texture semantics with identical precedence",
      sandOverride &&
        Object.values(value).every((weight) => weight === 0) &&
        color.getHex() === 0x9b968a,
    );
  } finally {
    CUSTOM_MAP.floor = originalFloor;
  }
}
