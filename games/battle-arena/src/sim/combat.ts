// Damage pipeline, basic attacks, knockback, death/respawn, projectiles.
import { CHAMP_BY_ID, type RhythmStep } from "../data/champions";
import { strikeMs, swingClip } from "../data/clip-timing";
import {
  KEG_BLAST,
  PROP_COIN_CHANCE,
  PROP_COIN_GOLD,
  PROP_RESPAWN_MS,
  destructibleProps,
} from "../data/props";
import { MELEE_HALF_ANGLE, MELEE_OVERREACH, RANGED_BASIC_HIT_RADIUS } from "./combat-geometry";
import { ATTACK_VARIANCE, attackIntervalMs, respawnTime, type DamageType } from "../data/config";
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

const MELEE_CLEAVE_CAP = 3; // max enemies a swing damages
const MELEE_CLEAVE_FALLOFF = 0.5; // secondary targets take half — caps AoE DPS at ~2× single

/** Melee reach for the cleave / its VFX. */
function meleeReach(u: Unit): number {
  return u.attackRange + MELEE_OVERREACH;
}

const UNIFORM_SWING: RhythmStep = { timeMult: 1, dmgMult: 1 };
/** The rhythm step of the swing this unit most recently STARTED — paces the
 *  next swing (timeMult), weights its damage (dmgMult), and carries a ranged
 *  swing's slow rider (slow). Uniform for creeps and champs with no rhythm.
 *  WHEN the swing connects comes from the clip's measured contact frame
 *  (data/clip-timing.ts), not from here. */
function lastSwingStep(u: Unit): RhythmStep {
  const rhythm = CHAMP_BY_ID[u.champId]?.basicRhythm;
  if (!rhythm || rhythm.length === 0 || u.swingCount < 1) return UNIFORM_SWING;
  return rhythm[(u.swingCount - 1) % rhythm.length] ?? UNIFORM_SWING;
}

// Action combat (Dragon-Nest style): a click always swings/shoots in the AIM
// direction — no target lock. Melee cleaves a cone (hits everything in front);
// ranged fires a straight, non-homing shot.
export function resolveAttacks(w: World): void {
  for (const u of w.units.values()) {
    if (!u.alive || (u.kind !== "hero" && u.kind !== "creep")) continue;

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

    if (!u.attackHeld || w.now < u.dashUntil) continue;
    const baseInterval = attackIntervalMs(effectiveAttackSpeed(u));
    // the swing currently occupying time paces the next one — a slow swing (the
    // 2H spin) holds longer before the next basic can start
    if (w.now - u.lastAttackAt < baseInterval * lastSwingStep(u).timeMult) continue;

    // swing regardless of whether anything is in range
    u.lastAttackAt = w.now;
    u.swingCount++;
    u.facing = angleOf(u.aimX, u.aimY);
    // a swing STARTED from stealth is an ambush — it lands as a 2× crit
    if (isStealthed(u)) u.ambush = true;
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
      u.kbx = Math.cos(u.facing) * 3.0;
      u.kby = Math.sin(u.facing) * 3.0;
      u.kbUntil = w.now + 140;
    }
    // (Melee swing VFX is a render-side weapon trail tracing the animated blade
    // — see render/weapon-trail.ts. The ranged muzzle flash fires at release.)
  }
}

function doAttackHit(w: World, u: Unit): void {
  const step = lastSwingStep(u);
  const variance = 1 - ATTACK_VARIANCE + rand(w) * (ATTACK_VARIANCE * 2);
  let raw = u.baseDamage * variance * step.dmgMult; // slow swings hit harder
  if (u.empowerNext > 0) {
    raw += u.empowerNext;
    u.empowerNext = 0;
  }
  // ambush (swing began in stealth): double damage, guaranteed crit read
  const ambush = u.ambush;
  if (ambush) {
    raw *= 2;
    u.ambush = false;
  }
  const fx = Math.cos(u.facing);
  const fy = Math.sin(u.facing);

  // a "spin" swing (rhythm aoe) whirls all the way around: every enemy inside
  // the radius takes full damage, no cone or cleave cap. Props shatter too.
  if (step.aoe && step.aoe > 0) {
    for (const t of w.units.values()) {
      if (t === u || !t.alive) continue;
      if (t.kind === "hero" || t.kind === "creep") {
        if (!isEnemy(u, t) || isUntargetable(t)) continue;
      } else if (!isBreakable(t)) continue;
      if (Math.hypot(t.x - u.x, t.y - u.y) > step.aoe + t.radius) continue;
      dealDamage(w, u, t, raw, u.attackDamageType, { isAttack: true, forceCrit: ambush });
    }
    w.fx.push({ t: "strike", tag: "spin", x: u.x, y: u.y, dx: fx, dy: fy, r: step.aoe });
    return;
  }

  if (u.attackType === "ranged") {
    // the shot leaves NOW — the release frame: muzzle flash + shoulder kick
    // land on the same tick the arrow/bolt spawns
    w.fx.push({
      t: "swing",
      x: u.x + fx * 0.45,
      y: u.y + fy * 0.45,
      ang: u.facing,
      r: 0.8,
      melee: false,
      dtype: u.attackDamageType,
    });
    if (w.now >= u.kbUntil) {
      u.kbx = fx * -1.4;
      u.kby = fy * -1.4;
      u.kbUntil = w.now + 120;
    }
    // per-champ basic behavior: ranger arrows PIERCE the line; caster bolts
    // burst in a small splash (data/champions `basic`)
    const basic = CHAMP_BY_ID[u.champId]?.basic;
    spawnProjectile(w, u, {
      dirX: fx,
      dirY: fy,
      damage: raw,
      dtype: u.attackDamageType,
      kind: u.attackKind,
      speed: u.projectileSpeed,
      radius: basic?.splash ?? 0,
      pierce: basic?.pierce ?? false,
      // fatter collision on basics — ranged champs should land shots without
      // pixel-perfect aim (abilities keep the tight default)
      hitRadius: RANGED_BASIC_HIT_RADIUS,
      range: u.attackRange + 5,
      // the KITE TOOL: this rhythm beat's slow rides the shot to its victim
      // (every 3rd arrow cripples / bolt chills — see champions basicRhythm)
      onHit: step.slow
        ? { tag: "slow", pct: step.slow.pct, duration: step.slow.dur }
        : { tag: "none" },
      isAttack: true,
    });
    return;
  }

  // melee cleave: nearest enemy in the cone takes full damage; the next
  // (cap-1) take FALLOFF; the rest none. Bounds AoE DPS to ~2× single-target
  // (was unbounded × #targets — the dominant balance problem). Deterministic:
  // sort by distance, tie-break by id.
  const reach = meleeReach(u);
  const cap =
    u.kind === "hero"
      ? (CHAMP_BY_ID[u.champId]?.cleaveTargets ?? MELEE_CLEAVE_CAP)
      : MELEE_CLEAVE_CAP;
  const hits: { t: Unit; d: number }[] = [];
  for (const t of w.units.values()) {
    if (t === u || !t.alive) continue;
    const rx = t.x - u.x;
    const ry = t.y - u.y;
    const d = Math.hypot(rx, ry);
    if (d > reach + t.radius) continue;
    if (d > 0.25 && Math.abs(angleDelta(u.facing, Math.atan2(ry, rx))) > MELEE_HALF_ANGLE) continue;
    // props in the cone break for free — they never eat the cleave cap
    if (isBreakable(t) && u.kind === "hero") {
      dealDamage(w, u, t, raw, u.attackDamageType, { isAttack: true });
      continue;
    }
    if (t.kind !== "hero" && t.kind !== "creep") continue;
    if (!isEnemy(u, t) || isUntargetable(t)) continue;
    hits.push({ t, d });
  }
  hits.sort((a, b) => a.d - b.d || (a.t.id < b.t.id ? -1 : 1));
  for (let i = 0; i < hits.length && i < cap; i++) {
    const t = hits[i]!.t;
    const mult = i === 0 ? 1 : MELEE_CLEAVE_FALLOFF;
    const heavy = dealDamage(w, u, t, raw * mult, u.attackDamageType, {
      isAttack: true,
      forceCrit: ambush,
    });
    // micro-shove on the primary target — basics finally *move* people
    if (i === 0 && t.alive) applyKnockback(t, u.x, u.y, heavy ? 2.6 : 1.4, w);
    // FrostGolem on-hit chill (fixed id → refreshes, never stacks)
    if (u.champId === "frostgolem" && t.alive) {
      addStatus(t, { kind: "slow", until: w.now + 1500, pct: 25, id: "chill" });
    }
  }
}

// ── Central damage ───────────────────────────────────────────────────────────
export type DamageOpts = {
  isAttack?: boolean;
  ap?: number;
  silentFx?: boolean;
  forceCrit?: boolean;
};

/** Returns true when the hit was HEAVY (≥18% of the victim's max HP) — the
 *  render heavy/crit tier and the primary-target shove key off it. */
export function dealDamage(
  w: World,
  attacker: Unit | null,
  victim: Unit,
  raw: number,
  dtype: DamageType,
  opts: DamageOpts = {},
): boolean {
  if (!victim.alive || raw <= 0) return false;
  const ap = opts.ap ?? attacker?.abilityPower ?? 0;
  let final = computeDamage(victim, raw, dtype, ap);
  // hidden solo mercy (opt-in, offline): soften AI damage on a struggling human
  if (w.soloMercy && attacker?.isBot && !victim.isBot && victim.mercy > 0) {
    final *= 1 - 0.07 * victim.mercy;
  }
  // props never crit (every hit would clear their 18% bar → gold-ring spam)
  const heavy = victim.kind !== "prop" && (opts.forceCrit === true || final >= victim.maxHp * 0.18);
  const leftover = absorbShield(victim, final);
  victim.hp -= leftover;
  victim.lastHitAt = w.now;

  if (attacker) {
    victim.recentDamageFrom[attacker.ownerId] = w.now;
    // no lifesteal off the furniture
    if (opts.isAttack && attacker.lifesteal > 0 && attacker.alive && victim.kind !== "prop") {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + leftover * attacker.lifesteal);
    }
  }

  const dir = attacker ? norm(victim.x - attacker.x, victim.y - attacker.y) : { x: 0, y: 1 };
  victim.lastHitDx = dir.x;
  victim.lastHitDy = dir.y;
  if (!opts.silentFx) {
    w.fx.push({
      t: "hit",
      x: victim.x,
      y: victim.y,
      dx: dir.x,
      dy: dir.y,
      dtype,
      by: attacker?.id ?? "",
      to: victim.id,
      amount: Math.round(final),
      crit: heavy,
    });
  }

  if (victim.hp <= 0) handleDeath(w, victim, attacker?.ownerId ?? null);
  return heavy;
}

export function applyKnockback(
  u: Unit,
  fromX: number,
  fromY: number,
  force: number,
  w: World,
): void {
  if (u.statuses.some((s) => s.kind === "unstoppable")) return;
  const d = norm(u.x - fromX, u.y - fromY);
  u.kbx = d.x * force;
  u.kby = d.y * force;
  u.kbUntil = w.now + 260;
}

export function handleDeath(w: World, victim: Unit, killerId: string | null): void {
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
    breakProp(w, victim, killerId);
    return;
  }
  w.fx.push({ t: "death", x: victim.x, y: victim.y, team: victim.team, by: killerId ?? "" });

  if (victim.kind === "hero") {
    victim.deaths += 1;
    victim.killStreak = 0;
    // hidden mercy ramp: a kill-less human dying to a bot earns softening;
    // any other death decays it (only ever consulted when World.soloMercy)
    if (!victim.isBot) {
      if (killerId !== null && killerId.startsWith("bot:") && victim.kills === 0) {
        victim.mercy = Math.min(3, victim.mercy + 1);
      } else {
        victim.mercy = Math.max(0, victim.mercy - 1);
      }
    }
    victim.respawnAt = w.now + respawnTime(victim.level) * 1000;
    awardKill(w, killerId, victim);
  } else if (victim.kind === "creep") {
    victim.respawnAt = w.now + 1200; // linger for the death anim, then cleanup
    awardCreepKill(w, killerId, victim);
  }
}

/** A destructible prop shatters: debris fx, maybe a keg blast (damages the
 *  breaker's ENEMIES — herding foes onto kegs is the play), maybe a coin. */
function breakProp(w: World, prop: Unit, killerId: string | null): void {
  const spec = destructibleProps()[prop.slot];
  prop.respawnAt = w.now + PROP_RESPAWN_MS;
  w.fx.push({
    t: "propBreak",
    x: prop.x,
    y: prop.y,
    model: prop.champId,
    explosive: spec?.explosive,
  });

  if (spec?.explosive) {
    // the breaker owns the blast: it hurts THEIR enemies (and other props)
    const breaker =
      killerId !== null
        ? ([...w.units.values()].find((u) => u.kind === "hero" && u.ownerId === killerId) ?? null)
        : null;
    for (const t of w.units.values()) {
      if (!t.alive || t === prop) continue;
      const inRange =
        (t.x - prop.x) ** 2 + (t.y - prop.y) ** 2 <= (KEG_BLAST.radius + t.radius) ** 2;
      if (!inRange) continue;
      if (isBreakable(t)) {
        dealDamage(w, breaker, t, KEG_BLAST.damage, "pure", {}); // chain-pop neighbors
      } else if (
        (t.kind === "hero" || t.kind === "creep") &&
        (!breaker || isEnemy(breaker, t)) &&
        !isUntargetable(t)
      ) {
        dealDamage(w, breaker, t, KEG_BLAST.damage, "magic", {});
        if (t.alive) applyKnockback(t, prop.x, prop.y, 5, w);
      }
    }
    w.fx.push({ t: "explosion", x: prop.x, y: prop.y, radius: KEG_BLAST.radius, kind: "keg" });
  }

  // lucky drop: a small gold coin, claimable immediately
  if (rand(w) < PROP_COIN_CHANCE) {
    w.coins.push({
      id: nextId(w, "coin"),
      x: prop.x,
      y: prop.y,
      fromX: prop.x,
      fromY: prop.y,
      gold: PROP_COIN_GOLD,
      landAt: w.now,
      expireAt: w.now + 9000,
    });
  }
}

// ── Projectiles ──────────────────────────────────────────────────────────────
export type SpawnProjArgs = {
  target?: Unit | null;
  dirX?: number;
  dirY?: number;
  damage: number;
  dtype: DamageType;
  kind: string;
  speed: number;
  radius: number; // splash
  hitRadius?: number; // collision fatness (default 0.55)
  range: number;
  pierce?: boolean;
  isAttack?: boolean;
  burstAtEnd?: boolean; // detonate the splash at max range (aim-point casts)
  onHit?: Projectile["onHit"];
};

export function spawnProjectile(w: World, owner: Unit, a: SpawnProjArgs): void {
  let dx = a.dirX ?? 0;
  let dy = a.dirY ?? 0;
  if (a.target) {
    const d = norm(a.target.x - owner.x, a.target.y - owner.y);
    dx = d.x;
    dy = d.y;
  } else {
    const d = norm(dx, dy);
    dx = d.x;
    dy = d.y;
  }
  const p: Projectile = {
    id: nextId(w, "p"),
    ownerId: owner.id,
    team: owner.team,
    x: owner.x + dx * (owner.radius + 0.3),
    y: owner.y + dy * (owner.radius + 0.3),
    vx: dx * a.speed,
    vy: dy * a.speed,
    speed: a.speed,
    targetId: a.target ? a.target.id : null,
    damage: a.damage,
    dtype: a.dtype,
    radius: a.radius,
    hitRadius: a.hitRadius ?? 0.55,
    pierce: a.pierce ?? false,
    isAttack: a.isAttack ?? false,
    hitIds: [],
    range: a.range,
    burstAtEnd: a.burstAtEnd ?? false,
    traveled: 0,
    kind: a.kind,
    onHit: a.onHit ?? { tag: "none" },
  };
  w.projectiles.set(p.id, p);
}

export function stepProjectiles(w: World, dt: number): void {
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

    let consumed = false;
    for (const u of w.units.values()) {
      if (!u.alive || u.kind === "boss") continue;
      if (u.team === p.team || u.id === p.ownerId) continue;
      if (p.hitIds.includes(u.id)) continue;
      if (isUntargetable(u)) continue; // dash i-frames: the shot passes through
      const reach = p.hitRadius + u.radius;
      const overlap = (u.x - p.x) ** 2 + (u.y - p.y) ** 2 <= reach * reach;
      if (overlap) {
        onProjectileHit(w, p, u);
        if (p.pierce) {
          p.hitIds.push(u.id);
        } else {
          consumed = true;
          break;
        }
      }
    }

    if (consumed || p.traveled >= p.range) {
      if (!consumed) {
        // aim-point casts: an unspent splash detonates where the player aimed
        // (snapped back to the exact range point — a 30Hz tick can overshoot);
        // everything else visibly FIZZLES instead of vanishing mid-air
        const over = p.traveled - p.range;
        if (over > 0 && p.speed > 0) {
          p.x -= (p.vx / p.speed) * over;
          p.y -= (p.vy / p.speed) * over;
        }
        if (p.burstAtEnd && p.radius > 0) burstProjectile(w, p);
        else w.fx.push({ t: "fizzle", x: p.x, y: p.y, kind: p.kind });
      }
      w.projectiles.delete(p.id);
    }
  }
}

/** Detonate a splash projectile at its current position. The blast reaches a
 *  unit's EDGE (radius + u.radius) — a fat-hitbox bolt bursts short of its
 *  victim's center, so a center-only test would cheat the splash. */
function burstProjectile(w: World, p: Projectile): void {
  const owner = w.units.get(p.ownerId) ?? null;
  for (const u of w.units.values()) {
    if (!u.alive || u.kind === "boss" || u.team === p.team) continue;
    const reach = p.radius + u.radius;
    if ((u.x - p.x) ** 2 + (u.y - p.y) ** 2 <= reach * reach) {
      dealDamage(w, owner, u, p.damage, p.dtype, { ap: owner?.abilityPower, isAttack: p.isAttack });
      applyOnHit(w, p, u);
    }
  }
  w.fx.push({ t: "explosion", x: p.x, y: p.y, radius: p.radius, kind: p.kind });
}

function onProjectileHit(w: World, p: Projectile, primary: Unit): void {
  const owner = w.units.get(p.ownerId) ?? null;
  if (p.radius > 0) {
    burstProjectile(w, p); // splash: everyone (incl primary) within radius
  } else {
    dealDamage(w, owner, primary, p.damage, p.dtype, {
      ap: owner?.abilityPower,
      isAttack: p.isAttack,
    });
    applyOnHit(w, p, primary);
  }
}

/** Statuses a projectile carries to its victim. Props never take them — a
 *  slowed barrel is nonsense, and it would spam the wire with dead statuses.
 *  Every rider is addStatus'd under a fixed per-source id, so a repeat hit
 *  (a piercing arrow, an every-3rd-shot cripple) REFRESHES one status instead
 *  of stacking a wall of them. */
function applyOnHit(w: World, p: Projectile, u: Unit): void {
  if (u.kind === "prop") return;
  const h = p.onHit;
  if (h.tag === "slow")
    addStatus(u, {
      kind: "slow",
      until: w.now + h.duration * 1000,
      pct: h.pct,
      id: `${p.kind}-slow`,
    });
  else if (h.tag === "root")
    addStatus(u, { kind: "root", until: w.now + h.duration * 1000, id: `${p.kind}-root` });
  else if (h.tag === "burn")
    addStatus(u, {
      kind: "dot",
      until: w.now + h.duration * 1000,
      nextTick: w.now + 500,
      dps: h.dps,
      dtype: "magic",
      sourceId: p.ownerId,
      id: `${p.kind}-burn`,
    });
}
