import type {
  Asteroid,
  Beam,
  Item,
  Point,
  Ship,
  Splinter,
  UFO,
  Weapon,
} from "./types";
import {
  ASTEROID_MAX_SIZE,
  ASTEROID_MIN_SIZE,
  ASTEROID_VERTEX_COUNT,
  ITEM_LIFETIME,
  ITEM_SPEED,
  SHIP_ANGLES_DEG,
  SHIP_SIZE,
  SHIP_SPEED,
  UFO_HP,
  UFO_SIZE,
  UFO_SPEED,
  WEAPON_DEFAULT,
  WEAPONS_SPECIAL,
  WORLD_HEIGHT,
  WORLD_WIDTH,
} from "./constants";
import {
  DEG_TO_RAD,
  PI,
  TWO_PI,
  add,
  angle,
  clampPoint,
  inWorld,
  length,
  normalize,
  polar,
  randInt,
  randUniform,
  sub,
} from "./math";

// ---------------------------------------------------------------------------
// Ship
// ---------------------------------------------------------------------------

export function createShip(x: number, y: number): Ship {
  const position = { x, y };
  const path: Point[] = [];
  const referencePath: Point[] = [];

  for (const deg of SHIP_ANGLES_DEG) {
    const ang = DEG_TO_RAD * deg;
    const r = deg === 180 ? SHIP_SIZE / 2 : SHIP_SIZE;
    const p = add(position, polar(r, ang));
    path.push({ ...p });
    referencePath.push({ ...p });
  }

  return {
    position,
    angle: 0,
    size: SHIP_SIZE,
    path,
    referencePath,
    alive: true,
    invulnerable: false,
    invulnerableUntil: 0,
    respawnAt: 0,
  };
}

export function updateShip(ship: Ship, target: Point): Ship {
  const v = sub(target, ship.position);
  const vlen = length(v);
  const newAngle = angle(v);
  const velocity = vlen > SHIP_SPEED ? normalize(v, SHIP_SPEED) : v;

  let newPosition = ship.position;
  if (vlen > ship.size + 10) {
    const raw = add(ship.position, velocity);
    newPosition = clampPoint(raw);
  }

  // Rotate path points
  const cos = Math.cos(newAngle);
  const sin = Math.sin(newAngle);
  const newPath = ship.referencePath.map((rp) => {
    const dx = rp.x - ship.position.x;
    const dy = rp.y - ship.position.y;
    return {
      x: newPosition.x + dx * cos - dy * sin,
      y: newPosition.y + dx * sin + dy * cos,
    };
  });

  // Move reference path by delta
  const delta = sub(newPosition, ship.position);
  const newRefPath = ship.referencePath.map((rp) => add(rp, delta));

  return {
    ...ship,
    position: newPosition,
    angle: newAngle,
    path: newPath,
    referencePath: newRefPath,
  };
}

export function drawShip(
  ctx: CanvasRenderingContext2D,
  path: Point[],
  color: string,
  alpha = 1,
) {
  if (path.length === 0) return;
  ctx.beginPath();
  ctx.strokeStyle = color;
  ctx.globalAlpha = alpha;
  ctx.lineWidth = 1;
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(path[i].x, path[i].y);
  }
  ctx.lineTo(path[0].x, path[0].y);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Asteroid
// ---------------------------------------------------------------------------

function makeAsteroidVertices(radius: number): Point[] {
  const verts: Point[] = [];
  for (let i = 0; i < ASTEROID_VERTEX_COUNT; i++) {
    const r = randUniform(radius, radius * 0.5);
    const a = (TWO_PI * i) / ASTEROID_VERTEX_COUNT;
    verts.push(polar(r, a));
  }
  return verts;
}

export function createAsteroid(
  x: number,
  y: number,
  radius: number,
  ang: number,
): Asteroid {
  const speed = (1 - radius / ASTEROID_MAX_SIZE) * 1.75 + 0.25;
  return {
    id: crypto.randomUUID(),
    position: { x, y },
    velocity: polar(speed, ang),
    radius,
    vertices: makeAsteroidVertices(radius),
    rotation: 0,
  };
}

export function spawnAsteroid(): Asteroid {
  const side = randInt(3);
  let x: number, y: number;
  let ang = randUniform(PI * 0.5);

  if (side <= 1) {
    y = randUniform(WORLD_HEIGHT + ASTEROID_MAX_SIZE, -ASTEROID_MAX_SIZE);
    x = side === 0 ? -ASTEROID_MAX_SIZE : WORLD_WIDTH + ASTEROID_MAX_SIZE;
    ang = side === 0 ? ang - PI * 0.25 : ang + PI * 0.75;
  } else {
    x = randUniform(WORLD_WIDTH + ASTEROID_MAX_SIZE, -ASTEROID_MAX_SIZE);
    y = side === 2 ? -ASTEROID_MAX_SIZE : WORLD_HEIGHT + ASTEROID_MAX_SIZE;
    ang = side === 2 ? ang + PI * 0.25 : ang - PI * 0.75;
  }

  const radius = randUniform(ASTEROID_MAX_SIZE, ASTEROID_MIN_SIZE);
  return createAsteroid(x, y, radius, ang);
}

export function updateAsteroid(a: Asteroid): Asteroid & { outOfBounds: boolean } {
  const newPos = add(a.position, a.velocity);
  return {
    ...a,
    position: newPos,
    rotation: a.rotation + 0.005,
    outOfBounds: !inWorld(newPos, ASTEROID_MAX_SIZE + 20),
  };
}

/**
 * Damage an asteroid. Returns updated asteroid (or null if destroyed)
 * plus child asteroids from splitting.
 */
export function damageAsteroid(
  a: Asteroid,
  damage: number,
): { asteroid: Asteroid | null; children: Asteroid[] } {
  const newRadius = a.radius - ASTEROID_MAX_SIZE * Math.min(damage, 1);

  if (newRadius < ASTEROID_MIN_SIZE) {
    return { asteroid: null, children: [] };
  }

  const newAngle = angle(a.velocity) + DEG_TO_RAD * randUniform(30, -30);
  const updated = createAsteroid(a.position.x, a.position.y, newRadius, newAngle);
  updated.id = a.id; // keep same ID

  return { asteroid: updated, children: [] };
}

export function drawAsteroid(ctx: CanvasRenderingContext2D, a: Asteroid) {
  const cos = Math.cos(a.rotation);
  const sin = Math.sin(a.rotation);

  ctx.beginPath();
  for (let i = 0; i < a.vertices.length; i++) {
    const v = a.vertices[i];
    const rx = v.x * cos - v.y * sin;
    const ry = v.x * sin + v.y * cos;
    const px = a.position.x + rx;
    const py = a.position.y + ry;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Beam
// ---------------------------------------------------------------------------

let beamCounter = 0;

export function createBeam(
  ship: Ship,
  weapon: Weapon,
  playerId: string,
): Beam {
  const nose = add(ship.position, polar(ship.size, ship.angle));
  return {
    id: `beam-${playerId}-${beamCounter++}`,
    head: { ...nose },
    tail: { ...nose },
    angle: ship.angle,
    speed: weapon.speed,
    weapon,
    released: false,
    exploding: false,
    explosionRadius: 0,
    explosionMaxRadius: weapon.explosion ? weapon.explosion.range : 0,
    explosionSpeed: weapon.explosion ? weapon.explosion.speed : 0,
    vanished: false,
    playerId,
  };
}

export function updateBeam(b: Beam): Beam {
  if (b.vanished) return b;

  if (b.exploding) {
    const newRadius = b.explosionRadius + b.explosionSpeed * 2;
    if (newRadius >= b.explosionMaxRadius) {
      return { ...b, vanished: true };
    }
    return { ...b, explosionRadius: newRadius };
  }

  const v = polar(b.speed, b.angle);
  const newHead = add(b.head, v);

  // Check if out of world bounds (with generous margin)
  const margin = 200;
  if (
    newHead.x < -margin || newHead.x > WORLD_WIDTH + margin ||
    newHead.y < -margin || newHead.y > WORLD_HEIGHT + margin
  ) {
    return { ...b, vanished: true };
  }

  let newTail = b.tail;
  let released = b.released;

  if (released) {
    newTail = add(b.tail, v);
  } else {
    const dist = length(sub(newHead, b.tail));
    if (dist > b.weapon.length) {
      released = true;
      newTail = add(newHead, polar(b.weapon.length, b.angle - PI));
    }
  }

  return { ...b, head: newHead, tail: newTail, released, vanished: false };
}

export function beamHit(b: Beam): Beam {
  if (b.weapon.explosion && !b.exploding) {
    return {
      ...b,
      exploding: true,
      explosionRadius: 0,
    };
  }
  if (b.weapon.through) return b;
  return { ...b, vanished: true };
}

export function drawBeam(ctx: CanvasRenderingContext2D, b: Beam) {
  if (b.vanished) return;

  if (b.exploding) {
    ctx.beginPath();
    ctx.strokeStyle = b.weapon.color;
    ctx.lineWidth = 1;
    ctx.arc(b.head.x, b.head.y, b.explosionRadius, 0, TWO_PI);
    ctx.stroke();
    return;
  }

  ctx.beginPath();
  ctx.strokeStyle = b.weapon.color;
  ctx.lineWidth = b.weapon.width;
  ctx.moveTo(b.tail.x, b.tail.y);
  ctx.lineTo(b.head.x, b.head.y);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// UFO
// ---------------------------------------------------------------------------

export function createUFO(): UFO {
  const side = randInt(3);
  let x: number, y: number;

  if (side <= 1) {
    y = randUniform(WORLD_HEIGHT + 30, -30);
    x = side === 0 ? -30 : WORLD_WIDTH + 30;
  } else {
    x = randUniform(WORLD_WIDTH + 30, -30);
    y = side === 2 ? -30 : WORLD_HEIGHT + 30;
  }

  const pos = { x, y };
  const dest = { x: randUniform(WORLD_WIDTH), y: randUniform(WORLD_HEIGHT) };
  const path = buildUFOPath(pos);

  return {
    id: crypto.randomUUID(),
    position: pos,
    velocity: { x: 0, y: 0 },
    destination: dest,
    path,
    hp: UFO_HP,
    damageBlink: 0,
  };
}

function buildUFOPath(p: Point): Point[] {
  return [
    { x: p.x - 4.5, y: p.y - 5 },
    { x: p.x + 4.5, y: p.y - 5 },
    { x: p.x + 7, y: p.y },
    { x: p.x + UFO_SIZE, y: p.y + 4.5 },
    { x: p.x + 7, y: p.y + 9 },
    { x: p.x - 7, y: p.y + 9 },
    { x: p.x - UFO_SIZE, y: p.y + 4.5 },
    { x: p.x - 7, y: p.y },
  ];
}

export function updateUFO(u: UFO): UFO {
  const v = sub(u.destination, u.position);
  const dist = length(v);
  let vel: Point;
  let dest = u.destination;

  if (dist > UFO_SPEED) {
    vel = normalize(v, UFO_SPEED);
  } else if (dist < 0.1) {
    dest = { x: randUniform(WORLD_WIDTH), y: randUniform(WORLD_HEIGHT) };
    vel = normalize(sub(dest, u.position), UFO_SPEED);
  } else {
    vel = v;
  }

  const newPos = add(u.position, vel);
  const newPath = buildUFOPath(newPos);
  const blink = Math.max(0, u.damageBlink - 1);

  return {
    ...u,
    position: newPos,
    velocity: vel,
    destination: dest,
    path: newPath,
    damageBlink: blink,
  };
}

export function damageUFO(u: UFO, damage: number): UFO {
  return {
    ...u,
    hp: u.hp - damage * 100,
    damageBlink: 40,
  };
}

export function drawUFO(ctx: CanvasRenderingContext2D, u: UFO) {
  if (u.damageBlink > 0 && u.damageBlink % 4 === 0) return;

  ctx.beginPath();
  const p = u.path;
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.lineTo(p[0].x, p[0].y);

  // Cross lines
  ctx.moveTo(p[2].x, p[2].y);
  ctx.lineTo(p[7].x, p[7].y);
  ctx.moveTo(p[3].x, p[3].y);
  ctx.lineTo(p[6].x, p[6].y);
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Item
// ---------------------------------------------------------------------------

export function createItem(x: number, y: number): Item {
  const weapon = WEAPONS_SPECIAL[randInt(WEAPONS_SPECIAL.length - 1)];
  const vel = polar(ITEM_SPEED, randUniform(TWO_PI));
  const pos = { x, y };
  const path: Point[] = [];
  const d = TWO_PI / 6;
  for (let i = 0; i < 6; i++) {
    path.push(add(pos, polar(10, d * i)));
  }

  return {
    id: crypto.randomUUID(),
    position: pos,
    velocity: vel,
    weapon,
    path,
    lifetime: ITEM_LIFETIME,
  };
}

export function updateItem(item: Item): Item {
  const newPos = add(item.position, item.velocity);
  const d = TWO_PI / 6;
  const path = Array.from({ length: 6 }, (_, i) =>
    add(newPos, polar(10, d * i)),
  );

  return {
    ...item,
    position: newPos,
    path,
    lifetime: item.lifetime - 1,
  };
}

export function drawItem(ctx: CanvasRenderingContext2D, item: Item) {
  ctx.beginPath();
  ctx.strokeStyle = item.weapon.color;
  ctx.lineWidth = 1;

  const p = item.path;
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.lineTo(p[0].x, p[0].y);

  // Inner cross lines
  for (let i = 0; i < 3; i++) {
    ctx.moveTo(p[i].x, p[i].y);
    ctx.lineTo(p[i + 3].x, p[i + 3].y);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------
// Splinter (explosion particles)
// ---------------------------------------------------------------------------

export function createSplinter(
  x: number,
  y: number,
  radius: number,
  num: number,
): Splinter {
  const particles = Array.from({ length: num }, () => ({
    x,
    y,
    angle: randUniform(TWO_PI),
    radius: randUniform(radius),
    speed: Math.random(),
  }));

  return { particles, origin: { x, y }, createdAt: Date.now() };
}

export function updateSplinter(s: Splinter): Splinter {
  const particles = s.particles
    .map((p) => ({
      ...p,
      x: s.origin.x + p.radius * Math.cos(p.angle),
      y: s.origin.y + p.radius * Math.sin(p.angle),
      radius: p.radius + p.speed,
    }))
    .filter(
      (p) =>
        p.x >= -10 && p.x <= WORLD_WIDTH + 10 &&
        p.y >= -10 && p.y <= WORLD_HEIGHT + 10,
    );

  return { ...s, particles };
}

export function isSplinterDone(s: Splinter): boolean {
  return s.particles.length === 0 || Date.now() - s.createdAt > 7000;
}

export function drawSplinters(
  ctx: CanvasRenderingContext2D,
  splinters: Splinter[],
) {
  ctx.beginPath();
  ctx.fillStyle = "rgb(255, 255, 255)";
  for (const s of splinters) {
    for (const p of s.particles) {
      ctx.rect(p.x, p.y, 1, 1);
    }
  }
  ctx.fill();
}
