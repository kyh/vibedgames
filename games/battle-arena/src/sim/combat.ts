// Damage pipeline, basic attacks, knockback, death/respawn, projectiles.
import { CHAMP_BY_ID } from "../data/champions";
import { MELEE_HALF_ANGLE, MELEE_OVERREACH } from "./combat-geometry";
import { ATTACK_VARIANCE, attackIntervalMs, respawnTime, type DamageType } from "../data/config";
import { angleDelta, angleOf, norm, rand } from "./math";
import {
  absorbShield,
  addStatus,
  breakStealth,
  computeDamage,
  effectiveAttackSpeed,
  isDisabled,
  isUntargetable,
} from "./stats";
import type { Projectile, Unit, World } from "./types";
import { nextId } from "./types";
import { awardCreepKill, awardKill } from "./economy";

export const isEnemy = (a: Unit, b: Unit): boolean => a.team !== b.team;

// Melee damage lands this fraction into the swing's interval — the blade-contact
// point of a full (never-clipped) swing clip. One dial for hit-flash timing.
const MELEE_STRIKE_FRAC = 0.45;
const RANGED_WINDUP = 160; // arrow/bolt leaves as the bow/staff visually releases
const MELEE_CLEAVE_CAP = 3; // max enemies a swing damages
const MELEE_CLEAVE_FALLOFF = 0.5; // secondary targets take half — caps AoE DPS at ~2× single

/** Melee reach for the cleave / its VFX. */
function meleeReach(u: Unit): number {
  return u.attackRange + MELEE_OVERREACH;
}

const UNIFORM_SWING = { timeMult: 1, dmgMult: 1 };
/** The rhythm step of the swing this unit most recently STARTED — paces the next
 *  swing (timeMult), weights its damage (dmgMult), and can override when its
 *  blade connects (strikeFrac). Uniform for creeps and champs with no rhythm. */
function lastSwingStep(u: Unit): { timeMult: number; dmgMult: number; strikeFrac?: number; aoe?: number } {
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
    breakStealth(u);
    // Damage lands when the blade visually CONNECTS. Every swing clip is fit to
    // its interval (render never clips it), so the strike is ~this fraction of
    // the swing's interval — the hit + victim flash line up with the animation.
    const step = lastSwingStep(u);
    const windup = u.attackType === "ranged" ? RANGED_WINDUP : baseInterval * step.timeMult * (step.strikeFrac ?? MELEE_STRIKE_FRAC);
    u.pendingAttack = { resolveAt: w.now + windup };

    // attacker lunge / kickback (never fight a real knockback): melee pounces
    // into the swing; ranged shoulder-kicks against the shot
    if (w.now >= u.kbUntil) {
      const push = u.attackType === "ranged" ? -1.4 : 3.0;
      u.kbx = Math.cos(u.facing) * push;
      u.kby = Math.sin(u.facing) * push;
      u.kbUntil = w.now + (u.attackType === "ranged" ? 120 : 140);
    }

    // Melee swing VFX is now a render-side weapon trail that traces the actual
    // animated blade (see render/weapon-trail.ts) — so it always lines up with
    // whichever swing clip plays. Only ranged still emits a muzzle-flash event.
    if (u.attackType === "ranged") {
      w.fx.push({
        t: "swing",
        x: u.x + Math.cos(u.facing) * 0.45,
        y: u.y + Math.sin(u.facing) * 0.45,
        ang: u.facing,
        r: 0.8,
        melee: false,
        dtype: u.attackDamageType,
      });
    }
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
  const fx = Math.cos(u.facing);
  const fy = Math.sin(u.facing);

  // a "spin" swing (rhythm aoe) whirls all the way around: every enemy inside
  // the radius takes full damage, no cone or cleave cap.
  if (step.aoe && step.aoe > 0) {
    for (const t of w.units.values()) {
      if (t === u || !t.alive || (t.kind !== "hero" && t.kind !== "creep")) continue;
      if (!isEnemy(u, t) || isUntargetable(t)) continue;
      if (Math.hypot(t.x - u.x, t.y - u.y) > step.aoe + t.radius) continue;
      dealDamage(w, u, t, raw, u.attackDamageType, { isAttack: true });
    }
    w.fx.push({ t: "swing", x: u.x, y: u.y, ang: u.facing, r: step.aoe, melee: true, dtype: u.attackDamageType });
    return;
  }

  if (u.attackType === "ranged") {
    spawnProjectile(w, u, {
      dirX: fx,
      dirY: fy,
      damage: raw,
      dtype: u.attackDamageType,
      kind: u.attackKind,
      speed: u.projectileSpeed,
      radius: 0,
      range: u.attackRange + 5,
      onHit: { tag: "none" },
      isAttack: true,
    });
    return;
  }

  // melee cleave: nearest enemy in the cone takes full damage; the next
  // (cap-1) take FALLOFF; the rest none. Bounds AoE DPS to ~2× single-target
  // (was unbounded × #targets — the dominant balance problem). Deterministic:
  // sort by distance, tie-break by id.
  const reach = meleeReach(u);
  const cap = u.kind === "hero" ? (CHAMP_BY_ID[u.champId]?.cleaveTargets ?? MELEE_CLEAVE_CAP) : MELEE_CLEAVE_CAP;
  const hits: { t: Unit; d: number }[] = [];
  for (const t of w.units.values()) {
    if (t === u || !t.alive || (t.kind !== "hero" && t.kind !== "creep")) continue;
    if (!isEnemy(u, t) || isUntargetable(t)) continue;
    const rx = t.x - u.x;
    const ry = t.y - u.y;
    const d = Math.hypot(rx, ry);
    if (d > reach + t.radius) continue;
    if (d > 0.25 && Math.abs(angleDelta(u.facing, Math.atan2(ry, rx))) > MELEE_HALF_ANGLE) continue;
    hits.push({ t, d });
  }
  hits.sort((a, b) => a.d - b.d || (a.t.id < b.t.id ? -1 : 1));
  for (let i = 0; i < hits.length && i < cap; i++) {
    const t = hits[i]!.t;
    const mult = i === 0 ? 1 : MELEE_CLEAVE_FALLOFF;
    const heavy = dealDamage(w, u, t, raw * mult, u.attackDamageType, { isAttack: true });
    // micro-shove on the primary target — basics finally *move* people
    if (i === 0 && t.alive) applyKnockback(t, u.x, u.y, heavy ? 2.6 : 1.4, w);
    // FrostGolem on-hit chill (fixed id → refreshes, never stacks)
    if (u.champId === "frostgolem" && t.alive) {
      addStatus(t, { kind: "slow", until: w.now + 1500, pct: 25, id: "chill" });
    }
  }
}

// ── Central damage ───────────────────────────────────────────────────────────
export type DamageOpts = { isAttack?: boolean; ap?: number; silentFx?: boolean };

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
  const heavy = final >= victim.maxHp * 0.18;
  const leftover = absorbShield(victim, final);
  victim.hp -= leftover;
  victim.lastHitAt = w.now;

  if (attacker) {
    victim.recentDamageFrom[attacker.ownerId] = w.now;
    if (opts.isAttack && attacker.lifesteal > 0 && attacker.alive) {
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + leftover * attacker.lifesteal);
    }
  }

  const dir = attacker ? norm(victim.x - attacker.x, victim.y - attacker.y) : { x: 0, y: 1 };
  victim.lastHitDx = dir.x;
  victim.lastHitDy = dir.y;
  if (!opts.silentFx) {
    w.fx.push({ t: "hit", x: victim.x, y: victim.y, dx: dir.x, dy: dir.y, dtype, by: attacker?.id ?? "", to: victim.id, crit: heavy });
    w.fx.push({ t: "damage", x: victim.x, y: victim.y, amount: Math.round(final), dtype, by: attacker?.id ?? "", crit: heavy });
  }

  if (victim.hp <= 0) handleDeath(w, victim, attacker?.ownerId ?? null);
  return heavy;
}

export function applyKnockback(u: Unit, fromX: number, fromY: number, force: number, w: World): void {
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
  victim.queuedCast = null;
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
  range: number;
  pierce?: boolean;
  isAttack?: boolean;
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
    hitRadius: 0.55,
    pierce: a.pierce ?? false,
    isAttack: a.isAttack ?? false,
    hitIds: [],
    range: a.range,
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

    if (consumed || p.traveled >= p.range) w.projectiles.delete(p.id);
  }
}

function onProjectileHit(w: World, p: Projectile, primary: Unit): void {
  const owner = w.units.get(p.ownerId) ?? null;
  if (p.radius > 0) {
    // splash: everyone (incl primary) within radius of impact
    for (const u of w.units.values()) {
      if (!u.alive || u.kind === "boss" || u.team === p.team) continue;
      if ((u.x - p.x) ** 2 + (u.y - p.y) ** 2 <= p.radius * p.radius) {
        dealDamage(w, owner, u, p.damage, p.dtype, { ap: owner?.abilityPower, isAttack: p.isAttack });
        applyOnHit(w, p, u);
      }
    }
    w.fx.push({ t: "explosion", x: p.x, y: p.y, radius: p.radius, kind: p.kind });
  } else {
    dealDamage(w, owner, primary, p.damage, p.dtype, { ap: owner?.abilityPower, isAttack: p.isAttack });
    applyOnHit(w, p, primary);
  }
}

function applyOnHit(w: World, p: Projectile, u: Unit): void {
  const h = p.onHit;
  if (h.tag === "slow") u.statuses.push({ kind: "slow", until: w.now + h.duration * 1000, pct: h.pct, id: `${p.kind}-slow` });
  else if (h.tag === "root") u.statuses.push({ kind: "root", until: w.now + h.duration * 1000, id: `${p.kind}-root` });
  else if (h.tag === "burn") u.statuses.push({ kind: "dot", until: w.now + h.duration * 1000, nextTick: w.now + 500, dps: h.dps, dtype: "magic", sourceId: p.ownerId, id: `${p.kind}-burn` });
}
