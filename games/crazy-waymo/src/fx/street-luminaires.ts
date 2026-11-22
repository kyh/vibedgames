import { modelUrl, PROP_TRAFFICLIGHT } from "../assets/manifest";
import type { BatchItemRec } from "../world/city";
import { registerBeacons } from "./beacon-lights";
import type { Beacon } from "./beacon-lights";

const SIGNAL_URL = modelUrl("props", PROP_TRAFFICLIGHT);
const MAST_LIT_SHARE = 0.7;
const MAST_HEAD_H = 4.9;
const MAST_COLOR = 0xff_c9_8a;
const MAST_HALO = 1.5;
const MAST_POOL = 13;
const MAST_POOL_BOOST = 1.9;
const MAST_GROUND_LIFT = 0.05;

const hash2 = (x: number, z: number) => {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43_758.5453;

  return s - Math.floor(s);
};

const mastLuminaires = (items: readonly BatchItemRec[]) => {
  const posts = new Map<string, { x: number; y: number; z: number }>();

  for (const it of items) {
    if (it.url !== SIGNAL_URL) {
      continue;
    }

    const x = it.m[12] ?? 0;
    const y = it.m[13] ?? 0;
    const z = it.m[14] ?? 0;
    const key = `${Math.round(x / 2)}|${Math.round(z / 2)}`;
    const prev = posts.get(key);

    if (!prev) {
      posts.set(key, { x, y, z });
    } else if (y < prev.y) {
      posts.set(key, { x, y, z });
    }
  }

  const out: Beacon[] = [];

  for (const p of posts.values()) {
    if (hash2(Math.round(p.x * 0.5) + 13.3, Math.round(p.z * 0.5) - 7.1) > MAST_LIT_SHARE) {
      continue;
    }

    out.push({
      color: MAST_COLOR,
      groundY: p.y + MAST_GROUND_LIFT,
      poolBoost: MAST_POOL_BOOST,
      poolSize: MAST_POOL,
      size: MAST_HALO,
      x: p.x,
      y: p.y + MAST_HEAD_H,
      z: p.z,
    });
  }

  return out;
};

/**
 * Register downtown's mast luminaires with the beacon registry. Call it
 * BEFORE the registry is drained (game-scene attachNightAndLife): the drain
 * is one-shot, and a registration after it lights nothing.
 */
export const registerStreetLuminaires = (items: readonly BatchItemRec[]) => {
  const masts = mastLuminaires(items);
  registerBeacons("night-street", masts);

  return masts.length;
};
