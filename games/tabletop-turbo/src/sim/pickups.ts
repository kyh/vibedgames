import {
  BLOT_ARM,
  BLOT_RADIUS,
  BLOT_SECONDS,
  BOX_RESPAWN,
  ITEM_KINDS,
  ORB_RESPAWN,
  PICKUP_RADIUS,
} from "../shared/constants";
import type { ItemKind } from "../shared/constants";
import { pointAt } from "./track";
import type { Track } from "./track";

/** An orb or an item box: where it sits, and when it is next there to take. */
export interface Spot {
  x: number;
  z: number;
  /** Seconds (scene clock) until which it is gone; 0 when present. */
  until: number;
}

/** A puddle dropped behind a kart. */
export interface Blot {
  id: number;
  x: number;
  z: number;
  /** Racer key of whoever dropped it. */
  by: string;
  /** Scene clock when it starts to bite, and when it dries up. */
  armAt: number;
  until: number;
}

/** A kart, as far as pickups care. */
export interface Toucher {
  key: string;
  x: number;
  z: number;
  /** Already holding an item: boxes stay where they are for the next kart. */
  holding?: boolean;
}

/** What one kart drove over this frame. */
export interface Gains {
  orbs: number;
  box: boolean;
  blot: boolean;
}

const BOX_ROWS = [0.09, 0.34, 0.6, 0.86] as const;
const BOX_LANES = [-0.62, -0.21, 0.21, 0.62] as const;
const ORB_GROUPS = 13;
const ORB_LANES = [-0.5, 0, 0.5, 0.25, -0.25] as const;

const near = (spot: { x: number; z: number }, kart: Toucher, radius: number) =>
  (spot.x - kart.x) ** 2 + (spot.z - kart.z) ** 2 <= radius * radius;

export class Field {
  readonly orbs: Spot[] = [];
  readonly boxes: Spot[] = [];
  blots: Blot[] = [];

  constructor(track: Track) {
    for (let group = 0; group < ORB_GROUPS; group += 1) {
      const start = (0.06 + ((group + 0.5) / ORB_GROUPS) * 0.9) * track.n;
      const lane = (ORB_LANES[group % ORB_LANES.length] ?? 0) * track.halfWidth;

      for (let i = 0; i < 5; i += 1) {
        const p = pointAt(track, start + i * 2.6, lane);
        this.orbs.push({ until: 0, x: p.x, z: p.z });
      }
    }

    for (const row of BOX_ROWS) {
      for (const lane of BOX_LANES) {
        const p = pointAt(track, row * track.n, lane * track.halfWidth);
        this.boxes.push({ until: 0, x: p.x, z: p.z });
      }
    }
  }

  /**
   * One pass over every kart on the road: whatever a kart touches is taken,
   * whoever's kart it is, so every client hides the same things. The caller
   * rewards only the karts it simulates.
   */
  touch(karts: readonly Toucher[], time: number) {
    const gains = new Map<string, Gains>();

    const of = (key: string) => {
      let entry = gains.get(key);

      if (!entry) {
        entry = { blot: false, box: false, orbs: 0 };
        gains.set(key, entry);
      }

      return entry;
    };

    for (const kart of karts) {
      for (const orb of this.orbs) {
        if (time >= orb.until && near(orb, kart, PICKUP_RADIUS)) {
          orb.until = time + ORB_RESPAWN;
          of(kart.key).orbs += 1;
        }
      }

      for (const box of this.boxes) {
        if (!kart.holding && time >= box.until && near(box, kart, PICKUP_RADIUS)) {
          box.until = time + BOX_RESPAWN;
          of(kart.key).box = true;
        }
      }

      for (const blot of this.blots) {
        const live = time >= blot.armAt || blot.by !== kart.key;

        if (live && near(blot, kart, BLOT_RADIUS)) {
          blot.until = 0;
          of(kart.key).blot = true;
        }
      }
    }

    this.blots = this.blots.filter((blot) => blot.until > time);

    return gains;
  }

  dropBlot(id: number, by: string, x: number, z: number, time: number) {
    if (!this.blots.some((blot) => blot.id === id)) {
      this.blots.push({ armAt: time + BLOT_ARM, by, id, until: time + BLOT_SECONDS, x, z });
    }
  }
}

/**
 * Which item a box gives. `share` is 0 for the leader and 1 for last place:
 * the front of the field gets things to defend with, the back gets things to
 * catch up with.
 */
export const rollItem: (share: number, roll: number) => ItemKind = (share, roll) => {
  const k = Math.min(1, Math.max(0, share));

  const weights: Record<ItemKind, number> = {
    blot: 0.5 - 0.44 * k,
    bomb: 0.16 + 0.2 * k,
    solvent: 0.29 - 0.13 * k,
    turbo: 0.05 + 0.37 * k,
  };

  let pick = roll * ITEM_KINDS.reduce((sum, kind) => sum + weights[kind], 0);

  for (const kind of ITEM_KINDS) {
    pick -= weights[kind];

    if (pick <= 0) {
      return kind;
    }
  }

  return "turbo";
};
