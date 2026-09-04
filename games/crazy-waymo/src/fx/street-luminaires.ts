import { modelUrl, PROP_TRAFFICLIGHT } from "../assets/manifest";
import type { BatchItemRec } from "../world/city";
import { type Beacon, registerBeacons } from "./beacon-lights";

// STREET-LEVEL LIGHT DOWNTOWN: the luminaire on the signal mast.
//
// DOWNTOWN HAS NO STREETLIGHTS, and no amount of tuning the ones it has can
// change that. world/furniture.ts walks every network edge and tries to seat a
// lamp post 0.6u outside the kerb; where the buildings meet the lot line —
// which is the definition of a downtown block — that lands inside a wall, the
// seat is refused, and the district ships unlit. Measured on the shipped
// world: 0 lamp heads within 100u of a Financial District chase camera, 11
// within 200u, against 16 within 120u in the Richmond, which is the district
// that reads correctly at night. Moving the lamps is a furniture change and a
// world rebake; this is the runtime half.
//
// What downtown does have is JUNCTION HARDWARE — 79 signal-mast instances
// inside the same 120u — and a signal mast carrying the street luminaire is
// what a real downtown corner looks like. So the light goes on the pole that
// is already standing there: a small hot head at the top of the mast and a
// pool wide enough to cross the roadway under it. Every lamp in this pass has
// real geometry beneath it; none of them floats.
//
// Density follows junction density, which is exactly the gradient we want —
// dense downtown, none in the residential grid where the lamp posts already
// work (the Richmond has no signals at all inside 120u, so this pass leaves
// the district that already reads correctly completely untouched).
//
// This used to live inside the night-windows pass, which painted lit windows
// on the kit buildings; the parcel fabric lights its own windows now and the
// kit buildings are gone, so the luminaires are all that pass was still for.

const SIGNAL_URL = modelUrl("props", PROP_TRAFFICLIGHT);
const MAST_LIT_SHARE = 0.7; // not EVERY corner: four lit poles per junction is a forecourt
const MAST_HEAD_H = 4.9; // top of the 5u mast (world/furniture.ts scaleToHeight)
const MAST_COLOR = 0xffc98a;
const MAST_HALO = 1.5; // near fx/lamp-glow.ts HALO_SIZE; bigger reads as bokeh
const MAST_POOL = 13; // under fx/lamp-glow.ts POOL_SIZE: four pools at a junction must stay
// four pools. At 17 they merged into one wide smear of light across the crossing.
const MAST_POOL_BOOST = 1.9; // the beacon layer's house gain is tuned for deck lanterns
const MAST_GROUND_LIFT = 0.05;

/** Deterministic 0..1 hash of a 2-D key. */
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * One luminaire per signal mast. Batch items are per source MESH, so a single
 * pole arrives as several records at slightly different child transforms —
 * they are grouped on a 2u cell and the group's LOWEST record is the pole's
 * seat on the pavement.
 */
function mastLuminaires(items: readonly BatchItemRec[]): Beacon[] {
  const posts = new Map<string, { x: number; y: number; z: number }>();
  for (const it of items) {
    if (it.url !== SIGNAL_URL) continue;
    const x = it.m[12] ?? 0;
    const y = it.m[13] ?? 0;
    const z = it.m[14] ?? 0;
    const key = `${Math.round(x / 2)}|${Math.round(z / 2)}`;
    const prev = posts.get(key);
    if (!prev) posts.set(key, { x, y, z });
    else if (y < prev.y) posts.set(key, { x, y, z });
  }
  const out: Beacon[] = [];
  for (const p of posts.values()) {
    if (hash2(Math.round(p.x * 0.5) + 13.3, Math.round(p.z * 0.5) - 7.1) > MAST_LIT_SHARE) continue;
    out.push({
      x: p.x,
      y: p.y + MAST_HEAD_H,
      z: p.z,
      color: MAST_COLOR,
      size: MAST_HALO,
      groundY: p.y + MAST_GROUND_LIFT,
      poolSize: MAST_POOL,
      poolBoost: MAST_POOL_BOOST,
    });
  }
  return out;
}

/**
 * Register downtown's mast luminaires with the beacon registry. Call it
 * BEFORE the registry is drained (game-scene attachNightAndLife): the drain
 * is one-shot, and a registration after it lights nothing.
 */
export function registerStreetLuminaires(items: readonly BatchItemRec[]): number {
  const masts = mastLuminaires(items);
  registerBeacons("night-street", masts);
  return masts.length;
}
