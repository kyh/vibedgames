// Custom-map file format (v1) + its boundary parser. A map is two flat lists:
// render-only prop placements (the decor vocabulary) and sim colliders.
// Produced by the in-browser editor (?editor=1), consumed at boot (main.ts):
// a bundled public/maps/default.json replaces the procedural arena for every
// client; in offline modes a localStorage draft (the editor's TEST loop) takes
// precedence. Colliders are SIM state — online play only ever loads the
// bundled file so every client simulates the same arena.
import { clampToArena } from "./map";

/** Render-only prop placement (mirrors decor.ts's Decor shape). */
export type MapProp = {
  model: string;
  x: number;
  y: number;
  rot: number;
  scale: number;
  /** Topple the prop 90° on Z (fallen debris). */
  lie?: boolean;
  /** Extra Y lift above the terrain (dais-top props, wall-mounted trophies). */
  h?: number;
};

/** Circle collider the sim resolves against. `model` is a render hint — the
 *  editor only emits it for "wall_run" (rendered as continuous wall segments);
 *  hand-authored maps may name any loaded prop to render at the collider. */
export type MapCollider = { x: number; y: number; radius: number; height: number; model?: string };

/** The four floor-tile bands the arena floor is built from. */
export const FLOOR_TYPES = ["flag", "worn", "dirt", "grate"] as const;
export type FloorType = (typeof FLOOR_TYPES)[number];

/** One painted floor cell: (x, y) is the cell center on the 4u tile grid
 *  (multiples of 4, sim plane), `t` the tile band. Cells not listed keep the
 *  procedural floor. */
export type MapFloorCell = { x: number; y: number; t: FloorType };

export type MapData = { version: 1; props: MapProp[]; colliders: MapCollider[]; floor?: MapFloorCell[] };

/** The editor's offline-draft slot (read at boot for ?auto quick-starts). */
export const MAP_STORAGE_KEY = "ba-map";

/** KayKit Dungeon pieces registered in the ModelLibrary at boot (main.ts loads
 *  each from ./models/dungeon/{name}.gltf). Lives here — not main.ts — so the
 *  editor's palette can import the vocabulary without pulling in the boot
 *  module's side effects. */
export const DUNGEON_MODELS = [
  "floor_tile_large",
  "wall",
  "pillar",
  "pillar_decorated",
  "column",
  "torch_lit",
  "crate_large",
  "barrel_large",
  "banner_red",
  "banner_blue",
  "floor_foundation_allsides",
  "floor_foundation_corner",
  "stairs",
  "wall_corner",
  // Sunken Court buildout
  "wall_broken",
  "wall_gated",
  "wall_pillar",
  "stairs_wide",
  "floor_tile_large_rocks",
  "floor_tile_big_grate",
  "floor_dirt_large",
  "floor_tile_small_weeds_A",
  "rubble_half",
  "rocks",
  "rocks_small",
  "rocks_gold",
  "chest_gold",
  "chest_large_gold",
  "chest_mimic",
  "chest",
  "coin_stack_small",
  "coin_stack_medium",
  "keg",
  "keg_decorated",
  "crates_stacked",
  "trunk_large_A",
  "post",
  "candle_triple",
  "sword_shield_broken",
  "scaffold_frame_small",
  "bucket_pickaxes",
  "banner_thin_yellow",
  "banner_white",
];

/** Everything the editor palette can place (dungeon set + standalone props). */
export const PLACEABLE_MODELS: string[] = [...DUNGEON_MODELS, "vampire_throne", "paladin_statue", "mushroom"];

const MAX_PROPS = 2000;
const MAX_COLLIDERS = 512;
const MAX_FLOOR_CELLS = 4096;
// clamp positions to the hex + a 3u apron — wall-mounted dressing (the gate
// trophies) legitimately sits a little proud of the playable boundary
const POS_MARGIN = -3;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function parseProp(v: unknown): MapProp | null {
  if (!isRecord(v)) return null;
  const model = v["model"];
  if (typeof model !== "string" || model.length === 0 || model.length > 64) return null;
  if (!isFiniteNumber(v["x"]) || !isFiniteNumber(v["y"]) || !isFiniteNumber(v["rot"]) || !isFiniteNumber(v["scale"])) return null;
  const lie = v["lie"];
  if (lie !== undefined && typeof lie !== "boolean") return null;
  const h = v["h"];
  if (h !== undefined && !isFiniteNumber(h)) return null;
  const pos = clampToArena(v["x"], v["y"], POS_MARGIN);
  const out: MapProp = { model, x: pos.x, y: pos.y, rot: v["rot"], scale: clampNum(v["scale"], 0.05, 10) };
  if (lie === true) out.lie = true;
  if (h !== undefined) out.h = clampNum(h, -10, 20);
  return out;
}

function parseCollider(v: unknown): MapCollider | null {
  if (!isRecord(v)) return null;
  if (!isFiniteNumber(v["x"]) || !isFiniteNumber(v["y"]) || !isFiniteNumber(v["radius"]) || !isFiniteNumber(v["height"])) return null;
  const model = v["model"];
  if (model !== undefined && (typeof model !== "string" || model.length === 0 || model.length > 64)) return null;
  const pos = clampToArena(v["x"], v["y"], POS_MARGIN);
  const out: MapCollider = {
    x: pos.x,
    y: pos.y,
    radius: clampNum(v["radius"], 0.05, 20),
    height: clampNum(v["height"], 0.1, 30),
  };
  if (model !== undefined) out.model = model;
  return out;
}

function isFloorType(v: unknown): v is FloorType {
  return typeof v === "string" && (FLOOR_TYPES as readonly string[]).includes(v);
}

/** Snap to the 4u tile grid the floor builder walks. */
const snapCell = (v: number): number => Math.round(v / 4) * 4;

function parseFloorCell(v: unknown): MapFloorCell | null {
  if (!isRecord(v)) return null;
  if (!isFiniteNumber(v["x"]) || !isFiniteNumber(v["y"]) || !isFloorType(v["t"])) return null;
  return { x: snapCell(clampNum(v["x"], -200, 200)), y: snapCell(clampNum(v["y"], -200, 200)), t: v["t"] };
}

/** Boundary parser: unknown JSON → MapData or null (never throws). Validates
 *  types, clamps numeric ranges, and clamps positions into the hex (+apron).
 *  Strict per-entry — one malformed prop rejects the whole map, so a bad file
 *  falls back to the procedural arena instead of half-loading. */
export function parseMapData(raw: unknown): MapData | null {
  if (!isRecord(raw)) return null;
  if (raw["version"] !== 1) return null;
  const rawProps = raw["props"];
  const rawColliders = raw["colliders"];
  if (!Array.isArray(rawProps) || !Array.isArray(rawColliders)) return null;
  if (rawProps.length > MAX_PROPS || rawColliders.length > MAX_COLLIDERS) return null;
  const propList: unknown[] = rawProps;
  const colliderList: unknown[] = rawColliders;
  const props: MapProp[] = [];
  for (const p of propList) {
    const parsed = parseProp(p);
    if (!parsed) return null;
    props.push(parsed);
  }
  const colliders: MapCollider[] = [];
  for (const c of colliderList) {
    const parsed = parseCollider(c);
    if (!parsed) return null;
    colliders.push(parsed);
  }
  const out: MapData = { version: 1, props, colliders };
  // optional painted floor (absent in older files — procedural everywhere)
  const rawFloor = raw["floor"];
  if (rawFloor !== undefined) {
    if (!Array.isArray(rawFloor) || rawFloor.length > MAX_FLOOR_CELLS) return null;
    const floorList: unknown[] = rawFloor;
    const floor: MapFloorCell[] = [];
    for (const f of floorList) {
      const parsed = parseFloorCell(f);
      if (!parsed) return null;
      floor.push(parsed);
    }
    if (floor.length > 0) out.floor = floor;
  }
  return out;
}

/** Pretty JSON for download / localStorage (the editor's output). */
export function serializeMapData(d: MapData): string {
  return JSON.stringify(d, null, 2);
}
