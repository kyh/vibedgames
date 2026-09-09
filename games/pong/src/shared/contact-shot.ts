// Charged power shots and contact placement — pure rules, shared by the host
// simulation, the guest's snapshot parsing and the unit tests.

/** Charge is earned only at an authoritative paddle contact. */
export type ShotCharge =
  | { readonly kind: "charging"; readonly hits: 0 | 1 | 2 | 3 }
  | { readonly kind: "ready" }
  | { readonly kind: "armed" };
export type ContactKind = "slice" | "flat" | "topspin";
export const CHARGE_HITS = 4;
export const POWER_MULTIPLIER = 1.4;
export const POWER_SPEED_MAX = 17;

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
  if (charge.kind === "armed") {
    return { charge: { kind: "charging", hits: 0 }, powered: true };
  }
  if (charge.kind === "ready") {
    return { charge, powered: false };
  }
  switch (charge.hits) {
    case 0: {
      return { charge: { kind: "charging", hits: 1 }, powered: false };
    }
    case 1: {
      return { charge: { kind: "charging", hits: 2 }, powered: false };
    }
    case 2: {
      return { charge: { kind: "charging", hits: 3 }, powered: false };
    }
    case 3: {
      return { charge: { kind: "ready" }, powered: false };
    }
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
    lift: kind === "topspin" ? 0.55 : 1,
    speed: Math.min(
      POWER_SPEED_MAX,
      speed * (powered ? POWER_MULTIPLIER : kind === "topspin" ? 1.1 : 1),
    ),
    spin: kind === "slice" ? -towardY * 0.8 : 0,
  };
}

/* oxlint-disable anti-slop/no-unknown-parameters -- parses two fields of an untrusted snapshot. */
export function readCharge(hits: unknown, armed: unknown): ShotCharge | null {
  if (hits === 4) {
    return armed === true ? { kind: "armed" } : { kind: "ready" };
  }
  if (hits === 0 || hits === 1 || hits === 2 || hits === 3) {
    if (armed === true) {
      return null;
    }
    return { hits, kind: "charging" };
  }
  return null;
}
