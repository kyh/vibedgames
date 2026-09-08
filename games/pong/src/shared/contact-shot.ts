/** Charge is earned only at an authoritative paddle contact. */
export type ShotCharge =
  | { readonly kind: "charging"; readonly hits: 0 | 1 | 2 | 3 }
  | { readonly kind: "ready" }
  | { readonly kind: "armed" };
export type ContactKind = "slice" | "flat" | "topspin";
export const CHARGE_HITS = 4;
export const POWER_MULTIPLIER = 1.4;
export const POWER_SPEED_MAX = 17;
const ACTION_LIMIT = 0x7fffffff;
const ACTION_SEQUENCE_WINDOW = 64;
export type PowerAction = Readonly<{ seq: number; rally: number; seen: number; armed: boolean }>;

export function chargeHits(charge: ShotCharge): number {
  return charge.kind === "charging" ? charge.hits : CHARGE_HITS;
}

export function armCharge(charge: ShotCharge): ShotCharge {
  return charge.kind === "ready" ? { kind: "armed" } : charge;
}

export function cancelCharge(charge: ShotCharge): ShotCharge {
  return charge.kind === "armed" ? { kind: "ready" } : charge;
}

type AcceptedReturn =
  | { readonly charge: { kind: "charging"; hits: 0 }; readonly powered: true }
  | { readonly charge: ShotCharge; readonly powered: false };

export function acceptReturn(charge: ShotCharge): AcceptedReturn {
  if (charge.kind === "armed") return { charge: { kind: "charging", hits: 0 }, powered: true };
  if (charge.kind === "ready") return { charge, powered: false };
  switch (charge.hits) {
    case 0:
      return { charge: { kind: "charging", hits: 1 }, powered: false };
    case 1:
      return { charge: { kind: "charging", hits: 2 }, powered: false };
    case 2:
      return { charge: { kind: "charging", hits: 3 }, powered: false };
    case 3:
      return { charge: { kind: "ready" }, powered: false };
  }
}

/** Contact x is measured in the hitter's screen frame; slot B mirrors slot A.
 * Topspin dips the visual hop. Both flat and topspin retain the return angle. */
export function contactShot(offset: number, towardY: 1 | -1, speed: number, powered: boolean) {
  const screenOffset = Math.max(-1, Math.min(1, offset * towardY));
  const kind: ContactKind =
    screenOffset < -1 / 3 ? "slice" : screenOffset > 1 / 3 ? "topspin" : "flat";
  return {
    kind,
    spin: kind === "slice" ? -towardY * 0.8 : 0,
    lift: kind === "topspin" ? 0.55 : 1,
    speed: Math.min(
      POWER_SPEED_MAX,
      speed * (powered ? POWER_MULTIPLIER : kind === "topspin" ? 1.1 : 1),
    ),
  };
}

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Network snapshot and action boundaries parse untrusted JSON here. */
export function readCharge(hits: unknown, armed: unknown): ShotCharge | null {
  if (hits === 4) return armed === true ? { kind: "armed" } : { kind: "ready" };
  if (hits === 0 || hits === 1 || hits === 2 || hits === 3) {
    if (armed === true) return null;
    return { kind: "charging", hits };
  }
  return null;
}

function actionInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= ACTION_LIMIT
  );
}

export function readPowerAction(value: unknown): PowerAction | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("seq" in value) ||
    !("rally" in value) ||
    !("seen" in value) ||
    !("armed" in value)
  )
    return null;
  const { seq, rally, seen, armed } = value;
  return actionInteger(seq) &&
    seq > 0 &&
    actionInteger(rally) &&
    actionInteger(seen) &&
    typeof armed === "boolean"
    ? { seq, rally, seen, armed }
    : null;
}

export function freshPowerSequence(seq: number, lastSeq: number): boolean {
  return seq > lastSeq && seq <= lastSeq + ACTION_SEQUENCE_WINDOW;
}

/** Sequence consumes a request even when charge is insufficient: an early arm
 * cannot be replayed after a later hit. Freshness uses host snapshot ticks. */
export function freshPowerAction(
  action: PowerAction,
  lastSeq: number,
  rally: number,
  hostSeq: number,
  maxAge: number,
): boolean {
  return (
    freshPowerSequence(action.seq, lastSeq) &&
    action.rally === rally &&
    action.seen <= hostSeq &&
    hostSeq - action.seen <= maxAge
  );
}
