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

export const chargeHits = (charge: ShotCharge): number =>
  charge.kind === "charging" ? charge.hits : CHARGE_HITS;

export const armCharge = (charge: ShotCharge): ShotCharge =>
  charge.kind === "ready" ? { kind: "armed" } : charge;

export const cancelCharge = (charge: ShotCharge): ShotCharge =>
  charge.kind === "armed" ? { kind: "ready" } : charge;

type AcceptedReturn =
  | { readonly charge: { kind: "charging"; hits: 0 }; readonly powered: true }
  | { readonly charge: ShotCharge; readonly powered: false };

export const acceptReturn = (charge: ShotCharge): AcceptedReturn => {
  if (charge.kind === "armed") {
    return { charge: { hits: 0, kind: "charging" }, powered: true };
  }
  if (charge.kind === "ready") {
    return { charge, powered: false };
  }
  switch (charge.hits) {
    case 0: {
      return { charge: { hits: 1, kind: "charging" }, powered: false };
    }
    case 1: {
      return { charge: { hits: 2, kind: "charging" }, powered: false };
    }
    case 2: {
      return { charge: { hits: 3, kind: "charging" }, powered: false };
    }
    case 3: {
      return { charge: { kind: "ready" }, powered: false };
    }
    default: {
      return { charge, powered: false };
    }
  }
};

const contactKind = (screenOffset: number): ContactKind => {
  if (screenOffset < -1 / 3) {
    return "slice";
  }
  return screenOffset > 1 / 3 ? "topspin" : "flat";
};

const speedMultiplier = (kind: ContactKind, powered: boolean): number => {
  if (powered) {
    return POWER_MULTIPLIER;
  }
  return kind === "topspin" ? 1.1 : 1;
};

/** Contact x is measured in the hitter's screen frame; slot B mirrors slot A.
 * Topspin dips the visual hop. Both flat and topspin retain the return angle. */
export const contactShot = (offset: number, towardY: 1 | -1, speed: number, powered: boolean) => {
  const screenOffset = Math.max(-1, Math.min(1, offset * towardY));
  const kind = contactKind(screenOffset);
  return {
    kind,
    lift: kind === "topspin" ? 0.55 : 1,
    speed: Math.min(POWER_SPEED_MAX, speed * speedMultiplier(kind, powered)),
    spin: kind === "slice" ? -towardY * 0.8 : 0,
  };
};

/* oxlint-disable anti-slop/no-unknown-parameters -- parses two fields of an untrusted snapshot. */
export const readCharge = (hits: unknown, armed: unknown): ShotCharge | null => {
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
};
