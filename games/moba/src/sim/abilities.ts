// Ability casting + per-tick ability/status effects (DoTs, heals, ground zones,
// auras, channels). One switch over the effect id keeps all 24 abilities here.

import { abilityRankCap } from "../data/config";
import type { DamageType } from "../data/config";
import { HERO_BY_ID, valAt } from "../data/heroes";
import type { AbilityDef, AbilityKey } from "../data/heroes";
import { ITEM_BY_ID } from "../data/items";
import { dealDamage, spawnAbilityProjectile } from "./combat";
import { dist, dist2, pointSegDist } from "./math";
import type { Vec2 } from "./math";
import { addStatus, cleanseSlows, disabled, silenced, spellAmp } from "./stats";
import type { GroundEffect, Unit, World } from "./types";
import { nextId } from "./types";

// ground/channel tick interval (s)
const TICK = 0.5;

const abilityOf = (u: Unit, key: AbilityKey): { def: AbilityDef; rank: number } | null => {
  if (!u.hero) {
    return null;
  }
  const def = HERO_BY_ID[u.hero.defId]?.abilities[key];
  if (!def) {
    return null;
  }
  const { rank } = u.hero.abilities[key];
  if (rank <= 0) {
    return null;
  }
  return { def, rank };
};

const v = (def: AbilityDef, field: string, rank: number): number => valAt(def.values[field], rank);

export interface CastInput {
  key: AbilityKey;
  point?: Vec2;
  targetId?: string;
}

const clampCastRange = (caster: Unit, point: Vec2, range: number): Vec2 => {
  const dx = point.x - caster.x;
  const dy = point.y - caster.y;
  const d = Math.hypot(dx, dy);
  if (d <= range || d < 1) {
    return point;
  }
  return { x: caster.x + (dx / d) * range, y: caster.y + (dy / d) * range };
};

const enemiesInRadius = (
  w: World,
  team: string,
  p: Vec2,
  radius: number,
  allowStructure = true,
): Unit[] => {
  const out: Unit[] = [];
  const r2 = radius * radius;
  for (const u of w.units.values()) {
    // neutrals are enemies of every team; same-team non-neutrals are not
    if (!u.alive || (!u.neutral && u.team === team)) {
      continue;
    }
    if (u.kind === "structure" && (!allowStructure || !u.structure?.attackable)) {
      continue;
    }
    if (u.statuses.some((s) => s.kind === "untargetable")) {
      continue;
    }
    if (dist2(u, p) <= r2) {
      out.push(u);
    }
  }
  return out;
};

const alliesInRadius = (
  w: World,
  team: string,
  p: Vec2,
  radius: number,
  heroesOnly = false,
): Unit[] => {
  const out: Unit[] = [];
  const r2 = radius * radius;
  for (const u of w.units.values()) {
    // never count neutrals as allies (they carry team:"dire" only for serialization)
    if (!u.alive || u.neutral || u.team !== team) {
      continue;
    }
    if (heroesOnly && u.kind !== "hero") {
      continue;
    }
    if (u.kind === "structure") {
      continue;
    }
    if (dist2(u, p) <= r2) {
      out.push(u);
    }
  }
  return out;
};

// ---- ground effects --------------------------------------------------------
interface GroundOpts {
  radius: number;
  until: number;
  enemyDps?: number;
  dtype?: DamageType;
  slowPct?: number;
  allyHealPerTick?: number;
  allyManaPerTick?: number;
  cleanse?: boolean;
  followOwner?: boolean;
  channel?: boolean;
  detonate?: { dmg: number; amp: number; burnDps: number; burnDur: number };
}

const createGround = (w: World, c: Unit, effect: string, p: Vec2, o: GroundOpts): void => {
  // Self-following auras (e.g. Flashfire) track the caster, so recasting before the
  // old one expires would stack two zones on the same hero → double DPS. Replace any
  // prior aura from this caster with the same effect instead of stacking.
  if (o.followOwner) {
    w.groundEffects = w.groundEffects.filter(
      (g) => !(g.followOwner && g.ownerId === c.id && g.effect === effect),
    );
  }
  const g: GroundEffect = {
    allyHealPerTick: o.allyHealPerTick,
    allyManaPerTick: o.allyManaPerTick,
    channel: o.channel,
    cleanse: o.cleanse,
    detonate: o.detonate,
    dtype: o.dtype,
    effect,
    enemyDps: o.enemyDps,
    followOwner: o.followOwner,
    id: nextId(w, "g"),
    nextTick: w.now + TICK * 1000,
    ownerId: c.id,
    radius: o.radius,
    slowPct: o.slowPct,
    team: c.team,
    tickInterval: TICK * 1000,
    until: o.until,
    x: p.x,
    y: p.y,
  };
  w.groundEffects.push(g);
};

// ---- channels --------------------------------------------------------------
interface ChannelBundle {
  radius: number;
  enemyDps?: number;
  dtype?: DamageType;
  slowPct?: number;
  allyHealPerTick?: number;
  allyManaPerTick?: number;
  cleanse?: boolean;
}

const startChannel = (
  w: World,
  c: Unit,
  def: AbilityDef,
  rank: number,
  p: Vec2,
  b: ChannelBundle,
): void => {
  if (!c.hero) {
    return;
  }
  const dur = v(def, "channel", rank) * 1000;
  c.hero.channel = {
    effect: def.effect,
    key: def.key,
    nextTick: w.now + TICK * 1000,
    point: { ...p },
    rank,
    until: w.now + dur,
  };
  createGround(w, c, def.effect, p, {
    allyHealPerTick: b.allyHealPerTick,
    allyManaPerTick: b.allyManaPerTick,
    channel: true,
    cleanse: b.cleanse,
    dtype: b.dtype,
    enemyDps: b.enemyDps,
    radius: b.radius,
    slowPct: b.slowPct,
    until: w.now + dur,
  });
  c.order = { type: "idle" };
  c.path = [];
};

export const breakChannel = (w: World, u: Unit): void => {
  if (!u.hero?.channel) {
    return;
  }
  const eff = u.hero.channel.effect;
  u.hero.channel = null;
  w.groundEffects = w.groundEffects.filter(
    (g) => !(g.ownerId === u.id && g.effect === eff && g.channel),
  );
};

// ---- the dispatch ----------------------------------------------------------
interface CastContext {
  w: World;
  c: Unit;
  def: AbilityDef;
  rank: number;
  p: Vec2;
  amp: number;
  target?: Unit;
}

const castIronvow = ({ amp, c, def, rank, target, w }: CastContext): boolean => {
  switch (def.effect) {
    case "ironvow:Q": {
      if (!target) {
        return false;
      }
      dealDamage(w, c, target, v(def, "damage", rank), "physical", {});
      addStatus(target, {
        kind: "stun",
        sourceId: c.id,
        until: w.now + v(def, "stun", rank) * 1000,
      });
      w.fx.push({
        effect: def.effect,
        radius: 40,
        t: "ability",
        team: c.team,
        x: c.x,
        x2: target.x,
        y: c.y,
        y2: target.y,
      });
      return true;
    }
    case "ironvow:W": {
      const dur = v(def, "duration", rank) * 1000;
      addStatus(c, {
        amount: v(def, "bonusArmor", rank),
        id: "ironvow:W:armor",
        kind: "armorBonus",
        until: w.now + dur,
      });
      addStatus(c, {
        amount: v(def, "shield", rank),
        id: "ironvow:W:shield",
        kind: "shield",
        until: w.now + dur,
      });
      addStatus(c, {
        id: "ironvow:W:reflect",
        kind: "reflect",
        pct: v(def, "reflectPct", rank) / 100,
        until: w.now + dur,
      });
      return true;
    }
    case "ironvow:R": {
      const radius = v(def, "radius", rank);
      const dur = v(def, "buffDuration", rank) * 1000;
      addStatus(c, {
        id: "ironvow:R:dr",
        kind: "damageReduction",
        pct: v(def, "damageReductionPct", rank) / 100,
        until: w.now + dur,
      });
      for (const e of enemiesInRadius(w, c.team, c, radius, false)) {
        if (e.kind === "structure") {
          continue;
        }
        dealDamage(w, c, e, v(def, "damage", rank), "magic", { attackerSpellAmp: amp });
        addStatus(e, {
          kind: "taunt",
          targetId: c.id,
          until: w.now + v(def, "taunt", rank) * 1000,
        });
      }
      w.fx.push({
        effect: def.effect,
        radius,
        t: "ability",
        team: c.team,
        x: c.x,
        x2: c.x,
        y: c.y,
        y2: c.y,
      });
      return true;
    }

    default: {
      return false;
    }
  }
};

const castDuskblade = ({ c, def, p, rank, target, w }: CastContext): boolean => {
  switch (def.effect) {
    case "duskblade:Q": {
      const from = { x: c.x, y: c.y };
      const d = Math.min(v(def, "blink", rank), dist(c, p));
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      c.x += Math.cos(ang) * d;
      c.y += Math.sin(ang) * d;
      c.path = [];
      c.order = { type: "idle" };
      addStatus(c, {
        bonus: v(def, "bonusNextAttack", rank),
        id: "duskblade:Q:emp",
        kind: "empowerNextAttack",
        until: w.now + v(def, "window", rank) * 1000,
      });
      w.fx.push({ t: "blink", x: from.x, x2: c.x, y: from.y, y2: c.y });
      return true;
    }
    case "duskblade:W": {
      const range = v(def, "coneRange", rank);
      const half = (v(def, "coneAngle", rank) * Math.PI) / 360;
      const dirAng = Math.atan2(p.y - c.y, p.x - c.x);
      for (const e of enemiesInRadius(w, c.team, c, range, true)) {
        const a = Math.atan2(e.y - c.y, e.x - c.x);
        let diff = Math.abs(a - dirAng);
        if (diff > Math.PI) {
          diff = Math.PI * 2 - diff;
        }
        if (diff <= half) {
          dealDamage(w, c, e, v(def, "damage", rank), "physical", {});
          addStatus(e, {
            id: `duskblade:W:${e.id}`,
            kind: "slow",
            pct: v(def, "slowPct", rank) / 100,
            until: w.now + v(def, "slowDuration", rank) * 1000,
          });
        }
      }
      w.fx.push({
        effect: def.effect,
        radius: range,
        t: "ability",
        team: c.team,
        x: c.x,
        x2: p.x,
        y: c.y,
        y2: p.y,
      });
      return true;
    }
    case "duskblade:R": {
      if (!target) {
        return false;
      }
      const strikes = v(def, "strikes", rank);
      const per = v(def, "damagePerStrike", rank);
      addStatus(c, { kind: "untargetable", until: w.now + v(def, "untargetable", rank) * 1000 });
      // blink behind target
      c.x = target.x + (c.x < target.x ? 30 : -30);
      c.y = target.y + 6;
      const total = per * (strikes - 1) + per * v(def, "critMult", rank);
      dealDamage(w, c, target, total, "physical", { crit: true });
      w.fx.push({
        effect: def.effect,
        radius: 40,
        t: "ability",
        team: c.team,
        x: c.x,
        x2: target.x,
        y: c.y,
        y2: target.y,
      });
      return true;
    }

    default: {
      return false;
    }
  }
};

const castStormcaller = ({ c, def, p, rank, target, w }: CastContext): boolean => {
  switch (def.effect) {
    case "stormcaller:Q": {
      const len = v(def, "length", rank);
      const width = v(def, "width", rank);
      const ang = Math.atan2(p.y - c.y, p.x - c.x);
      const end = { x: c.x + Math.cos(ang) * len, y: c.y + Math.sin(ang) * len };
      const hits = enemiesInRadius(w, c.team, c, len + width, true)
        .filter((e) => pointSegDist(e, c, end) <= width / 2 + e.radius)
        .toSorted((a, b) => dist2(c, a) - dist2(c, b));
      const minPct = v(def, "minPct", rank) / 100;
      const falloff = v(def, "falloffPct", rank) / 100;
      for (const [i, e] of hits.entries()) {
        const mult = Math.max(minPct, 1 - falloff * i);
        dealDamage(w, c, e, v(def, "damage", rank) * mult, "physical", {});
      }
      w.fx.push({
        effect: def.effect,
        radius: width,
        t: "ability",
        team: c.team,
        x: c.x,
        x2: end.x,
        y: c.y,
        y2: end.y,
      });
      return true;
    }
    case "stormcaller:W": {
      if (!target || target.kind !== "hero") {
        return false;
      }
      const dur = v(def, "duration", rank) * 1000;
      addStatus(target, {
        id: "stormcaller:W:amp",
        kind: "damageAmp",
        pct: v(def, "ampPct", rank) / 100,
        until: w.now + dur,
      });
      addStatus(c, {
        amount: v(def, "bonusAsVsMarked", rank),
        id: `markAS:${target.id}`,
        kind: "attackSpeed",
        until: w.now + dur,
      });
      w.fx.push({
        effect: def.effect,
        radius: 40,
        t: "ability",
        team: c.team,
        x: target.x,
        x2: target.x,
        y: target.y,
        y2: target.y,
      });
      return true;
    }
    case "stormcaller:E": {
      const dur = v(def, "duration", rank) * 1000;
      addStatus(c, {
        flat: v(def, "moveSpeed", rank),
        id: "stormcaller:E:ms",
        kind: "speed",
        pct: 0,
        until: w.now + dur,
      });
      addStatus(c, {
        amount: v(def, "attackSpeed", rank),
        id: "stormcaller:E:as",
        kind: "attackSpeed",
        until: w.now + dur,
      });
      return true;
    }
    case "stormcaller:R": {
      startChannel(w, c, def, rank, p, {
        dtype: "physical",
        enemyDps: v(def, "damagePerTick", rank) / TICK,
        radius: v(def, "radius", rank),
        slowPct: v(def, "slowPct", rank) / 100,
      });
      return true;
    }

    default: {
      return false;
    }
  }
};

const castEmberhex = ({ amp, c, def, p, rank, w }: CastContext): boolean => {
  switch (def.effect) {
    case "emberhex:Q": {
      spawnAbilityProjectile(w, {
        damage: v(def, "damage", rank),
        dtype: "magic",
        kind: "fireball",
        onHit: { tag: "none" },
        ownerId: c.id,
        radius: v(def, "radius", rank),
        speed: v(def, "projectileSpeed", rank) || 700,
        targetId: null,
        team: c.team,
        tx: p.x,
        ty: p.y,
        x: c.x,
        y: c.y - 20,
      });
      return true;
    }
    case "emberhex:W": {
      createGround(w, c, def.effect, p, {
        dtype: "magic",
        enemyDps: v(def, "dps", rank),
        radius: v(def, "radius", rank),
        slowPct: v(def, "slowPct", rank) / 100,
        until: w.now + v(def, "duration", rank) * 1000,
      });
      return true;
    }
    case "emberhex:E": {
      const dur = v(def, "duration", rank) * 1000;
      addStatus(c, {
        id: "emberhex:E:amp",
        kind: "spellAmp",
        pct: v(def, "spellAmpPct", rank) / 100,
        until: w.now + dur,
      });
      // self-following burn aura
      createGround(
        w,
        c,
        "flashfire",
        { x: c.x, y: c.y },
        {
          dtype: "magic",
          enemyDps: v(def, "dps", rank),
          followOwner: true,
          radius: v(def, "radius", rank),
          until: w.now + dur,
        },
      );
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
        detonate: { amp, burnDps, burnDur, dmg },
        radius,
        until: w.now + fuse * 1000,
      });
      w.fx.push({
        effect: def.effect,
        radius,
        t: "ability",
        team: c.team,
        x: p.x,
        x2: p.x,
        y: p.y,
        y2: p.y,
      });
      return true;
    }

    default: {
      return false;
    }
  }
};

const castBoomtinker = ({ amp, c, def, p, rank, w }: CastContext): boolean => {
  switch (def.effect) {
    case "boomtinker:Q": {
      spawnAbilityProjectile(w, {
        damage: v(def, "damage", rank),
        dtype: "magic",
        kind: "dynamite",
        onHit: { pct: v(def, "buildingBonusPct", rank), tag: "buildingBonus" },
        ownerId: c.id,
        radius: v(def, "radius", rank),
        speed: v(def, "projectileSpeed", rank) || 650,
        targetId: null,
        team: c.team,
        tx: p.x,
        ty: p.y,
        x: c.x,
        y: c.y - 20,
      });
      return true;
    }
    case "boomtinker:W": {
      const id = nextId(w, "m");
      w.mines.set(id, {
        armedAt: w.now + v(def, "armDelay", rank) * 1000,
        damage: v(def, "damage", rank),
        expireAt: w.now + v(def, "lifetime", rank) * 1000,
        id,
        ownerId: c.id,
        slowPct: v(def, "slowPct", rank) / 100,
        team: c.team,
        triggerRadius: v(def, "triggerRadius", rank),
        x: p.x,
        y: p.y,
      });
      // enforce max mines
      const max = v(def, "maxMines", rank);
      const mine = [...w.mines.values()].filter((m) => m.ownerId === c.id);
      if (mine.length > max) {
        for (const m of mine.slice(0, mine.length - max)) {
          w.mines.delete(m.id);
        }
      }
      return true;
    }
    case "boomtinker:E": {
      addStatus(c, {
        id: "boomtinker:E",
        kind: "splashAttacks",
        left: v(def, "attacks", rank),
        pct: v(def, "splashPct", rank) / 100,
        radius: v(def, "splashRadius", rank),
        until: w.now + 12_000,
      });
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
        dealDamage(w, c, e, v(def, "damage", rank), "magic", {
          attackerSpellAmp: amp,
          structureBonusPct: v(def, "buildingBonusPct", rank),
        });
        if (e.kind !== "structure") {
          addStatus(e, {
            kind: "stun",
            sourceId: c.id,
            until: w.now + v(def, "stun", rank) * 1000,
          });
        }
      }
      w.fx.push(
        { t: "blink", x: from.x, x2: c.x, y: from.y, y2: c.y },
        {
          effect: def.effect,
          radius,
          t: "ability",
          team: c.team,
          x: c.x,
          x2: c.x,
          y: c.y,
          y2: c.y,
        },
      );
      return true;
    }

    default: {
      return false;
    }
  }
};

const castBrewkeeper = ({ amp, c, def, p, rank, target, w }: CastContext): boolean => {
  switch (def.effect) {
    case "brewkeeper:Q": {
      // heal a same-team non-neutral ally, else self (never heal a neutral)
      const ally = target && !target.neutral && target.team === c.team ? target : c;
      ally.hp = Math.min(ally.maxHp, ally.hp + v(def, "heal", rank));
      addStatus(ally, {
        hps: v(def, "regenPerSec", rank),
        id: "brewkeeper:Q:regen",
        kind: "heal",
        nextTick: w.now + 500,
        until: w.now + v(def, "regenDuration", rank) * 1000,
      });
      w.fx.push(
        { amount: v(def, "heal", rank), t: "heal", x: ally.x, y: ally.y },
        {
          effect: def.effect,
          radius: 40,
          t: "ability",
          team: c.team,
          x: ally.x,
          x2: ally.x,
          y: ally.y,
          y2: ally.y,
        },
      );
      return true;
    }
    case "brewkeeper:W": {
      const radius = v(def, "radius", rank);
      for (const e of enemiesInRadius(w, c.team, p, radius, false)) {
        if (e.kind === "structure") {
          continue;
        }
        dealDamage(w, c, e, v(def, "damage", rank), "magic", { attackerSpellAmp: amp });
        addStatus(e, { kind: "silence", until: w.now + v(def, "silence", rank) * 1000 });
        addStatus(e, {
          id: `brewkeeper:W:${e.id}`,
          kind: "slow",
          pct: v(def, "slowPct", rank) / 100,
          until: w.now + v(def, "silence", rank) * 1000,
        });
      }
      w.fx.push({
        effect: def.effect,
        radius,
        t: "ability",
        team: c.team,
        x: p.x,
        x2: p.x,
        y: p.y,
        y2: p.y,
      });
      return true;
    }
    case "brewkeeper:E": {
      const dur = v(def, "duration", rank) * 1000;
      for (const a of alliesInRadius(w, c.team, c, v(def, "auraRadius", rank))) {
        addStatus(a, {
          amount: v(def, "shield", rank),
          id: "brewkeeper:E:shield",
          kind: "shield",
          until: w.now + dur,
        });
        addStatus(a, {
          amount: v(def, "bonusArmor", rank),
          id: "brewkeeper:E:armor",
          kind: "armorBonus",
          until: w.now + dur,
        });
      }
      return true;
    }
    case "brewkeeper:R": {
      startChannel(
        w,
        c,
        def,
        rank,
        { x: c.x, y: c.y },
        {
          allyHealPerTick: v(def, "healPerTick", rank),
          allyManaPerTick: v(def, "manaPerTick", rank),
          cleanse: true,
          radius: v(def, "radius", rank),
        },
      );
      return true;
    }
    default: {
      return false;
    }
  }
};

const HERO_CASTS = new Map<string, (cast: CastContext) => boolean>([
  ["boomtinker", castBoomtinker],
  ["brewkeeper", castBrewkeeper],
  ["duskblade", castDuskblade],
  ["emberhex", castEmberhex],
  ["ironvow", castIronvow],
  ["stormcaller", castStormcaller],
]);

const dispatch = (
  w: World,
  c: Unit,
  def: AbilityDef,
  rank: number,
  p: Vec2,
  target?: Unit,
): boolean => {
  const amp = spellAmp(c);
  const [hero] = def.effect.split(":");
  const cast = HERO_CASTS.get(hero ?? "");
  return cast?.({ amp, c, def, p, rank, target, w }) ?? false;
};

/** Attempt to cast. Returns true if the cast went through (mana/cd consumed). */
export const castAbility = (w: World, caster: Unit, input: CastInput): boolean => {
  if (!caster.alive || !caster.hero) {
    return false;
  }
  // stunned — but `unstoppable` (Haste) overrides
  if (disabled(caster)) {
    return false;
  }
  const got = abilityOf(caster, input.key);
  if (!got) {
    return false;
  }
  const { def, rank } = got;
  if (def.targeting === "passive") {
    return false;
  }
  if (silenced(caster)) {
    return false;
  }
  const slot = caster.hero.abilities[input.key];
  if (w.now < slot.readyAt) {
    return false;
  }
  const manaCost = valAt(def.manaCost, rank);
  if (caster.mp < manaCost) {
    return false;
  }

  // resolve target requirements
  let point: Vec2 | undefined = input.point;
  let target: Unit | undefined;
  if (def.targeting === "unit") {
    if (!input.targetId) {
      return false;
    }
    target = w.units.get(input.targetId);
    if (!target || !target.alive) {
      return false;
    }
    if (dist(caster, target) > def.castRange + caster.radius + target.radius + 30) {
      return false;
    }
    point = { x: target.x, y: target.y };
  } else if (def.targeting === "point") {
    if (!point) {
      return false;
    }
    point = clampCastRange(caster, point, def.castRange);
  } else {
    point = { x: caster.x, y: caster.y };
  }

  const ok = dispatch(w, caster, def, rank, point, target);
  if (!ok) {
    return false;
  }

  caster.mp -= manaCost;
  slot.readyAt = w.now + valAt(def.cooldown, rank) * 1000;
  if (caster.facing !== undefined && point) {
    caster.facing = point.x >= caster.x ? 1 : -1;
  }
  w.fx.push({ effect: def.effect, t: "cast", team: caster.team, x: caster.x, y: caster.y });
  return true;
};

// ---- per-tick processing ---------------------------------------------------

/** Apply always-on passive abilities (Banner aura, Bloodthirst). */
const tickPassives = (w: World, dt: number): void => {
  for (const u of w.units.values()) {
    if (!u.alive || !u.hero) {
      continue;
    }
    const def = HERO_BY_ID[u.hero.defId];
    if (!def) {
      continue;
    }
    // Ironvow E — Banner of Resolve aura
    const banner = u.hero.abilities.E.rank;
    if (def.abilities.E.effect === "ironvow:E" && banner > 0) {
      const b = def.abilities.E;
      const radius = v(b, "auraRadius", banner);
      const msPct = v(b, "moveSpeedPct", banner) / 100;
      const regen = v(b, "hpRegen", banner);
      for (const a of alliesInRadius(w, u.team, u, radius)) {
        addStatus(a, { flat: 0, id: "banner", kind: "speed", pct: msPct, until: w.now + 400 });
        if (a.hp < a.maxHp) {
          a.hp = Math.min(a.maxHp, a.hp + regen * dt);
        }
      }
    }
    // Duskblade E — Bloodthirst (lifesteal + attack-speed)
    const blood = u.hero.abilities.E.rank;
    if (def.abilities.E.effect === "duskblade:E" && blood > 0) {
      const b = def.abilities.E;
      addStatus(u, {
        id: "bloodthirst:ls",
        kind: "lifesteal",
        pct: v(b, "lifestealPct", blood) / 100,
        until: w.now + 500,
      });
      const asBonus = v(b, "asPerStack", blood) * v(b, "maxStacks", blood) * 0.6;
      addStatus(u, {
        amount: asBonus,
        id: "bloodthirst:as",
        kind: "attackSpeed",
        until: w.now + 500,
      });
    }
  }
};

const tickStatusDots = (w: World): void => {
  for (const u of w.units.values()) {
    if (!u.alive) {
      continue;
    }
    for (const s of u.statuses) {
      if (s.kind === "dot") {
        while (w.now >= s.nextTick && s.nextTick <= s.until) {
          const src = w.units.get(s.sourceId) ?? null;
          dealDamage(w, src, u, s.dps * 0.5, s.dtype, {
            attackerSpellAmp: src ? spellAmp(src) : 0,
          });
          s.nextTick += 500;
          if (!u.alive) {
            break;
          }
        }
      } else if (s.kind === "heal") {
        while (w.now >= s.nextTick && s.nextTick <= s.until) {
          u.hp = Math.min(u.maxHp, u.hp + s.hps * 0.5);
          s.nextTick += 500;
        }
      }
    }
  }
};

const applyGroundTick = (w: World, g: GroundEffect): void => {
  if (g.enemyDps && g.enemyDps > 0) {
    const src = w.units.get(g.ownerId) ?? null;
    for (const e of enemiesInRadius(w, g.team, g, g.radius, false)) {
      if (e.kind === "structure") {
        continue;
      }
      dealDamage(w, src, e, g.enemyDps * (g.tickInterval / 1000), g.dtype ?? "magic", {
        attackerSpellAmp: src ? spellAmp(src) : 0,
      });
      if (g.slowPct && g.slowPct > 0) {
        addStatus(e, {
          id: `ground:${g.id}:${e.id}`,
          kind: "slow",
          pct: g.slowPct,
          until: w.now + 800,
        });
      }
    }
  }
  if (
    (g.allyHealPerTick && g.allyHealPerTick > 0) ||
    (g.allyManaPerTick && g.allyManaPerTick > 0) ||
    g.cleanse
  ) {
    for (const a of alliesInRadius(w, g.team, g, g.radius)) {
      if (g.allyHealPerTick) {
        a.hp = Math.min(a.maxHp, a.hp + g.allyHealPerTick);
      }
      if (g.allyManaPerTick) {
        a.mp = Math.min(a.maxMp, a.mp + g.allyManaPerTick);
      }
      if (g.cleanse) {
        cleanseSlows(a);
      }
    }
    if (g.allyHealPerTick) {
      w.fx.push({ amount: g.allyHealPerTick, t: "heal", x: g.x, y: g.y });
    }
  }
};

const detonateConflagration = (
  w: World,
  g: GroundEffect,
  d: NonNullable<GroundOpts["detonate"]>,
): void => {
  const src = w.units.get(g.ownerId) ?? null;
  w.fx.push({ color: 0xff_5a_1a, radius: g.radius, t: "explosion", x: g.x, y: g.y });
  for (const e of enemiesInRadius(w, g.team, g, g.radius, true)) {
    dealDamage(w, src, e, d.dmg, "magic", { attackerSpellAmp: d.amp });
    if (e.kind !== "structure") {
      addStatus(e, {
        dps: d.burnDps,
        dtype: "magic",
        id: `conflag:${e.id}`,
        kind: "dot",
        nextTick: w.now + 500,
        sourceId: g.ownerId,
        until: w.now + d.burnDur * 1000,
      });
    }
  }
};

const tickGround = (w: World): void => {
  const survivors: GroundEffect[] = [];
  for (const g of w.groundEffects) {
    if (g.followOwner) {
      const owner = w.units.get(g.ownerId);
      if (owner && owner.alive) {
        g.x = owner.x;
        g.y = owner.y;
      } else {
        // owner gone: drop aura
        continue;
      }
    }
    // ticking effects
    while (w.now >= g.nextTick && g.nextTick <= g.until) {
      applyGroundTick(w, g);
      g.nextTick += g.tickInterval;
    }
    if (w.now >= g.until) {
      if (g.detonate) {
        detonateConflagration(w, g, g.detonate);
      }
      // expired
      continue;
    }
    survivors.push(g);
  }
  w.groundEffects = survivors;
};

const tickChannels = (w: World): void => {
  for (const u of w.units.values()) {
    const h = u.hero;
    if (!h?.channel) {
      continue;
    }
    if (w.now >= h.channel.until) {
      h.channel = null;
    }
  }
};
export const tickAbilities = (w: World, dt: number): void => {
  tickPassives(w, dt);
  tickStatusDots(w);
  tickGround(w);
  tickChannels(w);
};

// ---- item actives ----------------------------------------------------------
export const activateItem = (w: World, u: Unit, itemId: string, point?: Vec2): boolean => {
  const h = u.hero;
  if (!h || !u.alive || !h.items.includes(itemId)) {
    return false;
  }
  const it = ITEM_BY_ID[itemId];
  if (!it?.active) {
    return false;
  }
  const ready = h.itemActiveReadyAt[itemId] ?? 0;
  if (w.now < ready) {
    return false;
  }
  switch (it.active.kind) {
    case "haste": {
      addStatus(u, { flat: 120, id: "item:haste", kind: "speed", pct: 0, until: w.now + 3500 });
      addStatus(u, { kind: "unstoppable", until: w.now + 3500 });
      break;
    }
    case "barrier": {
      addStatus(u, { amount: 350, id: "item:barrier", kind: "shield", until: w.now + 5000 });
      cleanseSlows(u);
      break;
    }
    case "blink": {
      if (!point) {
        return false;
      }
      const d = Math.min(600, dist(u, point));
      const a = Math.atan2(point.y - u.y, point.x - u.x);
      const from = { x: u.x, y: u.y };
      u.x += Math.cos(a) * d;
      u.y += Math.sin(a) * d;
      u.path = [];
      u.order = { type: "idle" };
      w.fx.push({ t: "blink", x: from.x, x2: u.x, y: from.y, y2: u.y });
      break;
    }
    default: {
      break;
    }
  }
  h.itemActiveReadyAt[itemId] = w.now + it.active.cooldown * 1000;
  return true;
};

// ---- leveling --------------------------------------------------------------

export const levelAbility = (u: Unit, key: AbilityKey): boolean => {
  const h = u.hero;
  if (!h || h.abilityPoints <= 0) {
    return false;
  }
  const def = HERO_BY_ID[h.defId]?.abilities[key];
  if (!def) {
    return false;
  }
  const slot = h.abilities[key];
  const cap = Math.min(def.maxRank, abilityRankCap(key, h.level));
  if (slot.rank >= cap) {
    return false;
  }
  slot.rank += 1;
  h.abilityPoints -= 1;
  return true;
};

/** Spend all pending ability points: take the ultimate ASAP, then max Q>W>E. */
export const autoLevel = (w: World, u: Unit): void => {
  if (!u.hero) {
    return;
  }
  let guard = 0;
  while (u.hero.abilityPoints > 0 && guard < 8) {
    guard += 1;
    if (levelAbility(u, "R")) {
      continue;
    }
    let did = false;
    for (const k of ["Q", "W", "E"] satisfies AbilityKey[]) {
      if (levelAbility(u, k)) {
        did = true;
        break;
      }
    }
    if (!did) {
      break;
    }
  }
};
