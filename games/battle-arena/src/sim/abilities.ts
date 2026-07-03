// Ability casting + per-tick ability processing (ground zones, DoTs, meteors).
// Data-driven defs live in data/champions; this switches on def.effect.
import { CHAMP_BY_ID, valAt, type AbilityDef } from "../data/champions";
import { JUMP_MS } from "../data/config";
import { ITEM_BY_ID } from "../data/items";
import { angleDelta, angleOf, dist, norm } from "./math";
import { clampToArena, resolveObstacles } from "../data/map";
import {
  addStatus,
  cleanseDisables,
  isSilenced,
  isUntargetable,
} from "./stats";
import { applyKnockback, dealDamage, isEnemy, spawnProjectile } from "./combat";
import type { AbilityKey, GroundEffect, Unit, World } from "./types";
import { nextId } from "./types";

export type CastCtx = { point?: { x: number; y: number }; dir?: { x: number; y: number } };

const deg2rad = (d: number) => (d * Math.PI) / 180;

// Input buffer windows: a press up to CAST_BUFFER_LEAD ms before the cooldown
// ends (or while dashing/stunned) queues and fires the moment it's legal.
const CAST_BUFFER_LEAD = 350; // how early a press may queue
const CAST_BUFFER_MS = 300; // how long the queue lives (≈9 ticks ≈ Smash 10f)

/** Cast now, or buffer the press if it's *almost* legal (cooldown tail, mid-
 *  dash, stunned). The queue drains in step() — host-side, so guests get the
 *  same forgiveness. Returns true only when the cast fired immediately. */
export function requestCast(w: World, u: Unit, key: AbilityKey, ctx: CastCtx): boolean {
  if (castAbility(w, u, key, ctx)) {
    u.queuedCast = null;
    return true;
  }
  const slot = u.abilities[key];
  const soon =
    slot.rank >= 1 &&
    (slot.readyAt - w.now <= CAST_BUFFER_LEAD ||
      w.now < u.dashUntil ||
      u.statuses.some((s) => s.kind === "stun"));
  if (soon) {
    u.queuedCast = {
      key,
      px: ctx.point?.x ?? u.x,
      py: ctx.point?.y ?? u.y,
      ax: ctx.dir?.x ?? u.aimX,
      ay: ctx.dir?.y ?? u.aimY,
      until: w.now + CAST_BUFFER_MS,
    };
  }
  return false;
}

/** Try to cast caster's ability `key`. Returns true on success (host-side). */
export function castAbility(w: World, caster: Unit, key: AbilityKey, ctx: CastCtx): boolean {
  if (!caster.alive || caster.kind !== "hero") return false;
  const def = CHAMP_BY_ID[caster.champId]?.abilities[key];
  if (!def) return false;
  const slot = caster.abilities[key];
  if (slot.rank < 1) return false;
  if (isSilenced(caster)) return false;
  if (w.now < slot.readyAt) return false; // cooldown is the only gate (no mana)

  // resolve aim
  let dir = ctx.dir ?? { x: caster.aimX, y: caster.aimY };
  const dn = norm(dir.x, dir.y);
  dir = dn.x === 0 && dn.y === 0 ? { x: Math.cos(caster.facing), y: Math.sin(caster.facing) } : dn;
  let point = ctx.point ?? { x: caster.x + dir.x * def.castRange, y: caster.y + dir.y * def.castRange };
  if (def.targeting === "ground") point = clampCastRange(caster, point, def.castRange);

  const ok = dispatch(w, caster, def, key, dir, point);
  if (!ok) return false;

  slot.readyAt = w.now + valAt(def.cooldown, slot.rank) * 1000;
  caster.facing = angleOf(dir.x, dir.y);
  caster.lastCastAt = w.now;
  caster.lastCastKey = key;
  w.fx.push({ t: "cast", x: caster.x, y: caster.y, dx: dir.x, dy: dir.y, champId: caster.champId, key });
  return true;
}

function clampCastRange(c: Unit, p: { x: number; y: number }, range: number): { x: number; y: number } {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d <= range || d < 1e-6) return p;
  return { x: c.x + (dx / d) * range, y: c.y + (dy / d) * range };
}

function startDash(u: Unit, dir: { x: number; y: number }, speed: number, distance: number, w: World): void {
  u.dashVx = dir.x * speed;
  u.dashVy = dir.y * speed;
  u.dashUntil = w.now + (distance / speed) * 1000;
  u.facing = angleOf(dir.x, dir.y);
}

/** Abilities hit anything fightable — heroes AND camp creeps (the boss is
 *  handled separately and stays out of reach). */
function targetable(u: Unit): boolean {
  return u.kind === "hero" || u.kind === "creep";
}

/** Sweep a corridor from caster along dir for `length`; returns enemies hit. */
function corridorHits(w: World, c: Unit, dir: { x: number; y: number }, length: number, width: number): Unit[] {
  const hits: Unit[] = [];
  for (const t of w.units.values()) {
    if (t === c || !t.alive || !targetable(t) || !isEnemy(c, t)) continue;
    const rx = t.x - c.x;
    const ry = t.y - c.y;
    const along = rx * dir.x + ry * dir.y;
    if (along < 0 || along > length) continue;
    const perp = Math.abs(rx * -dir.y + ry * dir.x);
    if (perp <= width + t.radius) hits.push(t);
  }
  return hits;
}

function aoeEnemies(w: World, team: string, x: number, y: number, radius: number): Unit[] {
  const out: Unit[] = [];
  for (const u of w.units.values()) {
    if (!u.alive || !targetable(u) || u.team === team) continue;
    if ((u.x - x) ** 2 + (u.y - y) ** 2 <= radius * radius) out.push(u);
  }
  return out;
}

function pushGround(w: World, g: Omit<GroundEffect, "id">): void {
  w.grounds.push({ ...g, id: nextId(w, "g") });
}

/** A big weapon-slash arc VFX in front of the caster (for melee abilities). */
function meleeSwing(w: World, c: Unit, dir: { x: number; y: number }, r = 3.6): void {
  w.fx.push({ t: "swing", x: c.x + dir.x * r * 0.45, y: c.y + dir.y * r * 0.45, ang: angleOf(dir.x, dir.y), r, melee: true, dtype: "physical" });
}

// ── Dispatch ─────────────────────────────────────────────────────────────────
function dispatch(
  w: World,
  c: Unit,
  def: AbilityDef,
  key: AbilityKey,
  dir: { x: number; y: number },
  point: { x: number; y: number },
): boolean {
  const r = c.abilities[key].rank;
  const v = (f: string) => valAt(def.values[f], r);
  const ap = c.abilityPower;

  switch (def.effect) {
    // ── Knight ──
    case "knight:Q": {
      meleeSwing(w, c, dir);
      const ang = angleOf(dir.x, dir.y);
      const half = deg2rad(v("cone")) / 2;
      const range = def.castRange;
      for (const t of w.units.values()) {
        if (t === c || !t.alive || !targetable(t) || !isEnemy(c, t)) continue;
        if (dist(c, t) > range + t.radius) continue;
        if (Math.abs(angleDelta(ang, angleOf(t.x - c.x, t.y - c.y))) > half) continue;
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: "knight:Q" });
      }
      return true;
    }
    case "knight:W": {
      // Seismic Slam: a fissure line — damage + slow everyone in a corridor.
      for (const t of corridorHits(w, c, dir, def.castRange, v("width") / 2)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, { kind: "slow", until: w.now + v("slowDur") * 1000, pct: v("slow"), id: "knight:W" });
      }
      return true;
    }
    case "knight:E": {
      addStatus(c, { kind: "shield", until: w.now + v("duration") * 1000, amount: v("shield"), id: "knight:E" });
      addStatus(c, { kind: "speed", until: w.now + v("duration") * 1000, pct: v("speed"), id: "knight:E" });
      w.fx.push({ t: "heal", x: c.x, y: c.y, amount: v("shield") });
      return true;
    }
    case "knight:R": {
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "whirlwind",
        x: c.x,
        y: c.y,
        radius: v("radius"),
        until: w.now + v("duration") * 1000,
        nextTick: w.now + 250,
        tickInterval: 250,
        enemyDps: v("dps") * (1 + ap),
        dtype: "physical",
        slowPct: v("slow"),
      });
      return true;
    }
    case "knight:DASH": {
      startDash(c, dir, v("speed"), def.castRange, w);
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
      return true;
    }
    case "knight:JUMP": {
      // Skyfall Cleave: self-leap if grounded, slam AoE on the landing point.
      if (w.now >= c.jumpUntil) c.jumpUntil = w.now + JUMP_MS;
      const lx = c.x + dir.x * def.castRange;
      const ly = c.y + dir.y * def.castRange;
      const dmg = v("base") + v("perLevel") * (c.level - 1);
      for (const t of aoeEnemies(w, c.team, lx, ly, v("radius"))) {
        dealDamage(w, c, t, dmg, "physical", { ap });
        addStatus(t, { kind: "slow", until: w.now + v("slowDur") * 1000, pct: v("slow"), id: "knight:JUMP" });
      }
      w.fx.push({ t: "explosion", x: lx, y: ly, radius: v("radius"), kind: "execute" });
      return true;
    }

    // ── Ranger ──
    case "ranger:Q": {
      const n = v("arrows");
      const spread = deg2rad(v("spread"));
      const base = angleOf(dir.x, dir.y);
      for (let i = 0; i < n; i++) {
        const a = base + spread * (i / Math.max(1, n - 1) - 0.5);
        spawnProjectile(w, c, {
          dirX: Math.cos(a),
          dirY: Math.sin(a),
          damage: v("damage"),
          dtype: "physical",
          kind: "arrow",
          speed: 28,
          radius: 1.0, // small splash — grazing arrows still connect
          range: def.castRange,
        });
      }
      return true;
    }
    case "ranger:W": {
      // Hunter's Focus: self buff — attack + move speed for a few seconds.
      const dur = v("duration") * 1000;
      addStatus(c, { kind: "attackSpeed", until: w.now + dur, amount: v("atkSpeed"), id: "ranger:W" });
      addStatus(c, { kind: "speed", until: w.now + dur, pct: v("moveSpeed"), id: "ranger:W" });
      return true;
    }
    case "ranger:E": {
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "trap",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + v("life") * 1000,
        nextTick: w.now,
        tickInterval: 100,
        enemyDps: v("damage"), // applied once on trigger
        dtype: "physical",
        rootMs: v("root") * 1000,
        telegraph: true,
      });
      return true;
    }
    case "ranger:R": {
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "rain",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + v("duration") * 1000,
        nextTick: w.now + 300,
        tickInterval: 300,
        enemyDps: v("dps") * (1 + ap),
        dtype: "physical",
        slowPct: v("slow"),
        telegraph: true,
      });
      return true;
    }
    case "ranger:DASH": {
      startDash(c, dir, v("speed"), def.castRange, w);
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
      return true;
    }
    case "ranger:JUMP": {
      // Falcon Dive: self-leap, physical arrow-slam AoE (no CC).
      if (w.now >= c.jumpUntil) c.jumpUntil = w.now + JUMP_MS;
      const lx = c.x + dir.x * def.castRange;
      const ly = c.y + dir.y * def.castRange;
      const dmg = v("base") + v("perLevel") * (c.level - 1);
      for (const t of aoeEnemies(w, c.team, lx, ly, v("radius"))) {
        dealDamage(w, c, t, dmg, "physical", { ap });
      }
      w.fx.push({ t: "explosion", x: lx, y: ly, radius: v("radius"), kind: "execute" });
      return true;
    }

    // ── Mage ──
    case "mage:Q": {
      spawnProjectile(w, c, {
        dirX: dir.x,
        dirY: dir.y,
        damage: v("damage"),
        dtype: "magic",
        kind: "fireball",
        speed: 18,
        radius: v("radius"),
        range: def.castRange,
      });
      return true;
    }
    case "mage:W": {
      for (const t of aoeEnemies(w, c.team, point.x, point.y, v("radius"))) {
        dealDamage(w, c, t, v("damage"), "magic", { ap });
        addStatus(t, { kind: "slow", until: w.now + v("slowDur") * 1000, pct: v("slow"), id: "mage:W" });
      }
      w.fx.push({ t: "explosion", x: point.x, y: point.y, radius: v("radius"), kind: "frost" });
      return true;
    }
    case "mage:E": {
      // Cinderfall: a persistent ember zone — burns + slows enemies who stand in it.
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "cinderfall",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + v("duration") * 1000,
        nextTick: w.now + 500,
        tickInterval: 500,
        enemyDps: v("dps") * (1 + ap),
        dtype: "magic",
        slowPct: v("slow"),
        telegraph: false,
      });
      return true;
    }
    case "mage:R": {
      const delay = v("delay") * 1000;
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "meteor",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + delay + 200,
        nextTick: w.now + delay,
        tickInterval: 9999,
        detonateAt: w.now + delay,
        detonateDmg: v("damage") * (1 + ap),
        detonateDtype: "magic",
        slowPct: v("slow"),
        telegraph: true,
      });
      return true;
    }
    case "mage:DASH": {
      // Blink: instant teleport along the aim, clamped to arena + obstacles.
      const range = v("range");
      const oldX = c.x;
      const oldY = c.y;
      const dest = clampToArena(c.x + dir.x * range, c.y + dir.y * range, c.radius);
      const safe = resolveObstacles(dest.x, dest.y, c.radius);
      w.fx.push({ t: "blink", x: oldX, y: oldY, tx: safe.x, ty: safe.y });
      c.x = safe.x;
      c.y = safe.y;
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
      return true;
    }
    case "mage:JUMP": {
      // Emberdrop: comet slam — magic AoE + a lingering burn.
      if (w.now >= c.jumpUntil) c.jumpUntil = w.now + JUMP_MS;
      const lx = c.x + dir.x * def.castRange;
      const ly = c.y + dir.y * def.castRange;
      const dmg = v("base") + v("perLevel") * (c.level - 1);
      for (const t of aoeEnemies(w, c.team, lx, ly, v("radius"))) {
        dealDamage(w, c, t, dmg, "magic", { ap });
        addStatus(t, { kind: "dot", until: w.now + v("burnDur") * 1000, nextTick: w.now + 500, dps: v("burnDps"), dtype: "magic", sourceId: c.id, id: "mage:JUMP" });
      }
      w.fx.push({ t: "explosion", x: lx, y: ly, radius: v("radius"), kind: "meteor" });
      return true;
    }

    // ── Rogue ──
    case "rogue:Q": {
      meleeSwing(w, c, dir);
      startDash(c, dir, v("speed"), def.castRange, w);
      // poison lunge cuts everyone along the dash line — forgiving to aim
      for (const hit of corridorHits(w, c, dir, def.castRange, 1.4)) {
        dealDamage(w, c, hit, v("damage"), "physical", { ap });
        addStatus(hit, { kind: "dot", until: w.now + v("dur") * 1000, nextTick: w.now + 500, dps: v("dps"), dtype: "magic", sourceId: c.id, id: "rogue:Q" });
      }
      return true;
    }
    case "rogue:W": {
      // Rupture: a bleeding gash down a corridor — damage + bleed DoT + a damage-amp
      // mark that sets up Execute.
      for (const t of corridorHits(w, c, dir, def.castRange, 1.2)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, { kind: "dot", until: w.now + v("bleedDur") * 1000, nextTick: w.now + 500, dps: v("bleedDps"), dtype: "physical", sourceId: c.id, id: "rogue:W" });
        addStatus(t, { kind: "damageAmp", until: w.now + v("ampDur") * 1000, pct: v("dmgAmp"), id: "rogue:W" });
      }
      return true;
    }
    case "rogue:E": {
      addStatus(c, { kind: "stealth", until: w.now + v("duration") * 1000, id: "rogue:E" });
      addStatus(c, { kind: "speed", until: w.now + v("duration") * 1000, pct: v("speed"), id: "rogue:E" });
      return true;
    }
    case "rogue:R": {
      // dash to nearest enemy in front, strike harder the lower their HP
      let target: Unit | null = null;
      let bestD = Infinity;
      const base = angleOf(dir.x, dir.y);
      for (const t of w.units.values()) {
        if (t === c || !t.alive || !targetable(t) || !isEnemy(c, t) || isUntargetable(t)) continue;
        const d = dist(c, t);
        if (d > def.castRange + t.radius) continue;
        if (Math.abs(angleDelta(base, angleOf(t.x - c.x, t.y - c.y))) > deg2rad(70)) continue;
        if (d < bestD) {
          bestD = d;
          target = t;
        }
      }
      if (!target) return false;
      const d = norm(target.x - c.x, target.y - c.y);
      const stop = Math.max(0.5, dist(c, target) - (c.radius + target.radius));
      startDash(c, d, v("speed"), stop, w);
      meleeSwing(w, c, d);
      const hpFrac = target.hp / target.maxHp;
      const bonus = v("damage") * v("execMult") * (1 - hpFrac);
      dealDamage(w, c, target, v("damage") + bonus, "physical", { ap });
      w.fx.push({ t: "explosion", x: target.x, y: target.y, radius: 1.6, kind: "execute" });
      return true;
    }
    case "rogue:DASH": {
      startDash(c, dir, v("speed"), def.castRange, w);
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
      return true;
    }
    case "rogue:JUMP": {
      // Deathfall: tight, high-burst self-leap slam — physical AoE + brief slow.
      if (w.now >= c.jumpUntil) c.jumpUntil = w.now + JUMP_MS;
      const lx = c.x + dir.x * def.castRange;
      const ly = c.y + dir.y * def.castRange;
      const dmg = v("base") + v("perLevel") * (c.level - 1);
      for (const t of aoeEnemies(w, c.team, lx, ly, v("radius"))) {
        dealDamage(w, c, t, dmg, "physical", { ap });
        addStatus(t, { kind: "slow", until: w.now + v("slowDur") * 1000, pct: v("slow"), id: "rogue:JUMP" });
      }
      w.fx.push({ t: "explosion", x: lx, y: ly, radius: v("radius"), kind: "execute" });
      return true;
    }

    // ── Black Knight ──
    case "blackknight:Q": {
      meleeSwing(w, c, dir);
      const ang = angleOf(dir.x, dir.y);
      const half = deg2rad(v("cone")) / 2;
      for (const t of w.units.values()) {
        if (t === c || !t.alive || !targetable(t) || !isEnemy(c, t)) continue;
        if (dist(c, t) > def.castRange + t.radius) continue;
        if (Math.abs(angleDelta(ang, angleOf(t.x - c.x, t.y - c.y))) > half) continue;
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, { kind: "slow", until: w.now + v("slowDur") * 1000, pct: v("slow"), id: "blackknight:Q" });
      }
      return true;
    }
    case "blackknight:W": {
      // Consecrating Smite: a pillar of holy light at the target point — damage + stun.
      for (const t of aoeEnemies(w, c.team, point.x, point.y, v("radius"))) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: "blackknight:W" });
      }
      w.fx.push({ t: "explosion", x: point.x, y: point.y, radius: v("radius"), kind: "execute" });
      return true;
    }
    case "blackknight:E": {
      const dur = v("duration") * 1000;
      addStatus(c, { kind: "armor", until: w.now + dur, amount: v("armor"), id: "blackknight:E" });
      addStatus(c, { kind: "heal", until: w.now + dur, nextTick: w.now + 500, hps: v("hps"), id: "blackknight:E" });
      w.fx.push({ t: "heal", x: c.x, y: c.y, amount: v("hps") });
      return true;
    }
    case "blackknight:R": {
      for (const t of aoeEnemies(w, c.team, c.x, c.y, v("radius"))) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        applyKnockback(t, c.x, c.y, v("knockback"), w);
        addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: "blackknight:R" });
      }
      w.fx.push({ t: "explosion", x: c.x, y: c.y, radius: v("radius"), kind: "execute" });
      return true;
    }
    case "blackknight:DASH": {
      startDash(c, dir, v("speed"), def.castRange, w);
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
      return true;
    }
    case "blackknight:JUMP": {
      // Dawnbreaker: the biggest slam — wide physical AoE + a stun on landing.
      if (w.now >= c.jumpUntil) c.jumpUntil = w.now + JUMP_MS;
      const lx = c.x + dir.x * def.castRange;
      const ly = c.y + dir.y * def.castRange;
      const dmg = v("base") + v("perLevel") * (c.level - 1);
      for (const t of aoeEnemies(w, c.team, lx, ly, v("radius"))) {
        dealDamage(w, c, t, dmg, "physical", { ap });
        addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: "blackknight:JUMP" });
      }
      w.fx.push({ t: "explosion", x: lx, y: ly, radius: v("radius"), kind: "execute" });
      return true;
    }

    // ── Witch ──
    case "witch:Q": {
      spawnProjectile(w, c, {
        dirX: dir.x,
        dirY: dir.y,
        damage: v("damage"),
        dtype: "magic",
        kind: "hexbolt",
        speed: v("speed"),
        radius: 1.8, // curdled burst — the slow spreads to everyone splashed
        range: def.castRange,
        onHit: { tag: "slow", pct: v("slow"), duration: v("slowDur") },
      });
      return true;
    }
    case "witch:W": {
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "brew",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + v("duration") * 1000,
        nextTick: w.now + 300,
        tickInterval: 300,
        enemyDps: v("dps") * (1 + ap),
        dtype: "magic",
        slowPct: v("slow"), // refreshed per tick with id "brew" (= effect tag)
        telegraph: true,
      });
      return true;
    }
    case "witch:E": {
      // Bog Grasp: vines erupt at the point — magic damage + root.
      for (const t of aoeEnemies(w, c.team, point.x, point.y, v("radius"))) {
        dealDamage(w, c, t, v("damage"), "magic", { ap });
        addStatus(t, { kind: "root", until: w.now + v("root") * 1000, id: "witch:E" });
      }
      w.fx.push({ t: "explosion", x: point.x, y: point.y, radius: v("radius"), kind: "trap" });
      return true;
    }
    case "witch:R": {
      for (const t of aoeEnemies(w, c.team, point.x, point.y, v("radius"))) {
        addStatus(t, { kind: "hex", until: w.now + v("duration") * 1000, pct: v("slow"), id: "witch:R" });
      }
      w.fx.push({ t: "explosion", x: point.x, y: point.y, radius: v("radius"), kind: "hex" });
      return true;
    }
    case "witch:DASH": {
      startDash(c, dir, v("speed"), def.castRange, w);
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
      return true;
    }
    case "witch:JUMP": {
      // Hexfall: broom-dive slam — magic AoE + a cursed slow on landing.
      if (w.now >= c.jumpUntil) c.jumpUntil = w.now + JUMP_MS;
      const lx = c.x + dir.x * def.castRange;
      const ly = c.y + dir.y * def.castRange;
      const dmg = v("base") + v("perLevel") * (c.level - 1);
      for (const t of aoeEnemies(w, c.team, lx, ly, v("radius"))) {
        dealDamage(w, c, t, dmg, "magic", { ap });
        addStatus(t, { kind: "slow", until: w.now + v("slowDur") * 1000, pct: v("slow"), id: "witch:JUMP" });
      }
      w.fx.push({ t: "explosion", x: lx, y: ly, radius: v("radius"), kind: "hex" });
      return true;
    }
  }
  return false;
}

// ── Per-tick ability processing ──────────────────────────────────────────────
export function tickAbilities(w: World, _dt: number): void {
  tickGround(w);
  tickDots(w);
}

function tickGround(w: World): void {
  const keep: GroundEffect[] = [];
  for (const g of w.grounds) {
    if (g.effect === "whirlwind") {
      const owner = w.units.get(g.ownerId);
      if (owner && owner.alive) {
        g.x = owner.x;
        g.y = owner.y;
      }
    }

    // meteor: single detonation
    if (g.detonateAt !== undefined && w.now >= g.detonateAt) {
      for (const t of aoeEnemies(w, g.team, g.x, g.y, g.radius)) {
        dealDamage(w, w.units.get(g.ownerId) ?? null, t, g.detonateDmg ?? 0, g.detonateDtype ?? "magic", {});
        if (g.slowPct) addStatus(t, { kind: "slow", until: w.now + 1500, pct: g.slowPct, id: g.effect });
      }
      w.fx.push({ t: "explosion", x: g.x, y: g.y, radius: g.radius, kind: "meteor" });
      continue; // detonated → drop
    }

    // trap: trigger on first enemy inside
    if (g.effect === "trap") {
      const inside = aoeEnemies(w, g.team, g.x, g.y, g.radius);
      if (inside.length > 0) {
        for (const t of inside) {
          dealDamage(w, w.units.get(g.ownerId) ?? null, t, g.enemyDps ?? 0, g.dtype ?? "physical", {});
          if (g.rootMs) addStatus(t, { kind: "root", until: w.now + g.rootMs, id: "trap" });
        }
        w.fx.push({ t: "explosion", x: g.x, y: g.y, radius: g.radius, kind: "trap" });
        continue; // consumed
      }
      if (w.now < g.until) keep.push(g);
      continue;
    }

    // periodic zones (whirlwind / rain / brew burn enemies; a zone with only
    // allyHps still ticks and heals the owner's side)
    if ((g.enemyDps || g.allyHps) && w.now >= g.nextTick) {
      g.nextTick += g.tickInterval;
      const owner = w.units.get(g.ownerId) ?? null;
      if (g.enemyDps) {
        for (const t of aoeEnemies(w, g.team, g.x, g.y, g.radius)) {
          dealDamage(w, owner, t, g.enemyDps * (g.tickInterval / 1000), g.dtype ?? "physical", { silentFx: true });
          if (g.slowPct) addStatus(t, { kind: "slow", until: w.now + 600, pct: g.slowPct, id: g.effect });
        }
      }
      if (g.allyHps) {
        for (const t of w.units.values()) {
          if (!t.alive || t.team !== g.team) continue;
          if ((t.x - g.x) ** 2 + (t.y - g.y) ** 2 > g.radius * g.radius) continue;
          t.hp = Math.min(t.maxHp, t.hp + g.allyHps * (g.tickInterval / 1000));
        }
      }
    }

    if (w.now < g.until) keep.push(g);
  }
  w.grounds = keep;
}

function tickDots(w: World): void {
  for (const u of w.units.values()) {
    if (!u.alive) continue;
    for (const s of u.statuses) {
      if (s.kind === "dot" && w.now >= s.nextTick) {
        s.nextTick += 500;
        const src = w.units.get(s.sourceId) ?? null;
        dealDamage(w, src, u, s.dps * 0.5, s.dtype, { silentFx: true });
      } else if (s.kind === "heal" && w.now >= s.nextTick) {
        s.nextTick += 500;
        u.hp = Math.min(u.maxHp, u.hp + s.hps * 0.5);
      }
    }
  }
}

// ── Item actives ─────────────────────────────────────────────────────────────
export function useItemActive(w: World, u: Unit, slot: number, point?: { x: number; y: number }): boolean {
  const id = u.items[slot];
  if (!id) return false;
  const def = ITEM_BY_ID[id];
  if (!def?.active) return false;
  const ready = u.itemReadyAt[id] ?? 0;
  if (w.now < ready) return false;
  const a = def.active;
  switch (a.kind) {
    case "haste":
      addStatus(u, { kind: "speed", until: w.now + 3000, pct: a.amount ?? 40, id: `item:${id}` });
      w.fx.push({ t: "itemUse", x: u.x, y: u.y, item: id });
      break;
    case "heal":
      u.hp = Math.min(u.maxHp, u.hp + (a.amount ?? 0));
      w.fx.push({ t: "heal", x: u.x, y: u.y, amount: a.amount ?? 0 });
      break;
    case "cleanse":
      cleanseDisables(u);
      w.fx.push({ t: "itemUse", x: u.x, y: u.y, item: id });
      break;
    case "shield":
      addStatus(u, { kind: "shield", until: w.now + 4000, amount: a.amount ?? 0, id: `item:${id}` });
      w.fx.push({ t: "itemUse", x: u.x, y: u.y, item: id });
      break;
    case "blink": {
      const dir = norm(u.aimX, u.aimY);
      const range = a.range ?? 9;
      const dest = clampToArena(u.x + dir.x * range, u.y + dir.y * range, u.radius);
      const safe = resolveObstacles(dest.x, dest.y, u.radius);
      w.fx.push({ t: "blink", x: u.x, y: u.y, tx: safe.x, ty: safe.y });
      u.x = safe.x;
      u.y = safe.y;
      break;
    }
  }
  u.itemReadyAt[id] = w.now + a.cooldown * 1000;
  return true;
}
