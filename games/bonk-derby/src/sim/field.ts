import type { Arena } from "./arena";
import { BLOCKED, carRadius, clash, canHit, takeHit, wouldClash } from "./car";
import type { Car, Hit } from "./car";
import type { Shot } from "./shots";
import type { SpecialKind } from "./specials";

/** A car somebody else simulates: all this client knows is where it is. */
export interface Ghost {
  key: string;
  x: number;
  y: number;
  z: number;
  a: number;
  vx: number;
  vz: number;
  radius: number;
  /** On the board and able to be hit. */
  alive: boolean;
  safe: boolean;
  boosting: boolean;
}

/**
 * What a step did. `hit` landed on a car simulated here and throws it `reach`;
 * `send` is a blow on somebody else's car, theirs to accept and ours to send.
 */
export type FieldEvent =
  | { kind: "hit"; to: string; hit: Hit; reach: number; x: number; z: number }
  | { kind: "send"; to: string; hit: Hit; x: number; z: number }
  | { kind: "block"; key: string; x: number; z: number }
  | { kind: "clash"; a: string; b: string; x: number; z: number; remote: boolean }
  | { kind: "attack"; key: string }
  | { kind: "whiff"; key: string }
  | { kind: "land"; key: string; drop: boolean }
  | { kind: "fall"; key: string }
  | { kind: "out"; key: string; by: string }
  | { kind: "reach"; key: string; cube: number }
  | { kind: "use"; key: string; special: SpecialKind }
  | { kind: "slip"; key: string }
  | { kind: "pop"; shot: Shot; burst: boolean };

export interface Field {
  arena: Arena;
  round: number;
  /** Seconds into the round: negative under the countdown. */
  time: number;
  /** The round time the last step ran at: a step sweeps from there to `time`. */
  stepped: number;
  /** Cars simulated here: this player's, and the bots' on the host. */
  cars: Map<string, Car>;
  ghosts: Map<string, Ghost>;
  /** Everything let go on the board: this client's own, and what it has heard of. */
  shots: Shot[];
  /** Cubes of this round already taken. */
  taken: Set<number>;
  events: FieldEvent[];
  seq: number;
}

export const makeField: (arena: Arena) => Field = (arena) => ({
  arena,
  cars: new Map<string, Car>(),
  events: [],
  ghosts: new Map<string, Ghost>(),
  round: 0,
  seq: 0,
  shots: [],
  stepped: 0,
  taken: new Set<number>(),
  time: 0,
});

/** Anything a blow can land on: a car simulated here (`car` set) or a ghost. */
export interface Body {
  key: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  radius: number;
  alive: boolean;
  safe: boolean;
  car: Car | null;
}

export const bodies = (field: Field) => {
  const out: Body[] = [];

  for (const car of field.cars.values()) {
    out.push({
      alive: car.mode === "drive",
      car,
      key: car.key,
      radius: carRadius(car),
      safe: car.safe > 0,
      vx: car.vx,
      vz: car.vz,
      x: car.x,
      y: car.y,
      z: car.z,
    });
  }

  for (const ghost of field.ghosts.values()) {
    if (!field.cars.has(ghost.key)) {
      out.push({ ...ghost, car: null });
    }
  }

  return out;
};

/** An id no other blow or shot in the room shares. */
export const nextId = (field: Field, by: string) => {
  field.seq += 1;

  return `${by}:${field.round}:${field.seq}`;
};

/** Deliver a blow to a car simulated here. True if it landed. */
export const deliver = (field: Field, car: Car, hit: Hit) => {
  const attacker = field.cars.get(hit.by);

  if (canHit(car, hit) && wouldClash(car, hit)) {
    clash(car, hit.dx, hit.dz);
    car.hitId = hit.id;

    if (attacker) {
      clash(attacker, -hit.dx, -hit.dz);
    }

    field.events.push({
      a: hit.by,
      b: car.key,
      kind: "clash",
      remote: !attacker,
      x: (car.x + (attacker?.x ?? car.x - hit.dx * 3)) / 2,
      z: (car.z + (attacker?.z ?? car.z - hit.dz * 3)) / 2,
    });

    return false;
  }

  const reach = takeHit(car, hit);

  if (reach === BLOCKED) {
    field.events.push({ key: car.key, kind: "block", x: car.x, z: car.z });
  }

  if (reach < 0) {
    return false;
  }

  field.events.push({ hit, kind: "hit", reach, to: car.key, x: car.x, z: car.z });

  return true;
};

/**
 * Land a blow on any body: delivered if its car is simulated here, sent to its
 * owner if not. True if it landed, as far as this client can tell.
 */
export const blow = (field: Field, body: Body, hit: Hit) => {
  if (body.car) {
    return deliver(field, body.car, hit);
  }

  field.events.push({ hit, kind: "send", to: body.key, x: body.x, z: body.z });

  return true;
};
