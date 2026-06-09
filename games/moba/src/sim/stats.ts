// Derived stats + status helpers. Effective stats = base (already including
// item bonuses, applied at purchase) modified by transient statuses.

import { physicalMultiplier, magicMultiplier } from "../data/config";
import type { DamageType } from "../data/config";
import type { Status, Unit } from "./types";

export function hasStatus(u: Unit, kind: Status["kind"]): boolean {
  for (const s of u.statuses) if (s.kind === kind) return true;
  return false;
}

export function disabled(u: Unit): boolean {
  // Can't issue actions while stunned (unless unstoppable).
  if (u.statuses.some((s) => s.kind === "unstoppable")) return false;
  return u.statuses.some((s) => s.kind === "stun");
}

export function rooted(u: Unit): boolean {
  if (u.statuses.some((s) => s.kind === "unstoppable")) return false;
  return u.statuses.some((s) => s.kind === "stun" || s.kind === "root");
}

export function silenced(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "silence" || s.kind === "stun");
}

export function tauntTarget(u: Unit): string | null {
  for (const s of u.statuses) if (s.kind === "taunt") return s.targetId;
  return null;
}

export function untargetable(u: Unit): boolean {
  return u.statuses.some((s) => s.kind === "untargetable");
}

/** Effective move speed (px/sec) after slows/speed buffs. */
export function effectiveMoveSpeed(u: Unit): number {
  let ms = u.moveSpeedBase;
  let slow = 0;
  let speedPct = 0;
  let flat = 0;
  for (const s of u.statuses) {
    if (s.kind === "slow") slow = Math.max(slow, s.pct); // strongest slow only
    else if (s.kind === "speed") {
      speedPct += s.pct;
      flat += s.flat;
    }
  }
  if (u.statuses.some((s) => s.kind === "unstoppable")) slow = 0;
  ms = (ms + flat) * (1 + speedPct) * (1 - slow);
  return Math.max(80, ms);
}

/** Effective attacks/sec after attack-speed buffs (status amounts are +points/100). */
export function effectiveAttackSpeed(u: Unit, extraVsTarget = 0): number {
  let bonusPoints = extraVsTarget;
  for (const s of u.statuses) if (s.kind === "attackSpeed") bonusPoints += s.amount;
  const mult = 1 + bonusPoints / 100;
  return Math.min(5, u.attackSpeedBase * mult);
}

export function effectiveArmor(u: Unit): number {
  let a = u.armor;
  for (const s of u.statuses) if (s.kind === "armorBonus") a += s.amount;
  return a;
}

export function effectiveAttackDamage(u: Unit): number {
  // base damage already includes items; abilities may add empower at hit time.
  return u.baseDamage;
}

export function spellAmp(u: Unit): number {
  let amp = u.bonusSpellAmp;
  for (const s of u.statuses) if (s.kind === "spellAmp") amp += s.pct;
  return amp;
}

export function damageReduction(u: Unit): number {
  let r = 0;
  for (const s of u.statuses) if (s.kind === "damageReduction") r = Math.max(r, s.pct);
  return r;
}

export function damageAmpOn(u: Unit): number {
  let amp = 0;
  for (const s of u.statuses) if (s.kind === "damageAmp") amp += s.pct;
  return amp;
}

export function lifestealPct(u: Unit): number {
  let p = u.bonusLifesteal;
  for (const s of u.statuses) if (s.kind === "lifesteal") p = Math.max(p, s.pct);
  return p;
}

/**
 * Compute final damage a victim takes from a raw hit. Returns the HP to remove
 * (after armor/resist, target damage-reduction and damage-amp). Shields are
 * consumed by the caller via absorbShield().
 */
export function computeDamage(
  victim: Unit,
  raw: number,
  dtype: DamageType,
  attackerSpellAmp = 0,
): number {
  let dmg = raw;
  if (dtype === "physical") {
    dmg *= physicalMultiplier(effectiveArmor(victim));
  } else if (dtype === "magic") {
    dmg *= 1 + attackerSpellAmp; // spell amp boosts magic
    dmg *= magicMultiplier(victim.kind === "hero");
  }
  // pure ignores armor/resist.
  dmg *= 1 + damageAmpOn(victim);
  dmg *= 1 - damageReduction(victim);
  return Math.max(0, dmg);
}

/** Remove `amount` from the unit's shields first; returns leftover damage. */
export function absorbShield(u: Unit, amount: number): number {
  let left = amount;
  for (const s of u.statuses) {
    if (s.kind !== "shield") continue;
    if (left <= 0) break;
    const used = Math.min(s.amount, left);
    s.amount -= used;
    left -= used;
  }
  // drop emptied shields
  u.statuses = u.statuses.filter((s) => s.kind !== "shield" || s.amount > 0.5);
  return left;
}

export function addStatus(u: Unit, s: Status): void {
  // Replace by (kind,id) so re-applying refreshes instead of stacking.
  const id = "id" in s ? s.id : undefined;
  if (id !== undefined) {
    u.statuses = u.statuses.filter((x) => !("id" in x && x.id === id && x.kind === s.kind));
  }
  u.statuses.push(s);
}

export function removeStatusesById(u: Unit, id: string): void {
  u.statuses = u.statuses.filter((x) => !("id" in x && x.id === id));
}

export function cleanseSlows(u: Unit): void {
  u.statuses = u.statuses.filter((s) => s.kind !== "slow");
}

export function expireStatuses(u: Unit, now: number): void {
  if (u.statuses.length === 0) return;
  u.statuses = u.statuses.filter((s) => s.until > now);
}
