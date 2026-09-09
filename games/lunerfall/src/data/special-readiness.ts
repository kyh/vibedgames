export type SpecialReadiness =
  | { kind: "ready" }
  | { kind: "busy" }
  | { kind: "cooldown"; remaining: number }
  | { kind: "unknown" };

interface SpecialBody {
  dead: boolean;
  downed: boolean;
  specialActive: boolean;
  attackStep: number;
  dashTime: number;
  hurtStun: number;
  specialCd: number;
}

/** The cast gates, read from either the local body or an accepted checkpoint. */
export function specialReadiness(body: SpecialBody): SpecialReadiness {
  if (body.dead || body.downed) {
    return { kind: "busy" };
  }
  if (body.specialCd > 0) {
    return { kind: "cooldown", remaining: body.specialCd };
  }
  if (body.specialActive || body.attackStep > 0 || body.dashTime > 0 || body.hurtStun > 0) {
    return { kind: "busy" };
  }
  return { kind: "ready" };
}
