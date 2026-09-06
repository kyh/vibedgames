import * as THREE from "three";

// Reference/spec: art/salesforce. A static, shared landmark kit; fresh scene
// nodes borrow these six immutable buffers. The old local radius4.2 and
// y0..49.5 remain the placement/collision contract (landmarks applies13/8).
export const SALESFORCE_RADIUS = 4.2;
export const SALESFORCE_HEIGHT = 49.5;
const COLUMNS = 32;
const FLOORS = 40;
const LOBBY_TOP = 3.2;
const OFFICE_TOP = 43.4;
const CROWN_TOP = 49.4;
const TAU = Math.PI * 2;
type Vec3 = readonly [number, number, number];
type MaterialKey = "glass" | "lit" | "metal" | "crown" | "stone" | "dark";
export type SalesforcePart = {
  readonly name: string;
  readonly geo: THREE.BufferGeometry;
  readonly mat: THREE.MeshStandardMaterial;
};

const materials = {
  glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.18 }),
  lit: new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.32,
    metalness: 0.16,
    emissive: 0xffd49d,
    emissiveIntensity: 0,
  }),
  metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.35 }),
  crown: new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.24,
    metalness: 0.12,
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    emissive: 0x72d3f5,
    emissiveIntensity: 0,
  }),
  stone: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72 }),
  dark: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.36, metalness: 0.08 }),
} satisfies Record<MaterialKey, THREE.MeshStandardMaterial>;

/** Lamp factor from the game clock. No timers or material callbacks. */
export function setSalesforceNight(night: number): void {
  const amount = Number.isFinite(night) ? THREE.MathUtils.clamp(night, 0, 1) : 0;
  materials.lit.emissiveIntensity = amount * 0.24;
  materials.crown.emissiveIntensity = amount * 0.75;
}

/** A bounded rounded-square section, with a steeper gentle curve at the crown. */
function profile(angle: number, y: number, offset = 0): Vec3 {
  const t = y / CROWN_TOP;
  const radius = 4.03 - 0.1 * t - 1.1 * t ** 4 + offset;
  const power = 2 / 3;
  const normalize = 2 ** (0.5 - 1 / 3);
  const sx = Math.sin(angle);
  const sz = Math.cos(angle);
  return [
    (Math.sign(sx) * Math.abs(sx) ** power * radius) / normalize,
    y,
    (Math.sign(sz) * Math.abs(sz) ** power * radius) / normalize,
  ];
}

class Surface {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];
  private readonly color = new THREE.Color();

  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, color: number): void {
    const start = this.positions.length / 3;
    this.positions.push(...a, ...b, ...c, ...d);
    this.color.setHex(color);
    for (let i = 0; i < 4; i++) this.colors.push(this.color.r, this.color.g, this.color.b);
    this.indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
  }

  cap(y: number, offset: number, color: number): void {
    for (let i = 0; i < COLUMNS; i++) {
      const a = profile((i * TAU) / COLUMNS, y, offset);
      const b = profile(((i + 1) * TAU) / COLUMNS, y, offset);
      const start = this.positions.length / 3;
      this.positions.push(0, y, 0, ...a, ...b);
      this.color.setHex(color);
      for (let j = 0; j < 3; j++) this.colors.push(this.color.r, this.color.g, this.color.b);
      this.indices.push(start, start + 1, start + 2);
    }
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, color: number): void {
    const x0 = x - w / 2,
      x1 = x + w / 2;
    const y0 = y - h / 2,
      y1 = y + h / 2;
    const z0 = z - d / 2,
      z1 = z + d / 2;
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], color);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], color);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], color);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], color);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], color);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], color);
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute(
      "color",
      new THREE.BufferAttribute(
        Uint8Array.from(this.colors, (v) => Math.round(v * 255)),
        3,
        true,
      ),
    );
    geo.setIndex(this.indices);
    geo.computeVertexNormals();
    // Same compact GPU attribute contract as the parcel fabric. Manufactured
    // planar faces need no float precision for unit normals or linear colors.
    const normals = geo.getAttribute("normal");
    const packed = new Int8Array(normals.count * 3);
    for (let i = 0; i < normals.count; i++) {
      packed[i * 3] = Math.round(normals.getX(i) * 127);
      packed[i * 3 + 1] = Math.round(normals.getY(i) * 127);
      packed[i * 3 + 2] = Math.round(normals.getZ(i) * 127);
    }
    geo.setAttribute("normal", new THREE.BufferAttribute(packed, 3, true));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

/** Closed projecting ledge: upper, lower and outward faces cast real shade. */
function ledge(surface: Surface, y: number, color: number, depth = 0.135, h = 0.075): void {
  const lo = y - h / 2,
    hi = y + h / 2;
  for (let i = 0; i < COLUMNS; i++) {
    const a = (i * TAU) / COLUMNS,
      b = ((i + 1) * TAU) / COLUMNS;
    surface.quad(
      profile(a, hi, depth),
      profile(b, hi, depth),
      profile(b, hi, -0.04),
      profile(a, hi, -0.04),
      color,
    );
    surface.quad(
      profile(a, lo, -0.04),
      profile(b, lo, -0.04),
      profile(b, lo, depth),
      profile(a, lo, depth),
      color,
    );
    surface.quad(
      profile(a, lo, depth),
      profile(b, lo, depth),
      profile(b, hi, depth),
      profile(a, hi, depth),
      color,
    );
  }
}

/** Three exposed fin faces; its hidden fourth face meets the curtain wall. */
function fin(surface: Surface, angle: number, stations: readonly number[], offset = 0): void {
  const a = angle - 0.007,
    b = angle + 0.007;
  const front = 0.15 + offset,
    back = -0.025 + offset;
  for (let i = 1; i < stations.length; i++) {
    const lo = stations[i - 1],
      hi = stations[i];
    if (lo === undefined || hi === undefined) continue;
    surface.quad(
      profile(a, lo, front),
      profile(b, lo, front),
      profile(b, hi, front),
      profile(a, hi, front),
      0xcbd5d8,
    );
    surface.quad(
      profile(a, lo, back),
      profile(a, lo, front),
      profile(a, hi, front),
      profile(a, hi, back),
      0xb6c4ca,
    );
    surface.quad(
      profile(b, lo, front),
      profile(b, lo, back),
      profile(b, hi, back),
      profile(b, hi, front),
      0xb6c4ca,
    );
  }
  const top = stations.at(-1);
  if (top !== undefined) {
    surface.quad(
      profile(a, top, back),
      profile(a, top, front),
      profile(b, top, front),
      profile(b, top, back),
      0xd7dfe0,
    );
  }
}

const PANE_COLORS = [0x397088, 0x467f96, 0x548ba0, 0x2e617a];
function paneHash(row: number, column: number): number {
  return (Math.imul(row + 1, 73856093) ^ Math.imul(column + 1, 19349663)) >>> 0;
}

function buildKit(): readonly SalesforcePart[] {
  const surfaces = {
    glass: new Surface(),
    lit: new Surface(),
    metal: new Surface(),
    crown: new Surface(),
    stone: new Surface(),
    dark: new Surface(),
  } satisfies Record<MaterialKey, Surface>;
  const pitch = (OFFICE_TOP - LOBBY_TOP) / FLOORS;
  for (let row = 0; row < FLOORS; row++) {
    const lo = LOBBY_TOP + row * pitch + 0.055;
    const hi = LOBBY_TOP + (row + 1) * pitch - 0.055;
    for (let column = 0; column < COLUMNS; column++) {
      const a = (column * TAU) / COLUMNS + 0.009;
      const b = ((column + 1) * TAU) / COLUMNS - 0.009;
      const hash = paneHash(row, column);
      const surface = hash % 11 < 2 ? surfaces.lit : surfaces.glass;
      const color = PANE_COLORS[hash % PANE_COLORS.length] ?? 0x407d98;
      surface.quad(
        profile(a, lo, -0.025),
        profile(b, lo, -0.025),
        profile(b, hi, -0.025),
        profile(a, hi, -0.025),
        color,
      );
    }
  }
  for (let row = 0; row <= FLOORS; row++) {
    ledge(surfaces.metal, LOBBY_TOP + row * pitch, 0xc6d2d5);
  }
  const stations = [LOBBY_TOP, 13, 25, 33, 38, OFFICE_TOP, 46, 48, CROWN_TOP];
  for (let i = 0; i < COLUMNS; i++) fin(surfaces.metal, (i * TAU) / COLUMNS, stations);

  // The crown's veil has actual gaps. It continues the structural grid above
  // a recessed mechanical core, so it reads as a light lattice in silhouette.
  const crownBands = 6;
  for (let row = 0; row < crownBands; row++) {
    const lo = OFFICE_TOP + ((CROWN_TOP - OFFICE_TOP) * row) / crownBands;
    const hi = OFFICE_TOP + ((CROWN_TOP - OFFICE_TOP) * (row + 1)) / crownBands;
    for (let i = 0; i < COLUMNS; i++) {
      if ((i + row) % 4 === 0) continue;
      const a = (i * TAU) / COLUMNS + 0.011,
        b = ((i + 1) * TAU) / COLUMNS - 0.011;
      surfaces.crown.quad(
        profile(a, lo + 0.08, -0.06),
        profile(b, lo + 0.08, -0.06),
        profile(b, hi - 0.08, -0.06),
        profile(a, hi - 0.08, -0.06),
        row % 2 === 0 ? 0x80b7ce : 0x9acbda,
      );
    }
    ledge(surfaces.metal, hi, 0xd6dfe1, 0.1, 0.07);
  }
  surfaces.dark.cap(OFFICE_TOP - 0.07, -0.04, 0x334c59);
  for (let i = 0; i < COLUMNS; i++) {
    const a = (i * TAU) / COLUMNS,
      b = ((i + 1) * TAU) / COLUMNS;
    surfaces.dark.quad(
      profile(a, OFFICE_TOP, -1.15),
      profile(b, OFFICE_TOP, -1.15),
      profile(b, 45.0, -1.15),
      profile(a, 45.0, -1.15),
      0x425966,
    );
  }
  surfaces.dark.cap(45.0, -1.15, 0x344852);

  // A tall, inset lobby grounds the tower. Its pale entrance frame and canopy
  // remain behind the old circular perimeter, including the canopy corners.
  for (let i = 0; i < COLUMNS; i++) {
    const a = (i * TAU) / COLUMNS,
      b = ((i + 1) * TAU) / COLUMNS;
    surfaces.dark.quad(
      profile(a, 0.16, -0.45),
      profile(b, 0.16, -0.45),
      profile(b, LOBBY_TOP, -0.45),
      profile(a, LOBBY_TOP, -0.45),
      i % 3 === 0 ? 0x335769 : 0x254653,
    );
    fin(surfaces.metal, a, [0.16, LOBBY_TOP], -0.46);
  }
  ledge(surfaces.stone, 0.1, 0xc8cbc7, 0.08, 0.2);
  surfaces.stone.cap(0.2, 0.03, 0xc8cbc7);
  surfaces.stone.box(0, 2.52, 3.32, 2.7, 0.2, 1.0, 0xd7d8d2);
  for (const x of [-1.2, 1.2]) surfaces.stone.box(x, 1.24, 3.27, 0.2, 2.48, 0.27, 0xc6caca);
  surfaces.dark.box(0, 1.2, 3.12, 2.12, 2.25, 0.08, 0x233e4c);
  for (const x of [-0.9, 0, 0.9]) surfaces.metal.box(x, 1.15, 3.18, 0.045, 2.14, 0.045, 0xafc2c9);
  surfaces.metal.box(0, 2.18, 3.18, 1.85, 0.055, 0.05, 0xb7c9ce);
  surfaces.lit.box(0, 2.29, 3.2, 1.95, 0.09, 0.04, 0xd4c4a4);
  for (const x of [-0.08, 0.08]) surfaces.metal.box(x, 1.1, 3.22, 0.028, 0.36, 0.035, 0xd0dadd);

  const keys: readonly MaterialKey[] = ["glass", "lit", "metal", "crown", "stone", "dark"];
  return keys.map((key) => ({
    name: `salesforce-${key}`,
    geo: surfaces[key].geometry(),
    mat: materials[key],
  }));
}

let kit: readonly SalesforcePart[] | null = null;
/** Shared geometry/material ownership stays here; placement code must not dispose it. */
export function getSalesforceKit(): readonly SalesforcePart[] {
  if (kit === null) kit = buildKit();
  return kit;
}

export function createSalesforceModel(
  options: { readonly castShadow?: boolean; readonly receiveShadow?: boolean } = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = "salesforce-tower";
  for (const part of getSalesforceKit()) {
    const mesh = new THREE.Mesh(part.geo, part.mat);
    mesh.name = part.name;
    mesh.castShadow = (options.castShadow ?? true) && !part.mat.transparent;
    mesh.receiveShadow = options.receiveShadow ?? true;
    group.add(mesh);
  }
  return group;
}
