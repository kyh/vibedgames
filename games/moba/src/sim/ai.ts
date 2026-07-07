// Host-driven bot hero AI. Each bot, on a ~0.35s decision cadence: retreats when
// low, shops at the fountain, pushes its lane, last-hits, and engages enemy
// heroes when it has an edge — using its full ability kit generically.

import { enemyOf } from "../data/config";
import type { Team } from "../data/config";
import { HERO_BY_ID } from "../data/heroes";
import type { AbilityKey } from "../data/heroes";
import { ITEMS } from "../data/items";
import { BASES, TOWERS, lanePath } from "../data/map";
import type { LaneId } from "../data/map";
import { autoLevel, castAbility } from "./abilities";
import { dist } from "./math";
import type { Vec2 } from "./math";
import { buyItem, issueOrder } from "./world";
import type { Unit, World } from "./types";

const DECISION_MS = 350;
// ability cast priority: ult first, then Q > W > E
const CAST_ORDER: readonly AbilityKey[] = ["R", "Q", "W", "E"];
const RETREAT_HP = 0.32;
const SAFE_HP = 0.65;
const ENGAGE_RANGE = 760; // notice enemy heroes within this
const PUSH_LOOK = 560; // attack creeps/towers within this of the objective

// item buy priority per hero role
const BUY_PRIORITY: Record<string, string[]> = {
  ironvow: ["ringmail", "bulwark", "aegis", "sash", "boots", "whetstone"],
  duskblade: ["whetstone", "boots", "fang", "quiver", "scepter", "sash"],
  stormcaller: ["whetstone", "quiver", "boots", "fang", "scepter", "sash"],
  emberhex: ["tome", "boots", "scepter", "aegis", "bulwark"],
  boomtinker: ["whetstone", "boots", "quiver", "scepter", "bulwark"],
  brewkeeper: ["boots", "ringmail", "tome", "aegis", "bulwark"],
};

export function tickBots(w: World, _dt: number): void {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.hero?.isBot) continue;
    if (!u.alive) continue;
    if (u.hero.abilityPoints > 0) autoLevel(w, u);
    if (w.now < u.hero.botNextDecisionAt) {
      // between decisions, keep casting opportunistically on the current target
      continue;
    }
    u.hero.botNextDecisionAt = w.now + DECISION_MS;
    decide(w, u);
  }
}

function decide(w: World, u: Unit): void {
  const h = u.hero;
  if (!h) return;
  const hpPct = u.hp / u.maxHp;

  // shop when near home fountain
  const home = BASES[u.team];
  if (dist(u, home.fountain) < home.shopRadius) tryShop(w, u);

  // mid/late game: converge on one lane to actually close out. Bots group on the
  // enemy lane whose frontmost tower is weakest once they have an ult or it's late.
  if (w.gameTime > 360 || h.level >= 6) {
    const focus = focusLane(w, u.team);
    if (focus) h.botLane = focus;
  }

  // retreat hysteresis
  if (hpPct <= RETREAT_HP) h.botRetreating = true;
  else if (hpPct >= SAFE_HP) h.botRetreating = false;

  if (h.botRetreating) {
    // heal at fountain; cast escape/heal if available
    castKit(w, u, null);
    if (dist(u, home.fountain) > home.fountainRadius * 0.6) issueOrder(w, u, { type: "fountain" });
    else issueOrder(w, u, { type: "hold" });
    return;
  }

  // assess threats/targets
  const enemyHero = nearestEnemyHero(w, u, ENGAGE_RANGE);
  const allyCount = countAllies(w, u, 600);
  const enemyCount = countEnemies(w, u, 600);

  if (enemyHero) {
    const myAdv =
      u.hp / u.maxHp + allyCount * 0.25 >= enemyHero.hp / enemyHero.maxHp + enemyCount * 0.25;
    const closeEnough = dist(u, enemyHero) < 520;
    if (myAdv || closeEnough) {
      issueOrder(w, u, { type: "attackUnit", targetId: enemyHero.id });
      castKit(w, u, enemyHero);
      return;
    }
  }

  // push lane: aim at the lane objective, fight whatever is there
  const obj = laneObjective(w, u, h.botLane);

  // 1) farm/clear: hit the best enemy creep near me or the objective
  const creep = nearestEnemyCreep(w, u, obj, PUSH_LOOK);
  if (creep) {
    issueOrder(w, u, { type: "attackUnit", targetId: creep.id });
    castKit(w, u, creep);
    return;
  }
  // 2) siege: if a contestable enemy structure is here and allied creeps are
  // around to tank it, attack it; otherwise march up to bring the wave.
  const struct = nearestEnemyStructure(w, u, h.botLane, obj, PUSH_LOOK + 160);
  if (struct) {
    const alliedCreeps = countAlliedCreepsNear(w, struct, 520);
    const defenders = countTeamHeroesNear(w, enemyOf(u.team), struct, 560);
    // dive when creeps are pressuring and the lane isn't defended (or the
    // structure is already low enough to just finish)
    const low = struct.hp / struct.maxHp < 0.35;
    if ((alliedCreeps >= 1 && defenders === 0) || (low && defenders <= 1)) {
      issueOrder(w, u, { type: "attackUnit", targetId: struct.id });
      castKit(w, u, struct);
      return;
    }
  }
  issueOrder(w, u, { type: "attackMove", to: obj });
}

/** Use the bot's abilities sensibly given an optional primary enemy target. */
function castKit(w: World, u: Unit, target: Unit | null): void {
  const h = u.hero;
  if (!h) return;
  const def = HERO_BY_ID[h.defId];
  if (!def) return;
  const inFight = target != null && dist(u, target) < 600;
  for (const key of CAST_ORDER) {
    const slot = h.abilities[key];
    if (slot.rank <= 0 || w.now < slot.readyAt) continue;
    const ad = def.abilities[key];
    if (ad.targeting === "passive") continue;
    if (ad.targeting === "unit") {
      const isHeal = ad.effect === "brewkeeper:Q";
      if (isHeal) {
        const ally = lowestAlly(w, u, ad.castRange);
        if (ally && ally.hp / ally.maxHp < 0.7) castAbility(w, u, { key, targetId: ally.id });
      } else if (target && target.team !== u.team && dist(u, target) <= ad.castRange + 40) {
        castAbility(w, u, { key, targetId: target.id });
      }
    } else if (ad.targeting === "point") {
      if (target) {
        const p = leadTarget(u, target);
        if (dist(u, p) <= ad.castRange + 80) castAbility(w, u, { key, point: p });
      }
    } else if (ad.targeting === "none") {
      // self-buff / teamfight ult — fire when actually fighting
      if (inFight) castAbility(w, u, { key });
    }
  }
}

function leadTarget(u: Unit, t: Unit): Vec2 {
  // simple lead based on target velocity + projectile-ish travel
  const lead = 0.18;
  return { x: t.x + t.vx * lead, y: t.y + t.vy * lead };
}

function nearestEnemyHero(w: World, u: Unit, range: number): Unit | null {
  let best: Unit | null = null;
  let bd = range * range;
  for (const e of w.units.values()) {
    if (e.kind !== "hero" || e.team === u.team || !e.alive) continue;
    if (e.statuses.some((s) => s.kind === "untargetable")) continue;
    const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
    if (d < bd) {
      bd = d;
      best = e;
    }
  }
  return best;
}

function nearestEnemyCreep(w: World, u: Unit, near: Vec2, range: number): Unit | null {
  let best: Unit | null = null;
  let bestScore = Infinity;
  for (const e of w.units.values()) {
    // bots farm lane creeps only — never wander into jungle camps / Roshan
    if (e.kind !== "creep" || e.neutral || e.team === u.team || !e.alive) continue;
    if (e.statuses.some((s) => s.kind === "untargetable")) continue;
    const dToMe = dist(u, e);
    if (dToMe > range && dist(near, e) > range) continue;
    // prefer low-hp creeps (last hits) and closeness
    const score = dToMe - (1 - e.hp / e.maxHp) * 220;
    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }
  return best;
}

function nearestEnemyStructure(
  w: World,
  u: Unit,
  lane: LaneId,
  near: Vec2,
  range: number,
): Unit | null {
  const enemy = enemyOf(u.team);
  let best: Unit | null = null;
  let bestD = range * range;
  for (const t of TOWERS) {
    if (t.team !== enemy || (t.lane !== lane && t.lane !== "base")) continue;
    const su = w.units.get(t.id);
    if (!su || !su.alive || !su.structure?.attackable) continue;
    const d = Math.min(
      (su.x - u.x) ** 2 + (su.y - u.y) ** 2,
      (su.x - near.x) ** 2 + (su.y - near.y) ** 2,
    );
    if (d < bestD) {
      bestD = d;
      best = su;
    }
  }
  // also the ancient if attackable
  const anc = w.units.get(enemy === "radiant" ? "r-ancient" : "d-ancient");
  if (anc && anc.alive && anc.structure?.attackable && dist(u, anc) < range + 200) best = anc;
  return best;
}

/** Count creeps attacking `struct` — i.e. creeps NOT on the structure's team. */
function countAlliedCreepsNear(w: World, struct: Unit, r: number): number {
  let n = 0;
  const r2 = r * r;
  const allyTeam = enemyOf(struct.team);
  for (const c of w.units.values()) {
    if (c.kind !== "creep" || c.neutral || c.team !== allyTeam || !c.alive) continue;
    if ((c.x - struct.x) ** 2 + (c.y - struct.y) ** 2 <= r2) n++;
  }
  return n;
}

/** The enemy lane whose frontmost standing tower is weakest — where the team
 * should converge to actually break a lane and reach the ancient. */
function focusLane(w: World, team: Team): LaneId | null {
  const enemy = enemyOf(team);
  const lanes: LaneId[] = ["top", "bottom"];
  let bestLane: LaneId | null = null;
  let bestScore = Infinity;
  for (const lane of lanes) {
    // frontmost = lowest tier still standing (t1 < t2)
    let frontHp = Infinity;
    let anyAlive = false;
    for (const tier of ["t1", "t2"] as const) {
      const id = `${enemy === "radiant" ? "r" : "d"}-${lane === "bottom" ? "bot" : lane}-${tier}`;
      const su = w.units.get(id);
      if (su && su.alive) {
        frontHp = su.hp;
        anyAlive = true;
        break;
      }
    }
    if (!anyAlive) return lane; // an open lane — push it straight to the ancient
    if (frontHp < bestScore) {
      bestScore = frontHp;
      bestLane = lane;
    }
  }
  return bestLane;
}

function countTeamHeroesNear(w: World, team: string, near: Unit, r: number): number {
  let n = 0;
  const r2 = r * r;
  for (const e of w.units.values()) {
    if (e.kind !== "hero" || e.team !== team || !e.alive) continue;
    if ((e.x - near.x) ** 2 + (e.y - near.y) ** 2 <= r2) n++;
  }
  return n;
}

/** The point a bot should fight toward: the frontmost allied creep in its lane,
 * else the nearest standing enemy structure in that lane, else enemy ancient. */
function laneObjective(w: World, u: Unit, lane: LaneId): Vec2 {
  const path = lanePath(lane, u.team);
  // frontmost allied creep on this lane
  let front: Unit | null = null;
  let frontProg = -1;
  for (const c of w.units.values()) {
    const cs = c.creep;
    if (c.kind !== "creep" || c.neutral || c.team !== u.team || !c.alive || !cs || cs.lane !== lane)
      continue;
    const prog = cs.wpIdx;
    if (prog > frontProg) {
      frontProg = prog;
      front = c;
    }
  }
  if (front) return { x: front.x, y: front.y };
  // nearest standing enemy structure in this lane
  const enemy = enemyOf(u.team);
  let bestStruct: Vec2 | null = null;
  let bestD = Infinity;
  for (const t of TOWERS) {
    if (t.team !== enemy || t.lane !== lane) continue;
    const su = w.units.get(t.id);
    if (!su || !su.alive) continue;
    const d = (t.x - u.x) ** 2 + (t.y - u.y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestStruct = { x: t.x, y: t.y };
    }
  }
  if (bestStruct) return bestStruct;
  const a = path[path.length - 1];
  return a ? { x: a.x, y: a.y } : BASES[enemy].ancient;
}

function countAllies(w: World, u: Unit, r: number): number {
  let n = 0;
  for (const e of w.units.values())
    if (e.kind === "hero" && e.team === u.team && e.alive && e !== u && dist(u, e) < r) n++;
  return n;
}
function countEnemies(w: World, u: Unit, r: number): number {
  let n = 0;
  for (const e of w.units.values())
    if (e.kind === "hero" && e.team !== u.team && e.alive && dist(u, e) < r) n++;
  return n;
}
function lowestAlly(w: World, u: Unit, range: number): Unit | null {
  let best: Unit | null = null;
  let bestPct = 1.1;
  for (const e of w.units.values()) {
    if (e.kind !== "hero" || e.team !== u.team || !e.alive) continue;
    if (dist(u, e) > range) continue;
    const pct = e.hp / e.maxHp;
    if (pct < bestPct) {
      bestPct = pct;
      best = e;
    }
  }
  return best;
}

function tryShop(w: World, u: Unit): void {
  if (!u.hero) return;
  const prio = BUY_PRIORITY[u.hero.defId] ?? ITEMS.map((i) => i.id);
  // buyItem is the single source of the purchase rules (gold, dup, max-items, shop
  // radius) — call it instead of re-implementing the economy here.
  for (const id of prio) {
    if (buyItem(w, u, id)) return; // one buy per visit
  }
}
