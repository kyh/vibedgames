import { ENEMY_NAMES, HERO_NAMES } from "../data/animations";
import type { EnemyName } from "../data/animations";
import { isJsonObject, isJsonString } from "./json";
import type { JsonObject, JsonValue } from "./json";
import type {
  NetAck,
  NetBossRow,
  NetEdge,
  NetEnemyRow,
  NetLastStand,
  NetPlayerRow,
  NetProjRow,
  NetStatus,
  NetVersus,
  Snapshot,
} from "./snapshot";

const num = (v: JsonValue | undefined): v is number => Number.isFinite(v);
const int = (v: JsonValue | undefined): v is number => num(v) && Number.isSafeInteger(v);
const bool = (v: JsonValue | undefined): v is boolean => v === true || v === false;

const numbers = (v: JsonValue | undefined, length: number): v is number[] =>
  Array.isArray(v) && v.length === length && v.every(num);

const rows = <T extends JsonValue>(
  v: JsonValue | undefined,
  read: (row: JsonValue) => row is T,
): v is T[] => Array.isArray(v) && v.every(read);

const MAX_TICKS = 32;
const MAX_BITS = 4095;

export const readNetInputs = (v: JsonValue | undefined) => {
  if (!isJsonObject(v) || !int(v.seq) || !int(v.room) || !num(v.t) || !Array.isArray(v.ticks)) {
    return null;
  }

  const { ticks } = v;

  if (ticks.length === 0 || ticks.length > MAX_TICKS) {
    return null;
  }

  const bits: number[] = [];

  for (const t of ticks) {
    if (!int(t) || t < 0 || t > MAX_BITS) {
      return null;
    }

    bits.push(t);
  }

  return { room: v.room, seq: v.seq, t: v.t, ticks: bits };
};

const playerRow = (v: JsonValue): v is NetPlayerRow => numbers(v, 9);
const enemyRow = (v: JsonValue): v is NetEnemyRow => numbers(v, 6);
const bossRow = (v: JsonValue | undefined): v is NetBossRow => numbers(v, 6);
const projRow = (v: JsonValue): v is NetProjRow => numbers(v, 6);
const edgeRow = (v: JsonValue): v is NetEdge => numbers(v, 5);

const ack = (v: JsonValue): v is NetAck =>
  isJsonObject(v) && int(v.row) && int(v.ack) && int(v.age) && rows(v.edges, edgeRow);

const lastStand = (v: JsonValue | undefined): v is NetLastStand | null =>
  v === null || (isJsonObject(v) && num(v.bleed) && num(v.rev));

const versus = (v: JsonValue | undefined): v is NetVersus | null =>
  v === null ||
  (isJsonObject(v) &&
    ["waiting", "countdown", "fighting", "roundEnd", "matchEnd"].some((p) => p === v.phase) &&
    ["round", "t", "hostHp", "guestHp", "hostScore", "guestScore"].every((k) => num(v[k])) &&
    (v.winner === null || v.winner === "host" || v.winner === "guest"));

const stamp = (v: JsonObject) => ["t", "run", "term", "room"].every((k) => num(v[k]));

const isSnapshot = (v: JsonValue | undefined): v is Snapshot =>
  isJsonObject(v) &&
  stamp(v) &&
  rows(v.players, playerRow) &&
  rows(v.acks, ack) &&
  rows(v.enemies, enemyRow) &&
  (v.boss === null || bossRow(v.boss)) &&
  rows(v.proj, projRow) &&
  lastStand(v.lastStand) &&
  versus(v.vs);

export const readSnapshot = (v: JsonValue | undefined) => (isSnapshot(v) ? v : null);

const isStatus = (v: JsonValue | undefined): v is NetStatus =>
  isJsonObject(v) &&
  ["hearts", "maxHearts", "gold", "score", "biome", "depth"].every((k) => num(v[k])) &&
  bool(v.cleared) &&
  bool(v.over);

export const readStatus = (v: JsonValue | undefined) => (isStatus(v) ? v : null);

const castPlayer = (v: JsonValue): v is [string, string] =>
  Array.isArray(v) && v.length === 2 && isJsonString(v[0]) && isJsonString(v[1]);

const castEnemy = (v: JsonValue): v is [number, string, number] =>
  Array.isArray(v) && v.length === 3 && int(v[0]) && isJsonString(v[1]) && int(v[2]);

export const readCast = (v: JsonValue | undefined) =>
  isJsonObject(v) && rows(v.players, castPlayer) && rows(v.enemies, castEnemy)
    ? { enemies: v.enemies, players: v.players }
    : null;

export const parseHero = (v: JsonValue | undefined) => HERO_NAMES.find((h) => h === v) ?? null;

export const parseEnemy: (v: string) => EnemyName = (v) =>
  ENEMY_NAMES.find((e) => e === v) ?? "warrior";
