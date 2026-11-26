import type { GroundEffect, Mine, Projectile, Unit } from "../sim/types";
import type { Snapshot } from "./snapshot";
import { isJsonNumber, isJsonObject, isJsonString } from "./json";
import type { JsonObject, JsonValue } from "./json";

const placed = (v: JsonObject) =>
  isJsonString(v.id) && isJsonString(v.team) && isJsonNumber(v.x) && isJsonNumber(v.y);

/** A host-written unit row: its identity and position, the fields a guest keys on. */
export const isUnitRow = (v: JsonValue | undefined): v is Unit =>
  isJsonObject(v) && placed(v) && isJsonString(v.kind) && isJsonNumber(v.hp);

/** A host-written projectile row. */
export const isProjectileRow = (v: JsonValue | undefined): v is Projectile =>
  isJsonObject(v) && placed(v) && isJsonString(v.ownerId) && isJsonString(v.kind);

/** A host-written mine row. */
export const isMineRow = (v: JsonValue | undefined): v is Mine =>
  isJsonObject(v) && placed(v) && isJsonNumber(v.armedAt) && isJsonNumber(v.expireAt);

/** A host-written ground-effect row. */
export const isGroundRow = (v: JsonValue | undefined): v is GroundEffect =>
  isJsonObject(v) && placed(v) && isJsonString(v.effect) && isJsonNumber(v.until);

/** Whether every value of `v` passes `row`. */
export const isRowRecord = <T extends JsonValue>(
  v: JsonValue | undefined,
  row: (item: JsonValue | undefined) => item is T,
): v is Record<string, T> & JsonObject =>
  isJsonObject(v) && Object.values(v).every((item) => row(item));

/** Whether every value of `v` is a number. */
export const isNumberRecord = (v: JsonValue | undefined): v is Record<string, number> =>
  isJsonObject(v) && Object.values(v).every((item) => isJsonNumber(item));

/** A host-written keyframe: every table holds rows a guest can adopt. */
export const isSnapshot = (v: JsonValue | undefined): v is Snapshot =>
  isJsonObject(v) &&
  isJsonNumber(v.now) &&
  isJsonNumber(v.gameTime) &&
  (v.phase === "playing" || v.phase === "ended") &&
  isRowRecord(v.units, isUnitRow) &&
  isRowRecord(v.projectiles, isProjectileRow) &&
  isRowRecord(v.mines, isMineRow) &&
  isJsonNumber(v.nextWaveAt) &&
  isJsonNumber(v.waveCount) &&
  isJsonNumber(v.seq) &&
  (v.winner === null || isJsonString(v.winner)) &&
  (v.grounds === undefined ||
    (Array.isArray(v.grounds) && v.grounds.every((g) => isGroundRow(g)))) &&
  (v.campRespawnAt === undefined || isNumberRecord(v.campRespawnAt));
