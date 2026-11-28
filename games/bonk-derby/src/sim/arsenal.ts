import { CAR_NOSE, DAMAGE_MAX } from "../shared/constants";
import { edgeDistance } from "./arena";
import { carScale } from "./car";
import type { Car, Hit, HitHow } from "./car";
import { blow, nextId } from "./field";
import type { Body, Field } from "./field";
import { KINDS } from "./kinds";
import { makeShot, moveShot, shotLife } from "./shots";
import type { Shot, ShotKind } from "./shots";
import {
  MAGNET_DAMAGE,
  MAGNET_RADIUS,
  MAGNET_STOP,
  MINE_ARM,
  MINE_BLAST,
  MINE_DAMAGE,
  MINE_THROW,
  MINE_TRIGGER,
  OIL_DAMAGE,
  OIL_RADIUS,
  OIL_SLIP,
  ROCKET_BLAST,
  ROCKET_DAMAGE,
  ROCKET_THROW,
  SEEKER_DAMAGE,
  SEEKER_THROW,
  SHOCK_DAMAGE,
  SHOCK_RADIUS,
  SHOCK_THROW,
  STOMP_DAMAGE,
  STOMP_RADIUS,
  STOMP_THROW,
  ZAP_DAMAGE,
  ZAP_RADIUS,
  ZAP_STUN,
} from "./specials";
import type { SpecialKind } from "./specials";

const open = (body: Body, by: string) => body.key !== by && body.alive && !body.safe;

const nearest = (all: readonly Body[], by: string, x: number, z: number, reach: number) => {
  let best: Body | null = null;
  let bestGap = reach;

  for (const body of all) {
    const gap = Math.hypot(body.x - x, body.z - z);

    if (open(body, by) && gap < bestGap) {
      bestGap = gap;
      best = body;
    }
  }

  return best;
};

const preyOf = (car: Car, all: readonly Body[]) => {
  const cos = Math.cos(car.a);
  const sin = Math.sin(car.a);
  let best: Body | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const body of all) {
    const gap = Math.hypot(body.x - car.x, body.z - car.z) || 1;
    const ahead = ((body.x - car.x) * cos + (body.z - car.z) * sin) / gap;
    const score = gap * (ahead > 0.2 ? 1 : 3);

    if (open(body, car.key) && gap < 45 && score < bestScore) {
      bestScore = score;
      best = body;
    }
  }

  return best?.key ?? "";
};

/** Let a shot go from `car`: out of the nose, or dropped behind the tail. */
export const spawnShot = (field: Field, car: Car, kind: ShotKind, all: readonly Body[]) => {
  const behind = kind === "mine" || kind === "oil";
  const off = (behind ? -(CAR_NOSE + 1.7) : CAR_NOSE + 0.7) * carScale(car);

  const shot = makeShot(
    nextId(field, car.key),
    kind,
    car.key,
    {
      a: car.a,
      t: field.time,
      x: car.x + Math.cos(car.a) * off,
      z: car.z + Math.sin(car.a) * off,
    },
    true,
  );

  shot.power = KINDS[car.kind].power;
  shot.target = kind === "seeker" ? preyOf(car, all) : "";
  field.shots.push(shot);

  return shot;
};

interface Blast {
  x: number;
  z: number;
  by: string;
  how: HitHow;
  radius: number;
  reach: number;
  damage: number;
  stun: number;
  spare: string;
}

const blast = (field: Field, all: readonly Body[], spec: Blast) => {
  for (const body of all) {
    const dx = body.x - spec.x;
    const dz = body.z - spec.z;
    const gap = Math.hypot(dx, dz);
    const inside = gap < spec.radius + body.radius * 0.5 && body.y < 2.2;

    if (open(body, spec.by) && body.key !== spec.spare && inside) {
      blow(field, body, {
        by: spec.by,
        damage: spec.damage,
        dx: gap > 0.001 ? dx / gap : 1,
        dz: gap > 0.001 ? dz / gap : 0,
        how: spec.how,
        id: nextId(field, spec.by),
        lift: 1,
        reach: spec.reach * (1 - 0.4 * Math.min(1, gap / spec.radius)),
        stun: spec.stun,
      });
    }
  }
};

const magnet = (field: Field, car: Car, all: readonly Body[]) => {
  const tx = car.x + Math.cos(car.a) * MAGNET_STOP;
  const tz = car.z + Math.sin(car.a) * MAGNET_STOP;

  for (const body of all) {
    const far = Math.hypot(body.x - car.x, body.z - car.z);
    const dx = tx - body.x;
    const dz = tz - body.z;
    const gap = Math.hypot(dx, dz);

    if (open(body, car.key) && far < MAGNET_RADIUS && gap > 1) {
      blow(field, body, {
        by: car.key,
        damage: MAGNET_DAMAGE,
        dx: dx / gap,
        dz: dz / gap,
        how: "magnet",
        id: nextId(field, car.key),
        lift: 0.7,
        reach: gap,
        stun: 0,
      });
    }
  }
};

/** What a special does to the board the moment it is used. The car's own change is already made. */
export const fire = (field: Field, car: Car, special: SpecialKind, all: readonly Body[]) => {
  field.events.push({ key: car.key, kind: "use", special });
  const here = { by: car.key, spare: "", x: car.x, z: car.z };

  if (special === "rocket" || special === "seeker" || special === "mine" || special === "oil") {
    spawnShot(field, car, special, all);
  } else if (special === "shock") {
    blast(field, all, {
      ...here,
      damage: SHOCK_DAMAGE,
      how: "shock",
      radius: SHOCK_RADIUS,
      reach: SHOCK_THROW,
      stun: 0,
    });
  } else if (special === "zap") {
    blast(field, all, {
      ...here,
      damage: ZAP_DAMAGE,
      how: "zap",
      radius: ZAP_RADIUS,
      reach: 0,
      stun: ZAP_STUN,
    });
  } else if (special === "magnet") {
    magnet(field, car, all);
  }
};

/** A car coming down off a spring: everyone under it is thrown clear. */
export const stomp = (field: Field, car: Car, all: readonly Body[]) => {
  blast(field, all, {
    by: car.key,
    damage: STOMP_DAMAGE,
    how: "stomp",
    radius: STOMP_RADIUS,
    reach: STOMP_THROW,
    spare: "",
    stun: 0,
    x: car.x,
    z: car.z,
  });
};

const end = (field: Field, shot: Shot, burst: boolean) => {
  shot.dead = true;
  field.events.push({ burst, kind: "pop", shot });
};

const direct = (shot: Shot, body: Body, how: HitHow, reach: number, damage: number, id: string) => {
  const gap = Math.hypot(body.x - shot.x, body.z - shot.z) || 1;
  const dx = Math.cos(shot.a) * 0.8 + ((body.x - shot.x) / gap) * 0.2;
  const dz = Math.sin(shot.a) * 0.8 + ((body.z - shot.z) / gap) * 0.2;
  const length = Math.hypot(dx, dz) || 1;

  return {
    by: shot.by,
    damage,
    dx: dx / length,
    dz: dz / length,
    how,
    id,
    lift: 1,
    reach,
    stun: 0,
  } satisfies Hit;
};

interface Spot {
  x: number;
  z: number;
}

const touching = (shot: Shot, all: readonly Body[], reach: number, from: Spot) => {
  const sx = shot.x - from.x;
  const sz = shot.z - from.z;
  const span = sx * sx + sz * sz;
  let best: Body | null = null;
  let first = 2;

  for (const body of all) {
    const along = ((body.x - from.x) * sx + (body.z - from.z) * sz) / (span || 1);
    const part = span > 0 ? Math.min(1, Math.max(0, along)) : 1;
    const gap = Math.hypot(body.x - from.x - sx * part, body.z - from.z - sz * part);

    if (open(body, shot.by) && body.y < 2.2 && gap < body.radius + reach && part < first) {
      first = part;
      best = body;
    }
  }

  if (best) {
    shot.x = from.x + sx * first;
    shot.z = from.z + sz * first;
  }

  return best;
};

const strike = (field: Field, shot: Shot, all: readonly Body[], age: number, from: Spot) => {
  if (shot.kind === "mine") {
    if (age > MINE_ARM && touching(shot, all, MINE_TRIGGER - 1.2, shot)) {
      blast(field, all, {
        by: shot.by,
        damage: MINE_DAMAGE,
        how: "mine",
        radius: MINE_BLAST,
        reach: MINE_THROW,
        spare: "",
        stun: 0,
        x: shot.x,
        z: shot.z,
      });
      end(field, shot, true);
    }

    return;
  }

  const reach = shot.kind === "puck" ? 0.55 : 0.7;
  const body = shot.kind === "oil" ? null : touching(shot, all, reach, from);

  if (!body) {
    return;
  }

  const id = nextId(field, shot.by);

  if (shot.kind === "puck") {
    const { damage } = KINDS.popper;
    blow(field, body, direct(shot, body, "shot", KINDS.popper.throw * shot.power, damage, id));
  } else if (shot.kind === "seeker") {
    blow(field, body, direct(shot, body, "seeker", SEEKER_THROW, SEEKER_DAMAGE, id));
  } else {
    blow(field, body, direct(shot, body, "rocket", ROCKET_THROW, ROCKET_DAMAGE, id));
    blast(field, all, {
      by: shot.by,
      damage: ROCKET_DAMAGE * 0.6,
      how: "rocket",
      radius: ROCKET_BLAST,
      reach: ROCKET_THROW * 0.7,
      spare: body.key,
      stun: 0,
      x: shot.x,
      z: shot.z,
    });
  }

  end(field, shot, true);
};

const slicks = (field: Field) => {
  for (const car of field.cars.values()) {
    const ready = car.mode === "drive" && car.y < 0.3 && car.safe <= 0 && car.slip <= 0;

    for (const shot of ready ? field.shots : []) {
      const age = field.time - shot.t0;
      const lock = `oil:${shot.id}`;
      const on = Math.hypot(car.x - shot.x, car.z - shot.z) < OIL_RADIUS + 0.3;
      const live = shot.kind === "oil" && !shot.dead && shot.by !== car.key && age > 0.2;

      if (live && on && !car.locks.has(lock)) {
        car.slip = OIL_SLIP;
        car.boosting = false;
        car.damage = Math.min(DAMAGE_MAX, car.damage + OIL_DAMAGE);
        car.hitHow = "oil";
        car.lastBy = shot.by;
        car.lastByT = 0;
        car.locks.set(lock, 2.5);
        field.events.push({ key: car.key, kind: "slip" });
      }
    }
  }
};

/**
 * Move everything let go on the board, and settle what this client's own shots
 * hit along the way they came. Somebody else's shot only moves here: its owner
 * says what it did.
 */
export const stepShots = (field: Field, all: readonly Body[], late: boolean, dt: number) => {
  for (const shot of field.shots) {
    const prey =
      shot.kind === "seeker"
        ? (all.find((body) => body.key === shot.target && body.alive) ?? null)
        : null;

    const from = { x: shot.x, z: shot.z };
    const age = moveShot(shot, field.time, dt, prey);
    const life = shotLife(shot.kind);

    const laid = shot.kind === "mine" || shot.kind === "oil";
    const gone = laid && late && edgeDistance(field.arena, shot.x, shot.z, true) < 0;

    if (!shot.own) {
      shot.dead ||= age > life + 1;
    } else if (gone) {
      end(field, shot, false);
    } else if (age >= life) {
      end(field, shot, shot.kind === "rocket");
    } else {
      if (shot.kind === "seeker" && !prey) {
        shot.target = nearest(all, shot.by, shot.x, shot.z, 40)?.key ?? "";
      }

      strike(field, shot, all, age, from);
    }
  }

  slicks(field);

  for (let i = field.shots.length - 1; i >= 0; i -= 1) {
    if (field.shots[i]?.dead === true) {
      field.shots.splice(i, 1);
    }
  }
};
