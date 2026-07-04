// Bot AI — runs inside the host sim so guests see identical behavior. Bots seek
// the throne brawl, hunt the leader, grab coins/deliveries (so the catch-up
// economy actually reaches trailing players), shop, use item actives, retreat
// to heal when low, and cast abilities by real range. Deterministic (rand(w)).
import { CHAMP_BY_ID } from "../data/champions";
import { ITEM_BY_ID } from "../data/items";
import type { ActiveKind } from "../data/items";
import { dist, norm, rand, type Vec2 } from "./math";
import { nearestStair, onPlateau } from "./elevation";
import { isInThrone, SPAWNS } from "../data/map";
import { castAbility, useItemActive } from "./abilities";
import { isEnemy } from "./combat";
import { isDisabled, isUntargetable } from "./stats";
import { ALL_ABILITY_KEYS, type Unit, type World } from "./types";
import { buyItem, inOwnBase } from "./world";

const BUY_LISTS: Record<string, string[]> = {
  int: ["tome", "arcaneorb", "vitality", "wardstone", "phaseband", "elixir"],
  str: ["vitality", "ringmail", "bulwark", "whetstone", "swiftboots"],
  agi: ["whetstone", "quiver", "reaver", "vampiric", "boots", "swiftboots"],
};

/** Steering direction from u toward a goal, routed via the nearest stair when
 *  the goal is on the other side of the throne-plateau edge (so bots take the
 *  stairs instead of shoving the wall). */
function routeTo(u: Unit, gx: number, gy: number): Vec2 {
  if (onPlateau(u.x, u.y) === onPlateau(gx, gy)) return norm(gx - u.x, gy - u.y);
  const wp = nearestStair(u.x, u.y);
  if (Math.hypot(u.x - wp.x, u.y - wp.y) < 1.8) return norm(gx - u.x, gy - u.y); // at the gap — push through
  return norm(wp.x - u.x, wp.y - u.y);
}

function nearestEnemy(w: World, u: Unit): Unit | null {
  let best: Unit | null = null;
  let bestD = Infinity;
  for (const t of w.units.values()) {
    if (t === u || !t.alive || t.kind !== "hero" || !isEnemy(u, t) || isUntargetable(t)) continue;
    const d = (t.x - u.x) ** 2 + (t.y - u.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  return best;
}

/** Use a held active item of the given kind, if owned and off cooldown. */
function tryActive(w: World, u: Unit, kind: ActiveKind, point?: { x: number; y: number }): boolean {
  for (let i = 0; i < u.items.length; i++) {
    const def = ITEM_BY_ID[u.items[i]!];
    if (def?.active?.kind === kind && w.now >= (u.itemReadyAt[u.items[i]!] ?? 0)) {
      return useItemActive(w, u, i, point);
    }
  }
  return false;
}

function medianKills(w: World): number {
  const ks = [...w.units.values()].filter((x) => x.kind === "hero").map((x) => x.kills).sort((a, b) => a - b);
  return ks.length ? ks[Math.floor(ks.length / 2)]! : 0;
}

export function tickBots(w: World): void {
  if (w.phase !== "playing") return;
  const median = medianKills(w);

  for (const u of w.units.values()) {
    if (u.kind === "creep" && u.alive) {
      tickSkeleton(w, u);
      continue;
    }
    if (u.kind !== "hero" || !u.isBot || !u.alive) continue;
    const def = CHAMP_BY_ID[u.champId];
    if (!def) continue;
    const sp = SPAWNS[u.slot % SPAWNS.length]!;
    const lowHp = u.hp < u.maxHp * 0.32;
    const trailing = u.kills <= median;

    // ── economy: shop while home ──
    if (inOwnBase(u)) {
      const list = BUY_LISTS[def.primary] ?? [];
      for (const id of list) {
        const it = ITEM_BY_ID[id];
        if (it && u.gold >= it.cost && !u.items.includes(id)) {
          buyItem(w, u, id);
          break;
        }
      }
    }

    // ── cleanse if hard-disabled ──
    if (isDisabled(u)) tryActive(w, u, "cleanse");
    if (isDisabled(u)) continue; // stunned: can't act further this tick

    // ── retreat to heal when low (disengage→heal→re-engage) ──
    if (lowHp) {
      tryActive(w, u, "heal");
      tryActive(w, u, "shield");
      const toBase = norm(sp.x - u.x, sp.y - u.y);
      u.moveX = toBase.x;
      u.moveY = toBase.y;
      u.aimX = toBase.x || u.aimX;
      u.aimY = toBase.y || u.aimY;
      u.attackHeld = false;
      const en = nearestEnemy(w, u);
      if (en && dist(u, en) < 6) tryActive(w, u, "blink"); // peel off
      continue;
    }

    // ── grab nearby coins / deliveries (catch-up; trailing bots prioritize) ──
    const pickup = nearestPickup(w, u, trailing ? 22 : 12);
    const target = pickTarget(w, u);
    if (pickup && (!target || dist(u, pickup) < dist(u, target) - 3)) {
      const to = norm(pickup.x - u.x, pickup.y - u.y);
      u.moveX = to.x;
      u.moveY = to.y;
      u.aimX = to.x || u.aimX;
      u.aimY = to.y || u.aimY;
      u.attackHeld = false;
      continue;
    }

    // ── no close fight: drift to the throne magnet (via the stairs). A wider
    //    threshold so bots more actively climb to contest the high ground. ──
    if (!target || dist(u, target) > 13) {
      const jx = (rand(w) - 0.5) * 0.3;
      const jy = (rand(w) - 0.5) * 0.3;
      if (isInThrone(u.x, u.y)) {
        u.moveX = jx;
        u.moveY = jy;
      } else {
        const toCenter = routeTo(u, jx * 8, jy * 8); // routes onto the plateau via a stair
        u.moveX = toCenter.x;
        u.moveY = toCenter.y;
      }
      u.aimX = u.moveX || u.aimX;
      u.aimY = u.moveY || u.aimY;
      u.attackHeld = false;
      continue;
    }

    // ── combat ──
    const aim = norm(target.x - u.x, target.y - u.y); // facing / attack direction
    const move = routeTo(u, target.x, target.y); // pathing (via a stair if needed)
    const d = dist(u, target);
    const wantRange = u.attackRange * 0.8;
    if (d > wantRange) {
      u.moveX = move.x;
      u.moveY = move.y;
      if (d > 8) tryActive(w, u, "haste"); // close the gap
    } else {
      u.moveX = aim.y * 0.4; // strafe
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
    const closing = d > wantRange; // advancing on the target, not strafing in-range
    for (const key of ALL_ABILITY_KEYS) {
      const slot = u.abilities[key];
      if (slot.rank < 1 || w.now < slot.readyAt) continue;
      const range = def.abilities[key].castRange || u.attackRange + 3;
      if (d > range + target.radius) continue;
      if (key === "R" && !(target.hp < target.maxHp * 0.55 || d < 6)) continue; // ult on value
      if (key === "DASH" && !closing) continue; // only dash to gap-close, never past a target in-range
      castAbility(w, u, key, { point, dir: aim }); // dir=aim → dash/jump land toward the target
      break; // one ability per tick
    }
  }
}

/** Skeleton AI: guard the camp — aggro nearby heroes, leash home. */
function tickSkeleton(w: World, u: Unit): void {
  const hx = u.homeX ?? u.x;
  const hy = u.homeY ?? u.y;
  const distHome = Math.hypot(u.x - hx, u.y - hy);
  if (isDisabled(u)) {
    u.attackHeld = false;
    return;
  }
  let target = nearestEnemy(w, u); // nearest hero
  if (target) {
    const dTarget = dist(u, target);
    const targetFromHome = Math.hypot(target.x - hx, target.y - hy);
    if (dTarget > 11 || targetFromHome > 14 || distHome > 15) target = null; // out of aggro/leash
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
}

/** Pick the bot's combat target: the leader if trailing & close, else nearest. */
function pickTarget(w: World, u: Unit): Unit | null {
  let target = nearestEnemy(w, u);
  if (w.leaderId && w.leaderId !== u.team) {
    const leader = [...w.units.values()].find((x) => x.kind === "hero" && x.team === w.leaderId && x.alive);
    if (leader && leader !== u && u.kills < leader.kills && dist(u, leader) < 24) target = leader;
  }
  return target;
}

/** Nearest claimable coin or delivery within range. */
function nearestPickup(w: World, u: Unit, maxR: number): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = maxR * maxR;
  for (const c of w.coins) {
    if (w.now < c.landAt) continue;
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
}
