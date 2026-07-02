// The economy + the four signature mechanics (build-doc §10): throne aura,
// Over Boss coins, catch-up deliveries, leader bounty. Plus XP/gold/kill awards.
// These four are the anti-snowball valves — they ARE the game.
import {
  ASSIST_FRACTION,
  ASSIST_WINDOW,
  COIN_GOLD,
  COIN_INTERVAL,
  COIN_LIFETIME,
  DELIVERY_INTERVAL,
  DELIVERY_LIFETIME,
  KILL_GOLD,
  KILL_XP,
  LEADER_BOUNTY,
  LEVEL_CAP,
  PASSIVE_GOLD_PER_SEC,
  THRONE_GOLD_MULT,
  THRONE_XP_MULT,
  levelForXp,
} from "../data/config";
import { ITEMS, ITEM_BY_ID, MAX_ITEMS } from "../data/items";
import { BOSS_POS, DELIVERY_PADS, isInThrone } from "../data/map";
import { rand, randPick, randRange } from "./math";
import { syncAbilityRanks } from "./ranks";
import { recomputeStats } from "./stats";
import { creepReward } from "./world";
import type { Coin, Unit, World } from "./types";
import { nextId } from "./types";

const AURA_XP_PER_SEC = 5; // baseline passive level trickle
const ITEMS_BY_COST = [...ITEMS].sort((a, b) => a.cost - b.cost);

export function heroes(w: World): Unit[] {
  return [...w.units.values()].filter((u) => u.kind === "hero");
}

// ── Per-tick economy ─────────────────────────────────────────────────────────
export function tickEconomy(w: World, dt: number): void {
  passiveIncome(w, dt);
  tickCoins(w, dt);
  tickDeliveries(w, dt);
}

function passiveIncome(w: World, dt: number): void {
  for (const u of w.units.values()) {
    if (u.kind !== "hero" || !u.alive) continue;
    const inThrone = isInThrone(u.x, u.y);
    const goldMult = inThrone ? 1 + THRONE_GOLD_MULT : 1;
    const xpMult = inThrone ? 1 + THRONE_XP_MULT : 1;
    u.gold += PASSIVE_GOLD_PER_SEC * dt * goldMult;
    // throne grants the real xp aura; outside, a steady trickle (narrowed gap
    // so center control isn't a runaway leveling multiplier for the leader)
    const xpRate = inThrone ? AURA_XP_PER_SEC * xpMult : AURA_XP_PER_SEC * 0.6;
    grantXp(w, u, xpRate * dt);
  }
}

// ── XP / gold / leveling ─────────────────────────────────────────────────────
export function grantXp(w: World, u: Unit, amount: number): void {
  if (u.level >= LEVEL_CAP) return;
  u.xp += amount;
  const newLevel = levelForXp(u.xp);
  if (newLevel > u.level) {
    const prevMax = u.maxHp;
    u.level = newLevel;
    syncAbilityRanks(u);
    recomputeStats(u);
    // level-up tops you up by the gained max HP (a small heal — feels good)
    u.hp = Math.min(u.maxHp, u.hp + (u.maxHp - prevMax));
    w.fx.push({ t: "levelup", x: u.x, y: u.y });
  }
}


// ── Kills, bounties, assists ─────────────────────────────────────────────────
export function awardKill(w: World, killerId: string | null, victim: Unit): void {
  const killer = killerId ? findByOwner(w, killerId) : null;
  const standing = standings(w);

  if (killer && killer !== victim && killer.team !== victim.team) {
    killer.kills += 1;
    killer.killStreak += 1;
    if (!killer.isBot) killer.mercy = 0; // a human kill ends the mercy ramp
    let gold = KILL_GOLD + Math.min(150, victim.killStreak * 25) + victim.level * 6;
    const wasLeader = w.leaderId !== null && victim.team === w.leaderId && victim.kills >= 1;
    if (wasLeader) gold += LEADER_BOUNTY;
    killer.gold += gold;
    grantXp(w, killer, KILL_XP + victim.level * 8);
    w.fx.push({
      t: "kill",
      killer: killer.ownerId,
      victim: victim.ownerId,
      killerName: killer.name,
      victimName: victim.name,
      leader: wasLeader,
    });
    if (wasLeader) w.fx.push({ t: "notify", text: `${killer.name} SLEW THE LEADER`, kind: "leader" });
    const streak = killer.killStreak;
    const word =
      streak === 3 ? "KILLING SPREE" : streak === 5 ? "RAMPAGE" : streak === 7 ? "UNSTOPPABLE" : streak >= 9 && streak % 2 === 1 ? "GODLIKE" : null;
    if (word) w.fx.push({ t: "notify", text: `${killer.name} — ${word}`, kind: "streak" });
  } else {
    w.fx.push({
      t: "kill",
      killer: killerId ?? "",
      victim: victim.ownerId,
      killerName: killer?.name ?? "the arena",
      victimName: victim.name,
    });
  }

  // assists (recent damagers, not the killer)
  for (const ownerId of Object.keys(victim.recentDamageFrom)) {
    if (killer && ownerId === killer.ownerId) continue;
    if (w.now - victim.recentDamageFrom[ownerId]! > ASSIST_WINDOW * 1000) continue;
    const helper = findByOwner(w, ownerId);
    if (helper && helper.team !== victim.team) {
      helper.assists += 1;
      helper.gold += KILL_GOLD * ASSIST_FRACTION;
      grantXp(w, helper, KILL_XP * ASSIST_FRACTION);
    }
  }
  void standing;
}

/** Killing a skeleton: bounty + XP to the killer, and drop a loot coin anyone
 *  can grab (the "drops" — visible reward for clearing a camp). */
export function awardCreepKill(w: World, killerId: string | null, victim: Unit): void {
  const reward = creepReward(victim.champId);
  const killer = killerId ? findByOwner(w, killerId) : null;
  if (killer && killer.kind === "hero") {
    killer.gold += reward.bounty;
    grantXp(w, killer, reward.xp);
  }
  // visible loot coin (uses the coin pickup system) — claimable immediately
  w.coins.push({
    id: nextId(w, "loot"),
    x: victim.x,
    y: victim.y,
    fromX: victim.x,
    fromY: victim.y,
    gold: Math.round(reward.bounty * 0.8),
    landAt: w.now,
    expireAt: w.now + COIN_LIFETIME * 1000,
  });
  // the elite bounty is an announcement-worthy event
  if (victim.champId === "frostgolem") {
    w.fx.push({ t: "notify", text: "FROST GOLEM SLAIN", kind: "leader" });
  }
}

function findByOwner(w: World, ownerId: string): Unit | null {
  for (const u of w.units.values()) if (u.kind === "hero" && u.ownerId === ownerId) return u;
  return null;
}

/** Heroes sorted by kills desc (0 = leader). */
function standings(w: World): Unit[] {
  return heroes(w).sort((a, b) => b.kills - a.kills || b.gold - a.gold);
}

export function updateLeader(w: World): void {
  const top = standings(w)[0];
  w.leaderId = top && top.kills >= 1 ? top.team : null;
}

// ── Over Boss coins ──────────────────────────────────────────────────────────
function tickCoins(w: World, _dt: number): void {
  // throw on cadence
  if (w.boss.alive && w.gameTime >= w.nextCoinAt) {
    w.nextCoinAt += COIN_INTERVAL;
    throwCoin(w);
  }
  const keep: Coin[] = [];
  for (const c of w.coins) {
    if (w.now >= c.expireAt) continue;
    if (w.now >= c.landAt) {
      // claimable: first hero to touch
      let claimed = false;
      for (const u of w.units.values()) {
        if (u.kind !== "hero" || !u.alive) continue;
        if ((u.x - c.x) ** 2 + (u.y - c.y) ** 2 <= (u.radius + 0.8) ** 2) {
          u.gold += c.gold;
          w.fx.push({ t: "coinGrab", x: c.x, y: c.y, gold: c.gold });
          claimed = true;
          break;
        }
      }
      if (claimed) continue;
    }
    keep.push(c);
  }
  w.coins = keep;
}

function throwCoin(w: World): void {
  // land at a random spot in the mid-field (reachable, away from the dais)
  const ang = randRange(w, 0, Math.PI * 2);
  const r = randRange(w, 9, 22);
  const tx = Math.cos(ang) * r;
  const ty = Math.sin(ang) * r;
  w.coins.push({
    id: nextId(w, "coin"),
    x: tx,
    y: ty,
    fromX: BOSS_POS.x,
    fromY: BOSS_POS.y,
    gold: COIN_GOLD,
    landAt: w.now + 900,
    expireAt: w.now + (900 + COIN_LIFETIME * 1000),
  });
  w.fx.push({ t: "coinThrow", x: BOSS_POS.x, y: BOSS_POS.y, tx, ty });
}

// ── Catch-up deliveries (rubber-band) ────────────────────────────────────────
function tickDeliveries(w: World, _dt: number): void {
  if (w.gameTime >= w.nextDeliveryAt) {
    w.nextDeliveryAt += DELIVERY_INTERVAL;
    const pad = randPick(w, DELIVERY_PADS);
    if (pad) {
      w.deliveries.push({
        id: nextId(w, "del"),
        x: pad.x,
        y: pad.y,
        expireAt: w.now + DELIVERY_LIFETIME * 1000,
      });
      w.fx.push({ t: "notify", text: "ITEM INBOUND", kind: "delivery" });
    }
  }

  const keep = [];
  for (const d of w.deliveries) {
    if (w.now >= d.expireAt) continue;
    let claimed = false;
    for (const u of w.units.values()) {
      if (u.kind !== "hero" || !u.alive) continue;
      if ((u.x - d.x) ** 2 + (u.y - d.y) ** 2 <= (u.radius + 1.0) ** 2) {
        claimDelivery(w, u);
        w.fx.push({ t: "delivery", x: d.x, y: d.y, tier: "", playerName: u.name });
        claimed = true;
        break;
      }
    }
    if (!claimed) keep.push(d);
  }
  w.deliveries = keep;
}

/** Resolve the delivery's item by the claimant's standing — last place gets the
 *  strongest item, the leader the weakest. The core anti-snowball valve. */
function claimDelivery(w: World, claimant: Unit): void {
  const order = standings(w);
  const n = Math.max(1, order.length - 1);
  const standing = Math.max(0, order.indexOf(claimant));
  const frac = standing / n; // 0 = leader, 1 = last
  // band the cost-sorted list; bias toward the band but jitter a little
  const idx = Math.min(
    ITEMS_BY_COST.length - 1,
    Math.max(0, Math.round(frac * (ITEMS_BY_COST.length - 1) + (rand(w) - 0.5) * 1.5)),
  );
  const item = ITEMS_BY_COST[idx]!;
  if (claimant.items.length < MAX_ITEMS) {
    claimant.items.push(item.id);
  } else {
    // full inventory → refund as gold instead
    claimant.gold += item.cost;
  }
  recomputeStats(claimant);
  void ITEM_BY_ID; // (kept for symmetry / future tooltips)
}
