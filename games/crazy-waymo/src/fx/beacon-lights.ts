import * as THREE from "three";

import { GlowLayer, HALO_GAIN, POOL_GAIN } from "./glow-layer";

// Night lights for anything that is NOT a street lamp: pier lanterns, dock
// floods, bridge deck strings, the aviation beacons on the tower tops — and,
// through the shared GlowLayer (fx/glow-layer.ts), the headlights and tail
// lights of the traffic fleet (fx/vehicle-lights.ts).
//
// Street lamps ride `city.lampHeads`, which is packed into the baked world bin
// — so adding a field to it (colour, blink) would force a world rebake. The
// waterfront geometry is rebuilt live on every load instead, so its lights get
// this runtime-only registry: a builder calls `registerBeacons` while it builds,
// GameScene drains the registry once the world's streamed tail resolves and
// turns the whole lot into ONE additive instanced draw (plus one for the deck
// pools).
//
// Registration is keyed by source so a rebuild replaces its own entries rather
// than doubling them — the landmark/pier/bridge builders all run again on every
// load, and dev HMR runs them more than that.

export interface Beacon {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Lamp colour; the halo is additive so this reads as the emitted light. */
  readonly color: number;
  /** Halo diameter in world units. */
  readonly size: number;
  /** Seconds per blink cycle. Omit for a steady lamp. */
  readonly blinkS?: number;
  /** Deck/pavement height under the lamp — adds a flat pool of light there. */
  readonly groundY?: number;
  /**
   * Pool diameter, when POOL_SCALE x `size` is the wrong shape for this lamp.
   * A pier lantern is a fat glow over a small patch of deck; a STREET
   * luminaire is the opposite — a small hot head 5 metres up over a pool wide
   * enough to cross the roadway. Tying the two together is what made the
   * first pass of mast luminaires read as floating blobs with no light under
   * them.
   */
  readonly poolSize?: number;
  /**
   * Extra HDR gain on this lamp's POOL only. The layer's house gain is tuned
   * for a lantern on a dark deck; asphalt under a street luminaire is the
   * brightest thing in a night street and has to clear the bloom cut the way
   * fx/lamp-glow.ts POOL_GAIN does.
   */
  readonly poolBoost?: number;
}

const registry = new Map<string, readonly Beacon[]>();

/**
 * Publish (or replace) one builder's night lights. Call it while the world is
 * being generated — GameScene reads the registry once, after the load tail.
 */
export const registerBeacons = (source: string, beacons: readonly Beacon[]): void => {
  registry.set(source, beacons);
};

/** Every registered beacon, flattened. Order follows registration order. */
export const collectBeacons = (): readonly Beacon[] => {
  const all: Beacon[] = [];
  for (const list of registry.values()) {
    all.push(...list);
  }
  return all;
};

const HALO_ALPHA = 0.62;
const POOL_ALPHA = 0.32;
// pool diameter relative to the halo
const POOL_SCALE = 3.2;
// clear of the deck it is drawn on
const POOL_LIFT = 0.06;

/** Blink period in seconds → the shader's angular rate. 0 stays steady. */
export const blinkRate = (blinkS: number | undefined): number =>
  blinkS !== undefined && blinkS > 0 ? (Math.PI * 2) / blinkS : 0;

export class BeaconLights {
  readonly group = new THREE.Group();
  private intensity = { value: 0 };
  private time = { value: 0 };

  constructor(beacons: readonly Beacon[]) {
    if (beacons.length === 0) {
      return;
    }
    const pooled = beacons.filter((b) => b.groundY !== undefined).length;
    const halo = new GlowLayer({
      alpha: HALO_ALPHA,
      capacity: beacons.length,
      gain: HALO_GAIN,
      intensity: this.intensity,
      kind: "halo",
      time: this.time,
    });
    halo.begin();
    const col = new THREE.Color();
    for (const b of beacons) {
      halo.push(b.x, b.y, b.z, col.setHex(b.color), b.size, blinkRate(b.blinkS));
    }
    halo.commit();
    this.group.add(halo.mesh);

    if (pooled > 0) {
      const pool = new GlowLayer({
        alpha: POOL_ALPHA,
        capacity: pooled,
        gain: POOL_GAIN,
        intensity: this.intensity,
        kind: "pool",
        time: this.time,
      });
      pool.begin();
      for (const b of beacons) {
        if (b.groundY === undefined) {
          continue;
        }
        const c = col.setHex(b.color).multiplyScalar(b.poolBoost ?? 1);
        pool.push(
          b.x,
          b.groundY + POOL_LIFT,
          b.z,
          c,
          b.poolSize ?? b.size * POOL_SCALE,
          blinkRate(b.blinkS),
        );
      }
      pool.commit();
      this.group.add(pool.mesh);
    }
    this.group.visible = false;
  }

  setIntensity(night: number): void {
    this.intensity.value = night;
    // no draw at all in daylight
    this.group.visible = night > 0.01;
  }

  update(dt: number): void {
    if (this.group.visible) {
      this.time.value += dt;
    }
  }
}
