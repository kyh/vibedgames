import * as THREE from "three";

import { type Beacon, registerBeacons } from "../fx/beacon-lights";
import { Rng } from "../shared/rng";
import { prismGeometry, prismSpec, type PrismSpec } from "./sf-prisms";
import { SF_DOCKS, SF_PIERS } from "./sf-piers";
import type { Terrain } from "./terrain";
import { addMoorings, planMoorings, PORT_MATERIAL, PortBuilder, WATER_Y } from "./watercraft";

// The waterfront: real Embarcadero/wharf pier decks with their bulkhead sheds,
// cargo gear and crab shacks, the marina floats and the fleet moored to them,
// and the riprap along the seawall. Visual only (no solids — the water already
// ends the drivable world), built main-side like the landmarks and freeways and
// rebuilt live on every load, so nothing here needs a world rebake.
//
// Everything goes through ONE vertex-coloured material (watercraft.ts
// PORT_MATERIAL) bucketed into ~360u chunks, so the renderer frustum-culls the
// half of the waterfront behind you. That is what pays for the detail: the old
// pass drew ~85 unculled meshes to put one identical beige box on 14 of the 55
// piers and nothing at all on the other 41.

const CHUNK = 360;

/** The port's geometry, split into frustum-cullable buckets. */
class ChunkedPort {
  private readonly buckets = new Map<string, PortBuilder>();

  /** The builder for whatever bucket (x, z) falls in. */
  at(x: number, z: number): PortBuilder {
    const key = `${Math.round(x / CHUNK)},${Math.round(z / CHUNK)}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = new PortBuilder();
      this.buckets.set(key, b);
    }
    return b;
  }

  get triCount(): number {
    let n = 0;
    for (const b of this.buckets.values()) n += b.triCount;
    return n;
  }

  get meshCount(): number {
    return this.buckets.size;
  }

  addTo(group: THREE.Group): void {
    for (const b of this.buckets.values()) {
      const geo = b.geometry();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, PORT_MATERIAL);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
    }
  }
}

// --- Palette --------------------------------------------------------------
// The point of the vertex-coloured merge: the waterfront stops being one beige.
// Decks weather, sheds were painted in different decades, roofs rust unevenly.

const DECKS = [0xb9ac96, 0xc4b8a2, 0xaa9e8b, 0xcabfab, 0xb3a894] as const;
const SHED_WALLS = [0xe3dac8, 0xd8ccb6, 0xcdbfa6, 0xe8e2d4, 0xc6b8a0, 0xdcc9a8] as const;
const SHED_TRIM = 0x8d7c66;
const ROOFS = [0x9a6a52, 0x7f6c5d, 0x8a7263, 0x6d6862, 0x94705a] as const;
const SHACK_WALLS = [0xf0efe6, 0xd94f3a, 0x3f7fa8, 0xf2c341, 0xe8e0cc] as const;
const AWNINGS = [0xd94f3a, 0xe8e6e0, 0x2f7f5a, 0xf2b03a] as const;
const PILE = 0x6f6152;
const PILE_WET = 0x4e453b; // the band standing in the water
const STEEL = 0x99a1a6;
const CRANE_ORANGE = 0xd4732b;
const TIMBER = 0xc2a578;
const ROCKS = [0x8b877f, 0x776f66, 0x9a938a, 0x6d6a66] as const;
const GLASS = 0x2f4d5e;

// --- Pier numbering -------------------------------------------------------
// Real Embarcadero numbering: ODD northward from the Ferry Building out to the
// wharf, EVEN southward. The board on the bulkhead is the single detail that
// makes a row of sheds read as SF's waterfront and not as a generic dock.

const NORTH_NUMBERS = [45, 43, 41, 39, 35, 33, 31, 29, 27, 23, 19, 17, 15, 9, 7, 5, 3] as const;
const SOUTH_NUMBERS = [14, 22, 24, 26, 28, 30, 32, 36, 38, 40, 48] as const;
/** The Ferry Building's own pier: the numbering hinges here. */
const FERRY_Z = -905;
const NUMBERED_MIN_AREA = 220;

// --- Sign boards ----------------------------------------------------------

const SIGN_COLS = 4;
const SIGN_ROWS = 8;
const SIGN_CELL = 128;

/**
 * One 512×512 atlas holding every pier number, so all the boards are a single
 * textured draw. Returns null where there is no DOM (the headless world tools),
 * and the boards are simply skipped.
 */
function signAtlas(numbers: readonly number[]): THREE.Texture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = SIGN_COLS * SIGN_CELL;
  canvas.height = SIGN_ROWS * (SIGN_CELL / 2);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#1d2b36";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  numbers.forEach((n, i) => {
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    const x = col * SIGN_CELL;
    const y = row * (SIGN_CELL / 2);
    ctx.fillStyle = "#f4f1e8";
    ctx.fillRect(x + 3, y + 3, SIGN_CELL - 6, SIGN_CELL / 2 - 6);
    ctx.fillStyle = "#1d2b36";
    ctx.font = `600 ${SIGN_CELL * 0.19}px system-ui, sans-serif`;
    ctx.fillText("PIER", x + SIGN_CELL / 2, y + SIGN_CELL * 0.16);
    ctx.font = `700 ${SIGN_CELL * 0.3}px system-ui, sans-serif`;
    ctx.fillText(String(n), x + SIGN_CELL / 2, y + SIGN_CELL * 0.34);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Accumulates the numbered boards into one textured mesh. */
class SignBoards {
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly uv: number[] = [];

  /** A board `w`×`h`, centred at (x, y, z), facing (nx, nz) in the XZ plane. */
  push(
    cell: number,
    x: number,
    y: number,
    z: number,
    nx: number,
    nz: number,
    w: number,
    h: number,
  ): void {
    // Board-right, for a reader standing in front of it: cross(-n, up). Get
    // this backwards and the board is either back-facing or mirror-written.
    const ax = nz * (w / 2);
    const az = -nx * (w / 2);
    const u0 = (cell % SIGN_COLS) / SIGN_COLS;
    const v1 = 1 - Math.floor(cell / SIGN_COLS) / SIGN_ROWS;
    const u1 = u0 + 1 / SIGN_COLS;
    const v0 = v1 - 1 / SIGN_ROWS;
    const corners: readonly (readonly [number, number, number, number, number])[] = [
      [x - ax, y - h / 2, z - az, u0, v0],
      [x + ax, y - h / 2, z + az, u1, v0],
      [x + ax, y + h / 2, z + az, u1, v1],
      [x - ax, y + h / 2, z - az, u0, v1],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const c = corners[i];
      if (!c) continue;
      this.pos.push(c[0], c[1], c[2]);
      this.nor.push(nx, 0, nz);
      this.uv.push(c[3], c[4]);
    }
  }

  mesh(tex: THREE.Texture): THREE.Mesh | null {
    if (this.pos.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }));
  }
}

// --- Pier analysis --------------------------------------------------------

/** A pier reduced to the frame everything else is placed in. */
type PierInfo = {
  readonly spec: PrismSpec;
  readonly area: number;
  readonly deckY: number;
  /** OBB centre (NOT the ring centroid — L-shaped piers differ a lot). */
  readonly ox: number;
  readonly oz: number;
  /** Unit vector down the pier's long axis, and the yaw that matches it. */
  readonly ex: number;
  readonly ez: number;
  readonly yaw: number;
  readonly lenA: number;
  readonly lenB: number;
  /** +1 if the shore lies toward +A, -1 if toward -A. */
  readonly shoreSign: number;
  /** Chainage along the waterfront, for numbering (see FERRY_Z). */
  readonly key: number;
  number: number | null;
};

function analyse(flat: readonly number[], area: number, terrain: Terrain): PierInfo | null {
  const spec = prismSpec([0.85, ...flat]);
  if (!spec) return null;
  const { cx, cz, rel } = spec;
  const n = rel.length / 2;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    hi = Math.max(hi, terrain.heightAt(cx + (rel[i * 2] ?? 0), cz + (rel[i * 2 + 1] ?? 0)));
  }
  // Deck just clear of the water, meeting the seawall height shoreside. The
  // floor used to be 1.2, which left a full unit of daylight under every low
  // pier; the pilings and the wale below close what is left.
  const deckY = Math.min(Math.max(hi + 0.35, 0.95), 4.2);

  let bestLen = 0;
  let ex = 1;
  let ez = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = (rel[j * 2] ?? 0) - (rel[i * 2] ?? 0);
    const dz = (rel[j * 2 + 1] ?? 0) - (rel[i * 2 + 1] ?? 0);
    const len = Math.hypot(dx, dz);
    if (len > bestLen) {
      bestLen = len;
      ex = dx / len;
      ez = dz / len;
    }
  }
  let minA = Infinity;
  let maxA = -Infinity;
  let minB = Infinity;
  let maxB = -Infinity;
  for (let i = 0; i < n; i++) {
    const dx = rel[i * 2] ?? 0;
    const dz = rel[i * 2 + 1] ?? 0;
    const a = dx * ex + dz * ez;
    const bb = -dx * ez + dz * ex;
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    minB = Math.min(minB, bb);
    maxB = Math.max(maxB, bb);
  }
  const aMid = (minA + maxA) / 2;
  const bMid = (minB + maxB) / 2;
  const ox = cx + aMid * ex - bMid * ez;
  const oz = cz + aMid * ez + bMid * ex;
  // The shore end is the one standing in shallower water: the bulkhead facade
  // faces the street, and the navigation light goes on the other end.
  const probe = (s: number): number =>
    terrain.landAt(ox + s * ex * (maxA - minA) * 0.5, oz + s * ez * (maxA - minA) * 0.5);
  const shoreSign = probe(1) >= probe(-1) ? 1 : -1;
  return {
    spec,
    area,
    deckY,
    ox,
    oz,
    ex,
    ez,
    yaw: Math.atan2(-ez, ex),
    lenA: maxA - minA,
    lenB: maxB - minB,
    shoreSign,
    key: oz < -1050 ? ox : 1000 + (oz + 1050),
    number: null,
  };
}

/** World point at (along-axis, across-axis) in a pier's own frame. */
function atFrame(p: PierInfo, a: number, bb: number): readonly [number, number] {
  return [p.ox + a * p.ex - bb * p.ez, p.oz + a * p.ez + bb * p.ex];
}

// --- Substructure ---------------------------------------------------------

const PILE_STEP = 6.5; // was ~40 on the long edges: the piers looked levitated
const PILE_FOOT = -2.6;
const BRACE_MIN_EDGE = 22;

function substructure(port: ChunkedPort, p: PierInfo): void {
  const { cx, cz, rel } = p.spec;
  const n = rel.length / 2;
  const top = p.deckY - 0.75;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = cx + (rel[i * 2] ?? 0);
    const az = cz + (rel[i * 2 + 1] ?? 0);
    const bx = cx + (rel[j * 2] ?? 0);
    const bz = cz + (rel[j * 2 + 1] ?? 0);
    const len = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.round(len / PILE_STEP));
    const b = port.at(ax, az);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const px = ax + (bx - ax) * t;
      const pz = az + (bz - az) * t;
      b.box(PILE, 0.55, top - PILE_FOOT, 0.55, px, (top + PILE_FOOT) / 2, pz);
    }
    // A continuous wale at the waterline ties the pilings together and gives
    // the whole substructure the dark wet band it was missing.
    b.beam(PILE_WET, ax, -0.05, az, bx, -0.05, bz, 0.7);
    if (len >= BRACE_MIN_EDGE) {
      const bays = Math.max(1, Math.round(len / 14));
      for (let k = 0; k < bays; k++) {
        const t0 = k / bays;
        const t1 = (k + 1) / bays;
        const x0 = ax + (bx - ax) * t0;
        const z0 = az + (bz - az) * t0;
        const x1 = ax + (bx - ax) * t1;
        const z1 = az + (bz - az) * t1;
        b.beam(PILE, x0, top - 0.4, z0, x1, -0.9, z1, 0.35);
        b.beam(PILE, x1, top - 0.4, z1, x0, -0.9, z0, 0.35);
      }
    }
  }
  // Interior bents so a wide deck is not a table on four legs.
  if (p.area > 400) {
    for (let a = -p.lenA / 2 + 10; a < p.lenA / 2 - 8; a += 16) {
      for (let bb = -p.lenB / 2 + 8; bb < p.lenB / 2 - 6; bb += 14) {
        const [x, z] = atFrame(p, a, bb);
        port.at(x, z).box(PILE, 0.55, top - PILE_FOOT, 0.55, x, (top + PILE_FOOT) / 2, z);
      }
    }
  }
}

/** Bollards, tyre fenders and a ladder round the rim — the working detail. */
function rimFurniture(port: ChunkedPort, p: PierInfo, rng: Rng, beacons: Beacon[]): void {
  const { cx, cz, rel } = p.spec;
  const n = rel.length / 2;
  let laddered = false;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = cx + (rel[i * 2] ?? 0);
    const az = cz + (rel[i * 2 + 1] ?? 0);
    const bx = cx + (rel[j * 2] ?? 0);
    const bz = cz + (rel[j * 2 + 1] ?? 0);
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 8) continue;
    const dx = (bx - ax) / len;
    const dz = (bz - az) / len;
    // Inward normal, so the bollards stand ON the deck instead of over water.
    const inx = dz;
    const inz = -dx;
    const b = port.at(ax, az);
    const bollards = Math.max(1, Math.floor(len / 13));
    for (let k = 0; k < bollards; k++) {
      const t = ((k + 0.5) / bollards) * len;
      const x = ax + dx * t + inx * 1.4;
      const z = az + dz * t + inz * 1.4;
      b.box(0x3a3a3a, 0.55, 0.95, 0.55, x, p.deckY + 0.45, z);
      b.box(0x3a3a3a, 0.75, 0.2, 0.75, x, p.deckY + 0.95, z);
    }
    const fenders = Math.max(1, Math.floor(len / 11));
    for (let k = 0; k < fenders; k++) {
      const t = ((k + 0.35) / fenders) * len;
      const x = ax + dx * t - inx * 0.3;
      const z = az + dz * t - inz * 0.3;
      b.box(0x232120, 0.7, 0.75, 0.7, x, p.deckY - 1.1, z, Math.atan2(dx, dz));
    }
    if (!laddered && p.area > 250) {
      laddered = true;
      const x = ax + dx * len * 0.5;
      const z = az + dz * len * 0.5;
      for (const side of [-1, 1] as const) {
        b.box(
          STEEL,
          0.12,
          p.deckY + 1.2,
          0.12,
          x - inx * 0.25 - dx * 0.35 * side,
          (p.deckY - 1) / 2,
          z - inz * 0.25 - dz * 0.35 * side,
        );
      }
      for (let k = 0; k < 3; k++) {
        b.beam(
          STEEL,
          x - inx * 0.25 - dx * 0.35,
          -0.4 + k * 0.7,
          z - inz * 0.25 - dz * 0.35,
          x - inx * 0.25 + dx * 0.35,
          -0.4 + k * 0.7,
          z - inz * 0.25 + dz * 0.35,
          0.1,
        );
      }
    }
  }
  // Navigation light on the seaward end: red to port of the channel, green to
  // starboard, blinking the way a real pier-head lantern does.
  const [nx, nz] = atFrame(p, (-p.shoreSign * p.lenA) / 2 + p.shoreSign * 1.5, 0);
  if (p.area > 150) {
    port.at(nx, nz).box(0x2f3438, 0.4, 1.8, 0.4, nx, p.deckY + 0.9, nz);
    beacons.push({
      x: nx,
      y: p.deckY + 2,
      z: nz,
      color: rng.chance(0.5) ? 0xff3524 : 0x2bff6a,
      size: 2.4,
      blinkS: rng.range(2.6, 4.2),
    });
  }
}

// --- Superstructure -------------------------------------------------------

/** A pitched-roof shed on the deck. */
function shed(
  port: ChunkedPort,
  p: PierInfo,
  aCentre: number,
  lenA: number,
  lenB: number,
  wallH: number,
  roofH: number,
  wall: number,
  roof: number,
): void {
  const [x, z] = atFrame(p, aCentre, 0);
  const b = port.at(x, z);
  b.box(wall, lenA, wallH, lenB, x, p.deckY + wallH / 2, z, p.yaw);
  // A band of glazing and a base plinth: two boxes that stop the mass reading
  // as one flat slab from the Embarcadero.
  b.box(GLASS, lenA + 0.06, 0.85, lenB + 0.06, x, p.deckY + wallH * 0.62, z, p.yaw);
  b.box(SHED_TRIM, lenA + 0.2, 0.5, lenB + 0.2, x, p.deckY + 0.25, z, p.yaw);
  const half = lenB / 2 + 0.5;
  const run = Math.hypot(half, roofH);
  const pitch = Math.atan2(roofH, half);
  for (const side of [-1, 1] as const) {
    const [rx, rz] = atFrame(p, aCentre, (side * half) / 2);
    b.pitchedBox(
      roof,
      lenA + 1,
      0.35,
      run,
      rx,
      p.deckY + wallH + roofH / 2,
      rz,
      p.yaw,
      side * pitch,
    );
  }
  // Gable ends.
  for (const end of [-1, 1] as const) {
    const a = aCentre + (end * lenA) / 2;
    const p0 = atFrame(p, a, -lenB / 2);
    const p1 = atFrame(p, a, lenB / 2);
    const p2 = atFrame(p, a, 0);
    const v0: [number, number, number] = [p0[0], p.deckY + wallH, p0[1]];
    const v1: [number, number, number] = [p1[0], p.deckY + wallH, p1[1]];
    const v2: [number, number, number] = [p2[0], p.deckY + wallH + roofH, p2[1]];
    if (end > 0) b.tri(wall, v0, v2, v1);
    else b.tri(wall, v0, v1, v2);
  }
}

/**
 * The bulkhead: the arched, parapeted street front the Embarcadero sheds hide
 * behind, with the pier's number board over the central bay.
 */
function bulkhead(
  port: ChunkedPort,
  p: PierInfo,
  aFace: number,
  width: number,
  wallH: number,
  wall: number,
  signs: SignBoards,
  cell: number | null,
): void {
  const [x, z] = atFrame(p, aFace, 0);
  const b = port.at(x, z);
  const out = p.shoreSign; // the facade faces the street, i.e. shoreward
  const faceH = wallH + 1.6;
  b.box(wall, 1.1, faceH, width, x, p.deckY + faceH / 2, z, p.yaw);
  // Parapet with a raised central pediment.
  b.box(SHED_TRIM, 1.5, 0.55, width + 0.6, x, p.deckY + faceH + 0.27, z, p.yaw);
  b.box(wall, 1.5, 1.5, width * 0.34, x, p.deckY + faceH + 1.05, z, p.yaw);
  b.box(SHED_TRIM, 1.7, 0.35, width * 0.36, x, p.deckY + faceH + 1.95, z, p.yaw);

  // Three arched bays: a dark recess with a stepped head, between pilasters.
  const bays = width > 26 ? 5 : 3;
  const bayW = (width * 0.78) / bays;
  for (let i = 0; i < bays; i++) {
    const bb = (i - (bays - 1) / 2) * (width / bays);
    const [ox, oz] = atFrame(p, aFace + out * 0.35, bb);
    const openH = faceH * 0.62;
    b.box(0x24292d, 0.6, openH, bayW * 0.72, ox, p.deckY + openH / 2, oz, p.yaw);
    for (let s = 0; s < 3; s++) {
      b.box(
        0x24292d,
        0.6,
        0.3,
        bayW * (0.66 - s * 0.17),
        ox,
        p.deckY + openH + 0.15 + s * 0.3,
        oz,
        p.yaw,
      );
    }
    if (i > 0) {
      const [qx, qz] = atFrame(p, aFace + out * 0.3, bb - width / bays / 2);
      b.box(SHED_TRIM, 0.5, faceH, 0.7, qx, p.deckY + faceH / 2, qz, p.yaw);
    }
  }
  if (cell !== null) {
    const [sx, sz] = atFrame(p, aFace + out * 0.9, 0);
    signs.push(
      cell,
      sx,
      p.deckY + faceH + 1.05,
      sz,
      out * p.ex,
      out * p.ez,
      Math.min(width * 0.3, 6),
      Math.min(width * 0.15, 3),
    );
  }
}

/**
 * Portal gantry crane on the industrial piers. `aWanted` is clamped into the
 * deck: a crane whose bogies stand in the water reads as a floating prop.
 */
function gantry(port: ChunkedPort, p: PierInfo, aWanted: number, span: number): void {
  const edge = Math.max(0, p.lenA / 2 - 9);
  const aCentre = Math.min(edge, Math.max(-edge, aWanted));
  const [x, z] = atFrame(p, aCentre, 0);
  const b = port.at(x, z);
  const legH = 9.5;
  for (const sa of [-1, 1] as const) {
    for (const sb of [-1, 1] as const) {
      const [lx, lz] = atFrame(p, aCentre + sa * 4, (sb * span) / 2);
      b.box(CRANE_ORANGE, 0.8, legH, 0.8, lx, p.deckY + legH / 2, lz);
      b.box(0x3a3f42, 1.6, 0.5, 1.6, lx, p.deckY + 0.25, lz); // bogie
    }
  }
  // Portal beam across the span, plus the boom reaching out over the water.
  const [b0x, b0z] = atFrame(p, aCentre, -span / 2);
  const [b1x, b1z] = atFrame(p, aCentre, span / 2);
  b.beam(CRANE_ORANGE, b0x, p.deckY + legH, b0z, b1x, p.deckY + legH, b1z, 1.6);
  // Leg-to-portal knee braces: without them the head reads as floating.
  for (const sb of [-1, 1] as const) {
    const [kx, kz] = atFrame(p, aCentre, (sb * span) / 2);
    b.beam(CRANE_ORANGE, kx, p.deckY + legH - 3.4, kz, x, p.deckY + legH - 0.4, z, 0.5);
  }
  b.box(CRANE_ORANGE, 2.4, 2.4, span * 0.3, x, p.deckY + legH + 1.8, z, p.yaw);
  const [tipX, tipZ] = atFrame(p, aCentre, -span * 0.9);
  b.beam(CRANE_ORANGE, x, p.deckY + legH + 2.6, z, tipX, p.deckY + legH + 4.4, tipZ, 0.7);
  b.beam(STEEL, x, p.deckY + legH + 3, z, tipX, p.deckY + legH + 4.4, tipZ, 0.25);
  // Spreader hanging off the trolley.
  const [hx, hz] = atFrame(p, aCentre, -span * 0.45);
  b.box(0x3a3f42, 1.4, 0.5, 5, hx, p.deckY + legH - 1.4, hz, p.yaw);
}

/** Stacked containers — the cargo that says a pier still works for a living. */
function cargo(port: ChunkedPort, p: PierInfo, rng: Rng): void {
  const hues = [0xc4562f, 0x2f6ea8, 0x3d7a4a, 0xb8a03a, 0x8a4d86, 0x9aa2a8];
  const rows = Math.max(1, Math.floor(p.lenA / 18));
  for (let i = 0; i < rows; i++) {
    const a = -p.lenA / 2 + 9 + i * 18;
    if (!rng.chance(0.7)) continue;
    for (let k = 0; k < 2; k++) {
      const bb = (k - 0.5) * Math.min(p.lenB * 0.36, 8);
      const [x, z] = atFrame(p, a, bb);
      const tiers = 1 + rng.int(3);
      for (let t = 0; t < tiers; t++) {
        port
          .at(x, z)
          .box(
            rng.pick(hues),
            6.4,
            1.6,
            2.8,
            x,
            p.deckY + 0.8 + t * 1.65,
            z,
            p.yaw + rng.range(-0.05, 0.05),
          );
      }
    }
  }
}

/** Fisherman's Wharf: a cluster of crab shacks with striped awnings. */
function crabShacks(port: ChunkedPort, p: PierInfo, rng: Rng, beacons: Beacon[]): void {
  const count = Math.max(2, Math.min(7, Math.floor(p.lenA / 11)));
  for (let i = 0; i < count; i++) {
    const a = -p.lenA / 2 + 6 + (i * (p.lenA - 10)) / Math.max(1, count - 1);
    const bb = rng.range(-p.lenB * 0.2, p.lenB * 0.2);
    const [x, z] = atFrame(p, a, bb);
    const b = port.at(x, z);
    const w = rng.range(4.5, 7);
    const d = rng.range(4, 5.5);
    const h = rng.range(2.6, 3.4);
    b.box(rng.pick(SHACK_WALLS), w, h, d, x, p.deckY + h / 2, z, p.yaw);
    b.box(rng.pick(ROOFS), w + 0.6, 0.35, d + 0.6, x, p.deckY + h + 0.17, z, p.yaw);
    // Awning over the counter, and the steam pot behind it.
    const [awx, awz] = atFrame(p, a, bb + d * 0.62);
    b.pitchedBox(rng.pick(AWNINGS), w, 0.16, 2.2, awx, p.deckY + h - 0.5, awz, p.yaw, 0.34);
    b.cylinder(STEEL, 0.55, 1, x, p.deckY, z);
    if (rng.chance(0.5)) {
      beacons.push({
        x,
        y: p.deckY + h + 0.6,
        z,
        color: 0xffce7a,
        size: 4.2,
        groundY: p.deckY,
      });
    }
  }
}

/** Pier 39: two rows of shopfronts down a boardwalk, with the carousel. */
function arcade(port: ChunkedPort, p: PierInfo, rng: Rng, beacons: Beacon[]): void {
  const rows = Math.max(3, Math.floor(p.lenA / 12));
  const off = Math.min(p.lenB * 0.28, 9);
  for (let i = 0; i < rows; i++) {
    const a = -p.lenA / 2 + 8 + (i * (p.lenA - 14)) / Math.max(1, rows - 1);
    for (const side of [-1, 1] as const) {
      const [x, z] = atFrame(p, a, side * off);
      const b = port.at(x, z);
      const h = rng.range(3.2, 4.4);
      const w = rng.range(7, 9.5);
      b.box(rng.pick(SHACK_WALLS), w, h, 7, x, p.deckY + h / 2, z, p.yaw);
      const roofH = rng.range(1.2, 2);
      const run = Math.hypot(3.8, roofH);
      const pitch = Math.atan2(roofH, 3.8);
      for (const s of [-1, 1] as const) {
        const [rx, rz] = atFrame(p, a, side * off + s * 1.9);
        b.pitchedBox(
          rng.pick(ROOFS),
          w + 0.8,
          0.3,
          run,
          rx,
          p.deckY + h + roofH / 2,
          rz,
          p.yaw,
          s * pitch,
        );
      }
      const [awx, awz] = atFrame(p, a, side * off - side * 4.2);
      b.pitchedBox(
        rng.pick(AWNINGS),
        w * 0.8,
        0.14,
        2,
        awx,
        p.deckY + h - 0.9,
        awz,
        p.yaw,
        -side * 0.3,
      );
      if (rng.chance(0.45)) {
        beacons.push({ x, y: p.deckY + h - 0.4, z, color: 0xffd58f, size: 5, groundY: p.deckY });
      }
    }
  }
  // The carousel at the seaward end: a drum, a conical roof, a lit finial.
  const [cx, cz] = atFrame(p, (-p.shoreSign * p.lenA) / 2 + p.shoreSign * 9, 0);
  const b = port.at(cx, cz);
  b.cylinder(0xf3ece0, 4.4, 4.2, cx, p.deckY, cz);
  b.cone(0xd94f3a, 5.2, 2.6, cx, p.deckY + 4.2, cz);
  b.cylinder(0xf2c341, 0.3, 1.2, cx, p.deckY + 6.8, cz);
  beacons.push({ x: cx, y: p.deckY + 7.6, z: cz, color: 0xffe6a8, size: 7, groundY: p.deckY });
}

/** The ferry terminal: three covered slips off the Ferry Building's pier. */
function ferryTerminal(port: ChunkedPort, p: PierInfo, beacons: Beacon[]): void {
  const out = -p.shoreSign;
  const aEnd = (out * p.lenA) / 2;
  for (let i = -1; i <= 1; i++) {
    const bb = i * Math.min(p.lenB * 0.34, 13);
    const [gx, gz] = atFrame(p, aEnd - out * 5, bb);
    const [tx, tz] = atFrame(p, aEnd + out * 9, bb);
    const b = port.at(gx, gz);
    // Gangway out to a landing float, under a hipped canopy.
    b.beam(TIMBER, gx, p.deckY + 0.1, gz, tx, WATER_Y + 1.1, tz, 3.2);
    b.box(0xf1ece0, 4.6, 2.4, 5.4, tx, WATER_Y + 3.4, tz, p.yaw);
    b.box(0x2b5f86, 4.9, 0.4, 5.7, tx, WATER_Y + 4.7, tz, p.yaw);
    for (const s of [-1, 1] as const) {
      const [dx, dz] = atFrame(p, aEnd + out * 9, bb + s * 4.4);
      b.box(PILE, 0.8, 7, 0.8, dx, 1.2, dz); // mooring dolphin
      b.box(PILE_WET, 1, 0.9, 1, dx, -0.2, dz);
    }
    beacons.push({
      x: tx,
      y: WATER_Y + 5.2,
      z: tz,
      color: 0xffe0b0,
      size: 6,
      groundY: WATER_Y + 0.2,
    });
  }
  // Terminal shed on the deck itself, glazed toward the slips.
  const [sx, sz] = atFrame(p, aEnd - out * 17, 0);
  const b = port.at(sx, sz);
  b.box(0xe8e2d2, 12, 4.2, Math.min(p.lenB * 0.8, 26), sx, p.deckY + 2.1, sz, p.yaw);
  b.box(GLASS, 12.1, 1.5, Math.min(p.lenB * 0.8, 26) + 0.1, sx, p.deckY + 2.9, sz, p.yaw);
  b.box(SHED_TRIM, 13.4, 0.5, Math.min(p.lenB * 0.8, 26) + 1.4, sx, p.deckY + 4.45, sz, p.yaw);
  beacons.push({ x: sx, y: p.deckY + 4.8, z: sz, color: 0xffdca6, size: 9, groundY: p.deckY });
}

// --- Shoreline ------------------------------------------------------------

const RIPRAP_STEP = 8;

/**
 * Riprap: the rock armour banked against the seawall. Marched out from the
 * shore until the terrain drops under the water, so it follows the traced
 * coast rather than a guessed line, and skipped wherever a pier deck lands.
 */
function riprap(
  port: ChunkedPort,
  terrain: Terrain,
  near: (x: number, z: number) => boolean,
): void {
  const rng = new Rng(0x5ea11);
  for (let z = -1240; z < -60; z += RIPRAP_STEP) {
    // March WEST out of open water: the first sample standing above the
    // waterline is the shore, wherever the traced coast put it that row.
    let found = -1;
    for (let x = 1320; x > 260; x -= 3) {
      if (terrain.heightAt(x, z) > -0.9) {
        found = x;
        break;
      }
    }
    if (found < 0 || near(found, z)) continue;
    const b = port.at(found, z);
    for (let k = 0; k < 4; k++) {
      const rx = found + rng.range(-1.4, 4.5);
      const rz = z + rng.range(-4, 4);
      // Rubble, not blocks: a 2u "boulder" is an 8 m rock at pier scale.
      const s = rng.range(0.6, 1.6);
      b.box(
        rng.pick(ROCKS),
        s * rng.range(0.8, 1.5),
        s * rng.range(0.6, 1),
        s * rng.range(0.8, 1.5),
        rx,
        WATER_Y + s * 0.05,
        rz,
        rng.range(0, Math.PI),
      );
    }
  }
}

// --- Marina floats --------------------------------------------------------

const FLOAT_TOP = 0.16;
const FLOAT_BOT = -0.55;

/** The dock fingers themselves: shallow boxes RIDING the water, not over it. */
function dockFloats(port: ChunkedPort, isWater: (x: number, z: number) => boolean): void {
  for (const dock of SF_DOCKS) {
    for (let i = 0; i + 3 < dock.length; i += 2) {
      const ax = dock[i] ?? 0;
      const az = dock[i + 1] ?? 0;
      const bx = dock[i + 2] ?? 0;
      const bz = dock[i + 3] ?? 0;
      // A float riding at the waterline on dry ground is a plank in a car
      // park. Same test the moorings use, for the same OSM-vs-new-coastline
      // reason.
      if (!isWater((ax + bx) / 2, (az + bz) / 2)) continue;
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const nx = (-(bz - az) / len) * 0.8;
      const nz = ((bx - ax) / len) * 0.8;
      const b = port.at(ax, az);
      b.quad(
        TIMBER,
        [ax - nx, FLOAT_TOP, az - nz],
        [bx - nx, FLOAT_TOP, bz - nz],
        [bx + nx, FLOAT_TOP, bz + nz],
        [ax + nx, FLOAT_TOP, az + nz],
      );
      b.quad(
        0xa08659,
        [ax + nx, FLOAT_TOP, az + nz],
        [bx + nx, FLOAT_TOP, bz + nz],
        [bx + nx, FLOAT_BOT, bz + nz],
        [ax + nx, FLOAT_BOT, az + nz],
      );
      b.quad(
        0xa08659,
        [ax - nx, FLOAT_BOT, az - nz],
        [bx - nx, FLOAT_BOT, bz - nz],
        [bx - nx, FLOAT_TOP, bz - nz],
        [ax - nx, FLOAT_TOP, az - nz],
      );
    }
  }
}

// --- Entry point ----------------------------------------------------------

export function buildPiers(terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  const port = new ChunkedPort();
  const beacons: Beacon[] = [];
  const signs = new SignBoards();
  const rng = new Rng(0x9155);

  const piers: PierInfo[] = [];
  for (const raw of SF_PIERS) {
    const info = analyse(raw.p, raw.area, terrain);
    if (info) piers.push(info);
  }

  // Number the numbered ones: odd out to the wharf, even down toward Mission
  // Bay, the Ferry Building's own pier excluded (it is the terminal).
  const ferryPier = piers.reduce<PierInfo | null>(
    (best, p) =>
      p.area > 600 && Math.abs(p.oz - FERRY_Z) < 60 && (!best || p.area > best.area) ? p : best,
    null,
  );
  const numbered = piers.filter((p) => p.area >= NUMBERED_MIN_AREA && p !== ferryPier);
  const north = numbered.filter((p) => p.oz < FERRY_Z).sort((a, b) => b.key - a.key);
  const south = numbered.filter((p) => p.oz >= FERRY_Z).sort((a, b) => a.key - b.key);
  north.forEach((p, i) => {
    p.number = NORTH_NUMBERS[NORTH_NUMBERS.length - 1 - i] ?? null;
  });
  south.forEach((p, i) => {
    p.number = SOUTH_NUMBERS[i] ?? null;
  });
  const cells: number[] = [];
  for (const p of piers) if (p.number !== null) cells.push(p.number);
  const atlas = signAtlas(cells);

  const nearPier = (x: number, z: number): boolean => {
    for (const p of piers) {
      if (Math.abs(p.ox - x) > 90 || Math.abs(p.oz - z) > 90) continue;
      const { cx, cz, rel } = p.spec;
      for (let i = 0; i < rel.length; i += 2) {
        if (Math.hypot(cx + (rel[i] ?? 0) - x, cz + (rel[i + 1] ?? 0) - z) < 14) return true;
      }
    }
    return false;
  };

  for (const p of piers) {
    const b = port.at(p.ox, p.oz);
    b.addGeometry(
      prismGeometry(p.spec),
      DECKS[Math.abs(Math.round(p.key)) % DECKS.length] ?? DECKS[0],
      new THREE.Matrix4().makeTranslation(p.spec.cx, p.deckY - 0.85, p.spec.cz),
    );
    substructure(port, p);
    rimFurniture(port, p, rng, beacons);

    if (p === ferryPier) {
      ferryTerminal(port, p, beacons);
      continue;
    }
    const wharf = p.oz < -1050;
    const industrial = p.oz > -560;
    if (p.area < 150) continue; // a mooring stub: pilings and a bollard is all
    if (wharf) {
      if (p.area > 800) arcade(port, p, rng, beacons);
      else crabShacks(port, p, rng, beacons);
      continue;
    }
    // Embarcadero and industrial piers: a shed of varied length and pitch, its
    // bulkhead facade at the street end, cargo gear on the working ones.
    const lenA = Math.min(p.lenA * rng.range(0.6, 0.84), 52);
    const lenB = Math.min(p.lenB * rng.range(0.5, 0.7), 22);
    if (lenA < 9 || lenB < 5) continue;
    const wallH = rng.range(3.2, 5.4);
    const roofH = rng.range(1.1, 2.6);
    const wall = SHED_WALLS[Math.abs(Math.round(p.key)) % SHED_WALLS.length] ?? SHED_WALLS[0];
    const roof = ROOFS[Math.abs(Math.round(p.key * 7)) % ROOFS.length] ?? ROOFS[0];
    const aShed = (p.shoreSign * (p.lenA - lenA)) / 2 - p.shoreSign * 2;
    shed(port, p, aShed, lenA, lenB, wallH, roofH, wall, roof);
    bulkhead(
      port,
      p,
      aShed + (p.shoreSign * lenA) / 2,
      lenB + 2,
      wallH,
      wall,
      signs,
      p.number === null ? null : cells.indexOf(p.number),
    );
    beacons.push({
      x: p.ox,
      y: p.deckY + wallH,
      z: p.oz,
      color: 0xffdca6,
      size: 6,
      groundY: p.deckY,
    });
    if (industrial && p.area > 500 && p.lenA > 34) {
      gantry(port, p, aShed - p.shoreSign * (lenA / 2 + 14), Math.min(p.lenB * 0.6, 22));
      cargo(port, p, rng);
    }
  }

  // The waterline test the whole harbour shares: the same −0.9 threshold
  // `riprap` marches to, so floats, moorings and rock armour all agree on
  // where the water is.
  const isWater = (x: number, z: number): boolean => terrain.heightAt(x, z) < -0.9;
  dockFloats(port, isWater);
  riprap(port, terrain, nearPier);
  const moorings = planMoorings(0x1a7b, isWater);
  for (const l of addMoorings((x, z) => port.at(x, z), moorings)) {
    beacons.push({ x: l.x, y: l.y, z: l.z, color: l.color, size: l.size });
  }

  port.addTo(group);
  if (atlas) {
    const mesh = signs.mesh(atlas);
    if (mesh) group.add(mesh);
  }
  registerBeacons("piers", beacons);
  console.log(
    `[piers] ${piers.length} piers, ${moorings.length} moored, ${port.triCount} tris in ${port.meshCount} meshes, ${beacons.length} lamps`,
  );
  return group;
}
