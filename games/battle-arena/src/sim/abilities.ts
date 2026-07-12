// Ability casting + per-tick ability processing (ground zones, DoTs, meteors).
// Data-driven defs live in data/champions; this switches on def.effect.
//
// Damage timing: casting an ability no longer deals damage on the cast tick.
// Each damaging ability resolves through ONE of two delayed mechanisms so the
// hit lands when the animation visually connects — and is dodgeable:
//   - PendingStrike queue (w.strikes): caster-relative shapes (cones,
//     corridors, jump slams, delayed projectile spawns). Delay = the cast
//     clip's measured contact frame (data/clip-timing.ts) or the leap/dash
//     travel time. Re-tests the hit shape at resolve.
//   - Detonate zones (w.grounds + detonateAt): point-target AoEs (smite,
//     nova, vines, grand hex, meteor). Renders a ground telegraph while armed.
import { CHAMP_BY_ID, valAt, type AbilityDef } from "../data/champions";
import { castStrikeMs } from "../data/clip-timing";
import { HOP_HEIGHT } from "../data/config";
import { ITEM_BY_ID } from "../data/items";
import { angleDelta, angleOf, dist, norm } from "./math";
import { clampToArena, resolveObstacles } from "../data/map";
import { addStatus, cleanseDisables, isDisabled, isSilenced, isUntargetable } from "./stats";
import { applyKnockback, dealDamage, isEnemy, spawnProjectile } from "./combat";
import { abilityShapes, type HitShape } from "./hit-shapes";
import type { AbilityKey, GroundEffect, PendingStrike, Unit, World } from "./types";
import { nextId } from "./types";

export type CastCtx = { point?: { x: number; y: number }; dir?: { x: number; y: number } };

const deg2rad = (d: number) => (d * Math.PI) / 180;

// JUMP attack = a dive: clicking in the air brings you DOWN fast to slam. This
// caps the remaining airtime (or gives a grounded caster a quick hop) so the
// strike lands right away, centred on where you come down.
const JUMP_DIVE_MS = 200;

// Input buffer windows: a press up to CAST_BUFFER_LEAD ms before the cooldown
// ends (or while dashing/stunned) queues and fires the moment it's legal.
const CAST_BUFFER_LEAD = 350; // how early a press may queue
const CAST_BUFFER_MS = 300; // how long the queue lives (≈9 ticks ≈ Smash 10f)

// Arming delays for the point-target detonate zones (ms) — short telegraphs.
const SMITE_ARM_MS = 450;
const NOVA_ARM_MS = 400;
const VINES_ARM_MS = 500;
const HEXRING_ARM_MS = 500;

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
  let point = ctx.point ?? {
    x: caster.x + dir.x * def.castRange,
    y: caster.y + dir.y * def.castRange,
  };
  if (def.targeting === "ground") point = clampCastRange(caster, point, def.castRange);

  const ok = dispatch(w, caster, def, key, dir, point);
  if (!ok) return false;

  slot.readyAt = w.now + valAt(def.cooldown, slot.rank) * 1000;
  caster.facing = angleOf(dir.x, dir.y);
  caster.lastCastAt = w.now;
  caster.lastCastKey = key;
  w.fx.push({
    t: "cast",
    x: caster.x,
    y: caster.y,
    dx: dir.x,
    dy: dir.y,
    champId: caster.champId,
    key,
  });
  return true;
}

function clampCastRange(
  c: Unit,
  p: { x: number; y: number },
  range: number,
): { x: number; y: number } {
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const d = Math.hypot(dx, dy);
  if (d <= range || d < 1e-6) return p;
  return { x: c.x + (dx / d) * range, y: c.y + (dy / d) * range };
}

function startDash(
  u: Unit,
  dir: { x: number; y: number },
  speed: number,
  distance: number,
  w: World,
): void {
  u.dashVx = dir.x * speed;
  u.dashVy = dir.y * speed;
  u.dashUntil = w.now + (distance / speed) * 1000;
  u.facing = angleOf(dir.x, dir.y);
}

/** Pin a unit in place for `ms` — a dash with no velocity (see world.isDashing).
 *  Aerial abilities use it: you're committed to the air, not steering out of it. */
function startHover(u: Unit, w: World, ms: number): void {
  u.dashVx = 0;
  u.dashVy = 0;
  u.dashUntil = w.now + ms;
}

const JUMP_LEAP_SPEED = 20; // horizontal dash speed of a jump-attack leap

/** Abilities hit anything fightable — heroes, camp creeps, AND destructible
 *  props (the boss is handled separately and stays out of reach). Status
 *  riders on props are inert; the damage is what breaks them. */
function targetable(u: Unit): boolean {
  return u.kind === "hero" || u.kind === "creep" || u.kind === "prop";
}

/** Sweep a corridor from (ox,oy) along dir for `length`; returns enemies hit. */
function corridorHits(
  w: World,
  c: Unit,
  ox: number,
  oy: number,
  dir: { x: number; y: number },
  length: number,
  width: number,
): Unit[] {
  const hits: Unit[] = [];
  for (const t of w.units.values()) {
    if (t === c || !t.alive || !targetable(t) || !isEnemy(c, t)) continue;
    const rx = t.x - ox;
    const ry = t.y - oy;
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

/** Enemies covered by an INSTANT shape (cone/corridor/self/at) anchored at
 *  (ox,oy) — the shared hit test for abilities whose geometry is defined in
 *  abilityShapes(). Projectiles and ground zones spawn their own entities. */
function targetsInShape(
  w: World,
  c: Unit,
  shape: HitShape,
  ox: number,
  oy: number,
  dir: { x: number; y: number },
  point: { x: number; y: number },
): Unit[] {
  switch (shape.kind) {
    case "cone": {
      const ang = angleOf(dir.x, dir.y);
      const out: Unit[] = [];
      for (const t of w.units.values()) {
        if (t === c || !t.alive || !targetable(t) || !isEnemy(c, t)) continue;
        if (Math.hypot(t.x - ox, t.y - oy) > shape.radius + t.radius) continue;
        if (Math.abs(angleDelta(ang, angleOf(t.x - ox, t.y - oy))) > shape.half) continue;
        out.push(t);
      }
      return out;
    }
    case "corridor":
      return corridorHits(w, c, ox, oy, dir, shape.length, shape.halfWidth);
    case "circleSelf":
      return aoeEnemies(w, c.team, ox, oy, shape.radius);
    case "circleAt":
      return aoeEnemies(w, c.team, point.x, point.y, shape.radius);
    default:
      return []; // projectile — the sim spawns a projectile instead
  }
}

/** Enemies hit by an ability's (first) instant shape anchored at (ox,oy) —
 *  geometry sourced from abilityShapes() so the sim and the viewer never
 *  disagree on the hit area. */
function abilityTargets(
  w: World,
  c: Unit,
  def: AbilityDef,
  rank: number,
  ox: number,
  oy: number,
  dir: { x: number; y: number },
  point: { x: number; y: number },
): Unit[] {
  const [shape] = abilityShapes(def, rank);
  return shape ? targetsInShape(w, c, shape, ox, oy, dir, point) : [];
}

// ── Pending strikes ──────────────────────────────────────────────────────────

/** Schedule this ability's damage for `delayMs` from now — the moment its
 *  animation connects. The shape re-tests at resolve, so it's dodgeable. */
function scheduleStrike(
  w: World,
  c: Unit,
  key: AbilityKey,
  delayMs: number,
  dir: { x: number; y: number },
  point: { x: number; y: number },
  targetId?: string,
): void {
  const s: PendingStrike = {
    at: w.now + delayMs,
    casterId: c.id,
    key,
    dx: dir.x,
    dy: dir.y,
    px: point.x,
    py: point.y,
    ox: c.x,
    oy: c.y,
  };
  if (targetId !== undefined) s.targetId = targetId;
  w.strikes.push(s);
}

/** Resolve due strikes. A dead or disabled caster forfeits the strike — a
 *  stun caught mid-windup (or mid-leap) cancels the blow, like basics. */
export function resolveStrikes(w: World): void {
  if (w.strikes.length === 0) return;
  const keep: PendingStrike[] = [];
  for (const s of w.strikes) {
    if (w.now < s.at) {
      keep.push(s);
      continue;
    }
    const c = w.units.get(s.casterId);
    if (c && c.alive && c.kind === "hero" && !isDisabled(c)) applyStrike(w, c, s);
  }
  w.strikes = keep;
}

/** The impact half of a damaging ability — runs when the animation connects. */
function applyStrike(w: World, c: Unit, s: PendingStrike): void {
  const def = CHAMP_BY_ID[c.champId]?.abilities[s.key];
  if (!def) return;
  const r = c.abilities[s.key].rank;
  const v = (f: string) => valAt(def.values[f], r);
  const ap = c.abilityPower;
  const dir = { x: s.dx, y: s.dy };
  const point = { x: s.px, y: s.py };

  // JUMP impacts are data-driven, and there are two shapes of them.
  if (s.key === "JUMP") {
    const dtype =
      def.effect.startsWith("mage") || def.effect.startsWith("witch") ? "magic" : "physical";

    // AERIAL (`shots`): at the apex the champ spins and looses a full ring of
    // shots outward. The ring is anchored to the aim, so the shot you're looking
    // at always goes where you're pointing — the rest cover your back.
    if (def.values["shots"]) {
      const n = v("shots");
      const dmg = v("damage") + v("perLevel") * (c.level - 1);
      const base = angleOf(dir.x, dir.y);
      for (let i = 0; i < n; i++) {
        const a = base + (i / n) * Math.PI * 2;
        spawnProjectile(w, c, {
          dirX: Math.cos(a),
          dirY: Math.sin(a),
          damage: dmg,
          dtype,
          kind: c.attackKind,
          speed: Math.max(24, c.projectileSpeed),
          radius: def.values["splash"] ? v("splash") : 0, // casters' shots burst
          hitRadius: 1.0,
          range: 11,
          pierce: dtype === "physical", // arrows punch the line, bolts pop on contact
          launchH: HOP_HEIGHT, // they're loosed from the apex and fall to the plane
        });
      }
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: c.x,
        y: c.y,
        dx: dir.x,
        dy: dir.y,
        r: v("radius"),
      });
      return;
    }

    // GROUNDED: corridor slam along the leap path, riders from the def's values.
    const dmg = v("base") + v("perLevel") * (c.level - 1);
    for (const t of abilityTargets(w, c, def, r, s.ox, s.oy, dir, point)) {
      dealDamage(w, c, t, dmg, dtype, { ap });
      applyValueRiders(w, c, t, def, r);
    }
    w.fx.push({
      t: "strike",
      tag: def.effect,
      x: point.x,
      y: point.y,
      dx: dir.x,
      dy: dir.y,
      r: v("radius"),
    });
    return;
  }

  switch (def.effect) {
    case "knight:Q": {
      // Cleaving Blow: frontal cone from where Garran stands as the blade lands.
      for (const t of abilityTargets(w, c, def, r, c.x, c.y, dir, point)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: "knight:Q" });
      }
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: c.x,
        y: c.y,
        dx: dir.x,
        dy: dir.y,
        r: def.castRange,
      });
      break;
    }
    case "knight:W": {
      // Seismic Slam: the fissure erupts on blade contact.
      for (const t of abilityTargets(w, c, def, r, c.x, c.y, dir, point)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, {
          kind: "slow",
          until: w.now + v("slowDur") * 1000,
          pct: v("slow"),
          id: "knight:W",
        });
      }
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: c.x,
        y: c.y,
        dx: dir.x,
        dy: dir.y,
        r: def.castRange,
      });
      break;
    }
    case "blackknight:Q": {
      // Executioner's Arc: vast sweep — carve + slow on contact.
      for (const t of abilityTargets(w, c, def, r, c.x, c.y, dir, point)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, {
          kind: "slow",
          until: w.now + v("slowDur") * 1000,
          pct: v("slow"),
          id: "blackknight:Q",
        });
      }
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: c.x,
        y: c.y,
        dx: dir.x,
        dy: dir.y,
        r: def.castRange,
      });
      break;
    }
    case "blackknight:R": {
      // Oblivion Slam: the hammer comes DOWN — throw + stun everything near.
      for (const t of abilityTargets(w, c, def, r, c.x, c.y, dir, point)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        applyKnockback(t, c.x, c.y, v("knockback"), w);
        addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: "blackknight:R" });
      }
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: c.x,
        y: c.y,
        dx: dir.x,
        dy: dir.y,
        r: v("radius"),
      });
      break;
    }
    case "rogue:Q": {
      // Poison Lunge: the blade cuts along the traveled dash line.
      for (const hit of abilityTargets(w, c, def, r, s.ox, s.oy, dir, point)) {
        dealDamage(w, c, hit, v("damage"), "physical", { ap });
        addStatus(hit, {
          kind: "dot",
          until: w.now + v("dur") * 1000,
          nextTick: w.now + 500,
          dps: v("dps"),
          dtype: "magic",
          sourceId: c.id,
          id: "rogue:Q",
        });
      }
      w.fx.push({ t: "strike", tag: def.effect, x: c.x, y: c.y, dx: dir.x, dy: dir.y, r: 1.4 });
      break;
    }
    case "rogue:W": {
      // Rupture: the gash opens on blade contact.
      for (const t of abilityTargets(w, c, def, r, c.x, c.y, dir, point)) {
        dealDamage(w, c, t, v("damage"), "physical", { ap });
        addStatus(t, {
          kind: "dot",
          until: w.now + v("bleedDur") * 1000,
          nextTick: w.now + 500,
          dps: v("bleedDps"),
          dtype: "physical",
          sourceId: c.id,
          id: "rogue:W",
        });
        addStatus(t, {
          kind: "damageAmp",
          until: w.now + v("ampDur") * 1000,
          pct: v("dmgAmp"),
          id: "rogue:W",
        });
      }
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: c.x,
        y: c.y,
        dx: dir.x,
        dy: dir.y,
        r: def.castRange,
      });
      break;
    }
    case "rogue:R": {
      // Execute: the killing blow lands as the blink-dash arrives.
      const target = s.targetId ? w.units.get(s.targetId) : undefined;
      if (!target || !target.alive || isUntargetable(target)) return;
      const hpFrac = target.hp / target.maxHp;
      const bonus = v("damage") * v("execMult") * (1 - hpFrac);
      dealDamage(w, c, target, v("damage") + bonus, "physical", { ap });
      w.fx.push({
        t: "strike",
        tag: def.effect,
        x: target.x,
        y: target.y,
        dx: dir.x,
        dy: dir.y,
        r: 1.6,
      });
      break;
    }
    // delayed projectile spawns — the shot leaves on the release frame
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
      w.fx.push({ t: "strike", tag: def.effect, x: c.x, y: c.y, dx: dir.x, dy: dir.y, r: 1 });
      break;
    }
    case "mage:Q": {
      // flies TO THE AIM POINT and airbursts there (never fizzles mid-air) —
      // point-blank casts and max-range casts both explode where you aimed.
      // Re-aimed from the caster's RELEASE position so the burst stays on the
      // point even if they moved during the windup.
      const fb = aimAtPoint(c, s, def.castRange);
      spawnProjectile(w, c, {
        dirX: fb.x,
        dirY: fb.y,
        damage: v("damage"),
        dtype: "magic",
        kind: "fireball",
        speed: 18,
        radius: v("radius"),
        range: fb.range,
        burstAtEnd: true,
      });
      w.fx.push({ t: "strike", tag: def.effect, x: c.x, y: c.y, dx: fb.x, dy: fb.y, r: 1 });
      break;
    }
    case "witch:Q": {
      const hb = aimAtPoint(c, s, def.castRange);
      spawnProjectile(w, c, {
        dirX: hb.x,
        dirY: hb.y,
        damage: v("damage"),
        dtype: "magic",
        kind: "hexbolt",
        speed: v("speed"),
        radius: 1.8, // curdled burst — the slow spreads to everyone splashed
        range: hb.range,
        burstAtEnd: true,
        onHit: { tag: "slow", pct: v("slow"), duration: v("slowDur") },
      });
      w.fx.push({ t: "strike", tag: def.effect, x: c.x, y: c.y, dx: hb.x, dy: hb.y, r: 1 });
      break;
    }
    default:
      break;
  }
}

/** Direction + travel distance from the caster's CURRENT position to the
 *  strike's captured aim point — aim-point projectiles (fireball/hexbolt)
 *  detonate where the player aimed, not at a fixed max range. */
function aimAtPoint(
  c: Unit,
  s: PendingStrike,
  castRange: number,
): { x: number; y: number; range: number } {
  const dx = s.px - c.x;
  const dy = s.py - c.y;
  const d = Math.hypot(dx, dy) - (c.radius + 0.3); // spawnProjectile offsets the muzzle
  if (d < 0.5) return { x: s.dx, y: s.dy, range: 1 }; // point-blank — keep the cast aim
  const n = Math.hypot(dx, dy);
  return { x: dx / n, y: dy / n, range: Math.max(1, Math.min(castRange, d)) };
}

/** Data-driven strike riders from a def's values: stun / slow / burn. Used by
 *  the shared JUMP slam so per-champ flavor stays in champions.ts. */
function applyValueRiders(w: World, c: Unit, t: Unit, def: AbilityDef, rank: number): void {
  const v = (f: string) => valAt(def.values[f], rank);
  if (def.values["stun"]) {
    addStatus(t, { kind: "stun", until: w.now + v("stun") * 1000, id: def.effect });
  } else if (def.values["slowDur"]) {
    addStatus(t, {
      kind: "slow",
      until: w.now + v("slowDur") * 1000,
      pct: v("slow"),
      id: def.effect,
    });
  }
  if (def.values["burnDps"]) {
    addStatus(t, {
      kind: "dot",
      until: w.now + v("burnDur") * 1000,
      nextTick: w.now + 500,
      dps: v("burnDps"),
      dtype: "magic",
      sourceId: c.id,
      id: def.effect,
    });
  }
}

// ── Dispatch (cast-time half) ────────────────────────────────────────────────
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

  // Every DASH is the same move (mage's is a blink — `range` instead of
  // `speed`); every JUMP is a leap whose slam resolves on landing.
  if (key === "DASH") {
    if (def.values["speed"]) {
      startDash(c, dir, v("speed"), def.castRange, w);
    } else {
      const range = v("range");
      const dest = clampToArena(c.x + dir.x * range, c.y + dir.y * range, c.radius);
      const safe = resolveObstacles(dest.x, dest.y, c.radius);
      w.fx.push({ t: "blink", x: c.x, y: c.y, tx: safe.x, ty: safe.y });
      c.x = safe.x;
      c.y = safe.y;
    }
    addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "dash" });
    return true;
  }
  if (key === "JUMP") {
    // An AERIAL jump (`air`) doesn't travel: you spring straight up, hang, and
    // fire from the apex. You're pinned (a zero-speed dash = a hover) and
    // untargetable for the whole window — the trade is commitment for immunity.
    if (def.values["air"]) {
      const airMs = v("air") * 1000;
      startHover(c, w, airMs);
      c.jumpUntil = w.now + airMs;
      addStatus(c, { kind: "untargetable", until: w.now + v("iframe") * 1000, id: "jump" });
      scheduleStrike(w, c, key, airMs * 0.45, dir, { x: c.x, y: c.y }); // fires at the apex
      return true;
    }
    // otherwise: leap toward the aim; the slam damage is a PendingStrike at touchdown
    startDash(c, dir, JUMP_LEAP_SPEED, def.castRange, w);
    const leapMs = Math.max(JUMP_DIVE_MS, (def.castRange / JUMP_LEAP_SPEED) * 1000);
    c.jumpUntil = w.now + leapMs;
    const land = { x: c.x + dir.x * def.castRange, y: c.y + dir.y * def.castRange };
    scheduleStrike(w, c, key, leapMs, dir, land);
    return true;
  }

  switch (def.effect) {
    // ── Knight ──
    case "knight:Q":
    case "knight:W":
      scheduleStrike(w, c, key, castStrikeMs(c.champId, key), dir, point);
      return true;
    case "knight:E": {
      addStatus(c, {
        kind: "shield",
        until: w.now + v("duration") * 1000,
        amount: v("shield"),
        id: "knight:E",
      });
      addStatus(c, {
        kind: "speed",
        until: w.now + v("duration") * 1000,
        pct: v("speed"),
        id: "knight:E",
      });
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
        enemyDps: v("dps"), // AP applies once, in computeDamage (no double-dip)
        dtype: "physical",
        slowPct: v("slow"),
      });
      return true;
    }

    // ── Ranger ──
    case "ranger:Q":
      scheduleStrike(w, c, key, castStrikeMs(c.champId, key), dir, point);
      return true;
    case "ranger:W": {
      // Hunter's Focus: self buff — attack + move speed for a few seconds.
      const dur = v("duration") * 1000;
      addStatus(c, {
        kind: "attackSpeed",
        until: w.now + dur,
        amount: v("atkSpeed"),
        id: "ranger:W",
      });
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
        enemyDps: v("dps"), // AP applies once, in computeDamage (no double-dip)
        dtype: "physical",
        slowPct: v("slow"),
        telegraph: true,
      });
      return true;
    }

    // ── Mage ──
    case "mage:Q":
      scheduleStrike(w, c, key, castStrikeMs(c.champId, key), dir, point);
      return true;
    case "mage:W": {
      // Frost Nova: brief arming shimmer at the point, then the ring detonates.
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "nova",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + NOVA_ARM_MS + 200,
        nextTick: w.now + NOVA_ARM_MS,
        tickInterval: 9999,
        detonateAt: w.now + NOVA_ARM_MS,
        detonateDmg: v("damage"), // AP applies once, in computeDamage
        detonateDtype: "magic",
        slowPct: v("slow"),
        slowMs: v("slowDur") * 1000,
        telegraph: true,
      });
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
        enemyDps: v("dps"), // AP applies once, in computeDamage (no double-dip)
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
        detonateDmg: v("damage"), // AP applies once, in computeDamage
        detonateDtype: "magic",
        slowPct: v("slow"),
        telegraph: true,
      });
      return true;
    }

    // ── Rogue ──
    case "rogue:Q": {
      // lunge NOW; the poison cut lands as the dash completes
      startDash(c, dir, v("speed"), def.castRange, w);
      scheduleStrike(w, c, key, (def.castRange / v("speed")) * 1000, dir, point);
      return true;
    }
    case "rogue:W":
      scheduleStrike(w, c, key, castStrikeMs(c.champId, key), dir, point);
      return true;
    case "rogue:E": {
      addStatus(c, { kind: "stealth", until: w.now + v("duration") * 1000, id: "rogue:E" });
      addStatus(c, {
        kind: "speed",
        until: w.now + v("duration") * 1000,
        pct: v("speed"),
        id: "rogue:E",
      });
      return true;
    }
    case "rogue:R": {
      // dash to nearest enemy in the front arc (abilityShapes cone); the
      // execute lands on arrival, scaled by their hp THEN — not at cast
      let target: Unit | null = null;
      let bestD = Infinity;
      for (const t of abilityTargets(w, c, def, r, c.x, c.y, dir, point)) {
        if (isUntargetable(t) || t.kind === "prop") continue; // never ult a barrel
        const d = dist(c, t);
        if (d < bestD) {
          bestD = d;
          target = t;
        }
      }
      if (!target) return false;
      const d = norm(target.x - c.x, target.y - c.y);
      const stop = Math.max(0.5, dist(c, target) - (c.radius + target.radius));
      startDash(c, d, v("speed"), stop, w);
      scheduleStrike(w, c, key, (stop / v("speed")) * 1000, d, point, target.id);
      return true;
    }

    // ── Black Knight ──
    case "blackknight:Q":
    case "blackknight:R":
      scheduleStrike(w, c, key, castStrikeMs(c.champId, key), dir, point);
      return true;
    case "blackknight:W": {
      // Consecrating Smite: the pillar falls after a short arming telegraph.
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "smite",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + SMITE_ARM_MS + 200,
        nextTick: w.now + SMITE_ARM_MS,
        tickInterval: 9999,
        detonateAt: w.now + SMITE_ARM_MS,
        detonateDmg: v("damage"),
        detonateDtype: "physical",
        stunMs: v("stun") * 1000,
        telegraph: true,
      });
      return true;
    }
    case "blackknight:E": {
      const dur = v("duration") * 1000;
      addStatus(c, { kind: "armor", until: w.now + dur, amount: v("armor"), id: "blackknight:E" });
      addStatus(c, {
        kind: "heal",
        until: w.now + dur,
        nextTick: w.now + 500,
        hps: v("hps"),
        id: "blackknight:E",
      });
      w.fx.push({ t: "heal", x: c.x, y: c.y, amount: v("hps") });
      return true;
    }

    // ── Witch ──
    case "witch:Q":
      scheduleStrike(w, c, key, castStrikeMs(c.champId, key), dir, point);
      return true;
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
        enemyDps: v("dps"), // AP applies once, in computeDamage (no double-dip)
        dtype: "magic",
        slowPct: v("slow"), // refreshed per tick with id "brew" (= effect tag)
        telegraph: true,
      });
      return true;
    }
    case "witch:E": {
      // Bog Grasp: vines gather, then erupt — damage + root.
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "vines",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + VINES_ARM_MS + 200,
        nextTick: w.now + VINES_ARM_MS,
        tickInterval: 9999,
        detonateAt: w.now + VINES_ARM_MS,
        detonateDmg: v("damage"),
        detonateDtype: "magic",
        rootMs: v("root") * 1000,
        telegraph: true,
      });
      return true;
    }
    case "witch:R": {
      // Grand Hex: the ring seals after a beat — everyone caught mushrooms.
      pushGround(w, {
        ownerId: c.id,
        team: c.team,
        effect: "hexring",
        x: point.x,
        y: point.y,
        radius: v("radius"),
        until: w.now + HEXRING_ARM_MS + 200,
        nextTick: w.now + HEXRING_ARM_MS,
        tickInterval: 9999,
        detonateAt: w.now + HEXRING_ARM_MS,
        detonateDmg: 0,
        hexMs: v("duration") * 1000,
        slowPct: v("slow"), // hex status carries the move-slow while shroomed
        telegraph: true,
      });
      return true;
    }
  }
  return false;
}

// ── Per-tick ability processing ──────────────────────────────────────────────
export function tickAbilities(w: World, _dt: number): void {
  resolveStrikes(w);
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

    // armed detonation (meteor/smite/nova/vines/hexring): one blast + riders
    if (g.detonateAt !== undefined && w.now >= g.detonateAt) {
      for (const t of aoeEnemies(w, g.team, g.x, g.y, g.radius)) {
        if (g.detonateDmg)
          dealDamage(
            w,
            w.units.get(g.ownerId) ?? null,
            t,
            g.detonateDmg,
            g.detonateDtype ?? "magic",
            {},
          );
        if (!t.alive) continue;
        if (g.stunMs) addStatus(t, { kind: "stun", until: w.now + g.stunMs, id: g.effect });
        if (g.rootMs) addStatus(t, { kind: "root", until: w.now + g.rootMs, id: g.effect });
        if (g.hexMs)
          addStatus(t, { kind: "hex", until: w.now + g.hexMs, pct: g.slowPct ?? 0, id: g.effect });
        else if (g.slowPct)
          addStatus(t, {
            kind: "slow",
            until: w.now + (g.slowMs ?? 1500),
            pct: g.slowPct,
            id: g.effect,
          });
      }
      w.fx.push({ t: "explosion", x: g.x, y: g.y, radius: g.radius, kind: g.effect });
      continue; // detonated → drop
    }

    // trap: trigger on first enemy inside (props can't spring it — a trap
    // armed beside a barrel must wait for something that walks)
    if (g.effect === "trap") {
      const inside = aoeEnemies(w, g.team, g.x, g.y, g.radius).filter((t) => t.kind !== "prop");
      if (inside.length > 0) {
        for (const t of inside) {
          dealDamage(
            w,
            w.units.get(g.ownerId) ?? null,
            t,
            g.enemyDps ?? 0,
            g.dtype ?? "physical",
            {},
          );
          if (g.rootMs && t.alive)
            addStatus(t, { kind: "root", until: w.now + g.rootMs, id: "trap" });
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
          dealDamage(w, owner, t, g.enemyDps * (g.tickInterval / 1000), g.dtype ?? "physical", {
            silentFx: true,
          });
          if (g.slowPct && t.alive)
            addStatus(t, { kind: "slow", until: w.now + 600, pct: g.slowPct, id: g.effect });
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
export function useItemActive(
  w: World,
  u: Unit,
  slot: number,
  point?: { x: number; y: number },
): boolean {
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
      addStatus(u, {
        kind: "shield",
        until: w.now + 4000,
        amount: a.amount ?? 0,
        id: `item:${id}`,
      });
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
