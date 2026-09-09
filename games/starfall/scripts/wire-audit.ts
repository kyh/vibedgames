/**
 * 32-player worst-case bandwidth audit (backlog dir-002).
 *
 * Models the wire exactly as shipped: the host's `updateSharedState` sends the
 * FULL merged SharedState (not the dirty-delta — see the multiplayer package's
 * client.ts) as a `state_patch` message at 20Hz, and the party server
 * broadcasts it to every client; each client sends its full PlayerNetState at
 * 20Hz, fanned out to the other N-1 clients.
 *
 * Worst-case assumptions (all caps from shared/constants.ts, arena at the
 * full 7680×4320 32-player bounds so coordinates use max digits):
 *   - asteroids at ASTEROID_CAP_MAX, enemies at ENEMY_CAP_MAX (incl. one boss
 *     with lances + a few snipers mid-telegraph)
 *   - enemyShots: 2 live shots per enemy on average (4s TTL, burst weapons)
 *   - shards at SHARDS_MAX_LIVE, items at ITEMS_MAX_LIVE + 1 UFO-bypass drop
 *   - every player: 16 live beams (QA measured 7–15 under autofire) incl. one
 *     ARC chain, 3 boosts, a shield mod, a sentry, longest weapon name
 *
 * BEFORE = the v5 room as shipped: crypto.randomUUID ids (36 chars), asteroid
 * verts riding the wire, raw float64 coordinates.
 * AFTER = the v6 room: 8-char ids (entityId), verts derived client-side from
 * the id (asteroidUnitVerts), everything quantized via shared/wire.ts.
 *
 * Run: node_modules/.bin/tsx scripts/wire-audit.ts
 */

import {
  ASTEROID_CAP_MAX,
  ASTEROID_VERTEX_COUNT,
  ENEMY_CAP_MAX,
  ITEMS_MAX_LIVE,
  SHARDS_MAX_LIVE,
  WORLD_H,
  WORLD_W,
} from "../src/shared/constants";
import type {
  AsteroidState,
  EnemyShotState,
  EnemyState,
  ItemState,
  PlayerNetState,
  PullState,
  SerializedBeam,
  ShardState,
  UfoState,
  Vec,
} from "../src/shared/constants";
import {
  asteroidToWire,
  beaconToWire,
  enemyShotToWire,
  enemyToWire,
  itemToWire,
  playerToWire,
  pullToWire,
  shardToWire,
  ufoToWire,
} from "../src/shared/wire";

const PLAYERS = 32;
const NET_HZ = 20;
// fixed so runs are comparable
const EPOCH = 1_752_566_400_000;

/** The v5 asteroid carried its 12-vert outline on the wire; v6 derives it. */
type RawAsteroid = AsteroidState & { verts: Vec[] };

/** Structural stand-in for SharedState that admits both wire generations. */
interface SharedLike {
  asteroids: unknown[];
  ufo: unknown;
  items: unknown[];
  enemies: unknown[];
  enemyShots: unknown[];
  shards: unknown[];
  pulls: unknown[];
  /** v6 BEACON event entry (dir-004) — absent on the v5 wire. */
  beacon?: unknown;
  arenaEpoch: number;
  playW: number;
  playH: number;
}

// Full-precision floats, like a position after thousands of dt integrations.
const fx = (): number => Math.random() * WORLD_W;
const fy = (): number => Math.random() * WORLD_H;
const fv = (): number => (Math.random() - 0.5) * 300;

/** v5 id: crypto.randomUUID (36 chars). */
const uuid = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
/** v6 id: 8 base36 chars (shared/constants entityId). */
const shortId = (i: number): string => i.toString(36).padStart(8, "0");

type IdFn = (i: number) => string;

/** The v5 outline (absolute-px verts) — kept here to model the old wire. */
const rawVerts = (radius: number): Vec[] => {
  const verts: Vec[] = [];
  for (let i = 0; i < ASTEROID_VERTEX_COUNT; i += 1) {
    const r = radius * (0.5 + Math.random() * 0.5);
    const a = (Math.PI * 2 * i) / ASTEROID_VERTEX_COUNT;
    verts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return verts;
};

const makeAsteroid = (id: IdFn, i: number): AsteroidState => ({
  id: id(i),
  radius: 5 + Math.random() * 75,
  rot: Math.random() * Math.PI * 2,
  vx: fv(),
  vy: fv(),
  x: fx(),
  y: fy(),
});

const makeRawAsteroid = (i: number): RawAsteroid => {
  const a = makeAsteroid(uuid, i);
  return { ...a, verts: rawVerts(a.radius) };
};

const enemyKind = (boss: boolean, sniper: boolean): EnemyState["kind"] => {
  if (boss) {
    return "dreadnought";
  }
  return sniper ? "sniper" : "drone";
};

const lanceCount = (boss: boolean, sniper: boolean): number => {
  if (boss) {
    return 4;
  }
  return sniper ? 1 : 0;
};

const makeEnemy = (id: IdFn, i: number): EnemyState => {
  // Worst mix: 1 boss (maxHp + 4 locked lances), a few snipers mid-telegraph
  // (1 lance each), the rest plain fodder.
  const boss = i === 0;
  const sniper = !boss && i % 20 === 0;
  const lance = (): Vec => ({ x: fx(), y: fy() });
  return {
    angle: Math.random() * Math.PI * 2,
    attackAt: EPOCH + Math.random() * 1000,
    blinkUntil: EPOCH + Math.random() * 1000,
    chargeUntil: EPOCH + Math.random() * 1000,
    graceUntil: EPOCH + Math.random() * 1000,
    hp: Math.random() * 4000,
    id: id(1000 + i),
    kind: enemyKind(boss, sniper),
    lances: Array.from({ length: lanceCount(boss, sniper) }, lance),
    maxHp: boss ? 4000 : 0,
    shielded: false,
    telegraphUntil: EPOCH + Math.random() * 1000,
    vx: fv(),
    vy: fv(),
    x: fx(),
    y: fy(),
  };
};

const makeShot = (id: IdFn, i: number): EnemyShotState => ({
  diesAt: EPOCH + 4000,
  id: id(2000 + i),
  vx: fv(),
  vy: fv(),
  x: fx(),
  y: fy(),
});

const makeShard = (id: IdFn, i: number): ShardState => ({
  diesAt: EPOCH + 8000,
  id: id(3000 + i),
  vx: fv(),
  vy: fv(),
  x: fx(),
  y: fy(),
});

const makeItem = (id: IdFn, i: number): ItemState => ({
  diesAt: EPOCH + 25_000,
  id: id(4000 + i),
  kind: "weapon",
  vx: fv(),
  vy: fv(),
  weaponIdx: 12,
  x: fx(),
  y: fy(),
});

const makeUfo = (id: IdFn): UfoState => ({
  blinkUntil: EPOCH + Math.random() * 300,
  destX: fx(),
  destY: fy(),
  hp: 57.99999999999997,
  id: id(5000),
  x: fx(),
  y: fy(),
});

const makePulls = (id: IdFn): PullState[] =>
  Array.from({ length: 4 }, (_, i) => ({
    id: id(6000 + i),
    until: EPOCH + Math.random() * 4000,
    x: fx(),
    y: fy(),
  }));

const ENEMY_SHOTS = ENEMY_CAP_MAX * 2;

const beforeAsteroids: RawAsteroid[] = Array.from({ length: ASTEROID_CAP_MAX }, (_, i) =>
  makeRawAsteroid(i),
);

/** v5 wire: raw floats, uuid ids, verts on every asteroid. */
const before: SharedLike = {
  arenaEpoch: EPOCH + 0.30000000001,
  asteroids: beforeAsteroids,
  enemies: Array.from({ length: ENEMY_CAP_MAX }, (_, i) => makeEnemy(uuid, i)),
  enemyShots: Array.from({ length: ENEMY_SHOTS }, (_, i) => makeShot(uuid, i)),
  items: Array.from({ length: ITEMS_MAX_LIVE + 1 }, (_, i) => makeItem(uuid, i)),
  playH: WORLD_H,
  playW: WORLD_W,
  pulls: makePulls(uuid),
  shards: Array.from({ length: SHARDS_MAX_LIVE }, (_, i) => makeShard(uuid, i)),
  ufo: makeUfo(uuid),
};

/** v6 wire: short ids, no verts, quantized at the boundary. */
const after: SharedLike = {
  arenaEpoch: Math.round(EPOCH + 0.30000000001),
  asteroids: Array.from({ length: ASTEROID_CAP_MAX }, (_, i) =>
    asteroidToWire(makeAsteroid(shortId, i)),
  ),
  // Worst case: a beacon is live and controlled (controllerId = a full player
  // id, which comes from the MP client, not entityId).
  beacon: beaconToWire({
    activeAt: EPOCH + 8000.1234,
    contested: false,
    controllerId: uuid(8000),
    diesAt: EPOCH + 48_000.5678,
    x: fx(),
    y: fy(),
  }),
  enemies: Array.from({ length: ENEMY_CAP_MAX }, (_, i) => enemyToWire(makeEnemy(shortId, i))),
  enemyShots: Array.from({ length: ENEMY_SHOTS }, (_, i) => enemyShotToWire(makeShot(shortId, i))),
  items: Array.from({ length: ITEMS_MAX_LIVE + 1 }, (_, i) => itemToWire(makeItem(shortId, i))),
  playH: WORLD_H,
  playW: WORLD_W,
  pulls: makePulls(shortId).map(pullToWire),
  shards: Array.from({ length: SHARDS_MAX_LIVE }, (_, i) => shardToWire(makeShard(shortId, i))),
  ufo: ufoToWire(makeUfo(shortId)),
};

const makeBeam = (chain: boolean): SerializedBeam => {
  const b: SerializedBeam = {
    exploding: false,
    explosionRadius: 0,
    hx: fx(),
    hy: fy(),
    power: 0.25,
    tint: 0xff_2d_78,
    tx: fx(),
    ty: fy(),
    width: 3,
  };
  if (chain) {
    b.chain = Array.from({ length: 6 }, () => ({ x: fx(), y: fy() }));
  }
  return b;
};

const makePlayer = (): PlayerNetState => ({
  alive: true,
  angle: Math.random() * Math.PI * 2,
  beams: Array.from({ length: 16 }, (_, i) => makeBeam(i === 0)),
  boosts: [
    { kind: "overdrive", until: EPOCH + 9999.123 },
    { kind: "nitro", until: EPOCH + 8888.456 },
    { kind: "magnet", until: EPOCH + 7777.789 },
  ],
  invuln: false,
  level: 3,
  overHp: 42,
  present: true,
  sectorScore: 512,
  sentry: { until: EPOCH + 14_000.99, x: fx(), y: fy() },
  shieldHp: 87,
  shieldMod: { active: true, kind: "overshield", phased: false, until: EPOCH + 12_345.678 },
  streak: 41,
  tesla: false,
  vx: fv(),
  vy: fv(),
  weaponName: "CHAIN REACTOR",
  windup: 0.8765432109876543,
  x: fx(),
  xp: 111,
  y: fy(),
});

const bytes = <T>(v: T): number => Buffer.byteLength(JSON.stringify(v));
const sharedMsg = (data: SharedLike): number => bytes({ data, type: "state_patch" });
const playerMsg = (state: PlayerNetState): number =>
  bytes({ data: { playerId: uuid(7000), state }, type: "player_state" });

const report = (label: string, s: SharedLike, p: PlayerNetState): void => {
  const rows: [string, number, number][] = [
    ["asteroids", s.asteroids.length, bytes(s.asteroids)],
    ["enemies", s.enemies.length, bytes(s.enemies)],
    ["enemyShots", s.enemyShots.length, bytes(s.enemyShots)],
    ["shards", s.shards.length, bytes(s.shards)],
    ["items", s.items.length, bytes(s.items)],
    ["pulls", s.pulls.length, bytes(s.pulls)],
    ["ufo", 1, bytes(s.ufo)],
  ];
  rows.sort((a, b) => b[2] - a[2]);
  const sharedBytes = sharedMsg(s);
  const playerBytes = playerMsg(p);
  const perClientTick = sharedBytes + (PLAYERS - 1) * playerBytes;

  console.log(`\n=== ${label} ===`);
  for (const [name, count, b] of rows) {
    console.log(`  ${name.padEnd(11)} ×${String(count).padStart(3)}  ${b.toLocaleString()} B`);
  }
  console.log(`  shared state_patch msg:        ${sharedBytes.toLocaleString()} B/tick`);
  console.log(`  one player_state msg:          ${playerBytes.toLocaleString()} B/tick`);
  console.log(
    `  per-client downstream:         ${perClientTick.toLocaleString()} B/tick = ${((perClientTick * NET_HZ) / 1024).toFixed(0)} KiB/s = ${((perClientTick * NET_HZ * 8) / 1e6).toFixed(2)} Mbps`,
  );
  console.log(
    `  server egress (×${PLAYERS}):           ${((perClientTick * PLAYERS * NET_HZ) / 1024 / 1024).toFixed(1)} MiB/s`,
  );
  console.log(
    `  host upstream (shared only):   ${((sharedBytes * NET_HZ) / 1024).toFixed(0)} KiB/s`,
  );
};

const vertsBytes = bytes(beforeAsteroids.map((a) => a.verts));
console.log(`asteroid verts alone (v5 wire): ${vertsBytes.toLocaleString()} B`);

report("BEFORE — v5 as shipped (uuid ids, verts on wire, raw floats)", before, makePlayer());
report("AFTER — v6 (short ids, derived verts, quantized)", after, playerToWire(makePlayer()));
