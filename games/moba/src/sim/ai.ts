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
import { buyItem, issueOrder } from "./orders";
import type { Unit, World } from "./types";

const DECISION_MS = 350;
const CAST_ORDER: readonly AbilityKey[] = ["R", "Q", "W", "E"];
const RETREAT_HP = 0.32;
const SAFE_HP = 0.65;
const ENGAGE_RANGE = 760;
const PUSH_LOOK = 560;

const BUY_PRIORITY = new Map<string, string[]>([
  ["ironvow", ["ringmail", "bulwark", "aegis", "sash", "boots", "whetstone"]],
  ["duskblade", ["whetstone", "boots", "fang", "quiver", "scepter", "sash"]],
  ["stormcaller", ["whetstone", "quiver", "boots", "fang", "scepter", "sash"]],
  ["emberhex", ["tome", "boots", "scepter", "aegis", "bulwark"]],
  ["boomtinker", ["whetstone", "boots", "quiver", "scepter", "bulwark"]],
  ["brewkeeper", ["boots", "ringmail", "tome", "aegis", "bulwark"]],
]);

const leadTarget = (u: Unit, t: Unit) => {
  const lead = 0.18;

  return { x: t.x + t.vx * lead, y: t.y + t.vy * lead };
};

const lowestAlly = (w: World, u: Unit, range: number) => {
  let best: Unit | null = null;
  let bestPct = 1.1;

  for (const e of w.units.values()) {
    if (e.kind !== "hero" || e.team !== u.team || !e.alive) {
      continue;
    }

    if (dist(u, e) > range) {
      continue;
    }

    const pct = e.hp / e.maxHp;

    if (pct < bestPct) {
      bestPct = pct;
      best = e;
    }
  }

  return best;
};

const castKit = (w: World, u: Unit, target: Unit | null) => {
  const h = u.hero;

  if (!h) {
    return;
  }

  const def = HERO_BY_ID[h.defId];

  if (!def) {
    return;
  }

  const inFight = target !== null && dist(u, target) < 600;

  for (const key of CAST_ORDER) {
    const slot = h.abilities[key];

    if (slot.rank <= 0 || w.now < slot.readyAt) {
      continue;
    }

    const ad = def.abilities[key];

    if (ad.targeting === "passive") {
      continue;
    }

    if (ad.targeting === "unit") {
      const isHeal = ad.effect === "brewkeeper:Q";

      if (isHeal) {
        const ally = lowestAlly(w, u, ad.castRange);

        if (ally && ally.hp / ally.maxHp < 0.7) {
          castAbility(w, u, { key, targetId: ally.id });
        }
      } else if (target && target.team !== u.team && dist(u, target) <= ad.castRange + 40) {
        castAbility(w, u, { key, targetId: target.id });
      }
    } else if (ad.targeting === "point") {
      if (target) {
        const p = leadTarget(u, target);

        if (dist(u, p) <= ad.castRange + 80) {
          castAbility(w, u, { key, point: p });
        }
      }
    } else if (ad.targeting === "none" && inFight) {
      castAbility(w, u, { key });
    }
  }
};

const nearestEnemyHero = (w: World, u: Unit, range: number) => {
  let best: Unit | null = null;
  let bd = range * range;

  for (const e of w.units.values()) {
    if (e.kind !== "hero" || e.team === u.team || !e.alive) {
      continue;
    }

    if (e.statuses.some((s) => s.kind === "untargetable")) {
      continue;
    }

    const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;

    if (d < bd) {
      bd = d;
      best = e;
    }
  }

  return best;
};

const nearestEnemyCreep = (w: World, u: Unit, near: Vec2, range: number) => {
  let best: Unit | null = null;
  let bestScore = Infinity;

  for (const e of w.units.values()) {
    if (e.kind !== "creep" || e.neutral || e.team === u.team || !e.alive) {
      continue;
    }

    if (e.statuses.some((s) => s.kind === "untargetable")) {
      continue;
    }

    const dToMe = dist(u, e);

    if (dToMe > range && dist(near, e) > range) {
      continue;
    }

    const score = dToMe - (1 - e.hp / e.maxHp) * 220;

    if (score < bestScore) {
      bestScore = score;
      best = e;
    }
  }

  return best;
};

const nearestEnemyStructure = (w: World, u: Unit, lane: LaneId, near: Vec2, range: number) => {
  const enemy = enemyOf(u.team);
  let best: Unit | null = null;
  let bestD = range * range;

  for (const t of TOWERS) {
    if (t.team !== enemy || (t.lane !== lane && t.lane !== "base")) {
      continue;
    }

    const su = w.units.get(t.id);

    if (!su || !su.alive || !su.structure?.attackable) {
      continue;
    }

    const d = Math.min(
      (su.x - u.x) ** 2 + (su.y - u.y) ** 2,
      (su.x - near.x) ** 2 + (su.y - near.y) ** 2,
    );

    if (d < bestD) {
      bestD = d;
      best = su;
    }
  }

  const anc = w.units.get(enemy === "radiant" ? "r-ancient" : "d-ancient");

  if (anc && anc.alive && anc.structure?.attackable && dist(u, anc) < range + 200) {
    best = anc;
  }

  return best;
};

const countAlliedCreepsNear = (w: World, struct: Unit, r: number) => {
  let n = 0;
  const r2 = r * r;
  const allyTeam = enemyOf(struct.team);

  for (const c of w.units.values()) {
    if (c.kind !== "creep" || c.neutral || c.team !== allyTeam || !c.alive) {
      continue;
    }

    if ((c.x - struct.x) ** 2 + (c.y - struct.y) ** 2 <= r2) {
      n += 1;
    }
  }

  return n;
};

const focusLane = (w: World, team: Team) => {
  const enemy = enemyOf(team);
  const lanes: LaneId[] = ["top", "bottom"];
  let bestLane: LaneId | null = null;
  let bestScore = Infinity;

  for (const lane of lanes) {
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

    if (!anyAlive) {
      return lane;
    }

    if (frontHp < bestScore) {
      bestScore = frontHp;
      bestLane = lane;
    }
  }

  return bestLane;
};

const countTeamHeroesNear = (w: World, team: string, near: Unit, r: number) => {
  let n = 0;
  const r2 = r * r;

  for (const e of w.units.values()) {
    if (e.kind !== "hero" || e.team !== team || !e.alive) {
      continue;
    }

    if ((e.x - near.x) ** 2 + (e.y - near.y) ** 2 <= r2) {
      n += 1;
    }
  }

  return n;
};

/** The point a bot should fight toward: the frontmost allied creep in its lane,
 * else the nearest standing enemy structure in that lane, else enemy ancient. */
export const laneObjective = (w: World, u: Unit, lane: LaneId) => {
  const path = lanePath(lane, u.team);
  let front: Unit | null = null;
  let frontProg = -1;

  for (const c of w.units.values()) {
    const cs = c.creep;

    if (
      c.kind !== "creep" ||
      c.neutral ||
      c.team !== u.team ||
      !c.alive ||
      !cs ||
      cs.lane !== lane
    ) {
      continue;
    }

    const prog = cs.wpIdx;

    if (prog > frontProg) {
      frontProg = prog;
      front = c;
    }
  }

  if (front) {
    return { x: front.x, y: front.y };
  }

  const enemy = enemyOf(u.team);
  let bestStruct: Vec2 | null = null;
  let bestD = Infinity;

  for (const t of TOWERS) {
    if (t.team !== enemy || t.lane !== lane) {
      continue;
    }

    const su = w.units.get(t.id);

    if (!su || !su.alive) {
      continue;
    }

    const d = (t.x - u.x) ** 2 + (t.y - u.y) ** 2;

    if (d < bestD) {
      bestD = d;
      bestStruct = { x: t.x, y: t.y };
    }
  }

  if (bestStruct) {
    return bestStruct;
  }

  const a = path.at(-1);

  return a ? { x: a.x, y: a.y } : BASES[enemy].ancient;
};

const countAllies = (w: World, u: Unit, r: number) => {
  let n = 0;

  for (const e of w.units.values()) {
    if (e.kind === "hero" && e.team === u.team && e.alive && e !== u && dist(u, e) < r) {
      n += 1;
    }
  }

  return n;
};

const countEnemies = (w: World, u: Unit, r: number) => {
  let n = 0;

  for (const e of w.units.values()) {
    if (e.kind === "hero" && e.team !== u.team && e.alive && dist(u, e) < r) {
      n += 1;
    }
  }

  return n;
};

const tryShop = (w: World, u: Unit) => {
  if (!u.hero) {
    return;
  }

  const prio = BUY_PRIORITY.get(u.hero.defId) ?? ITEMS.map((i) => i.id);

  for (const id of prio) {
    if (buyItem(w, u, id)) {
      return;
    }
  }
};

const decide = (w: World, u: Unit) => {
  const h = u.hero;

  if (!h) {
    return;
  }

  const hpPct = u.hp / u.maxHp;

  const home = BASES[u.team];

  if (dist(u, home.fountain) < home.shopRadius) {
    tryShop(w, u);
  }

  if (w.gameTime > 360 || h.level >= 6) {
    const focus = focusLane(w, u.team);

    if (focus) {
      h.botLane = focus;
    }
  }

  if (hpPct <= RETREAT_HP) {
    h.botRetreating = true;
  } else if (hpPct >= SAFE_HP) {
    h.botRetreating = false;
  }

  if (h.botRetreating) {
    castKit(w, u, null);

    if (dist(u, home.fountain) > home.fountainRadius * 0.6) {
      issueOrder(w, u, { type: "fountain" });
    } else {
      issueOrder(w, u, { type: "hold" });
    }

    return;
  }

  const enemyHero = nearestEnemyHero(w, u, ENGAGE_RANGE);
  const allyCount = countAllies(w, u, 600);
  const enemyCount = countEnemies(w, u, 600);

  if (enemyHero) {
    const myAdv =
      u.hp / u.maxHp + allyCount * 0.25 >= enemyHero.hp / enemyHero.maxHp + enemyCount * 0.25;

    const closeEnough = dist(u, enemyHero) < 520;

    if (myAdv || closeEnough) {
      issueOrder(w, u, { targetId: enemyHero.id, type: "attackUnit" });
      castKit(w, u, enemyHero);

      return;
    }
  }

  const obj = laneObjective(w, u, h.botLane);

  const creep = nearestEnemyCreep(w, u, obj, PUSH_LOOK);

  if (creep) {
    issueOrder(w, u, { targetId: creep.id, type: "attackUnit" });
    castKit(w, u, creep);

    return;
  }

  const struct = nearestEnemyStructure(w, u, h.botLane, obj, PUSH_LOOK + 160);

  if (struct) {
    const alliedCreeps = countAlliedCreepsNear(w, struct, 520);
    const defenders = countTeamHeroesNear(w, enemyOf(u.team), struct, 560);
    const low = struct.hp / struct.maxHp < 0.35;

    if ((alliedCreeps >= 1 && defenders === 0) || (low && defenders <= 1)) {
      issueOrder(w, u, { targetId: struct.id, type: "attackUnit" });
      castKit(w, u, struct);

      return;
    }
  }

  issueOrder(w, u, { to: obj, type: "attackMove" });
};

export const tickBots = (w: World, _dt: number) => {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.hero?.isBot) {
      continue;
    }

    if (!u.alive) {
      continue;
    }

    if (u.hero.abilityPoints > 0) {
      autoLevel(w, u);
    }

    if (w.now < u.hero.botNextDecisionAt) {
      continue;
    }

    u.hero.botNextDecisionAt = w.now + DECISION_MS;
    decide(w, u);
  }
};
