import { applyPatch, diffState } from "@vibedgames/multiplayer";

import { FIRE_BASE, encodeFire } from "../src/net/fire-wire";
import type { WireRecord } from "../src/net/wire-read";
import { encodeWorld, stepUfo } from "../src/net/world-wire";
import {
  ASTEROID_CAP_MAX,
  ENEMY_CAP_MAX,
  ITEMS_MAX_LIVE,
  PLAYER_NET_HZ,
  SHARDS_MAX_LIVE,
  UFO_SPEED,
  WEAPONS_SPECIAL,
  WORLD_H,
  WORLD_NET_HZ,
  WORLD_W,
  baseWeaponForLevel,
  scaleWeaponForLevel,
} from "../src/shared/constants";
import type {
  EnemyShotState,
  EnemyState,
  ItemState,
  PlayerNetState,
  ShardState,
  SharedState,
} from "../src/shared/constants";
import { mulberry32 } from "../src/shared/rng";
import { playerToWire } from "../src/shared/wire";
import type { FireSpec } from "../src/sys/volley";

const PLAYERS = 32;
const PEERS = PLAYERS - 1;
const V6_HZ = 17;
const EPOCH = 1_752_566_400_000;
const ARENA_AGE_MS = 2 * 60 * 60 * 1000;
const TICKS = 60 * WORLD_NET_HZ;

const roll = mulberry32(2026);
const fx = () => roll() * WORLD_W;
const fy = () => roll() * WORLD_H;
const fv = () => (roll() - 0.5) * 300;
let nextId = 0;

const id = () => {
  nextId += 1;

  return nextId.toString(36).padStart(8, "0");
};

const PEER_ID = "00000000-0000-4000-8000-000000007000";

const bytes = <T>(v: T) => Buffer.byteLength(JSON.stringify(v));

const diffKeys = (prev: WireRecord, next: WireRecord) => {
  const out: WireRecord = {};

  for (const [k, v] of Object.entries(next)) {
    if (v instanceof Object || !Object.is(prev[k], v)) {
      out[k] = v;
    }
  }

  return out;
};

const statePatchMsg = <T>(data: T) => bytes({ data, type: "state_patch" });

const playerStateMsg = (state: WireRecord) =>
  bytes({ data: { id: PEER_ID, state }, type: "player_state" });

const eventMsg = (event: string, payload: WireRecord) =>
  bytes({ data: { event, from: PEER_ID, payload }, type: "event" });

const makeAsteroid = () => ({
  id: id(),
  radius: 5 + roll() * 75,
  rot: roll() * Math.PI * 2,
  vx: fv() / 4,
  vy: fv() / 4,
  x: fx(),
  y: fy(),
});

const makeEnemy = (i: number, now: number) => {
  const boss = i === 0;
  const sniper = !boss && i % 20 === 0;
  const lance = () => ({ x: fx(), y: fy() });
  let kind: EnemyState["kind"] = "drone";

  if (boss) {
    kind = "dreadnought";
  } else if (sniper) {
    kind = "sniper";
  }

  let lances = 0;

  if (boss) {
    lances = 4;
  } else if (sniper) {
    lances = 1;
  }

  return {
    angle: roll() * Math.PI * 2,
    attackAt: now - roll() * 3000,
    blinkUntil: now + roll() * 150,
    chargeUntil: 0,
    graceUntil: 0,
    hp: roll() * 4000,
    id: id(),
    kind,
    lances: Array.from({ length: lances }, lance),
    maxHp: boss ? 4000 : 20,
    shielded: false,
    telegraphUntil: now + roll() * 900,
    vx: fv(),
    vy: fv(),
    x: fx(),
    y: fy(),
  };
};

const makeShot = (now: number) => ({
  diesAt: now + 4000,
  id: id(),
  vx: fv() * 2,
  vy: fv() * 2,
  x: fx(),
  y: fy(),
});

const makeShard = (now: number) => ({
  diesAt: now + 8000,
  id: id(),
  vx: fv() / 10,
  vy: fv() / 10,
  x: fx(),
  y: fy(),
});

const makeItem: (now: number) => ItemState = (now) => ({
  diesAt: now + 25_000,
  id: id(),
  kind: "weapon",
  vx: fv() / 10,
  vy: fv() / 10,
  weaponIdx: 12,
  x: fx(),
  y: fy(),
});

const makePull = (now: number) => ({
  id: id(),
  until: now + roll() * 4000,
  x: fx(),
  y: fy(),
});

const atCaps: (now: number) => SharedState = (now) => ({
  arenaEpoch: now - ARENA_AGE_MS,
  asteroids: Array.from({ length: ASTEROID_CAP_MAX }, makeAsteroid),
  beacon: {
    activeAt: now + 8000,
    contested: false,
    controllerId: PEER_ID,
    diesAt: now + 48_000,
    x: fx(),
    y: fy(),
  },
  enemies: Array.from({ length: ENEMY_CAP_MAX }, (_, i) => makeEnemy(i, now)),
  enemyShots: Array.from({ length: ENEMY_CAP_MAX * 2 }, () => makeShot(now)),
  items: Array.from({ length: ITEMS_MAX_LIVE + 1 }, () => makeItem(now)),
  playH: WORLD_H,
  playW: WORLD_W,
  pulls: Array.from({ length: 4 }, () => makePull(now)),
  sectorBossIdx: 0,
  shards: Array.from({ length: SHARDS_MAX_LIVE }, () => makeShard(now)),
  ufo: { blinkUntil: now, destX: fx(), destY: fy(), hp: 58, id: id(), x: fx(), y: fy() },
});

const q1 = (n: number) => Math.round(n * 10) / 10;
const q3 = (n: number) => Math.round(n * 1000) / 1000;

const v6Shared = (w: SharedState) => ({
  arenaEpoch: Math.round(w.arenaEpoch),
  asteroids: w.asteroids.map((a) => ({
    id: a.id,
    radius: q1(a.radius),
    rot: q3(a.rot),
    vx: q1(a.vx),
    vy: q1(a.vy),
    x: q1(a.x),
    y: q1(a.y),
  })),
  beacon: w.beacon
    ? {
        activeAt: Math.round(w.beacon.activeAt),
        contested: w.beacon.contested,
        controllerId: w.beacon.controllerId,
        diesAt: Math.round(w.beacon.diesAt),
        x: q1(w.beacon.x),
        y: q1(w.beacon.y),
      }
    : null,
  enemies: w.enemies.map((e) => ({
    angle: q3(e.angle),
    attackAt: Math.round(e.attackAt),
    blinkUntil: Math.round(e.blinkUntil),
    chargeUntil: Math.round(e.chargeUntil),
    graceUntil: Math.round(e.graceUntil),
    hp: q1(e.hp),
    id: e.id,
    kind: e.kind,
    lances: e.lances.map((p) => ({ x: q1(p.x), y: q1(p.y) })),
    maxHp: e.maxHp,
    shielded: e.shielded,
    telegraphUntil: Math.round(e.telegraphUntil),
    vx: q1(e.vx),
    vy: q1(e.vy),
    x: q1(e.x),
    y: q1(e.y),
  })),
  enemyShots: w.enemyShots.map((s) => ({
    diesAt: Math.round(s.diesAt),
    id: s.id,
    vx: q1(s.vx),
    vy: q1(s.vy),
    x: q1(s.x),
    y: q1(s.y),
  })),
  items: w.items.map((it) => ({
    ...it,
    diesAt: Math.round(it.diesAt),
    vx: q1(it.vx),
    vy: q1(it.vy),
    x: q1(it.x),
    y: q1(it.y),
  })),
  playH: w.playH,
  playW: w.playW,
  pulls: w.pulls.map((p) => ({ id: p.id, until: Math.round(p.until), x: q1(p.x), y: q1(p.y) })),
  sectorBossIdx: w.sectorBossIdx,
  shards: w.shards.map((s) => ({
    diesAt: Math.round(s.diesAt),
    id: s.id,
    vx: q1(s.vx),
    vy: q1(s.vy),
    x: q1(s.x),
    y: q1(s.y),
  })),
  ufo: w.ufo
    ? {
        blinkUntil: Math.round(w.ufo.blinkUntil),
        destX: q1(w.ufo.destX),
        destY: q1(w.ufo.destY),
        hp: q1(w.ufo.hp),
        id: w.ufo.id,
        x: q1(w.ufo.x),
        y: q1(w.ufo.y),
      }
    : null,
});

const v6Beam = (chain: boolean) => {
  const b = {
    exploding: false,
    explosionRadius: 0,
    hx: q1(fx()),
    hy: q1(fy()),
    power: 0.25,
    tint: 0xff_2d_78,
    tx: q1(fx()),
    ty: q1(fy()),
    width: 3,
  };

  return chain
    ? { ...b, chain: Array.from({ length: 6 }, () => ({ x: q1(fx()), y: q1(fy()) })) }
    : b;
};

const v6Player = () => ({
  alive: true,
  angle: q3(roll() * Math.PI * 2),
  beams: Array.from({ length: 16 }, (_, i) => v6Beam(i === 0)),
  boosts: [
    { kind: "overdrive", until: EPOCH + 9999 },
    { kind: "nitro", until: EPOCH + 8888 },
    { kind: "magnet", until: EPOCH + 7778 },
  ],
  sentry: { until: EPOCH + 14_001, x: q1(fx()), y: q1(fy()) },
  shieldMod: { active: true, kind: "overshield", phased: false, until: EPOCH + 12_346 },
  vx: q1(fv()),
  vy: q1(fv()),
  windup: 0.88,
  x: q1(fx()),
  y: q1(fy()),
});

const stepWorld = (w: SharedState, now: number) => {
  const dt = 1 / WORLD_NET_HZ;

  for (const e of w.enemies) {
    const turn = (roll() - 0.5) * 0.3;
    const c = Math.cos(turn);
    const s = Math.sin(turn);
    [e.vx, e.vy] = [e.vx * c - e.vy * s, e.vx * s + e.vy * c];
    e.x += e.vx * dt;
    e.y += e.vy * dt;
    e.angle += turn;

    if (roll() < 1.5 / WORLD_NET_HZ) {
      const pick = roll();

      if (pick < 0.4) {
        e.telegraphUntil = now + 400;
      } else if (pick < 0.7) {
        e.attackAt = now;
      } else {
        e.hp -= 5;
        e.blinkUntil = now + 120;
      }
    }
  }

  for (const list of [w.asteroids, w.enemyShots, w.shards, w.items]) {
    for (const m of list) {
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    }
  }

  w.enemyShots.splice(0, 2);
  w.enemyShots.push(makeShot(now), makeShot(now));

  if (roll() < 1 / WORLD_NET_HZ) {
    w.enemyShots.splice(Math.floor(roll() * w.enemyShots.length), 1);
    w.enemyShots.push(makeShot(now));
  }

  for (let i = 0; i < 2; i += 1) {
    if (roll() < 1 / WORLD_NET_HZ) {
      const a = w.asteroids[Math.floor(roll() * w.asteroids.length)];

      if (a) {
        a.radius = Math.max(5, a.radius - 10);
        a.vx = fv() / 4;
        a.vy = fv() / 4;
      }
    }
  }

  if (roll() < 1 / WORLD_NET_HZ) {
    w.asteroids.splice(Math.floor(roll() * w.asteroids.length), 1);
    w.asteroids.push(makeAsteroid());
  }

  if (roll() < 3 / WORLD_NET_HZ) {
    w.shards.shift();
    w.shards.push(makeShard(now));
  }

  if (roll() < 2 / WORLD_NET_HZ) {
    w.shards.splice(Math.floor(roll() * w.shards.length), 1);
    w.shards.push(makeShard(now));
  }

  if (w.ufo) {
    stepUfo(w.ufo, UFO_SPEED * dt);
  }

  if (w.ufo && roll() < 0.2 / WORLD_NET_HZ) {
    w.ufo.destX = fx();
    w.ufo.destY = fy();
  }

  if (w.beacon && roll() < 0.5 / WORLD_NET_HZ) {
    w.beacon.contested = !w.beacon.contested;
  }
};

const world7 = atCaps(EPOCH);
let shared7: WireRecord = {};
const perFamily = new Map<string, number>();

const v7Patch = (now: number, tally: boolean) => {
  const patch = encodeWorld(world7, now, Math.round(now), shared7);
  const ops = diffState(shared7, { ...shared7, ...patch }, Object.keys(patch));
  shared7 = applyPatch(shared7, structuredClone(ops));

  if (tally) {
    for (const op of ops) {
      const family = String(op[0][0]).replace(/\d+$/u, "");
      perFamily.set(family, (perFamily.get(family) ?? 0) + bytes(op) + 1);
    }
  }

  return statePatchMsg(ops);
};

const firstShare = v7Patch(EPOCH, false);
let worldTotal = 0;
let worldMax = 0;

for (let i = 1; i <= TICKS; i += 1) {
  const now = EPOCH + (i * 1000) / WORLD_NET_HZ;
  stepWorld(world7, now);
  const b = v7Patch(now, true);
  worldTotal += b;
  worldMax = Math.max(worldMax, b);
}

const worldAvg = worldTotal / TICKS;
const syncBytes = bytes(shared7);

const player: (i: number) => PlayerNetState = (i) => ({
  alive: true,
  angle: (i * 0.05) % (Math.PI * 2),
  invuln: false,
  level: 3,
  magnet: true,
  nitro: true,
  overHp: 42,
  present: true,
  sectorScore: 512,
  shieldHp: 87,
  shieldMod: { active: true, kind: "overshield", phased: false },
  streak: 41,
  t: EPOCH + 1234.567 + (i * 1000) / PLAYER_NET_HZ,
  tesla: false,
  twin: false,
  vx: 287.123 - i,
  vy: -41.987 + i,
  weaponName: "CHAIN REACTOR",
  windup: (i % 10) / 10,
  x: 3811.928 + i * 9.6,
  xp: 111,
  y: 2011.462 - i * 1.4,
});

let playerPrev: WireRecord = {};
let playerTotal = 0;
const PLAYER_SAMPLES = 300;

for (let i = 0; i <= PLAYER_SAMPLES; i += 1) {
  const next = playerToWire(player(i));
  const sent = playerStateMsg(diffKeys(playerPrev, next));
  playerPrev = next;

  if (i > 0) {
    playerTotal += sent;
  }
}

const playerAvg = playerTotal / PLAYER_SAMPLES;

const fireSpec: (weaponIdx: number | null, lock: boolean) => FireSpec = (weaponIdx, lock) => {
  const weapon =
    weaponIdx === null
      ? baseWeaponForLevel(3)
      : scaleWeaponForLevel(WEAPONS_SPECIAL[weaponIdx] ?? baseWeaponForLevel(3), 3);

  return {
    angle: 2.3456789,
    chain: null,
    code: weaponIdx ?? FIRE_BASE,
    kind: "volley",
    level: 3,
    lock: lock ? { id: "k3j9x0ab", kind: "enemy" } : null,
    seed: 31_415,
    t: EPOCH + 1234.567,
    twin: 1.2345678,
    twinLock: null,
    weapon,
    x: 3811.928,
    y: 2011.462,
  };
};

const plasmaIdx = WEAPONS_SPECIAL.findIndex((w) => w.name === "PLASMA CONE");
const homingIdx = WEAPONS_SPECIAL.findIndex((w) => w.name === "HOMING");
const fireBase = eventMsg("fire", encodeFire(fireSpec(null, false)));
const fireHoming = eventMsg("fire", encodeFire(fireSpec(homingIdx, true)));
const plasmaPerSec = 1000 / (WEAPONS_SPECIAL[plasmaIdx]?.intervalMs ?? 70);
const firePlasma = eventMsg("fire", encodeFire(fireSpec(plasmaIdx, false)));

const v6World = statePatchMsg(v6Shared(atCaps(EPOCH)));
const v6PlayerMsg = playerStateMsg(v6Player());
const v6Down = v6World * V6_HZ + PEERS * v6PlayerMsg * V6_HZ;
const v7Fire = PEERS * plasmaPerSec * firePlasma;
const v7Down = worldAvg * WORLD_NET_HZ + PEERS * playerAvg * PLAYER_NET_HZ + v7Fire;
const kib = (b: number) => `${(b / 1024).toFixed(0)} KiB/s`;
const mbps = (b: number) => `${((b * 8) / 1e6).toFixed(2)} Mbps`;
const row = (label: string, value: string) => console.log(`  ${label.padEnd(38)} ${value}`);

console.log(`\n=== V6 — as shipped before (whole world + whole player state every send) ===`);

row("host world patch:", `${v6World.toLocaleString()} B/send (every send, ~${V6_HZ} Hz)`);

row("one player update (16 beams):", `${v6PlayerMsg.toLocaleString()} B/send (~${V6_HZ} Hz)`);

row("per-client downstream:", `${kib(v6Down)} = ${mbps(v6Down)}`);

row(`server egress (×${PLAYERS}):`, `${((v6Down * PLAYERS) / 1024 / 1024).toFixed(1)} MiB/s`);

row(
  `messages fanned out (×${PLAYERS}):`,
  `${Math.round(PLAYERS * (V6_HZ + PEERS * V6_HZ)).toLocaleString()}/s`,
);

console.log(`\n=== V7 — deltas, flat player state, shots as events ===`);

row("full world (first share / late join):", `${firstShare.toLocaleString()} B once`);

row("room sync a late joiner receives:", `${syncBytes.toLocaleString()} B once`);

row(
  `host world patch, busy minute:`,
  `${Math.round(worldAvg).toLocaleString()} B avg, ${worldMax.toLocaleString()} B max (${WORLD_NET_HZ} Hz)`,
);

for (const [family, total] of [...perFamily].toSorted((a, b) => b[1] - a[1])) {
  row(`  ${family}:`, `${Math.round(total / TICKS).toLocaleString()} B avg`);
}

row(
  "one player update (moving):",
  `${Math.round(playerAvg).toLocaleString()} B avg (${PLAYER_NET_HZ} Hz)`,
);

row("one fire event:", `${fireBase} B base weapon, ${fireHoming} B homing, ${firePlasma} B plasma`);

row(
  `fire events, ${PEERS} peers on PLASMA:`,
  `${kib(v7Fire)} (${Math.round(plasmaPerSec)}/s each)`,
);

row("per-client downstream:", `${kib(v7Down)} = ${mbps(v7Down)}`);

row(`server egress (×${PLAYERS}):`, `${((v7Down * PLAYERS) / 1024 / 1024).toFixed(1)} MiB/s`);

row(
  `messages fanned out (×${PLAYERS}):`,
  `${Math.round(PLAYERS * (WORLD_NET_HZ + PEERS * (PLAYER_NET_HZ + plasmaPerSec))).toLocaleString()}/s`,
);

console.log(`\n  downstream per client: ${(v6Down / v7Down).toFixed(1)}× less\n`);
