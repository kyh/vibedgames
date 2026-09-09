// Damage pipeline, basic attacks, knockback, death/respawn, projectiles.
import { CHAMP_BY_ID } from "../data/champions";
import type { RhythmStep } from "../data/champions";
import { strikeMs, swingClip } from "../data/clip-timing";
import {
  KEG_BLAST,
  PROP_COIN_CHANCE,
  PROP_COIN_GOLD,
  PROP_RESPAWN_MS,
  destructibleProps,
} from "../data/props";
import { MELEE_HALF_ANGLE, MELEE_OVERREACH, RANGED_BASIC_HIT_RADIUS } from "./combat-geometry";
import { ATTACK_VARIANCE, attackIntervalMs, respawnTime } from "../data/config";
import type { DamageType } from "../data/config";
import { angleDelta, angleOf, norm, rand } from "./math";
import {
  absorbShield,
  addStatus,
  breakStealth,
  computeDamage,
  effectiveAttackSpeed,
  isDisabled,
  isStealthed,
  isUntargetable,
} from "./stats";
import type { Projectile, Unit, World } from "./types";
import { nextId } from "./types";
import { awardCreepKill, awardKill } from "./economy";

export const isEnemy = (a: Unit, b: Unit): boolean => a.team !== b.team;

/** Anything a swing/blast can BREAK in addition to its real targets. */
export const isBreakable = (u: Unit): boolean => u.kind === "prop" && u.alive;

// max enemies a swing damages
const MELEE_CLEAVE_CAP = 3;
// secondary targets take half — caps AoE DPS at ~2× single
const MELEE_CLEAVE_FALLOFF = 0.5;

/** Melee reach for the cleave / its VFX. */
const meleeReach = (u: Unit): number => u.attackRange + MELEE_OVERREACH;

const UNIFORM_SWING: RhythmStep = { dmgMult: 1, timeMult: 1 };
/** The rhythm step of the swing this unit most recently STARTED — paces the
 *  next swing (timeMult), weights its damage (dmgMult), and carries a ranged
 *  swing's slow rider (slow). Uniform for creeps and champs with no rhythm.
 *  WHEN the swing connects comes from the clip's measured contact frame
 *  (data/clip-timing.ts), not from here. */
const lastSwingStep = (u: Unit): RhythmStep => {
  const rhythm = CHAMP_BY_ID[u.champId]?.basicRhythm;
  if (!rhythm || rhythm.length === 0 || u.swingCount < 1) {
    return UNIFORM_SWING;
  }
  return rhythm[(u.swingCount - 1) % rhythm.length] ?? UNIFORM_SWING;
};

// ── Central damage ───────────────────────────────────────────────────────────
export interface DamageOpts {
  isAttack?: boolean;
  ap?: number;
  silentFx?: boolean;
  forceCrit?: boolean;
}

export const applyKnockback = (
  u: Unit,
  fromX: number,
  fromY: number,
  force: number,
  w: World,
): void => {
  if (u.statuses.some((s) => s.kind === "unstoppable")) {
    return;
  }
  const d = norm(u.x - fromX, u.y - fromY);
  u.kbx = d.x * force;
  u.kby = d.y * force;
  u.kbUntil = w.now + 260;
};

export const handleDeath = (w: World, victim: Unit, killerId: string | null): void => {
  victim.alive = false;
  victim.vx = 0;
  victim.vy = 0;
  victim.hp = 0;
  victim.pendingAttack = null;
  victim.statuses = [];
  victim.kbUntil = 0;
  victim.dashUntil = 0;
  // clear stale intent so a dead guest's last input doesn't act on respawn
  victim.attackHeld = false;
  victim.moveX = 0;
  victim.moveY = 0;
  victim.empowerNext = 0;
  victim.ambush = false;
  victim.queuedCast = null;

  if (victim.kind === "prop") {
    // oxlint-disable-next-line no-use-before-define -- breakProp → dealDamage → handleDeath → breakProp is a cycle; one edge has to point forward
    breakProp(w, victim, killerId);
    return;
  }
  w.fx.push({ by: killerId ?? "", t: "death", team: victim.team, x: victim.x, y: victim.y });

  if (victim.kind === "hero") {
    victim.deaths += 1;
    victim.killStreak = 0;
    // hidden mercy ramp: a kill-less human dying to a bot earns softening;
    // any other death decays it (only ever consulted when World.soloMercy)
    if (!victim.isBot) {
      victim.mercy =
        killerId !== null && killerId.startsWith("bot:") && victim.kills === 0
          ? Math.min(3, victim.mercy + 1)
          : Math.max(0, victim.mercy - 1);
    }
    victim.respawnAt = w.now + respawnTime(victim.level) * 1000;
    awardKill(w, killerId, victim);
  } else if (victim.kind === "creep") {
    // linger for the death anim, then cleanup
    victim.respawnAt = w.now + 1200;
    awardCreepKill(w, killerId, victim);
  }
};

/** Hidden solo mercy (opt-in, offline): soften AI damage on a struggling human. */
const mercyScale = (w: World, attacker: Unit | null, victim: Unit): number =>
  w.soloMercy && attacker?.isBot && !victim.isBot && victim.mercy > 0 ? 1 - 0.07 * victim.mercy : 1;

/** Credit the attacker for a landed hit: kill-window attribution, then
 *  lifesteal — never off the furniture. */
const creditAttacker = (
  w: World,
  attacker: Unit,
  victim: Unit,
  dealt: number,
  isAttack: boolean | undefined,
): void => {
  victim.recentDamageFrom[attacker.ownerId] = w.now;
  if (isAttack && attacker.lifesteal > 0 && attacker.alive && victim.kind !== "prop") {
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + dealt * attacker.lifesteal);
  }
};

/** Returns true when the hit was HEAVY (≥18% of the victim's max HP) — the
 *  render heavy/crit tier and the primary-target shove key off it. */
export const dealDamage = (
  w: World,
  attacker: Unit | null,
  victim: Unit,
  raw: number,
  dtype: DamageType,
  opts: DamageOpts = {},
): boolean => {
  if (!victim.alive || raw <= 0) {
    return false;
  }
  const ap = opts.ap ?? attacker?.abilityPower ?? 0;
  const final = computeDamage(victim, raw, dtype, ap) * mercyScale(w, attacker, victim);
  // props never crit (every hit would clear their 18% bar → gold-ring spam)
  const heavy = victim.kind !== "prop" && (opts.forceCrit === true || final >= victim.maxHp * 0.18);
  const leftover = absorbShield(victim, final);
  victim.hp -= leftover;
  victim.lastHitAt = w.now;

  if (attacker) {
    creditAttacker(w, attacker, victim, leftover, opts.isAttack);
  }

  const dir = attacker ? norm(victim.x - attacker.x, victim.y - attacker.y) : { x: 0, y: 1 };
  victim.lastHitDx = dir.x;
  victim.lastHitDy = dir.y;
  if (!opts.silentFx) {
    w.fx.push({
      amount: Math.round(final),
      by: attacker?.id ?? "",
      crit: heavy,
      dtype,
      dx: dir.x,
      dy: dir.y,
      t: "hit",
      to: victim.id,
      x: victim.x,
      y: victim.y,
    });
  }

  if (victim.hp <= 0) {
    handleDeath(w, victim, attacker?.ownerId ?? null);
  }
  return heavy;
};

/** A destructible prop shatters: debris fx, maybe a keg blast (damages the
 *  breaker's ENEMIES — herding foes onto kegs is the play), maybe a coin. */
const breakProp = (w: World, prop: Unit, killerId: string | null): void => {
  const spec = destructibleProps()[prop.slot];
  prop.respawnAt = w.now + PROP_RESPAWN_MS;
  w.fx.push({
    explosive: spec?.explosive,
    model: prop.champId,
    t: "propBreak",
    x: prop.x,
    y: prop.y,
  });

  if (spec?.explosive) {
    // the breaker owns the blast: it hurts THEIR enemies (and other props)
    const breaker =
      killerId === null
        ? null
        : ([...w.units.values()].find((u) => u.kind === "hero" && u.ownerId === killerId) ?? null);
    for (const t of w.units.values()) {
      if (!t.alive || t === prop) {
        continue;
      }
      const inRange =
        (t.x - prop.x) ** 2 + (t.y - prop.y) ** 2 <= (KEG_BLAST.radius + t.radius) ** 2;
      if (!inRange) {
        continue;
      }
      if (isBreakable(t)) {
        // chain-pop neighbors
        dealDamage(w, breaker, t, KEG_BLAST.damage, "pure", {});
      } else if (
        (t.kind === "hero" || t.kind === "creep") &&
        (!breaker || isEnemy(breaker, t)) &&
        !isUntargetable(t)
      ) {
        dealDamage(w, breaker, t, KEG_BLAST.damage, "magic", {});
        if (t.alive) {
          applyKnockback(t, prop.x, prop.y, 5, w);
        }
      }
    }
    w.fx.push({ kind: "keg", radius: KEG_BLAST.radius, t: "explosion", x: prop.x, y: prop.y });
  }

  // lucky drop: a small gold coin, claimable immediately
  if (rand(w) < PROP_COIN_CHANCE) {
    w.coins.push({
      expireAt: w.now + 9000,
      fromX: prop.x,
      fromY: prop.y,
      gold: PROP_COIN_GOLD,
      id: nextId(w, "coin"),
      landAt: w.now,
      x: prop.x,
      y: prop.y,
    });
  }
};

// ── Projectiles ──────────────────────────────────────────────────────────────
export interface SpawnProjArgs {
  target?: Unit | null;
  dirX?: number;
  dirY?: number;
  damage: number;
  dtype: DamageType;
  kind: string;
  speed: number;
  // splash
  radius: number;
  // collision fatness (default 0.55)
  hitRadius?: number;
  range: number;
  pierce?: boolean;
  isAttack?: boolean;
  // detonate the splash at max range (aim-point casts)
  burstAtEnd?: boolean;
  onHit?: Projectile["onHit"];
  // render-only: fired from up in the air (aerial volleys)
  launchH?: number;
}

/** Statuses a projectile carries to its victim. Props never take them — a
 *  slowed barrel is nonsense, and it would spam the wire with dead statuses.
 *  Every rider is addStatus'd under a fixed per-source id, so a repeat hit
 *  (a piercing arrow, an every-3rd-shot cripple) REFRESHES one status instead
 *  of stacking a wall of them. */
const applyOnHit = (w: World, p: Projectile, u: Unit): void => {
  if (u.kind === "prop") {
    return;
  }
  const h = p.onHit;
  if (h.tag === "slow") {
    addStatus(u, {
      id: `${p.kind}-slow`,
      kind: "slow",
      pct: h.pct,
      until: w.now + h.duration * 1000,
    });
  } else if (h.tag === "root") {
    addStatus(u, { id: `${p.kind}-root`, kind: "root", until: w.now + h.duration * 1000 });
  } else if (h.tag === "burn") {
    addStatus(u, {
      dps: h.dps,
      dtype: "magic",
      id: `${p.kind}-burn`,
      kind: "dot",
      nextTick: w.now + 500,
      sourceId: p.ownerId,
      until: w.now + h.duration * 1000,
    });
  }
};

/** Detonate a splash projectile at its current position. The blast reaches a
 *  unit's EDGE (radius + u.radius) — a fat-hitbox bolt bursts short of its
 *  victim's center, so a center-only test would cheat the splash. */
const burstProjectile = (w: World, p: Projectile): void => {
  const owner = w.units.get(p.ownerId) ?? null;
  for (const u of w.units.values()) {
    if (!u.alive || u.kind === "boss" || u.team === p.team) {
      continue;
    }
    const reach = p.radius + u.radius;
    if ((u.x - p.x) ** 2 + (u.y - p.y) ** 2 <= reach * reach) {
      dealDamage(w, owner, u, p.damage, p.dtype, { ap: owner?.abilityPower, isAttack: p.isAttack });
      applyOnHit(w, p, u);
    }
  }
  w.fx.push({ kind: p.kind, radius: p.radius, t: "explosion", x: p.x, y: p.y });
};

const onProjectileHit = (w: World, p: Projectile, primary: Unit): void => {
  const owner = w.units.get(p.ownerId) ?? null;
  if (p.radius > 0) {
    // splash: everyone (incl primary) within radius
    burstProjectile(w, p);
  } else {
    dealDamage(w, owner, primary, p.damage, p.dtype, {
      ap: owner?.abilityPower,
      isAttack: p.isAttack,
    });
    applyOnHit(w, p, primary);
  }
};

export const spawnProjectile = (w: World, owner: Unit, a: SpawnProjArgs): void => {
  let dx = a.dirX ?? 0;
  let dy = a.dirY ?? 0;
  const d = a.target ? norm(a.target.x - owner.x, a.target.y - owner.y) : norm(dx, dy);
  dx = d.x;
  dy = d.y;
  const p: Projectile = {
    burstAtEnd: a.burstAtEnd ?? false,
    damage: a.damage,
    dtype: a.dtype,
    hitIds: [],
    hitRadius: a.hitRadius ?? 0.55,
    id: nextId(w, "p"),
    isAttack: a.isAttack ?? false,
    kind: a.kind,
    launchH: a.launchH ?? 0,
    onHit: a.onHit ?? { tag: "none" },
    ownerId: owner.id,
    pierce: a.pierce ?? false,
    radius: a.radius,
    range: a.range,
    speed: a.speed,
    targetId: a.target ? a.target.id : null,
    team: owner.team,
    traveled: 0,
    vx: dx * a.speed,
    vy: dy * a.speed,
    x: owner.x + dx * (owner.radius + 0.3),
    y: owner.y + dy * (owner.radius + 0.3),
  };
  w.projectiles.set(p.id, p);
};

/** Test one in-flight projectile against every unit it could reach. Returns
 *  true when the shot is spent (a non-piercing hit). */
const scanProjectileHits = (w: World, p: Projectile): boolean => {
  for (const u of w.units.values()) {
    if (!u.alive || u.kind === "boss") {
      continue;
    }
    if (u.team === p.team || u.id === p.ownerId) {
      continue;
    }
    if (p.hitIds.includes(u.id)) {
      continue;
    }
    if (isUntargetable(u)) {
      continue;
      // dash i-frames: the shot passes through
    }
    const reach = p.hitRadius + u.radius;
    const overlap = (u.x - p.x) ** 2 + (u.y - p.y) ** 2 <= reach * reach;
    if (overlap) {
      onProjectileHit(w, p, u);
      if (!p.pierce) {
        return true;
      }
      p.hitIds.push(u.id);
    }
  }
  return false;
};

/** End of flight without a hit: aim-point casts detonate where the player
 *  aimed (snapped back to the exact range point — a 30Hz tick can overshoot);
 *  everything else visibly FIZZLES instead of vanishing mid-air. */
const expireProjectile = (w: World, p: Projectile): void => {
  const over = p.traveled - p.range;
  if (over > 0 && p.speed > 0) {
    p.x -= (p.vx / p.speed) * over;
    p.y -= (p.vy / p.speed) * over;
  }
  if (p.burstAtEnd && p.radius > 0) {
    burstProjectile(w, p);
  } else {
    w.fx.push({ kind: p.kind, t: "fizzle", x: p.x, y: p.y });
  }
};

export const stepProjectiles = (w: World, dt: number): void => {
  // oxlint-disable-next-line unicorn/no-useless-spread -- the loop deletes from w.projectiles, so the walk needs its own snapshot
  for (const p of [...w.projectiles.values()]) {
    // light homing for auto-attack arrows/bolts
    if (p.targetId) {
      const t = w.units.get(p.targetId);
      if (t && t.alive && !isUntargetable(t)) {
        const d = norm(t.x - p.x, t.y - p.y);
        p.vx = d.x * p.speed;
        p.vy = d.y * p.speed;
      }
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.traveled += p.speed * dt;

    const consumed = scanProjectileHits(w, p);
    if (consumed || p.traveled >= p.range) {
      if (!consumed) {
        expireProjectile(w, p);
      }
      w.projectiles.delete(p.id);
    }
  }
};

/** One resolved swing: the damage it carries and the facing it landed on. */
interface SwingHit {
  raw: number;
  ambush: boolean;
  fx: number;
  fy: number;
  step: RhythmStep;
}

/** A "spin" swing (rhythm aoe) whirls all the way around: every enemy inside
 *  the radius takes full damage, no cone or cleave cap. Props shatter too. */
const doSpinHit = (w: World, u: Unit, s: SwingHit, aoe: number): void => {
  for (const t of w.units.values()) {
    if (t === u || !t.alive) {
      continue;
    }
    if (t.kind === "hero" || t.kind === "creep") {
      if (!isEnemy(u, t) || isUntargetable(t)) {
        continue;
      }
    } else if (!isBreakable(t)) {
      continue;
    }
    if (Math.hypot(t.x - u.x, t.y - u.y) > aoe + t.radius) {
      continue;
    }
    dealDamage(w, u, t, s.raw, u.attackDamageType, { forceCrit: s.ambush, isAttack: true });
  }
  w.fx.push({ dx: s.fx, dy: s.fy, r: aoe, t: "strike", tag: "spin", x: u.x, y: u.y });
};

/** The shot leaves NOW — the release frame: muzzle flash + shoulder kick land
 *  on the same tick the arrow/bolt spawns. */
const doRangedHit = (w: World, u: Unit, s: SwingHit): void => {
  w.fx.push({
    ang: u.facing,
    dtype: u.attackDamageType,
    melee: false,
    r: 0.8,
    t: "swing",
    x: u.x + s.fx * 0.45,
    y: u.y + s.fy * 0.45,
  });
  if (w.now >= u.kbUntil) {
    u.kbx = s.fx * -1.4;
    u.kby = s.fy * -1.4;
    u.kbUntil = w.now + 120;
  }
  // per-champ basic behavior: ranger arrows PIERCE the line; caster bolts
  // burst in a small splash (data/champions `basic`)
  const basic = CHAMP_BY_ID[u.champId]?.basic;
  spawnProjectile(w, u, {
    damage: s.raw,
    dirX: s.fx,
    dirY: s.fy,
    dtype: u.attackDamageType,
    // fatter collision on basics — ranged champs should land shots without
    // pixel-perfect aim (abilities keep the tight default)
    hitRadius: RANGED_BASIC_HIT_RADIUS,
    isAttack: true,
    kind: u.attackKind,
    // the KITE TOOL: this rhythm beat's slow rides the shot to its victim
    // (every 3rd arrow cripples / bolt chills — see champions basicRhythm)
    onHit: s.step.slow
      ? { duration: s.step.slow.dur, pct: s.step.slow.pct, tag: "slow" }
      : { tag: "none" },
    pierce: basic?.pierce ?? false,
    radius: basic?.splash ?? 0,
    range: u.attackRange + 5,
    speed: u.projectileSpeed,
  });
};

/** Enemies inside the melee cone, nearest first (ties broken by id, so every
 *  client resolves the same order). Props in the cone break for free here —
 *  they never eat the cleave cap. */
const meleeConeHits = (w: World, u: Unit, raw: number): { t: Unit; d: number }[] => {
  const reach = meleeReach(u);
  const hits: { t: Unit; d: number }[] = [];
  for (const t of w.units.values()) {
    if (t === u || !t.alive) {
      continue;
    }
    const rx = t.x - u.x;
    const ry = t.y - u.y;
    const d = Math.hypot(rx, ry);
    if (d > reach + t.radius) {
      continue;
    }
    if (d > 0.25 && Math.abs(angleDelta(u.facing, Math.atan2(ry, rx))) > MELEE_HALF_ANGLE) {
      continue;
    }
    if (isBreakable(t) && u.kind === "hero") {
      dealDamage(w, u, t, raw, u.attackDamageType, { isAttack: true });
      continue;
    }
    if (t.kind !== "hero" && t.kind !== "creep") {
      continue;
    }
    if (!isEnemy(u, t) || isUntargetable(t)) {
      continue;
    }
    hits.push({ d, t });
  }
  hits.sort((a, b) => a.d - b.d || (a.t.id < b.t.id ? -1 : 1));
  return hits;
};

/** Melee cleave: nearest enemy in the cone takes full damage; the next
 *  (cap-1) take FALLOFF; the rest none. Bounds AoE DPS to ~2× single-target
 *  (was unbounded × #targets — the dominant balance problem). */
const doMeleeHit = (w: World, u: Unit, s: SwingHit): void => {
  const cap =
    u.kind === "hero"
      ? (CHAMP_BY_ID[u.champId]?.cleaveTargets ?? MELEE_CLEAVE_CAP)
      : MELEE_CLEAVE_CAP;
  const hits = meleeConeHits(w, u, s.raw);
  for (let i = 0; i < hits.length && i < cap; i += 1) {
    const hit = hits[i];
    if (!hit) {
      continue;
    }
    const { t } = hit;
    const mult = i === 0 ? 1 : MELEE_CLEAVE_FALLOFF;
    const heavy = dealDamage(w, u, t, s.raw * mult, u.attackDamageType, {
      forceCrit: s.ambush,
      isAttack: true,
    });
    // micro-shove on the primary target — basics finally *move* people
    if (i === 0 && t.alive) {
      applyKnockback(t, u.x, u.y, heavy ? 2.6 : 1.4, w);
    }
    // FrostGolem on-hit chill (fixed id → refreshes, never stacks)
    if (u.champId === "frostgolem" && t.alive) {
      addStatus(t, { id: "chill", kind: "slow", pct: 25, until: w.now + 1500 });
    }
  }
};

const doAttackHit = (w: World, u: Unit): void => {
  const step = lastSwingStep(u);
  const variance = 1 - ATTACK_VARIANCE + rand(w) * (ATTACK_VARIANCE * 2);
  // slow swings hit harder
  let raw = u.baseDamage * variance * step.dmgMult;
  if (u.empowerNext > 0) {
    raw += u.empowerNext;
    u.empowerNext = 0;
  }
  // ambush (swing began in stealth): double damage, guaranteed crit read
  const { ambush } = u;
  if (ambush) {
    raw *= 2;
    u.ambush = false;
  }
  const swing: SwingHit = {
    ambush,
    fx: Math.cos(u.facing),
    fy: Math.sin(u.facing),
    raw,
    step,
  };

  if (step.aoe && step.aoe > 0) {
    doSpinHit(w, u, swing, step.aoe);
    return;
  }

  if (u.attackType === "ranged") {
    doRangedHit(w, u, swing);
    return;
  }

  doMeleeHit(w, u, swing);
};

// Action combat (Dragon-Nest style): a click always swings/shoots in the AIM
// direction — no target lock. Melee cleaves a cone (hits everything in front);
// ranged fires a straight, non-homing shot.
export const resolveAttacks = (w: World): void => {
  for (const u of w.units.values()) {
    if (!u.alive || (u.kind !== "hero" && u.kind !== "creep")) {
      continue;
    }

    // stunned units can neither resolve a wind-up nor start a new swing
    if (isDisabled(u)) {
      u.pendingAttack = null;
      continue;
    }

    // resolve a pending wind-up (no target needed — it hits whatever's there)
    if (u.pendingAttack) {
      if (w.now >= u.pendingAttack.resolveAt) {
        u.pendingAttack = null;
        doAttackHit(w, u);
      }
      continue;
    }

    if (!u.attackHeld || w.now < u.dashUntil) {
      continue;
    }
    const baseInterval = attackIntervalMs(effectiveAttackSpeed(u));
    // the swing currently occupying time paces the next one — a slow swing (the
    // 2H spin) holds longer before the next basic can start
    if (w.now - u.lastAttackAt < baseInterval * lastSwingStep(u).timeMult) {
      continue;
    }

    // swing regardless of whether anything is in range
    u.lastAttackAt = w.now;
    u.swingCount += 1;
    u.facing = angleOf(u.aimX, u.aimY);
    // a swing STARTED from stealth is an ambush — it lands as a 2× crit
    if (isStealthed(u)) {
      u.ambush = true;
    }
    breakStealth(u);
    // Damage lands when the blade/shot visually CONNECTS: the render fits every
    // swing clip inside its interval (never clipped), so the strike moment is
    // the clip's measured contact frame — sim + render read the same table.
    const step = lastSwingStep(u);
    const windup = strikeMs(swingClip(u.champId, u.swingCount), baseInterval * step.timeMult);
    u.pendingAttack = { resolveAt: w.now + windup };

    // melee pounces into the swing (ranged shoulder-kicks at the release —
    // see doAttackHit; never fight a real knockback)
    if (u.attackType === "melee" && w.now >= u.kbUntil) {
      u.kbx = Math.cos(u.facing) * 3;
      u.kby = Math.sin(u.facing) * 3;
      u.kbUntil = w.now + 140;
    }
    // (Melee swing VFX is a render-side weapon trail tracing the animated blade
    // — see render/weapon-trail.ts. The ranged muzzle flash fires at release.)
  }
};
