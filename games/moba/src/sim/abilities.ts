// Ability casting + per-tick ability/status effects (DoTs, heals, ground zones,
// auras, channels). One switch over the effect id keeps all 24 abilities here.

import { abilityRankCap } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityDef, AbilityKey } from "../data/heroes";
import { ITEM_BY_ID } from "../data/items";
import { dealDamage, spawnAbilityProjectile } from "./combat";
import { dist, dist2, pointSegDist } from "./math";
import type { Vec2 } from "./math";
import { addStatus, cleanseSlows, silenced, spellAmp } from "./stats";
import type { GroundEffect, Unit, World } from "./types";
import { nextId } from "./types";

const TICK = 0.5; // ground/channel tick interval (s)

function abilityOf(u: Unit, key: AbilityKey): { def: AbilityDef; rank: number } | null {
  if (!u.hero) return null;
  const def = HERO_BY_ID[u.hero.defId]?.abilities[key];
  if (!def) return null;
  const rank = u.hero.abilities[key].rank;
  if (rank <= 0) return null;
  return { def, rank };
}

function v(def: AbilityDef, field: string, rank: number): number {
  return valAt(def.values[field], rank);
}

export type CastInput = { key: AbilityKey; point?: Vec2; targetId?: string };

/** Attempt to cast. Returns true if the cast went through (mana/cd consumed). */
export function castAbility(w: World, caster: Unit, input: CastInput): boolean {
  if (!caster.alive || !caster.hero) return false;
  if (caster.statuses.some((s) => s.kind === "stun")) return false;
  const got = abilityOf(caster, input.key);
  if (!got) return false;
  const { def, rank } = got;
  if (def.targeting === "passive") return false;
  if (silenced(caster)) return false;
  const slot = caster.hero.abilities[input.key];
  if (w.now < slot.readyAt) return false;
  const manaCost = valAt(def.manaCost, rank);
  if (caster.mp < manaCost) return false;

  // resolve target requirements
  let point: Vec2 | undefined = input.point;
  let target: Unit | undefined;
  if (def.targeting === "unit") {
    if (!input.targetId) return false;
    target = w.units.get(input.targetId);
    if (!target || !target.alive) return false;
    if (dist(caster, target) > def.castRange + caster.radius + target.radius + 30) return false;
    point = { x: target.x, y: target.y };
  } else if (def.targeting === "point") {
    if (!point) return false;
    point = clampCastRange(caster, point, def.castRange);
  } else {
    point = { x: caster.x, y: caster.y };
  }

  const ok = dispatch(w, caster, def, rank, point, target);
  if (!ok) return false;

  caster.mp -= manaCost;
  slot.readyAt = w.now + valAt(def.cooldown, rank) * 1000;
  if (caster.facing !== undefined && point) caster.facing = point.x >= caster.x ? 1 : -1;
  w.fx.push({ t: "cast", x: caster.x, y: caster.y, effect: def.effect, team: caster.team });
  return true;
}

function clampCastRange(caster: Unit, point: Vec2, range: number): Vec2 {
  const dx = point.x - caster.x;
  const dy = point.y - caster.y;
  const d = Math.hypot(dx, dy);
  if (d <= range || d < 1) return point;
  return { x: caster.x + (dx / d) * range, y: caster.y + (dy / d) * range };
}

function enemiesInRadius(w: World, team: string, p: Vec2, radius: number, allowStructure = true): Unit[] {
  const out: Unit[] = [];
  const r2 = radius * radius;
  for (const u of w.units.values()) {
    // neutrals are enemies of every team; same-team non-neutrals are not
    if (!u.alive || (!u.neutral && u.team === team)) continue;
    if (u.kind === "structure" && (!allowStructure || !u.structure!.attackable)) continue;
    if (u.statuses.some((s) => s.kind === "untargetable")) continue;
    if (dist2(u, p) <= r2) out.push(u);
  }
  return out;
}

function alliesInRadius(w: World, team: string, p: Vec2, radius: number, heroesOnly = false): Unit[] {
  const out: Unit[] = [];
  const r2 = radius * radius;
  for (const u of w.units.values()) {
    // never count neutrals as allies (they carry team:"dire" only for serialization)
    if (!u.alive || u.neutral || u.team !== team) continue;
    if (heroesOnly && u.kind !== "hero") continue;
    if (u.kind === "structure") continue;
    if (dist2(u, p) <= r2) out.push(u);
  }
  return out;
}

// ---- the dispatch ----------------------------------------------------------
function dispatch(w: World, c: Unit, def: AbilityDef, rank: number, p: Vec2, target?: Unit): boolean {
  const amp = spellAmp(c);
  switch (def.effect) {
    // ---------------- IRONVOW ----------------
    case "ironvow:Q": {
      if (!target) return false;
      dealDamage(w, c, target, v(def, "damage", rank), "physical", {});
      addStatus(target, { kind: "stun", until: w.now + v(def, "stun", rank) * 1000, sourceId: c.id });
      w.fx.push({ t: "ability", effect: def.effect, x: c.x, y: c.y, x2: target.x, y2: target.y, radius: 40, team: c.team });
      return true;
    }
    case "ironvow:W": {
      const dur = v(def, "duration", rank) * 1000;
      addStatus(c, { kind: "armorBonus", amount: v(def, "bonusArmor", rank), until: w.now + dur, id: "ironvow:W:armor" });
      addStatus(c, { kind: "shield", amount: v(def, "shield", rank), until: w.now + dur, id: "ironvow:W:shield" });
      addStatus(c, { kind: "reflect", pct: v(def, "reflectPct", rank) / 100, until: w.now + dur, id: "ironvow:W:reflect" });
      return true;
    }
    case "ironvow:R": {
      const radius = v(def, "radius", rank);
      const dur = v(def, "buffDuration", rank) * 1000;
      addStatus(c, { kind: "damageReduction", pct: v(def, "damageReductionPct", rank) / 100, until: w.now + dur, id: "ironvow:R:dr" });
      for (const e of enemiesInRadius(w, c.team, c, radius, false)) {
        if (e.kind === "structure") continue;
        dealDamage(w, c, e, v(def, "damage", rank), "magic", { attackerSpellAmp: amp });
        addStatus(e, { kind: "taunt", targetId: c.id, until: w.now + v(def, "taunt", rank) * 1000 });
      }
      w.fx.push({ t: "ability", effect: def.effect, x: c.x, y: c.y, x2: c.x, y2: c.y, radius, team: c.team });
      return true;
    }

    // ---------------- DUSKBLADE ----------------
    case "duskblade:Q": {
      const from = { x: c.x, y: c.y };
      const d = Math.min(v(def, "blink", rank), dist(c, p));
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      c.x += Math.cos(ang) * d;
      c.y += Math.sin(ang) * d;
      c.path = [];
      c.order = { type: "idle" };
      addStatus(c, { kind: "empowerNextAttack", bonus: v(def, "bonusNextAttack", rank), until: w.now + v(def, "window", rank) * 1000, id: "duskblade:Q:emp" });
      w.fx.push({ t: "blink", x: from.x, y: from.y, x2: c.x, y2: c.y });
      return true;
    }
    case "duskblade:W": {
      const range = v(def, "coneRange", rank);
      const half = (v(def, "coneAngle", rank) * Math.PI) / 360;
      const dirAng = Math.atan2(p.y - c.y, p.x - c.x);
      for (const e of enemiesInRadius(w, c.team, c, range, true)) {
        const a = Math.atan2(e.y - c.y, e.x - c.x);
        let diff = Math.abs(a - dirAng);
        if (diff > Math.PI) diff = Math.PI * 2 - diff;
        if (diff <= half) {
          dealDamage(w, c, e, v(def, "damage", rank), "physical", {});
          addStatus(e, { kind: "slow", pct: v(def, "slowPct", rank) / 100, until: w.now + v(def, "slowDuration", rank) * 1000, id: `duskblade:W:${e.id}` });
        }
      }
      w.fx.push({ t: "ability", effect: def.effect, x: c.x, y: c.y, x2: p.x, y2: p.y, radius: range, team: c.team });
      return true;
    }
    case "duskblade:R": {
      if (!target) return false;
      const strikes = v(def, "strikes", rank);
      const per = v(def, "damagePerStrike", rank);
      addStatus(c, { kind: "untargetable", until: w.now + v(def, "untargetable", rank) * 1000 });
      // blink behind target
      c.x = target.x + (c.x < target.x ? 30 : -30);
      c.y = target.y + 6;
      const total = per * (strikes - 1) + per * v(def, "critMult", rank);
      dealDamage(w, c, target, total, "physical", { crit: true });
      w.fx.push({ t: "ability", effect: def.effect, x: c.x, y: c.y, x2: target.x, y2: target.y, radius: 40, team: c.team });
      return true;
    }

    // ---------------- STORMCALLER ----------------
    case "stormcaller:Q": {
      const len = v(def, "length", rank);
      const width = v(def, "width", rank);
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      const end = { x: c.x + Math.cos(ang) * len, y: c.y + Math.sin(ang) * len };
      const hits = enemiesInRadius(w, c.team, c, len + width, true)
        .filter((e) => pointSegDist(e, c, end) <= width / 2 + e.radius)
        .sort((a, b) => dist2(c, a) - dist2(c, b));
      const minPct = v(def, "minPct", rank) / 100;
      const falloff = v(def, "falloffPct", rank) / 100;
      hits.forEach((e, i) => {
        const mult = Math.max(minPct, 1 - falloff * i);
        dealDamage(w, c, e, v(def, "damage", rank) * mult, "physical", {});
      });
      w.fx.push({ t: "ability", effect: def.effect, x: c.x, y: c.y, x2: end.x, y2: end.y, radius: width, team: c.team });
      return true;
    }
    case "stormcaller:W": {
      if (!target || target.kind !== "hero") return false;
      const dur = v(def, "duration", rank) * 1000;
      addStatus(target, { kind: "damageAmp", pct: v(def, "ampPct", rank) / 100, until: w.now + dur, id: "stormcaller:W:amp" });
      addStatus(c, { kind: "attackSpeed", amount: v(def, "bonusAsVsMarked", rank), until: w.now + dur, id: `markAS:${target.id}` });
      w.fx.push({ t: "ability", effect: def.effect, x: target.x, y: target.y, x2: target.x, y2: target.y, radius: 40, team: c.team });
      return true;
    }
    case "stormcaller:E": {
      const dur = v(def, "duration", rank) * 1000;
      addStatus(c, { kind: "speed", pct: 0, flat: v(def, "moveSpeed", rank), until: w.now + dur, id: "stormcaller:E:ms" });
      addStatus(c, { kind: "attackSpeed", amount: v(def, "attackSpeed", rank), until: w.now + dur, id: "stormcaller:E:as" });
      return true;
    }
    case "stormcaller:R": {
      startChannel(w, c, def, rank, p, {
        radius: v(def, "radius", rank),
        enemyDps: v(def, "damagePerTick", rank) / TICK,
        dtype: "physical",
        slowPct: v(def, "slowPct", rank) / 100,
      });
      return true;
    }

    // ---------------- EMBERHEX ----------------
    case "emberhex:Q": {
      spawnAbilityProjectile(w, {
        ownerId: c.id, team: c.team, x: c.x, y: c.y - 20, speed: v(def, "projectileSpeed", rank) || 700,
        targetId: null, tx: p.x, ty: p.y, damage: v(def, "damage", rank), dtype: "magic",
        kind: "fireball", radius: v(def, "radius", rank), fromAbility: true, onHit: { tag: "none" },
      });
      return true;
    }
    case "emberhex:W": {
      createGround(w, c, def.effect, p, {
        radius: v(def, "radius", rank), until: w.now + v(def, "duration", rank) * 1000,
        enemyDps: v(def, "dps", rank), dtype: "magic", slowPct: v(def, "slowPct", rank) / 100,
      });
      return true;
    }
    case "emberhex:E": {
      const dur = v(def, "duration", rank) * 1000;
      addStatus(c, { kind: "spellAmp", pct: v(def, "spellAmpPct", rank) / 100, until: w.now + dur, id: "emberhex:E:amp" });
      // self-following burn aura
      createGround(w, c, "flashfire", { x: c.x, y: c.y }, {
        radius: v(def, "radius", rank), until: w.now + dur, enemyDps: v(def, "dps", rank), dtype: "magic", followOwner: true,
      });
      return true;
    }
    case "emberhex:R": {
      const fuse = v(def, "fuse", rank);
      const radius = v(def, "radius", rank);
      const dmg = v(def, "damage", rank);
      const burnDps = v(def, "burnDps", rank);
      const burnDur = v(def, "burnDuration", rank);
      // delayed firestorm via a one-shot ground effect that detonates on expiry
      createGround(w, c, "conflagration", p, {
        radius, until: w.now + fuse * 1000, detonate: { dmg, amp, burnDps, burnDur },
      });
      w.fx.push({ t: "ability", effect: def.effect, x: p.x, y: p.y, x2: p.x, y2: p.y, radius, team: c.team });
      return true;
    }

    // ---------------- BOOMTINKER ----------------
    case "boomtinker:Q": {
      spawnAbilityProjectile(w, {
        ownerId: c.id, team: c.team, x: c.x, y: c.y - 20, speed: v(def, "projectileSpeed", rank) || 650,
        targetId: null, tx: p.x, ty: p.y, damage: v(def, "damage", rank), dtype: "magic",
        kind: "dynamite", radius: v(def, "radius", rank), fromAbility: true,
        onHit: { tag: "buildingBonus", pct: v(def, "buildingBonusPct", rank) },
      });
      return true;
    }
    case "boomtinker:W": {
      const id = nextId(w, "m");
      w.mines.set(id, {
        id, ownerId: c.id, team: c.team, x: p.x, y: p.y,
        armedAt: w.now + v(def, "armDelay", rank) * 1000, expireAt: w.now + v(def, "lifetime", rank) * 1000,
        damage: v(def, "damage", rank), triggerRadius: v(def, "triggerRadius", rank), slowPct: v(def, "slowPct", rank) / 100,
      });
      // enforce max mines
      const max = v(def, "maxMines", rank);
      const mine = [...w.mines.values()].filter((m) => m.ownerId === c.id);
      if (mine.length > max) {
        mine.slice(0, mine.length - max).forEach((m) => w.mines.delete(m.id));
      }
      return true;
    }
    case "boomtinker:E": {
      addStatus(c, { kind: "splashAttacks", left: v(def, "attacks", rank), radius: v(def, "splashRadius", rank), pct: v(def, "splashPct", rank) / 100, until: w.now + 12000, id: "boomtinker:E" });
      return true;
    }
    case "boomtinker:R": {
      const from = { x: c.x, y: c.y };
      // dash to point (capped), brief unstoppable+speed, then slam
      c.x = p.x;
      c.y = p.y;
      c.path = [];
      c.order = { type: "idle" };
      addStatus(c, { kind: "unstoppable", until: w.now + 400 });
      const radius = v(def, "radius", rank);
      for (const e of enemiesInRadius(w, c.team, c, radius, true)) {
        dealDamage(w, c, e, v(def, "damage", rank), "magic", { attackerSpellAmp: amp, structureBonusPct: v(def, "buildingBonusPct", rank) });
        if (e.kind !== "structure") addStatus(e, { kind: "stun", until: w.now + v(def, "stun", rank) * 1000, sourceId: c.id });
      }
      w.fx.push({ t: "blink", x: from.x, y: from.y, x2: c.x, y2: c.y });
      w.fx.push({ t: "ability", effect: def.effect, x: c.x, y: c.y, x2: c.x, y2: c.y, radius, team: c.team });
      return true;
    }

    // ---------------- BREWKEEPER ----------------
    case "brewkeeper:Q": {
      // heal a same-team non-neutral ally, else self (never heal a neutral)
      const ally = target && !target.neutral && target.team === c.team ? target : c;
      ally.hp = Math.min(ally.maxHp, ally.hp + v(def, "heal", rank));
      addStatus(ally, { kind: "heal", hps: v(def, "regenPerSec", rank), until: w.now + v(def, "regenDuration", rank) * 1000, nextTick: w.now + 500, id: "brewkeeper:Q:regen" });
      w.fx.push({ t: "heal", x: ally.x, y: ally.y, amount: v(def, "heal", rank) });
      return true;
    }
    case "brewkeeper:W": {
      const radius = v(def, "radius", rank);
      for (const e of enemiesInRadius(w, c.team, p, radius, false)) {
        if (e.kind === "structure") continue;
        dealDamage(w, c, e, v(def, "damage", rank), "magic", { attackerSpellAmp: amp });
        addStatus(e, { kind: "silence", until: w.now + v(def, "silence", rank) * 1000 });
        addStatus(e, { kind: "slow", pct: v(def, "slowPct", rank) / 100, until: w.now + v(def, "silence", rank) * 1000, id: `brewkeeper:W:${e.id}` });
      }
      w.fx.push({ t: "ability", effect: def.effect, x: p.x, y: p.y, x2: p.x, y2: p.y, radius, team: c.team });
      return true;
    }
    case "brewkeeper:E": {
      const dur = v(def, "duration", rank) * 1000;
      for (const a of alliesInRadius(w, c.team, c, v(def, "auraRadius", rank))) {
        addStatus(a, { kind: "shield", amount: v(def, "shield", rank), until: w.now + dur, id: "brewkeeper:E:shield" });
        addStatus(a, { kind: "armorBonus", amount: v(def, "bonusArmor", rank), until: w.now + dur, id: "brewkeeper:E:armor" });
      }
      return true;
    }
    case "brewkeeper:R": {
      startChannel(w, c, def, rank, { x: c.x, y: c.y }, {
        radius: v(def, "radius", rank), allyHealPerTick: v(def, "healPerTick", rank), allyManaPerTick: v(def, "manaPerTick", rank), cleanse: true,
      });
      return true;
    }
  }
  return false;
}

// ---- channels --------------------------------------------------------------
type ChannelBundle = {
  radius: number;
  enemyDps?: number;
  dtype?: import("../data/config").DamageType;
  slowPct?: number;
  allyHealPerTick?: number;
  allyManaPerTick?: number;
  cleanse?: boolean;
};

function startChannel(w: World, c: Unit, def: AbilityDef, rank: number, p: Vec2, b: ChannelBundle): void {
  if (!c.hero) return;
  const dur = v(def, "channel", rank) * 1000;
  c.hero.channel = { effect: def.effect, key: def.key, rank, until: w.now + dur, nextTick: w.now + TICK * 1000, point: { ...p } };
  createGround(w, c, def.effect, p, {
    radius: b.radius, until: w.now + dur, enemyDps: b.enemyDps, dtype: b.dtype, slowPct: b.slowPct,
    allyHealPerTick: b.allyHealPerTick, allyManaPerTick: b.allyManaPerTick, cleanse: b.cleanse, channel: true,
  });
  c.order = { type: "idle" };
  c.path = [];
}

export function breakChannel(w: World, u: Unit): void {
  if (!u.hero?.channel) return;
  const eff = u.hero.channel.effect;
  u.hero.channel = null;
  w.groundEffects = w.groundEffects.filter((g) => !(g.ownerId === u.id && g.effect === eff && g.channel));
}

// ---- ground effects --------------------------------------------------------
type GroundOpts = {
  radius: number;
  until: number;
  enemyDps?: number;
  dtype?: import("../data/config").DamageType;
  slowPct?: number;
  allyHealPerTick?: number;
  allyManaPerTick?: number;
  cleanse?: boolean;
  followOwner?: boolean;
  channel?: boolean;
  detonate?: { dmg: number; amp: number; burnDps: number; burnDur: number };
};

function createGround(w: World, c: Unit, effect: string, p: Vec2, o: GroundOpts): void {
  const g: GroundEffect = {
    id: nextId(w, "g"),
    ownerId: c.id,
    team: c.team,
    effect,
    x: p.x,
    y: p.y,
    radius: o.radius,
    until: o.until,
    nextTick: w.now + TICK * 1000,
    tickInterval: TICK * 1000,
    enemyDps: o.enemyDps,
    dtype: o.dtype,
    slowPct: o.slowPct,
    allyHealPerTick: o.allyHealPerTick,
    allyManaPerTick: o.allyManaPerTick,
    cleanse: o.cleanse,
    followOwner: o.followOwner,
    channel: o.channel,
    detonate: o.detonate,
  };
  w.groundEffects.push(g);
}

// ---- per-tick processing ---------------------------------------------------
export function tickAbilities(w: World, dt: number): void {
  tickPassives(w, dt);
  tickStatusDots(w);
  tickGround(w);
  tickChannels(w);
}

/** Apply always-on passive abilities (Banner aura, Bloodthirst). */
function tickPassives(w: World, dt: number): void {
  for (const u of w.units.values()) {
    if (!u.alive || !u.hero) continue;
    const def = HERO_BY_ID[u.hero.defId];
    if (!def) continue;
    // Ironvow E — Banner of Resolve aura
    const banner = u.hero.abilities.E.rank;
    if (def.abilities.E.effect === "ironvow:E" && banner > 0) {
      const b = def.abilities.E;
      const radius = v(b, "auraRadius", banner);
      const msPct = v(b, "moveSpeedPct", banner) / 100;
      const regen = v(b, "hpRegen", banner);
      for (const a of alliesInRadius(w, u.team, u, radius)) {
        addStatus(a, { kind: "speed", pct: msPct, flat: 0, until: w.now + 400, id: "banner" });
        if (a.hp < a.maxHp) a.hp = Math.min(a.maxHp, a.hp + regen * dt);
      }
    }
    // Duskblade E — Bloodthirst (lifesteal + attack-speed)
    const blood = u.hero.abilities.E.rank;
    if (def.abilities.E.effect === "duskblade:E" && blood > 0) {
      const b = def.abilities.E;
      addStatus(u, { kind: "lifesteal", pct: v(b, "lifestealPct", blood) / 100, until: w.now + 500, id: "bloodthirst:ls" });
      const asBonus = v(b, "asPerStack", blood) * v(b, "maxStacks", blood) * 0.6;
      addStatus(u, { kind: "attackSpeed", amount: asBonus, until: w.now + 500, id: "bloodthirst:as" });
    }
  }
}

function tickStatusDots(w: World): void {
  for (const u of w.units.values()) {
    if (!u.alive) continue;
    for (const s of u.statuses) {
      if (s.kind === "dot") {
        while (w.now >= s.nextTick && s.nextTick <= s.until) {
          const src = w.units.get(s.sourceId) ?? null;
          dealDamage(w, src, u, s.dps * 0.5, s.dtype, { attackerSpellAmp: src ? spellAmp(src) : 0 });
          s.nextTick += 500;
          if (!u.alive) break;
        }
      } else if (s.kind === "heal") {
        while (w.now >= s.nextTick && s.nextTick <= s.until) {
          u.hp = Math.min(u.maxHp, u.hp + s.hps * 0.5);
          s.nextTick += 500;
        }
      }
    }
  }
}

function tickGround(w: World): void {
  const survivors: GroundEffect[] = [];
  for (const g of w.groundEffects) {
    if (g.followOwner) {
      const owner = w.units.get(g.ownerId);
      if (owner && owner.alive) {
        g.x = owner.x;
        g.y = owner.y;
      } else {
        continue; // owner gone: drop aura
      }
    }
    // ticking effects
    while (w.now >= g.nextTick && g.nextTick <= g.until) {
      applyGroundTick(w, g);
      g.nextTick += g.tickInterval;
    }
    if (w.now >= g.until) {
      if (g.detonate) detonateConflagration(w, g, g.detonate);
      continue; // expired
    }
    survivors.push(g);
  }
  w.groundEffects = survivors;
}

function applyGroundTick(w: World, g: GroundEffect): void {
  if (g.enemyDps && g.enemyDps > 0) {
    const src = w.units.get(g.ownerId) ?? null;
    for (const e of enemiesInRadius(w, g.team, g, g.radius, false)) {
      if (e.kind === "structure") continue;
      dealDamage(w, src, e, g.enemyDps * (g.tickInterval / 1000), g.dtype ?? "magic", { attackerSpellAmp: src ? spellAmp(src) : 0 });
      if (g.slowPct && g.slowPct > 0) addStatus(e, { kind: "slow", pct: g.slowPct, until: w.now + 800, id: `ground:${g.id}:${e.id}` });
    }
  }
  if ((g.allyHealPerTick && g.allyHealPerTick > 0) || (g.allyManaPerTick && g.allyManaPerTick > 0) || g.cleanse) {
    for (const a of alliesInRadius(w, g.team, g, g.radius)) {
      if (g.allyHealPerTick) a.hp = Math.min(a.maxHp, a.hp + g.allyHealPerTick);
      if (g.allyManaPerTick) a.mp = Math.min(a.maxMp, a.mp + g.allyManaPerTick);
      if (g.cleanse) cleanseSlows(a);
    }
    if (g.allyHealPerTick) w.fx.push({ t: "heal", x: g.x, y: g.y, amount: g.allyHealPerTick });
  }
}

function detonateConflagration(w: World, g: GroundEffect, d: NonNullable<GroundOpts["detonate"]>): void {
  const src = w.units.get(g.ownerId) ?? null;
  w.fx.push({ t: "explosion", x: g.x, y: g.y, radius: g.radius, color: 0xff5a1a });
  for (const e of enemiesInRadius(w, g.team, g, g.radius, true)) {
    dealDamage(w, src, e, d.dmg, "magic", { attackerSpellAmp: d.amp });
    if (e.kind !== "structure") addStatus(e, { kind: "dot", dps: d.burnDps, until: w.now + d.burnDur * 1000, nextTick: w.now + 500, dtype: "magic", sourceId: g.ownerId, id: `conflag:${e.id}` });
  }
}

function tickChannels(w: World): void {
  for (const u of w.units.values()) {
    const ch = u.hero?.channel;
    if (!ch) continue;
    if (w.now >= ch.until) {
      u.hero!.channel = null;
    }
  }
}

// ---- item actives ----------------------------------------------------------
export function useItem(w: World, u: Unit, itemId: string, point?: Vec2): boolean {
  const h = u.hero;
  if (!h || !u.alive || !h.items.includes(itemId)) return false;
  const it = ITEM_BY_ID[itemId];
  if (!it?.active) return false;
  const ready = h.itemActiveReadyAt[itemId] ?? 0;
  if (w.now < ready) return false;
  switch (it.active.kind) {
    case "haste":
      addStatus(u, { kind: "speed", pct: 0, flat: 120, until: w.now + 3500, id: "item:haste" });
      addStatus(u, { kind: "unstoppable", until: w.now + 3500 });
      break;
    case "barrier":
      addStatus(u, { kind: "shield", amount: 350, until: w.now + 5000, id: "item:barrier" });
      cleanseSlows(u);
      break;
    case "blink": {
      if (!point) return false;
      const d = Math.min(600, dist(u, point));
      const a = Math.atan2(point.y - u.y, point.x - u.x);
      const from = { x: u.x, y: u.y };
      u.x += Math.cos(a) * d;
      u.y += Math.sin(a) * d;
      u.path = [];
      u.order = { type: "idle" };
      w.fx.push({ t: "blink", x: from.x, y: from.y, x2: u.x, y2: u.y });
      break;
    }
  }
  h.itemActiveReadyAt[itemId] = w.now + it.active.cooldown * 1000;
  return true;
}

// ---- leveling --------------------------------------------------------------
/** Spend all pending ability points: take the ultimate ASAP, then max Q>W>E. */
export function autoLevel(w: World, u: Unit): void {
  if (!u.hero) return;
  let guard = 0;
  while (u.hero.abilityPoints > 0 && guard++ < 8) {
    if (levelAbility(w, u, "R")) continue;
    let did = false;
    for (const k of ["Q", "W", "E"] as AbilityKey[]) {
      if (levelAbility(w, u, k)) {
        did = true;
        break;
      }
    }
    if (!did) break;
  }
}

export function levelAbility(w: World, u: Unit, key: AbilityKey): boolean {
  const h = u.hero;
  if (!h || h.abilityPoints <= 0) return false;
  const def = HERO_BY_ID[h.defId]?.abilities[key];
  if (!def) return false;
  const slot = h.abilities[key];
  const cap = Math.min(def.maxRank, abilityRankCap(key, h.level));
  if (slot.rank >= cap) return false;
  slot.rank += 1;
  h.abilityPoints -= 1;
  void w;
  return true;
}
