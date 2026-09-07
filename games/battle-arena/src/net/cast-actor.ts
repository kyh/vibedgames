import { isJsonString, type JsonValue } from "../data/json";

/** Legacy or malformed FX never imply local ownership from position or champion. */
export function isLocalCast(unitId: JsonValue | undefined, localId: string): boolean {
  return localId.length > 0 && isJsonString(unitId) && unitId === localId;
}
