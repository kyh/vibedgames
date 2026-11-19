import { physicalMultiplier, magicMultiplier } from "../data/config";
import type { DamageType } from "../data/config";
import type { Status, Unit } from "./types";

export const disabled = (u: Unit) => {
  if (u.statuses.some((s) => s.kind === "unstoppable")) {
    return false;
  }

  return u.statuses.some((s) => s.kind === "stun");
};

export const rooted = (u: Unit) => {
  if (u.statuses.some((s) => s.kind === "unstoppable")) {
    return false;
  }

  return u.statuses.some((s) => s.kind === "stun" || s.kind === "root");
};

export const silenced = (u: Unit) =>
  u.statuses.some((s) => s.kind === "silence" || s.kind === "stun");

export const tauntTarget = (u: Unit) => {
  for (const s of u.statuses) {
    if (s.kind === "taunt") {
      return s.targetId;
    }
  }

  return null;
};

export const untargetable = (u: Unit) => u.statuses.some((s) => s.kind === "untargetable");

/** Effective move speed (px/sec) after slows/speed buffs. */
export const effectiveMoveSpeed = (u: Unit) => {
  let ms = u.moveSpeedBase;
  let slow = 0;
  let speedPct = 0;
  let flat = 0;

  for (const s of u.statuses) {
    if (s.kind === "slow") {
      slow = Math.max(slow, s.pct);
    } else if (s.kind === "speed") {
      speedPct += s.pct;
      flat += s.flat;
    }
  }

  if (u.statuses.some((s) => s.kind === "unstoppable")) {
    slow = 0;
  }

  ms = (ms + flat) * (1 + speedPct) * (1 - slow);

  return Math.max(80, ms);
};

/** Effective attacks/sec after attack-speed buffs (status amounts are +points/100).
 *  `markAS:` statuses (Hunter's Mark) are target-conditional and supplied via
 *  `extraVsTarget` by the caller — skip them here so the bonus applies ONLY vs the
 *  marked hero and isn't also counted globally / double-counted vs that hero. */
export const effectiveAttackSpeed = (u: Unit, extraVsTarget = 0) => {
  let bonusPoints = extraVsTarget;

  for (const s of u.statuses) {
    if (s.kind === "attackSpeed" && !s.id.startsWith("markAS:")) {
      bonusPoints += s.amount;
    }
  }

  const mult = 1 + bonusPoints / 100;

  return Math.min(5, u.attackSpeedBase * mult);
};

export const effectiveArmor = (u: Unit) => {
  let a = u.armor;

  for (const s of u.statuses) {
    if (s.kind === "armorBonus") {
      a += s.amount;
    }
  }

  return a;
};

export const effectiveAttackDamage = (u: Unit) => u.baseDamage;

export const spellAmp = (u: Unit) => {
  let amp = u.bonusSpellAmp;

  for (const s of u.statuses) {
    if (s.kind === "spellAmp") {
      amp += s.pct;
    }
  }

  return amp;
};

export const damageReduction = (u: Unit) => {
  let r = 0;

  for (const s of u.statuses) {
    if (s.kind === "damageReduction") {
      r = Math.max(r, s.pct);
    }
  }

  return r;
};

export const damageAmpOn = (u: Unit) => {
  let amp = 0;

  for (const s of u.statuses) {
    if (s.kind === "damageAmp") {
      amp += s.pct;
    }
  }

  return amp;
};

export const lifestealPct = (u: Unit) => {
  let p = u.bonusLifesteal;

  for (const s of u.statuses) {
    if (s.kind === "lifesteal") {
      p = Math.max(p, s.pct);
    }
  }

  return p;
};

/**
 * Compute final damage a victim takes from a raw hit. Returns the HP to remove
 * (after armor/resist, target damage-reduction and damage-amp). Shields are
 * consumed by the caller via absorbShield().
 */
export const computeDamage = (
  victim: Unit,
  raw: number,
  dtype: DamageType,
  attackerSpellAmp = 0,
) => {
  let dmg = raw;

  if (dtype === "physical") {
    dmg *= physicalMultiplier(effectiveArmor(victim));
  } else if (dtype === "magic") {
    dmg *= 1 + attackerSpellAmp;
    dmg *= magicMultiplier(victim.kind === "hero");
  }

  dmg *= 1 + damageAmpOn(victim);
  dmg *= 1 - damageReduction(victim);

  return Math.max(0, dmg);
};

/** Remove `amount` from the unit's shields first; returns leftover damage. */
export const absorbShield = (u: Unit, amount: number) => {
  let left = amount;

  for (const s of u.statuses) {
    if (s.kind !== "shield") {
      continue;
    }

    if (left <= 0) {
      break;
    }

    const used = Math.min(s.amount, left);
    s.amount -= used;
    left -= used;
  }

  u.statuses = u.statuses.filter((s) => s.kind !== "shield" || s.amount > 0.5);

  return left;
};

export const addStatus = (u: Unit, s: Status) => {
  const id = "id" in s ? s.id : undefined;

  if (id !== undefined) {
    const list = u.statuses;

    for (let i = list.length - 1; i >= 0; i -= 1) {
      const x = list[i];

      if (x && "id" in x && x.id === id && x.kind === s.kind) {
        list.splice(i, 1);
      }
    }
  }

  u.statuses.push(s);
};

export const cleanseSlows = (u: Unit) => {
  u.statuses = u.statuses.filter((s) => s.kind !== "slow");
};

export const expireStatuses = (u: Unit, now: number) => {
  if (u.statuses.length === 0) {
    return;
  }

  u.statuses = u.statuses.filter((s) => s.until > now);
};
