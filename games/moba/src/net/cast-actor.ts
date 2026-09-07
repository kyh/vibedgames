import type { MultiplayerClient } from "@vibedgames/multiplayer";

export type CastActor = { unitId: string; at: number };

/** Older peers omit this record. Validate the optional wire extension here;
 * malformed metadata cannot choose a body or reserve local audio priority. */
export function parseCastActor(
  value: MultiplayerClient["sharedState"][string] | undefined,
): CastActor | null {
  // oxlint-disable anti-slop/no-runtime-typeof -- Protocol boundary: establish both primitive fields before constructing CastActor.
  if (
    value === null ||
    typeof value !== "object" ||
    !("unitId" in value) ||
    typeof value.unitId !== "string" ||
    value.unitId.length === 0 ||
    value.unitId.length > 128 ||
    !("at" in value) ||
    typeof value.at !== "number" ||
    !Number.isFinite(value.at) ||
    value.at < 0
  )
    return null;
  // oxlint-enable anti-slop/no-runtime-typeof
  return { unitId: value.unitId, at: value.at };
}
