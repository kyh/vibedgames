import { HERO_NAMES, ENEMY_NAMES, type HeroName, type EnemyName } from "../data/animations";
import { ROOM_TYPES, type RoomType } from "../data/rooms";
import { RELICS, type RunMods } from "../data/relics";
import type { PlayerBodyCheckpoint } from "../entities/player-body";
import type { EnemyBodyCheckpoint } from "../entities/enemy-body";
import type { BossBodyCheckpoint } from "../entities/boss-body";
import type { VersusCheckpoint } from "../sys/versus";
import { isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json";
import type { NetRoom } from "./snapshot";

export type CheckpointSeats = { host: string | null; guest: string | null };
export type InputSequence = { j: number; d: number; a: number; s: number };
export type CheckpointCombat = {
  hitSwing: number[];
  lastSwing: number;
  hitSpecial: number[];
  lastSpecial: number;
  bossSwing: number;
  bossSpecial: number;
};
export type CheckpointPlayer = {
  id: string;
  hero: HeroName;
  body: PlayerBodyCheckpoint;
  combat: CheckpointCombat;
  versusHits: { swing: number; special: number };
};
export type CheckpointEnemy = {
  id: number;
  name: EnemyName;
  body: EnemyBodyCheckpoint;
  tint: number;
  deathAge: number | null;
};
export type CheckpointArrow = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  dmg: number;
};
export type CheckpointShot = CheckpointArrow & {
  owner: string | null;
  hit: number[];
  hitP: string[];
  hitBoss: boolean;
};
export type CheckpointHazard = {
  x: number;
  y: number;
  vx: number;
  life: number;
  dmg: number;
  hitPlayer: boolean;
};
export type CheckpointFeature = { x: number; y: number; used: boolean };
export type CheckpointMerchant = { x: number; y: number; relic: string; bought: boolean };
export type CheckpointPhase =
  | { kind: "active" }
  | { kind: "transition"; elapsed: number; built: boolean; offer: RoomType }
  | { kind: "dead"; elapsed: number };

// `host`/`guest` are the ORIGINAL left/right seats, never the elected writer.
// Body ownership remains player-ID based across authority changes.
type CheckpointBase = {
  version: 1;
  runId: string;
  writer: string;
  term: number;
  tick: number;
  room: number;
  rng: number;
  seats: CheckpointSeats;
  players: CheckpointPlayer[];
  enemies: CheckpointEnemy[];
  boss: BossBodyCheckpoint | null;
  bossDeathAge: number;
  nextEnemyId: number;
  arrows: CheckpointArrow[];
  shots: CheckpointShot[];
  hazards: CheckpointHazard[];
  run: { biome: number; depth: number; type: RoomType; offers: RoomType[] };
  mods: RunMods;
  relics: string[];
  merchant: CheckpointMerchant[];
  feature: CheckpointFeature | null;
  hearts: number;
  maxHearts: number;
  gold: number;
  score: number;
  combo: number;
  comboTime: number;
  freeze: number;
  accumulator: number;
  cleared: boolean;
  phase: CheckpointPhase;
};
export type ExpeditionCheckpoint = CheckpointBase &
  (
    | {
        mode: "coop";
        versus: null;
        lastStand: { id: string; bleed: number; revive: number } | null;
      }
    | { mode: "versus"; versus: VersusCheckpoint; lastStand: null }
  );
export type CheckpointRead =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "ready"; value: ExpeditionCheckpoint; room: NetRoom };

const bool = (v: JsonValue | undefined): v is boolean => v === true || v === false;
const id = (v: JsonValue | undefined): v is string => isJsonString(v) && v.length > 0;
const integer = (v: JsonValue | undefined): v is number =>
  isJsonNumber(v) && Number.isSafeInteger(v) && v >= 0;
const face = (v: JsonValue | undefined): v is 1 | -1 => v === 1 || v === -1;
const nums = (v: JsonObject, keys: readonly string[]): boolean =>
  keys.every((k) => isJsonNumber(v[k]));
const bools = (v: JsonObject, keys: readonly string[]): boolean => keys.every((k) => bool(v[k]));
const numbers = (v: JsonValue | undefined): v is number[] => Array.isArray(v) && v.every(integer);
const ids = (v: JsonValue | undefined): v is string[] => Array.isArray(v) && v.every(id);
const relic = (v: JsonValue | undefined): v is string => RELICS.some((r) => r.id === v);
const roomType = (v: JsonValue | undefined): v is RoomType => ROOM_TYPES.some((t) => t === v);
const nullableId = (v: JsonValue | undefined): v is string | null => v === null || id(v);
const point = (v: JsonValue | undefined): boolean => isJsonObject(v) && nums(v, ["x", "y"]);
const projectile = (v: JsonValue | undefined): boolean =>
  isJsonObject(v) && nums(v, ["x", "y", "vx", "vy"]);
const blast = (v: JsonValue | undefined): boolean =>
  isJsonObject(v) && nums(v, ["x", "y", "r", "dmg"]);

export function isPlayerCheckpoint(v: JsonValue | undefined): v is PlayerBodyCheckpoint {
  return (
    isJsonObject(v) &&
    nums(v, [
      "x",
      "y",
      "prevX",
      "prevY",
      "vx",
      "vy",
      "iframes",
      "attackStep",
      "swingId",
      "specialId",
      "pendingHeal",
      "attackTime",
      "attackBuf",
      "attackCd",
      "comboStage",
      "comboGrace",
      "specialBuf",
      "specialCd",
      "specialElapsed",
      "specialDur",
      "hurtStun",
      "coyote",
      "jumpBuf",
      "dashBuf",
      "dashTime",
      "dashCd",
      "wallLock",
      "dashDirX",
      "dashDirY",
      "landVy",
    ]) &&
    bools(v, [
      "grounded",
      "dead",
      "downed",
      "specialActive",
      "comboQueued",
      "specialFired",
      "airDash",
      "jumping",
      "hLeft",
      "hRight",
      "hUp",
      "hDown",
      "jumpHeld",
    ]) &&
    face(v.facing) &&
    (v.wallDir === -1 || v.wallDir === 0 || v.wallDir === 1) &&
    (v.pendingShot === null ||
      (projectile(v.pendingShot) && isJsonObject(v.pendingShot) && isJsonNumber(v.pendingShot.dmg)))
  );
}
export function isEnemyCheckpoint(v: JsonValue | undefined): v is EnemyBodyCheckpoint {
  return (
    isJsonObject(v) &&
    nums(v, [
      "x",
      "y",
      "prevX",
      "prevY",
      "vx",
      "vy",
      "hp",
      "stateT",
      "hitFlash",
      "iframes",
      "speedMult",
      "dmgTakenMult",
      "dmgOutMult",
      "attackCd",
    ]) &&
    bools(v, ["grounded", "dead", "hitWall", "exploded"]) &&
    face(v.facing) &&
    face(v.chargeDir) &&
    ["spawn", "chase", "windup", "attack", "charge", "recover", "hurt", "dead"].some(
      (s) => s === v.state,
    ) &&
    (v.pendingProjectile === null || projectile(v.pendingProjectile)) &&
    (v.pendingBlast === null || blast(v.pendingBlast))
  );
}
export function isBossCheckpoint(v: JsonValue | undefined): v is BossBodyCheckpoint {
  return (
    isJsonObject(v) &&
    nums(v, [
      "x",
      "y",
      "prevX",
      "prevY",
      "vx",
      "vy",
      "hp",
      "stateT",
      "hitFlash",
      "iframes",
      "attackCd",
    ]) &&
    (v.phase === 1 || v.phase === 2) &&
    bools(v, ["grounded", "dead"]) &&
    face(v.facing) &&
    ["intro", "idle", "wave", "jump", "slam", "charge", "punch", "hurt", "phase", "dead"].some(
      (s) => s === v.state,
    ) &&
    Array.isArray(v.pendingWaves) &&
    v.pendingWaves.every((w) => isJsonObject(w) && nums(w, ["x", "y", "vx", "dmg"])) &&
    (v.pendingBlast === null || blast(v.pendingBlast)) &&
    (v.pendingAdds === null ||
      (Array.isArray(v.pendingAdds) &&
        v.pendingAdds.every(
          (a) => isJsonObject(a) && point(a) && ENEMY_NAMES.some((n) => n === a.name),
        )))
  );
}
function combat(v: JsonValue | undefined): v is CheckpointCombat {
  return (
    isJsonObject(v) &&
    numbers(v.hitSwing) &&
    numbers(v.hitSpecial) &&
    nums(v, ["lastSwing", "lastSpecial", "bossSwing", "bossSpecial"])
  );
}
function player(v: JsonValue | undefined): v is CheckpointPlayer {
  return (
    isJsonObject(v) &&
    id(v.id) &&
    HERO_NAMES.some((h) => h === v.hero) &&
    isPlayerCheckpoint(v.body) &&
    combat(v.combat) &&
    isJsonObject(v.versusHits) &&
    nums(v.versusHits, ["swing", "special"])
  );
}
function enemy(v: JsonValue | undefined): v is CheckpointEnemy {
  return (
    isJsonObject(v) &&
    integer(v.id) &&
    ENEMY_NAMES.some((n) => n === v.name) &&
    isEnemyCheckpoint(v.body) &&
    integer(v.tint) &&
    v.tint <= 0xffffff &&
    (v.deathAge === null || isJsonNumber(v.deathAge))
  );
}
function arrow(v: JsonValue | undefined): v is CheckpointArrow {
  return isJsonObject(v) && nums(v, ["x", "y", "vx", "vy", "life", "dmg"]);
}
function shot(v: JsonValue | undefined): v is CheckpointShot {
  return (
    isJsonObject(v) &&
    nums(v, ["x", "y", "vx", "vy", "life", "dmg"]) &&
    nullableId(v.owner) &&
    numbers(v.hit) &&
    ids(v.hitP) &&
    bool(v.hitBoss)
  );
}
function hazard(v: JsonValue | undefined): v is CheckpointHazard {
  return isJsonObject(v) && nums(v, ["x", "y", "vx", "life", "dmg"]) && bool(v.hitPlayer);
}
function feature(v: JsonValue | undefined): v is CheckpointFeature {
  return isJsonObject(v) && point(v) && bool(v.used);
}
function merchant(v: JsonValue | undefined): v is CheckpointMerchant {
  return isJsonObject(v) && point(v) && relic(v.relic) && bool(v.bought);
}
function phase(v: JsonValue | undefined): v is CheckpointPhase {
  if (!isJsonObject(v)) return false;
  if (v.kind === "active") return true;
  if (!isJsonNumber(v.elapsed) || v.elapsed < 0) return false;
  return v.kind === "dead" || (v.kind === "transition" && bool(v.built) && roomType(v.offer));
}
function versus(v: JsonValue | undefined): v is VersusCheckpoint {
  return (
    isJsonObject(v) &&
    ["waiting", "countdown", "fighting", "roundEnd", "matchEnd"].some((p) => p === v.phase) &&
    integer(v.round) &&
    isJsonNumber(v.t) &&
    isJsonObject(v.hp) &&
    nums(v.hp, ["host", "guest"]) &&
    isJsonObject(v.score) &&
    nums(v.score, ["host", "guest"]) &&
    (v.winner === null || v.winner === "host" || v.winner === "guest")
  );
}
function room(v: JsonValue | undefined): v is NetRoom {
  return (
    isJsonObject(v) &&
    integer(v.seq) &&
    (v.mode === "coop" || v.mode === "vs") &&
    roomType(v.type) &&
    integer(v.cols) &&
    v.cols > 0 &&
    integer(v.rows) &&
    v.rows > 0 &&
    Array.isArray(v.cells) &&
    v.cells.length === v.cols * v.rows &&
    v.cells.every((c) => c === 0 || c === 1 || c === 2) &&
    nums(v, ["spawnX", "spawnY"]) &&
    Array.isArray(v.doors) &&
    v.doors.every(
      (d) =>
        isJsonObject(d) &&
        integer(d.index) &&
        point(d) &&
        roomType(d.type) &&
        isJsonString(d.label) &&
        bool(d.danger),
    ) &&
    isJsonString(v.propKey) &&
    bool(v.mustClear)
  );
}
function checkpoint(v: JsonValue | undefined): v is ExpeditionCheckpoint {
  if (
    !isJsonObject(v) ||
    v.version !== 1 ||
    !id(v.runId) ||
    !id(v.writer) ||
    !integer(v.term) ||
    !integer(v.tick) ||
    !integer(v.room) ||
    !integer(v.rng) ||
    v.rng > 0xffffffff
  )
    return false;
  if (
    !isJsonObject(v.seats) ||
    !nullableId(v.seats.host) ||
    !nullableId(v.seats.guest) ||
    (v.seats.host !== null && v.seats.host === v.seats.guest)
  )
    return false;
  if (
    !Array.isArray(v.players) ||
    v.players.length > 2 ||
    !v.players.every(player) ||
    !Array.isArray(v.enemies) ||
    !v.enemies.every(enemy) ||
    !(v.boss === null || isBossCheckpoint(v.boss))
  )
    return false;
  if (
    !Array.isArray(v.arrows) ||
    !v.arrows.every(arrow) ||
    !Array.isArray(v.shots) ||
    !v.shots.every(shot) ||
    !Array.isArray(v.hazards) ||
    !v.hazards.every(hazard)
  )
    return false;
  if (
    !isJsonObject(v.run) ||
    !integer(v.run.biome) ||
    v.run.biome < 1 ||
    !integer(v.run.depth) ||
    !roomType(v.run.type) ||
    !Array.isArray(v.run.offers) ||
    !v.run.offers.every(roomType)
  )
    return false;
  if (
    !isJsonObject(v.mods) ||
    !nums(v.mods, [
      "dmg",
      "maxHearts",
      "lifesteal",
      "goldMult",
      "armor",
      "crit",
      "critMult",
      "regen",
      "rage",
    ]) ||
    !Array.isArray(v.relics) ||
    !v.relics.every(relic)
  )
    return false;
  if (
    !Array.isArray(v.merchant) ||
    !v.merchant.every(merchant) ||
    !(v.feature === null || feature(v.feature))
  )
    return false;
  if (
    !nums(v, [
      "bossDeathAge",
      "hearts",
      "maxHearts",
      "gold",
      "score",
      "combo",
      "comboTime",
      "freeze",
      "accumulator",
    ]) ||
    !integer(v.nextEnemyId) ||
    !bool(v.cleared) ||
    !phase(v.phase)
  )
    return false;
  if (v.mode === "versus") {
    if (!versus(v.versus) || v.lastStand !== null) return false;
  } else if (v.mode === "coop") {
    if (
      v.versus !== null ||
      !(
        v.lastStand === null ||
        (isJsonObject(v.lastStand) && id(v.lastStand.id) && nums(v.lastStand, ["bleed", "revive"]))
      )
    )
      return false;
  } else return false;
  // Reference integrity prevents a partially restored graph and repeat hits.
  const seats = v.seats;
  const nextEnemyId = v.nextEnemyId;
  const playerIds = new Set(v.players.map((p) => p.id));
  const enemyIds = new Set(v.enemies.map((e) => e.id));
  if (playerIds.size !== v.players.length || enemyIds.size !== v.enemies.length) return false;
  if ([v.seats.host, v.seats.guest].some((s) => s !== null && !playerIds.has(s))) return false;
  if (v.players.some((p) => p.id !== seats.host && p.id !== seats.guest)) return false;
  if (
    v.players.some((p) =>
      [...p.combat.hitSwing, ...p.combat.hitSpecial].some((e) => !enemyIds.has(e)),
    )
  )
    return false;
  if (
    v.shots.some(
      (s) =>
        (s.owner !== null && !playerIds.has(s.owner)) ||
        s.hit.some((e) => !enemyIds.has(e)) ||
        s.hitP.some((p) => !playerIds.has(p)),
    )
  )
    return false;
  if (v.lastStand !== null && isJsonObject(v.lastStand) && !playerIds.has(String(v.lastStand.id)))
    return false;
  return v.enemies.every((e) => e.id < nextEnemyId);
}

/** Strict whole-boundary admission. Neither invalid data nor a mismatched room
 * can fall through to initial seeding. Returned mutable state is detached. */
export function readCheckpoint(shared: Record<string, JsonValue> | null): CheckpointRead {
  if (
    !shared ||
    (shared.checkpoint === undefined && shared.room === undefined && shared.snap === undefined)
  )
    return { kind: "absent" };
  const c = shared.checkpoint;
  const r = shared.room;
  if (!checkpoint(c) || !room(r) || c.room !== r.seq || (c.mode === "versus") !== (r.mode === "vs"))
    return { kind: "invalid" };
  return { kind: "ready", value: structuredClone(c), room: structuredClone(r) };
}
