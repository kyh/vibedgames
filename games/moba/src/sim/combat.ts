// Combat: target acquisition, attack wind-up/resolve, projectiles, the central
// damage pipeline, deaths + bounties, and structure attackability gating.

import {
  CREEPS,
  ECON,
  STRUCTS,
  TOWER_RAMP_MAX,
  attackIntervalMs,
  enemyOf,
  levelForXp,
  respawnTime,
} from "../data/config";
import type { DamageType } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import { dist, dist2 } from "./math";
import {
  absorbShield,
  addStatus,
  computeDamage,
  effectiveAttackDamage,
  effectiveAttackSpeed,
  lifestealPct,
  spellAmp,
  tauntTarget,
  untargetable,
} from "./stats";
import { applyHeroLevel } from "./herokit";
import type { Projectile, ProjectileHit, Unit, World } from "./types";
import { nextId, rand } from "./types";

export function isEnemy(a: Unit, b: Unit): boolean {
  // Neutrals (jungle/Roshan) are hostile to both teams and allied to each other.
  if (a.neutral || b.neutral) return !(a.neutral && b.neutral);
  return a.team !== b.team;
}

export function targetable(v: Unit, opts: { allowStructure?: boolean } = {}): boolean {
  if (!v.alive) return false;
  if (untargetable(v)) return false;
  if (v.kind === "structure") {
    if (opts.allowStructure === false) return false;
    return v.structure?.attackable ?? false;
  }
  return true;
}

/** Nearest enemy a unit may auto-attack given its order + standard aggro. */
export function acquireTarget(w: World, u: Unit): Unit | null {
  const taunt = tauntTarget(u);
  if (taunt) {
    const t = w.units.get(taunt);
    if (t && targetable(t, { allowStructure: true })) return t;
  }
  // explicit attack order
  if (u.order.type === "attackUnit") {
    const t = w.units.get(u.order.targetId);
    if (t && isEnemy(u, t) && targetable(t, { allowStructure: true })) return t;
  }
  const range = u.attackRange + u.radius;
  if (u.kind === "structure") return acquireForStructure(w, u, range);

  // heroes/creeps: nearest targetable enemy in range. Units (heroes/creeps) are
  // preferred; with no unit in range, both will siege an attackable structure.
  let best: Unit | null = null;
  let bestD = Infinity;
  let bestStruct: Unit | null = null;
  let bestStructD = Infinity;
  for (const t of w.units.values()) {
    if (!isEnemy(u, t)) continue;
    if (!targetable(t, { allowStructure: true })) continue;
    const d2 = dist2(u, t);
    if (d2 > range * range) continue;
    // prefer the current attack target to avoid flip-flopping
    const bias = u.pendingAttack?.targetId === t.id ? 0.8 : 1;
    const score = d2 * bias;
    if (t.kind === "structure") {
      if (score < bestStructD) {
        bestStructD = score;
        bestStruct = t;
      }
    } else if (score < bestD) {
      bestD = score;
      best = t;
    }
  }
  return best ?? bestStruct;
}

/**
 * Tower aggro priority: an enemy hero attacking an allied hero in range >
 * nearest enemy creep > nearest enemy hero.
 */
function acquireForStructure(w: World, u: Unit, range: number): Unit | null {
  let creep: Unit | null = null;
  let creepD = Infinity;
  let hero: Unit | null = null;
  let heroD = Infinity;
  let priorityHero: Unit | null = null;
  for (const t of w.units.values()) {
    if (!isEnemy(u, t) || !t.alive || untargetable(t)) continue;
    if (t.kind === "structure") continue;
    const d2 = dist2(u, t);
    if (d2 > range * range) continue;
    if (t.kind === "creep") {
      if (d2 < creepD) {
        creepD = d2;
        creep = t;
      }
    } else if (t.kind === "hero") {
      if (d2 < heroD) {
        heroD = d2;
        hero = t;
      }
      // is this hero attacking an allied hero within tower range?
      const victimId =
        t.pendingAttack?.targetId ?? (t.order.type === "attackUnit" ? t.order.targetId : null);
      if (victimId) {
        const victim = w.units.get(victimId);
        if (
          victim &&
          victim.kind === "hero" &&
          victim.team === u.team &&
          dist(u, victim) <= range
        ) {
          priorityHero = t;
        }
      }
    }
  }
  return priorityHero ?? creep ?? hero;
}

/** Begin a wind-up attack if off cooldown and a target is in range. */
export function tryAttack(w: World, u: Unit, target: Unit): void {
  if (u.pendingAttack) return;
  const interval = attackIntervalMs(effectiveAttackSpeed(u, attackSpeedVsTarget(u, target)));
  if (w.now - u.lastAttackAt < interval) return;
  u.lastAttackAt = w.now;
  // face the target
  u.facing = target.x >= u.x ? 1 : -1;
  // wind-up: damage/projectile lands partway through the swing
  const windup = u.kind === "structure" ? 80 : u.projectileSpeed > 0 ? 180 : 230;
  u.pendingAttack = { targetId: target.id, resolveAt: w.now + windup };
}

function attackSpeedVsTarget(u: Unit, target: Unit): number {
  // stormcaller Hunter's Mark grants bonus AS vs the marked hero (status on u).
  // Match the exact id ("markAS:" + target.id) — an endsWith() test could collide
  // when one unit id is a suffix of another.
  const markId = "markAS:" + target.id;
  let bonus = 0;
  for (const s of u.statuses) {
    if (s.kind === "attackSpeed" && s.id === markId) bonus += s.amount;
  }
  return bonus;
}

/** Resolve any wind-ups whose timer elapsed: melee hit or projectile launch. */
export function resolvePendingAttacks(w: World): void {
  for (const u of w.units.values()) {
    const pa = u.pendingAttack;
    if (!pa) continue;
    if (w.now < pa.resolveAt) continue;
    u.pendingAttack = null;
    const target = w.units.get(pa.targetId);
    if (!target || !target.alive || !isEnemy(u, target)) continue;
    // out of range now? (kiting) — fizzle but keep cooldown spent. Must mirror
    // the acquire/chase formula (incl. target radius) or attacks on big-radius
    // targets (towers, the ancient) wind up and whiff forever.
    if (dist(u, target) > u.attackRange + u.radius + target.radius + 40) continue;

    let dmg = effectiveAttackDamage(u);
    // consume empower-next-attack (duskblade Q)
    const emp = u.statuses.find((s) => s.kind === "empowerNextAttack");
    if (emp && emp.kind === "empowerNextAttack") {
      dmg += emp.bonus;
      u.statuses = u.statuses.filter((s) => s !== emp);
    }
    // ±12% attack variance — breaks perfect creep-lane symmetry so waves push,
    // and adds a little life to every hit.
    dmg *= 0.88 + rand(w) * 0.24;

    const ampSelf = u.kind === "structure" ? 0 : spellAmp(u);

    // Boomtinker Powder Keg: passive bonus damage to buildings while ranked.
    const structBonus = u.kind === "hero" ? boomtinkerBuildingBonus(u, target) : 0;

    if (u.projectileSpeed > 0) {
      spawnAttackProjectile(w, u, target, dmg);
    } else {
      applySplash(w, u, target, dmg);
      dealDamage(w, u, target, dmg, "physical", {
        isAttack: true,
        attackerSpellAmp: ampSelf,
        structureBonusPct: structBonus,
      });
    }
    // tower ramp accounting
    if (u.kind === "structure" && u.structure) {
      if (u.structure.rampTargetId === target.id) {
        u.structure.rampStacks = Math.min(TOWER_RAMP_MAX, u.structure.rampStacks + 1);
      } else {
        u.structure.rampTargetId = target.id;
        u.structure.rampStacks = 0;
      }
    }
  }
}

/** Boomtinker Powder Keg: splash a fraction of attack damage around target. */
function applySplash(w: World, u: Unit, target: Unit, dmg: number): void {
  const sp = u.statuses.find((s) => s.kind === "splashAttacks");
  if (!sp || sp.kind !== "splashAttacks") return;
  sp.left -= 1;
  for (const o of w.units.values()) {
    if (o === target || !isEnemy(u, o) || !o.alive || untargetable(o)) continue;
    if (dist(o, target) <= sp.radius) {
      dealDamage(w, u, o, dmg * sp.pct, "physical", {});
    }
  }
  if (sp.left <= 0) u.statuses = u.statuses.filter((s) => s !== sp);
}

/** Boomtinker E (Powder Keg): passive % bonus damage to structures while ranked. */
function boomtinkerBuildingBonus(u: Unit, target: Unit): number {
  if (target.kind !== "structure" || u.hero?.defId !== "boomtinker") return 0;
  const rank = u.hero.abilities.E.rank;
  if (rank <= 0) return 0;
  const def = HERO_BY_ID["boomtinker"]?.abilities.E;
  return def ? valAt(def.values["passiveBuildingPct"], rank) : 0;
}

function spawnAttackProjectile(w: World, u: Unit, target: Unit, dmg: number): void {
  const kind =
    u.kind === "structure"
      ? "tower"
      : u.hero?.defId === "stormcaller" || u.creep?.ckind === "ranged"
        ? "arrow"
        : "bolt";
  // Stormcaller Windfoot: while the speed buff is up, auto-attacks apply a slow.
  const windfoot = u.statuses.some((s) => s.kind === "speed" && s.id === "stormcaller:E:ms");
  const onHit: ProjectileHit = windfoot
    ? { tag: "slow", pct: 0.12, duration: 0.8 }
    : { tag: "none" };
  const p: Projectile = {
    id: nextId(w, "p"),
    ownerId: u.id,
    team: u.team,
    x: u.x,
    y: u.y - 20,
    speed: u.projectileSpeed,
    targetId: target.id,
    tx: target.x,
    ty: target.y,
    damage: dmg,
    dtype: "physical",
    kind,
    radius: 0,
    onHit,
  };
  w.projectiles.set(p.id, p);
}

/** Spawn an ability projectile (homing or straight). */
export function spawnAbilityProjectile(w: World, p: Omit<Projectile, "id">): Projectile {
  const proj: Projectile = { ...p, id: nextId(w, "p") };
  w.projectiles.set(proj.id, proj);
  return proj;
}

export function stepProjectiles(w: World, dt: number): void {
  for (const p of w.projectiles.values()) {
    let tx = p.tx;
    let ty = p.ty;
    if (p.targetId) {
      const t = w.units.get(p.targetId);
      if (t && t.alive) {
        tx = t.x;
        ty = t.y - 16;
        p.tx = tx;
        p.ty = ty;
      } else if (p.radius === 0) {
        // homing single-target projectile whose target vanished: drop it
        w.projectiles.delete(p.id);
        continue;
      }
    }
    const dx = tx - p.x;
    const dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * dt;
    if (d <= step + 6) {
      impactProjectile(w, p, tx, ty);
      w.projectiles.delete(p.id);
      continue;
    }
    p.x += (dx / d) * step;
    p.y += (dy / d) * step;
  }
}

function impactProjectile(w: World, p: Projectile, x: number, y: number): void {
  const owner = w.units.get(p.ownerId);
  const amp = owner ? spellAmp(owner) : 0;
  const applyTo = (v: Unit) => {
    let dmg = p.damage;
    if (p.onHit && p.onHit.tag === "buildingBonus" && v.kind === "structure")
      dmg *= 1 + p.onHit.pct / 100;
    dealDamage(w, owner ?? null, v, dmg, p.dtype, {
      attackerSpellAmp: p.dtype === "magic" ? amp : 0,
    });
    const oh = p.onHit;
    if (oh && oh.tag === "slow") {
      addStatus(v, {
        kind: "slow",
        pct: oh.pct,
        until: w.now + oh.duration * 1000,
        id: `pslow:${p.id}`,
      });
    } else if (oh && oh.tag === "burn" && owner) {
      addStatus(v, {
        kind: "dot",
        dps: oh.dps,
        until: w.now + oh.duration * 1000,
        nextTick: w.now + 500,
        dtype: "magic",
        sourceId: owner.id,
        id: `pburn:${p.id}`,
      });
    }
  };
  if (p.radius > 0) {
    w.fx.push({
      t: "explosion",
      x,
      y,
      radius: p.radius,
      color: p.kind === "fireball" ? 0xff7a2a : 0xffd24d,
    });
    for (const v of w.units.values()) {
      // neutrals are enemies of every projectile's team (which is always radiant/dire)
      if (!v.alive || (!v.neutral && v.team === p.team)) continue;
      if (!targetable(v, { allowStructure: true })) continue;
      if (dist2(v, { x, y }) <= p.radius * p.radius) applyTo(v);
    }
  } else {
    const t = p.targetId ? w.units.get(p.targetId) : null;
    if (t && t.alive && (t.neutral || t.team !== p.team)) applyTo(t);
  }
}

export type DamageOpts = {
  isAttack?: boolean;
  crit?: boolean;
  attackerSpellAmp?: number;
  noLifesteal?: boolean;
  structureBonusPct?: number;
};

/** The central damage pipeline. attacker may be null (environment/DoT owner gone). */
export function dealDamage(
  w: World,
  attacker: Unit | null,
  victim: Unit,
  raw: number,
  dtype: DamageType,
  opts: DamageOpts,
): void {
  if (!victim.alive) return;
  // gating is absolute: nothing (orders, splash, projectiles) hurts a protected
  // structure, so the tier ladder can't be bypassed
  if (victim.kind === "structure" && victim.structure?.attackable === false) return;
  let amount = raw;
  if (opts.structureBonusPct && victim.kind === "structure")
    amount *= 1 + opts.structureBonusPct / 100;
  // creeps deal a class-specific multiplier to structures (siege 3.5×, melee 1.5×…)
  if (attacker?.kind === "creep" && attacker.creep && victim.kind === "structure") {
    amount *= CREEPS[attacker.creep.ckind].structureDamageMult;
  }
  // siege creeps take reduced damage from units (not structures)
  if (
    victim.kind === "creep" &&
    victim.creep?.ckind === "siege" &&
    attacker &&
    attacker.kind !== "structure"
  ) {
    amount *= CREEPS.siege.incomingFromUnitsMult;
  }
  let final = computeDamage(victim, amount, dtype, opts.attackerSpellAmp ?? 0);

  // reflect (ironvow Oathguard) — melee attackers take a cut back
  if (opts.isAttack && attacker && attacker.kind === "hero" && dist(attacker, victim) < 200) {
    const refl = victim.statuses.find((s) => s.kind === "reflect");
    if (refl && refl.kind === "reflect" && attacker.projectileSpeed === 0) {
      dealDamage(w, victim, attacker, final * refl.pct, "physical", {});
    }
  }

  const leftover = absorbShield(victim, final);
  victim.hp -= leftover;

  // assist/last-hit bookkeeping
  if (attacker && victim.hero) {
    victim.hero.recentDamageFrom[attacker.id] = w.now;
  }
  if (attacker && attacker.hero && opts.isAttack) {
    // lifesteal on attacks
    const ls = opts.noLifesteal ? 0 : lifestealPct(attacker);
    if (ls > 0 && leftover > 0) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + leftover * ls);
    }
  }

  if (leftover > 0) {
    // knockback/spray direction: away from the attacker (fallback: straight up)
    let nx = 0;
    let ny = -1;
    if (attacker) {
      const dx = victim.x - attacker.x;
      const dy = victim.y - attacker.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01) {
        nx = dx / d;
        ny = dy / d;
      }
    }
    w.fx.push({
      t: "hit",
      x: victim.x,
      y: victim.y - victim.radius,
      dtype,
      amount: Math.round(leftover),
      crit: opts.crit,
      targetId: victim.id,
      nx,
      ny,
      isAttack: opts.isAttack,
    });
  }

  if (victim.hp <= 0) handleDeath(w, victim, attacker);
}

function handleDeath(w: World, victim: Unit, killer: Unit | null): void {
  if (!victim.alive) return;
  victim.alive = false;
  victim.hp = 0;
  victim.pendingAttack = null;
  victim.order = { type: "idle" };
  victim.path = [];
  w.fx.push({ t: "death", x: victim.x, y: victim.y, unitId: victim.id, kind: victim.kind });

  if (victim.kind === "creep") {
    awardCreepKill(w, victim, killer);
  } else if (victim.kind === "hero" && victim.hero) {
    awardHeroKill(w, victim, killer);
    const h = victim.hero;
    // end any active channel so its ground zone (heal/storm) stops ticking from a
    // corpse — handleDeath is the only death path, and breakChannel isn't reachable
    // for a dead unit. Inlined to avoid a combat->abilities import cycle.
    if (h.channel) {
      const eff = h.channel.effect;
      h.channel = null;
      w.groundEffects = w.groundEffects.filter(
        (g) => !(g.ownerId === victim.id && g.effect === eff && g.channel),
      );
    }
    h.killStreak = 0;
    h.deaths += 1;
    const aeg = victim.statuses.find((s) => s.kind === "aegis");
    if (aeg) {
      // Aegis: revive instantly where they fell and consume the charge.
      victim.statuses = [];
      victim.alive = true;
      victim.hp = victim.maxHp;
      victim.mp = victim.maxMp;
      victim.pendingAttack = null;
      victim.order = { type: "idle" };
      w.fx.push({
        t: "notify",
        text: `${heroName(victim)} is reborn by the Aegis!`,
        tone: "neutral",
      });
      w.fx.push({ t: "levelup", x: victim.x, y: victim.y, unitId: victim.id });
    } else {
      h.respawnAt = w.now + respawnTime(h.level) * 1000;
    }
  } else if (victim.kind === "structure") {
    onStructureDown(w, victim, killer);
  }
}

function nearbyEnemyHeroes(w: World, victim: Unit, radius: number): Unit[] {
  const out: Unit[] = [];
  const r2 = radius * radius;
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.alive || !isEnemy(u, victim)) continue;
    if (dist2(u, victim) <= r2) out.push(u);
  }
  return out;
}

function awardCreepKill(w: World, victim: Unit, killer: Unit | null): void {
  if (!victim.creep) return;
  const cs = victim.creep;
  const def = CREEPS[cs.ckind];
  const [lo, hi] = cs.goldOverride ?? def.goldBounty;
  const xpBounty = cs.xpOverride ?? def.xpBounty;
  // neutrals (jungle/Roshan) reward whichever hero lands the kill — never a deny.
  const denied = !victim.neutral && killer != null && killer.team === victim.team;
  // last-hit gold to the killing hero
  if (killer && killer.hero) {
    if (!denied) {
      const gold = Math.round(lo + rand(w) * (hi - lo));
      killer.hero.gold += gold;
      killer.hero.lastHits += 1;
      w.fx.push({ t: "gold", x: victim.x, y: victim.y - 20, amount: gold, heroId: killer.id });
      // Roshan: drop an Aegis (one free revive) on the killer + announce it.
      if (cs.boss) {
        addStatus(killer, { kind: "aegis", until: w.now + 300_000 });
        w.fx.push({
          t: "notify",
          text: `${heroName(killer)}'s team slew Roshan — Aegis claimed!`,
          tone: "good",
        });
        w.fx.push({ t: "levelup", x: killer.x, y: killer.y, unitId: killer.id });
      }
    } else {
      // deny: ally last-hit, no gold to enemy, denier counts a deny
      killer.hero.denies += 1;
    }
  }
  // xp share among heroes that count this creep as an enemy (denies halve xp)
  const recipients = nearbyEnemyHeroes(w, victim, ECON.xpShareRadius);
  if (recipients.length > 0) {
    const xpEach = (xpBounty * (denied ? ECON.denyXpFraction : 1)) / recipients.length;
    for (const h of recipients) grantXp(w, h, xpEach);
  }
}

function heroName(u: Unit): string {
  return u.hero ? (HERO_BY_ID[u.hero.defId]?.name ?? u.hero.defId) : u.id;
}

function awardHeroKill(w: World, victim: Unit, killer: Unit | null): void {
  const vh = victim.hero;
  if (!vh) return;
  const streak = vh.killStreak;
  const streakBonus =
    streak >= 1 ? Math.min(ECON.streakBonusCap, ECON.streakBonusPerKill * streak) : 0;
  let bounty = ECON.heroKillBaseBounty + ECON.heroKillPerLevel * vh.level + streakBonus;
  if (streak >= 3 && killer) bounty += ECON.shutdownBonus; // shutting down a streak

  // assist credit: enemy heroes who damaged victim in last 15s
  const assisters: Unit[] = [];
  for (const [id, t] of Object.entries(vh.recentDamageFrom)) {
    if (w.now - t > 15000) continue;
    const h = w.units.get(id);
    if (h && h.hero && h.team !== victim.team && h.alive && h !== killer) assisters.push(h);
  }

  if (killer && killer.hero && killer.team !== victim.team) {
    killer.hero.gold += Math.round(bounty);
    killer.hero.kills += 1;
    killer.hero.killStreak += 1;
    w.fx.push({
      t: "gold",
      x: killer.x,
      y: killer.y - 20,
      amount: Math.round(bounty),
      heroId: killer.id,
    });
    w.fx.push({ t: "kill", killer: heroName(killer), victim: heroName(victim), team: killer.team });
  } else {
    w.fx.push({ t: "kill", killer: "", victim: heroName(victim), team: enemyOf(victim.team) });
  }
  if (assisters.length > 0) {
    const each = Math.round((bounty * ECON.assistFraction) / assisters.length);
    for (const a of assisters) {
      const ah = a.hero;
      if (!ah) continue;
      ah.gold += each;
      ah.assists += 1;
    }
  }
  // xp share for the kill among nearby enemies
  const recipients = nearbyEnemyHeroes(w, victim, ECON.xpShareRadius);
  const xpTotal = 100 + vh.level * 40;
  if (recipients.length > 0) for (const h of recipients) grantXp(w, h, xpTotal / recipients.length);
  vh.recentDamageFrom = {};
}

export function grantXp(w: World, hero: Unit, xp: number): void {
  if (!hero.hero) return;
  hero.hero.xp += xp;
  const newLevel = levelForXp(hero.hero.xp);
  while (hero.hero.level < newLevel) {
    hero.hero.level += 1;
    hero.hero.abilityPoints += 1;
    applyHeroLevel(hero);
    w.fx.push({ t: "levelup", x: hero.x, y: hero.y, unitId: hero.id });
  }
}

// ---- structures ------------------------------------------------------------
function onStructureDown(w: World, victim: Unit, killer: Unit | null): void {
  const st = victim.structure;
  if (!st) return;
  const def = STRUCTS[st.tier];
  w.fx.push({ t: "structureDown", x: victim.x, y: victim.y, team: victim.team, tier: st.tier });
  // gold: local to killer + team gold to all living allies
  if (killer && killer.hero && killer.team !== victim.team) {
    killer.hero.gold += def.bountyLocal;
  }
  const winnerTeam = enemyOf(victim.team);
  for (const u of w.units.values()) {
    if (u.kind === "hero" && u.hero && u.team === winnerTeam) u.hero.gold += def.bountyTeam;
  }
  if (st.tier === "ancient") {
    w.phase = "ended";
    w.winner = winnerTeam;
  }
}

/**
 * Recompute which structures are attackable. Lane: t2 after t1. Base towers
 * after any lane t2 of that team falls. Ancient after both base towers fall.
 */
export function updateStructureGating(w: World): void {
  const aliveStruct = (id: string): boolean => {
    const u = w.units.get(id);
    return !!u && u.alive;
  };
  for (const u of w.units.values()) {
    if (u.kind !== "structure" || !u.structure) continue;
    const st = u.structure;
    const team = u.team;
    const prefix = team === "radiant" ? "r" : "d";
    if (st.tier === "t1") st.attackable = true;
    else if (st.tier === "t2") {
      const lane = laneCode(st.lane);
      st.attackable = !aliveStruct(`${prefix}-${lane}-t1`);
    } else if (st.tier === "base") {
      // attackable once any lane t2 of this team is dead
      st.attackable = !aliveStruct(`${prefix}-top-t2`) || !aliveStruct(`${prefix}-bot-t2`);
    } else if (st.tier === "ancient") {
      st.attackable = !aliveStruct(`${prefix}-base-1`) && !aliveStruct(`${prefix}-base-2`);
    }
  }
}

function laneCode(lane: string): string {
  return lane === "bottom" ? "bot" : lane;
}
