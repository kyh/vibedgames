// Bot AI — runs inside the host sim so guests see identical behavior. Bots seek
// the throne brawl, hunt the leader, grab coins/deliveries (so the catch-up
// economy actually reaches trailing players), shop, use item actives, retreat
// to heal when low, and cast abilities by real range. Deterministic (rand(w)).
import { CHAMP_BY_ID } from "../data/champions";
import type { ChampDef } from "../data/champions";
import { ITEM_BY_ID } from "../data/items";
import type { ActiveKind } from "../data/items";
import { dist, norm, rand } from "./math";
import type { Vec2 } from "./math";
import { nearestStair, onPlateau } from "./elevation";
import { isInThrone } from "../data/map";
import { castAbility, activateItem } from "./abilities";
import { isEnemy } from "./combat";
import { buyItem, homeSpawn, inOwnBase } from "./home-base";
import { isDisabled, isUntargetable } from "./stats";
import { ALL_ABILITY_KEYS } from "./types";
import type { Unit, World } from "./types";

const BUY_LISTS = new Map<string, string[]>([
  ["int", ["tome", "arcaneorb", "vitality", "wardstone", "phaseband", "elixir"]],
  ["str", ["vitality", "ringmail", "bulwark", "whetstone", "swiftboots"]],
  ["agi", ["whetstone", "quiver", "reaver", "vampiric", "boots", "swiftboots"]],
]);

/** Steering direction from u toward a goal, routed via the nearest stair when
 *  the goal is on the other side of the throne-plateau edge (so bots take the
 *  stairs instead of shoving the wall). */
const routeTo = (u: Unit, gx: number, gy: number): Vec2 => {
  if (onPlateau(u.x, u.y) === onPlateau(gx, gy)) {
    return norm(gx - u.x, gy - u.y);
  }
  const wp = nearestStair(u.x, u.y);
  if (Math.hypot(u.x - wp.x, u.y - wp.y) < 1.8) {
    return norm(gx - u.x, gy - u.y);
    // at the gap — push through
  }
  return norm(wp.x - u.x, wp.y - u.y);
};

const nearestEnemy = (w: World, u: Unit): Unit | null => {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const t of w.units.values()) {
    if (t === u || !t.alive || t.kind !== "hero" || !isEnemy(u, t) || isUntargetable(t)) {
      continue;
    }
    const d = (t.x - u.x) ** 2 + (t.y - u.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
};

/** Use a held active item of the given kind, if owned and off cooldown. */
const tryActive = (
  w: World,
  u: Unit,
  kind: ActiveKind,
  point?: { x: number; y: number },
): boolean => {
  for (const [i, id] of u.items.entries()) {
    const def = ITEM_BY_ID[id];
    if (def?.active?.kind === kind && w.now >= (u.itemReadyAt[id] ?? 0)) {
      return activateItem(w, u, i, point);
    }
  }
  return false;
};

const medianKills = (w: World): number => {
  const ks = [...w.units.values()]
    .filter((x) => x.kind === "hero")
    .map((x) => x.kills)
    .toSorted((a, b) => a - b);
  return ks[Math.floor(ks.length / 2)] ?? 0;
};

/** Skeleton AI: guard the camp — aggro nearby heroes, leash home. */
const tickSkeleton = (w: World, u: Unit): void => {
  const hx = u.homeX ?? u.x;
  const hy = u.homeY ?? u.y;
  const distHome = Math.hypot(u.x - hx, u.y - hy);
  if (isDisabled(u)) {
    u.attackHeld = false;
    return;
  }
  // nearest hero
  let target = nearestEnemy(w, u);
  if (target) {
    const dTarget = dist(u, target);
    const targetFromHome = Math.hypot(target.x - hx, target.y - hy);
    if (dTarget > 11 || targetFromHome > 14 || distHome > 15) {
      target = null;
      // out of aggro/leash
    }
  }
  if (!target) {
    // stand guard at camp; only walk back if dragged well away (no wall-grinding)
    if (distHome > 5) {
      const to = norm(hx - u.x, hy - u.y);
      u.moveX = to.x;
      u.moveY = to.y;
      u.aimX = to.x || u.aimX;
      u.aimY = to.y || u.aimY;
    } else {
      u.moveX = 0;
      u.moveY = 0;
    }
    u.attackHeld = false;
    return;
  }
  const aim = norm(target.x - u.x, target.y - u.y);
  const d = dist(u, target);
  if (d > u.attackRange * 0.8) {
    u.moveX = aim.x;
    u.moveY = aim.y;
  } else {
    u.moveX = 0;
    u.moveY = 0;
  }
  u.aimX = aim.x;
  u.aimY = aim.y;
  u.attackHeld = d <= u.attackRange + target.radius + 0.5;
};

/** Pick the bot's combat target: the leader if trailing & close, else nearest. */
const pickTarget = (w: World, u: Unit): Unit | null => {
  let target = nearestEnemy(w, u);
  if (w.leaderId && w.leaderId !== u.team) {
    const leader = [...w.units.values()].find(
      (x) => x.kind === "hero" && x.team === w.leaderId && x.alive,
    );
    if (leader && leader !== u && u.kills < leader.kills && dist(u, leader) < 24) {
      target = leader;
    }
  }
  return target;
};

/** Nearest claimable coin or delivery within range. */
const nearestPickup = (w: World, u: Unit, maxR: number): { x: number; y: number } | null => {
  let best: { x: number; y: number } | null = null;
  let bestD = maxR * maxR;
  for (const c of w.coins) {
    if (w.now < c.landAt) {
      continue;
    }
    const d = (c.x - u.x) ** 2 + (c.y - u.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x: c.x, y: c.y };
    }
  }
  for (const dlv of w.deliveries) {
    const d = (dlv.x - u.x) ** 2 + (dlv.y - u.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = { x: dlv.x, y: dlv.y };
    }
  }
  return best;
};

/** Walk straight at a point, facing it, weapon down. */
const walkTo = (u: Unit, x: number, y: number): void => {
  const to = norm(x - u.x, y - u.y);
  u.moveX = to.x;
  u.moveY = to.y;
  u.aimX = to.x || u.aimX;
  u.aimY = to.y || u.aimY;
  u.attackHeld = false;
};

/** Shop while home: the first affordable item on the champ's list not yet held. */
const shop = (w: World, u: Unit, def: ChampDef): void => {
  const list = BUY_LISTS.get(def.primary) ?? [];
  for (const id of list) {
    const it = ITEM_BY_ID[id];
    if (it && u.gold >= it.cost && !u.items.includes(id)) {
      buyItem(w, u, id);
      break;
    }
  }
};

/** Retreat to heal when low (disengage→heal→re-engage). */
const retreat = (w: World, u: Unit): void => {
  tryActive(w, u, "heal");
  tryActive(w, u, "shield");
  const sp = homeSpawn(u.slot);
  walkTo(u, sp.x, sp.y);
  const en = nearestEnemy(w, u);
  if (en && dist(u, en) < 6) {
    tryActive(w, u, "blink");
    // peel off
  }
};

/** No close fight: drift to the throne magnet (via the stairs). A wider
 *  threshold so bots more actively climb to contest the high ground. */
const driftToThrone = (w: World, u: Unit): void => {
  const jx = (rand(w) - 0.5) * 0.3;
  const jy = (rand(w) - 0.5) * 0.3;
  if (isInThrone(u.x, u.y)) {
    u.moveX = jx;
    u.moveY = jy;
  } else {
    // routes onto the plateau via a stair
    const toCenter = routeTo(u, jx * 8, jy * 8);
    u.moveX = toCenter.x;
    u.moveY = toCenter.y;
  }
  u.aimX = u.moveX || u.aimX;
  u.aimY = u.moveY || u.aimY;
  u.attackHeld = false;
};

const fight = (w: World, u: Unit, def: ChampDef, target: Unit): void => {
  // facing / attack direction
  const aim = norm(target.x - u.x, target.y - u.y);
  // pathing (via a stair if needed)
  const move = routeTo(u, target.x, target.y);
  const d = dist(u, target);
  const wantRange = u.attackRange * 0.8;
  if (d > wantRange) {
    u.moveX = move.x;
    u.moveY = move.y;
    if (d > 8) {
      tryActive(w, u, "haste");
      // close the gap
    }
  } else {
    // strafe
    u.moveX = aim.y * 0.4;
    u.moveY = -aim.x * 0.4;
  }
  u.aimX = aim.x;
  u.aimY = aim.y;
  u.attackHeld = d <= u.attackRange + target.radius + 0.6;

  // cast by real ability range; hold the ult for a worthwhile target. Iterate
  // all six slots so bots fire DASH + JUMP too: the same range-gate makes DASH
  // (its castRange is the dash distance) close the gap and JUMP (castRange 1.6)
  // strike an adjacent enemy — the dispatch self-leaps if grounded, so bots
  // don't hop first. DASH/JUMP are rank 1 for heroes, rank 0 for creeps, and
  // creeps route through tickSkeleton so they never reach this loop anyway.
  const point = { x: target.x, y: target.y };
  // advancing on the target, not strafing in-range
  const closing = d > wantRange;
  for (const key of ALL_ABILITY_KEYS) {
    const slot = u.abilities[key];
    if (slot.rank < 1 || w.now < slot.readyAt) {
      continue;
    }
    const range = def.abilities[key].castRange || u.attackRange + 3;
    if (d > range + target.radius) {
      continue;
    }
    if (key === "R" && !(target.hp < target.maxHp * 0.55 || d < 6)) {
      continue;
      // ult on value
    }
    if (key === "DASH" && !closing) {
      continue;
      // only dash to gap-close, never past a target in-range
    }
    // dir=aim → dash/jump land toward the target
    castAbility(w, u, key, { dir: aim, point });
    // one ability per tick
    break;
  }
};

const tickBot = (w: World, u: Unit, median: number): void => {
  const def = CHAMP_BY_ID[u.champId];
  if (!def) {
    return;
  }
  const lowHp = u.hp < u.maxHp * 0.32;
  const trailing = u.kills <= median;

  if (inOwnBase(u)) {
    shop(w, u, def);
  }

  // ── cleanse if hard-disabled ──
  if (isDisabled(u)) {
    tryActive(w, u, "cleanse");
  }
  if (isDisabled(u)) {
    return;
    // stunned: can't act further this tick
  }

  if (lowHp) {
    retreat(w, u);
    return;
  }

  // ── grab nearby coins / deliveries (catch-up; trailing bots prioritize) ──
  const pickup = nearestPickup(w, u, trailing ? 22 : 12);
  const target = pickTarget(w, u);
  if (pickup && (!target || dist(u, pickup) < dist(u, target) - 3)) {
    walkTo(u, pickup.x, pickup.y);
    return;
  }

  if (!target || dist(u, target) > 13) {
    driftToThrone(w, u);
    return;
  }

  fight(w, u, def, target);
};

export const tickBots = (w: World): void => {
  if (w.phase !== "playing") {
    return;
  }
  const median = medianKills(w);

  for (const u of w.units.values()) {
    if (u.kind === "creep" && u.alive) {
      tickSkeleton(w, u);
      continue;
    }
    if (u.kind !== "hero" || !u.isBot || !u.alive) {
      continue;
    }
    tickBot(w, u, median);
  }
};
