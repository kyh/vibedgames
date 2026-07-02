// Derived stats + status resolvers. recomputeStats() bakes champ base+growth+
// items onto the Unit; the effective* helpers fold transient statuses on top.
import { CHAMP_BY_ID, champStatAt } from "../data/champions";
import { HERO_MAGIC_RESIST, type DamageType } from "../data/config";
import { sumItemStats } from "../data/items";
import { clamp } from "./math";
import type { Status, Unit } from "./types";

/** Recompute a hero's derived combat stats from champ + level + items.
 *  Preserves the current hp/mp *fraction* when maxima change. */
export function recomputeStats(u: Unit): void {
  const def = CHAMP_BY_ID[u.champId];
  if (!def) return;
  const lvl = u.level;
  const items = sumItemStats(u.items);

  const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 1;

  u.maxHp = champStatAt(def, "hp", lvl) + items.hp;
  u.hpRegen = champStatAt(def, "hpRegen", lvl) + items.hpRegen;
  u.baseDamage = champStatAt(def, "damage", lvl) + items.damage;
  u.armor = champStatAt(def, "armor", lvl) + items.armor;
  u.attackRange = champStatAt(def, "attackRange", lvl);
  u.attackSpeed = champStatAt(def, "attackSpeed", lvl) + items.attackSpeed / 100;
  u.moveSpeed = champStatAt(def, "moveSpeed", lvl) + items.moveSpeed;
  u.projectileSpeed = champStatAt(def, "projectileSpeed", lvl);
  u.magicResist = HERO_MAGIC_RESIST + items.magicResist;
  u.abilityPower = items.abilityPower;
  u.lifesteal = items.lifesteal;

  u.hp = u.alive ? Math.min(u.maxHp, hpFrac * u.maxHp) : u.hp;
}

// ── Status helpers ───────────────────────────────────────────────────────────

export function addStatus(u: Unit, st: Status): void {
  if (st.id) {
    const i = u.statuses.findIndex((s) => s.kind === st.kind && s.id === st.id);
    if (i >= 0) {
      u.statuses[i] = st;
      return;
    }
  }
  u.statuses.push(st);
}

export function expireStatuses(u: Unit, now: number): void {
  if (u.statuses.length === 0) return;
  u.statuses = u.statuses.filter((s) => s.until > now);
}

export function hasStatus(u: Unit, kind: Status["kind"]): boolean {
  return u.statuses.some((s) => s.kind === kind);
}

export const isUnstoppable = (u: Unit): boolean => hasStatus(u, "unstoppable");
/** Can't attack or act (stun; hex polymorphs share the gate — mushrooms don't swing). */
export const isDisabled = (u: Unit): boolean =>
  !isUnstoppable(u) && (hasStatus(u, "stun") || hasStatus(u, "hex"));
export const isRooted = (u: Unit): boolean =>
  !isUnstoppable(u) && (hasStatus(u, "stun") || hasStatus(u, "root"));
export const isSilenced = (u: Unit): boolean =>
  hasStatus(u, "stun") || hasStatus(u, "silence") || hasStatus(u, "hex");
export const isStealthed = (u: Unit): boolean => hasStatus(u, "stealth");
/** Can't be auto-attacked / homed onto by enemies. */
export const isUntargetable = (u: Unit): boolean =>
  hasStatus(u, "untargetable") || hasStatus(u, "stealth");

/** Remove disables + slows (cleanse). Strips hex too — a cleanse un-mushrooms. */
export function cleanseDisables(u: Unit): void {
  u.statuses = u.statuses.filter(
    (s) => s.kind !== "stun" && s.kind !== "root" && s.kind !== "silence" && s.kind !== "slow" && s.kind !== "hex",
  );
}

export function breakStealth(u: Unit): void {
  u.statuses = u.statuses.filter((s) => s.kind !== "stealth");
}

// ── Effective (status-folded) stats ──────────────────────────────────────────

export function effectiveMoveSpeed(u: Unit): number {
  let speedPct = 0;
  let strongestSlow = 0;
  for (const s of u.statuses) {
    if (s.kind === "speed") speedPct += s.pct;
    else if (s.kind === "slow" || s.kind === "hex") strongestSlow = Math.max(strongestSlow, s.pct);
  }
  if (isUnstoppable(u)) strongestSlow = 0;
  const ms = u.moveSpeed * (1 + speedPct / 100) * (1 - strongestSlow / 100);
  return Math.max(2, ms);
}

export function effectiveArmor(u: Unit): number {
  let bonus = 0;
  for (const s of u.statuses) if (s.kind === "armor") bonus += s.amount;
  return u.armor + bonus;
}

export function effectiveAttackSpeed(u: Unit): number {
  let pct = 0;
  for (const s of u.statuses) if (s.kind === "attackSpeed") pct += s.amount;
  return clamp(u.attackSpeed * (1 + pct / 100), 0.1, 5);
}

export function damageAmpOn(u: Unit): number {
  let pct = 0;
  for (const s of u.statuses) if (s.kind === "damageAmp") pct += s.pct;
  return pct / 100;
}

// ── Damage + shields ─────────────────────────────────────────────────────────

/** Mitigate raw damage by type. attackerAp adds % to magic damage. */
export function computeDamage(
  victim: Unit,
  raw: number,
  dtype: DamageType,
  attackerAp = 0,
): number {
  let dmg = raw;
  if (dtype === "physical") {
    const armor = effectiveArmor(victim);
    const k = 0.06 * armor;
    dmg *= 1 - k / (1 + Math.abs(k));
  } else if (dtype === "magic") {
    dmg *= 1 + attackerAp;
    dmg *= 1 - clamp(victim.magicResist, -1, 0.85);
  }
  dmg *= 1 + damageAmpOn(victim);
  return Math.max(0, dmg);
}

/** Consume shield statuses; returns leftover damage to apply to hp. */
export function absorbShield(u: Unit, dmg: number): number {
  let remaining = dmg;
  for (const s of u.statuses) {
    if (s.kind !== "shield") continue;
    if (remaining <= 0) break;
    const used = Math.min(s.amount, remaining);
    s.amount -= used;
    remaining -= used;
  }
  u.statuses = u.statuses.filter((s) => s.kind !== "shield" || s.amount > 0.5);
  return remaining;
}
