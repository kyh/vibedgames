import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

// Authored from art/muni-shelter/reference.png through the image-to-threejs
// component spec. Geometry is shared across every stop; six merged material
// buckets enter the existing city batcher. Origin is ground, +Z is roadway.
export type StreetKitPart = {
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.MeshStandardMaterial;
};
type MaterialKey = "red" | "steel" | "charcoal" | "glass" | "cream" | "letter";
type Vec3 = readonly [number, number, number];
type Piece = StreetKitPart & { readonly name: string; readonly key: MaterialKey };
type Shelter = { readonly pieces: readonly Piece[]; readonly kit: readonly StreetKitPart[] };

const materials = {
  red: new THREE.MeshStandardMaterial({ color: 0xbd2533, roughness: 0.3, metalness: 0.08 }),
  steel: new THREE.MeshStandardMaterial({ color: 0x9ca9ac, roughness: 0.4, metalness: 0.42 }),
  charcoal: new THREE.MeshStandardMaterial({ color: 0x30383d, roughness: 0.48, metalness: 0.15 }),
  glass: new THREE.MeshStandardMaterial({
    color: 0x91bcc1,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity: 0.3,
    depthWrite: false,
  }),
  cream: new THREE.MeshStandardMaterial({ color: 0xeee4d0, roughness: 0.72 }),
  letter: new THREE.MeshStandardMaterial({ color: 0xf5f3e7, roughness: 0.65 }),
} satisfies Record<MaterialKey, THREE.MeshStandardMaterial>;

const LETTERS = new Map<string, readonly string[]>(
  Object.entries({
    M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
    U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
    N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
    I: ["111", "010", "010", "010", "010", "010", "010", "111"],
    S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
    F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
    "7": ["11111", "00001", "00010", "00100", "00100", "00100", "00100"],
  }),
);

function canopyHeight(x: number): number {
  return 2.48 + 0.24 * Math.cos(((x + 1.12) * Math.PI) / 1.18);
}

function canopyGeometry(bottom: number, top: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const quad = (a: Vec3, b: Vec3, c: Vec3, d: Vec3): void => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
  };
  const slices = 56;
  for (let i = 0; i < slices; i++) {
    const x0 = -2.2 + (4.4 * i) / slices;
    const x1 = -2.2 + (4.4 * (i + 1)) / slices;
    const a = canopyHeight(x0);
    const b = canopyHeight(x1);
    quad([x0, a + top, -0.95], [x0, a + top, 0.95], [x1, b + top, 0.95], [x1, b + top, -0.95]);
    quad(
      [x0, a + bottom, 0.95],
      [x0, a + bottom, -0.95],
      [x1, b + bottom, -0.95],
      [x1, b + bottom, 0.95],
    );
    quad([x0, a + bottom, 0.95], [x1, b + bottom, 0.95], [x1, b + top, 0.95], [x0, a + top, 0.95]);
    quad(
      [x1, b + bottom, -0.95],
      [x0, a + bottom, -0.95],
      [x0, a + top, -0.95],
      [x1, b + top, -0.95],
    );
  }
  for (const x of [-2.2, 2.2]) {
    const y = canopyHeight(x);
    const z0 = x < 0 ? -0.95 : 0.95;
    const z1 = -z0;
    quad([x, y + bottom, z0], [x, y + bottom, z1], [x, y + top, z1], [x, y + top, z0]);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(new Float32Array((positions.length / 3) * 2), 2),
  );
  geo.computeVertexNormals();
  return geo;
}

function buildShelter(): Shelter {
  const pieces: Piece[] = [];
  const add = (name: string, key: MaterialKey, geo: THREE.BufferGeometry): void => {
    pieces.push({ name, key, geo: geo.index ? geo.toNonIndexed() : geo, mat: materials[key] });
  };
  const box = (name: string, key: MaterialKey, at: Vec3, size: Vec3, radius = 0, yaw = 0): void => {
    const geo =
      radius > 0
        ? new RoundedBoxGeometry(size[0], size[1], size[2], 1, radius)
        : new THREE.BoxGeometry(size[0], size[1], size[2]);
    add(name, key, geo.rotateY(yaw).translate(...at));
  };
  const rod = (
    name: string,
    key: MaterialKey,
    points: readonly Vec3[],
    radius: number,
    segments = 12,
  ): void => {
    const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
    add(name, key, new THREE.TubeGeometry(curve, segments, radius, 5, false));
  };
  const text = (value: string, at: Vec3, pixel: number, yaw = 0): void => {
    let cursor = 0;
    for (const char of value) {
      const rows = LETTERS.get(char);
      if (!rows) continue;
      const width = rows[0]?.length ?? 0;
      for (let row = 0; row < rows.length; row++) {
        const cells = rows[row];
        if (!cells) continue;
        for (let column = 0; column < cells.length; column++) {
          if (cells[column] !== "1") continue;
          // Merge horizontal strokes so small lettering stays inexpensive.
          let end = column + 1;
          while (cells[end] === "1") end++;
          const px = cursor + (column + (end - column) / 2) * pixel;
          box(
            "letter-" + char,
            "letter",
            [at[0] + px * Math.cos(yaw), at[1] - row * pixel, at[2] - px * Math.sin(yaw)],
            [(end - column) * pixel, pixel * 0.91, 0.012],
            0,
            yaw,
          );
          column = end - 1;
        }
      }
      cursor += (width + 1) * pixel;
    }
  };

  add("canopy", "red", canopyGeometry(-0.065, 0.075));
  // A separate dark soffit gives the curled enamel fascia a readable lip.
  add("soffit", "charcoal", canopyGeometry(-0.087, -0.067));
  for (let i = 0; i < 15; i++) {
    const x = -1.99 + (3.98 * i) / 14;
    box("soffit-rib", "steel", [x, canopyHeight(x) - 0.115, 0], [0.035, 0.045, 1.76]);
  }
  for (const z of [-0.34, 0.34]) {
    const points: Vec3[] = [];
    for (let i = 0; i <= 28; i++) {
      const x = -2.16 + (4.32 * i) / 28;
      points.push([x, canopyHeight(x) + 0.07, z]);
    }
    rod("canopy-seam", "red", points, 0.008, 48);
  }

  for (const x of [-1.91, 1.91]) {
    const height = canopyHeight(x) - 0.09;
    for (const z of [-0.7, 0.69]) {
      box("post", "steel", [x, height / 2, z], [0.1, height, 0.1], 0.012);
      box("foot-plates", "steel", [x, 0.035, z], [0.24, 0.07, 0.23], 0.012);
      box("foot-collar", "steel", [x, 0.11, z], [0.15, 0.17, 0.15], 0.012);
      for (const dx of [-0.072, 0.072]) {
        for (const dz of [-0.066, 0.066]) {
          add(
            "foot-fastener",
            "charcoal",
            new THREE.CylinderGeometry(0.018, 0.018, 0.018, 6).translate(x + dx, 0.079, z + dz),
          );
        }
      }
    }
    box("side-rail", "steel", [x, 2.21, -0.01], [0.1, 0.085, 1.46], 0.01);
  }
  box("rear-top-rail", "steel", [0, 2.21, -0.72], [3.86, 0.09, 0.1], 0.012);
  box("rear-bottom-rail", "steel", [0, 0.25, -0.72], [3.86, 0.065, 0.09], 0.01);
  for (const x of [-0.645, 0.645]) {
    box("rear-mullion", "steel", [x, 1.24, -0.72], [0.055, 2.02, 0.055], 0.008);
  }
  for (let i = 0; i < 3; i++) {
    box("glass", "glass", [-1.28 + i * 1.28, 1.245, -0.725], [1.2, 1.84, 0.028]);
  }
  for (const x of [-1.91, 1.91]) {
    box("glass-return", "glass", [x, 1.245, -0.025], [0.028, 1.84, 1.3]);
  }
  for (const x of [-1.86, -0.68, -0.61, 0.61, 0.68, 1.86]) {
    for (const y of [0.43, 2.04]) {
      box("glass-clamp", "steel", [x, y, -0.695], [0.085, 0.035, 0.045], 0.006);
    }
  }

  // The bench has visible air between each slat, a curved seat/back junction,
  // rolled cheeks and three dividers. It is not a blue wall with a brown bar.
  const benchX = -0.1;
  for (let i = 0; i < 7; i++) {
    const z = 0.14 - i * 0.072;
    box("bench-seat-slat", "charcoal", [benchX, 0.63 + i * 0.004, z], [3.42, 0.045, 0.057]);
  }
  for (let i = 0; i < 7; i++) {
    const y = 0.735 + i * 0.075;
    const z = -0.39 - (y - 0.735) * 0.18;
    box("bench-back-slat", "charcoal", [benchX, y, z], [3.42, 0.059, 0.048]);
  }
  for (const x of [-1.85, 1.65]) {
    rod(
      "bench-cheek",
      "steel",
      [
        [x, 1.23, -0.48],
        [x, 0.99, -0.46],
        [x, 0.76, -0.36],
        [x, 0.66, -0.1],
        [x, 0.63, 0.18],
      ],
      0.039,
      18,
    );
  }
  for (const x of [-1.33, 1.14]) {
    box("bench-leg", "steel", [x, 0.33, -0.23], [0.08, 0.56, 0.1], 0.01);
    box("bench-foot", "steel", [x, 0.055, -0.23], [0.19, 0.045, 0.34], 0.01);
  }
  for (const x of [-0.96, -0.06, 0.84]) {
    rod(
      "bench-divider",
      "steel",
      [
        [x, 0.66, 0.14],
        [x, 0.85, 0.11],
        [x, 0.88, -0.22],
        [x, 0.85, -0.36],
        [x, 0.71, -0.38],
      ],
      0.021,
      16,
    );
  }

  box("front-sign", "steel", [1.1, 2.465, 0.883], [0.88, 0.28, 0.045], 0.026);
  box("front-sign-enamel", "red", [1.1, 2.465, 0.91], [0.82, 0.235, 0.026], 0.021);
  text("MUNI", [0.839, 2.527, 0.933], 0.022);
  for (const x of [0.74, 1.46]) {
    for (const y of [2.39, 2.54]) {
      add(
        "sign-fastener",
        "steel",
        new THREE.CylinderGeometry(0.015, 0.015, 0.012, 6)
          .rotateX(Math.PI / 2)
          .translate(x, y, 0.933),
      );
    }
  }

  // Route graphics are raised vector pieces, so the bake cannot lose a canvas
  // texture. They are municipal wayfinding, not a claim of live route data.
  const panelX = 1.976;
  const yaw = Math.PI / 2;
  box("route-panel-frame", "steel", [panelX, 1.25, 0.14], [0.79, 1.92, 0.1], 0.035, yaw);
  box("route-panel", "cream", [panelX + 0.056, 1.25, 0.14], [0.69, 1.79, 0.02], 0.022, yaw);
  box("route-header", "red", [panelX + 0.071, 1.94, 0.14], [0.675, 0.36, 0.017], 0.015, yaw);
  text("MUNI", [panelX + 0.086, 2.008, 0.389], 0.021, yaw);
  box("route-footer", "red", [panelX + 0.072, 0.5, 0.14], [0.675, 0.28, 0.017], 0.012, yaw);
  text("SF", [panelX + 0.088, 0.558, 0.363], 0.023, yaw);
  add(
    "route-badge",
    "red",
    new THREE.CylinderGeometry(0.078, 0.078, 0.017, 12)
      .rotateZ(Math.PI / 2)
      .translate(panelX + 0.076, 1.62, 0.35),
  );
  text("7", [panelX + 0.09, 1.653, 0.381], 0.012, yaw);
  box("route-line", "red", [panelX + 0.075, 1.12, 0.352], [0.017, 0.76, 0.018]);
  for (let i = 0; i < 6; i++) {
    const y = 1.46 - i * 0.133;
    add(
      "route-stop",
      "red",
      new THREE.CylinderGeometry(0.022, 0.022, 0.018, 8)
        .rotateZ(Math.PI / 2)
        .translate(panelX + 0.078, y, 0.352),
    );
    box(
      "route-caption",
      "charcoal",
      [panelX + 0.074, y, 0.115],
      [0.017, 0.017, i % 2 === 0 ? 0.29 : 0.22],
    );
  }

  const grouped = new Map<MaterialKey, THREE.BufferGeometry[]>();
  for (const p of pieces) {
    const bucket = grouped.get(p.key);
    if (bucket) bucket.push(p.geo);
    else grouped.set(p.key, [p.geo]);
  }
  const kit: StreetKitPart[] = [];
  for (const [key, geos] of grouped) {
    const geo = mergeGeometries(geos, false);
    if (!geo) throw new Error("Muni shelter material geometry is incompatible");
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    kit.push({ geo, mat: materials[key] });
  }
  return { pieces, kit };
}

let shelter: Shelter | undefined;
function getShelter(): Shelter {
  shelter ??= buildShelter();
  return shelter;
}

export function getMuniShelterKit(): readonly StreetKitPart[] {
  return getShelter().kit;
}

/** Named, shared geometry for image-to-threejs review; placements use the kit. */
export function createMuniShelterModel(
  options: { readonly castShadow?: boolean; readonly receiveShadow?: boolean } = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = "Muni Shelter";
  for (const p of getShelter().pieces) {
    const mesh = new THREE.Mesh(p.geo, p.mat);
    mesh.name = p.name;
    mesh.castShadow = !p.mat.transparent && (options.castShadow ?? true);
    mesh.receiveShadow = options.receiveShadow ?? true;
    group.add(mesh);
  }
  return group;
}
