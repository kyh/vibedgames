// Host-side roster: which humans hold seats, seating late arrivals during the
// countdown, dropping leavers, feeding guests' intents through the same
// brawler API the local player uses, and rebuilding the sim from the last
// snapshot when this client is promoted to host.
import { BRAWLERS, TUNING } from "../config";
import type { BrawlerId } from "../config";
import { Brawler } from "../entities/brawler";
import type { Game } from "../game";
import { cleanName } from "../hud-lobby";
import type { BrawlerDrive } from "./interpolation";
import { seatId } from "./protocol";
import type { NetBrawler, Snapshot } from "./snapshot";
import { GRID } from "../world/grid";

export interface Pick {
  kit: BrawlerId;
  name: string;
}

/** A human's claim on a roster slot for the next brawl. */
export interface Seat {
  isLocal: boolean;
  kit: BrawlerId;
  name: string;
  owner: string;
}

/** Connected humans with a pick, the local player first, capped at the roster size. */
export const onlineSeats = (game: Game): Seat[] => {
  const { session } = game;
  if (!session) {
    return [];
  }
  const me = session.playerId;
  const seats: Seat[] = [];
  for (const [owner, pick] of game.picks) {
    // A peer in its reconnect grace keeps its pick but is not seated into a brawl it cannot play.
    if (!session.players[owner] || session.players[owner]?.connected === false) {
      continue;
    }
    seats.push({ isLocal: owner === me, kit: pick.kit, name: pick.name, owner });
  }
  seats.sort((a, b) => Number(b.isLocal) - Number(a.isLocal));
  return seats.slice(0, TUNING.bots + 1);
};

/** Build a brawler from a snapshot row, carrying every field the row holds. */
export const spawnFromNet = (
  game: Game,
  n: NetBrawler,
  drive: BrawlerDrive,
  isLocal: boolean,
  owner: string | null = n.owner,
): Brawler => {
  const b = new Brawler(game, BRAWLERS[n.kit], {
    drive,
    hueShift: n.hue,
    isPlayer: isLocal,
    name: n.name,
    netId: n.id,
    owner,
    x: n.x,
    z: n.z,
  });
  b.root.position.y = n.y;
  b.netAir = n.y > 0.001;
  b.hp = n.hp;
  b.maxHp = n.maxHp;
  b.ammo = n.ammo;
  b.superCharge = n.charge;
  b.cubes = n.cubes;
  b.kills = n.kills;
  b.rank = n.rank;
  b.facing = n.facing;
  b.aimAngle = n.facing;
  b.root.rotation.y = n.facing;
  if (!n.alive) {
    b.alive = false;
    b.hp = 0;
    b.deadT = 1;
    b.root.visible = false;
    b.root.scale.setScalar(0);
  }
  return b;
};

const humanBrawler = (game: Game, owner: string): Brawler | undefined =>
  game.brawlers.find((b) => b.owner === owner);

/** A late human replaces a bot at its spawn — only while the countdown still runs. */
const seatLateArrivals = (game: Game): void => {
  for (const seat of onlineSeats(game)) {
    if (humanBrawler(game, seat.owner)) {
      continue;
    }
    const bot = game.brawlers.find((b) => b.owner === null && !b.isPlayer && b.alive);
    if (!bot) {
      return;
    }
    const { x, z } = bot;
    game.removeBrawler(bot, false);
    const b = new Brawler(game, BRAWLERS[seat.kit], {
      isPlayer: seat.isLocal,
      name: seat.name,
      netId: seatId(seat.owner),
      owner: seat.owner,
      x,
      z,
    });
    game.addBrawler(b, false);
    if (seat.isLocal) {
      game.adoptLocalSeat(b);
    }
  }
};

/** Every frame while hosting: leavers vanish, dropped peers stand still, arrivals are seated. */
export const reconcileSeats = (game: Game): void => {
  const { session } = game;
  if (!session) {
    return;
  }
  const { players } = session;
  const me = session.playerId;
  for (const owner of game.picks.keys()) {
    if (owner !== me && !players[owner]) {
      game.picks.delete(owner);
    }
  }
  let removed = false;
  // removeBrawler swaps in a filtered array, so iterating the current one is safe.
  for (const b of game.brawlers) {
    if (b.owner === null) {
      continue;
    }
    if (!players[b.owner]) {
      game.removeBrawler(b, true);
      removed = true;
    } else if (players[b.owner]?.connected === false) {
      b.moveX = 0;
      b.moveZ = 0;
    }
  }
  if (removed) {
    game.afterRosterChange();
  }
  if (game.state === "countdown") {
    seatLateArrivals(game);
  }
};

/** Drain the intent queue into picks and brawler actions. Guests only learn picks from it. */
export const applyRemoteIntents = (game: Game): void => {
  const { session } = game;
  if (!session) {
    return;
  }
  const me = session.playerId;
  for (const { from, intent } of session.drainIntents()) {
    if (intent.kind === "join") {
      game.picks.set(from, { kit: intent.kit, name: cleanName(intent.name) });
      continue;
    }
    if (game.mode !== "host" || from === me) {
      continue;
    }
    const b = humanBrawler(game, from);
    if (!b || !b.alive) {
      continue;
    }
    if (intent.kind === "input") {
      b.moveX = intent.mx;
      b.moveZ = intent.mz;
    } else if (intent.kind === "attack") {
      b.attack(intent.dx, intent.dz, intent.x, intent.z);
    } else if (intent.kind === "super") {
      b.useSuper(intent.dx, intent.dz, intent.x, intent.z);
    }
  }
};

const restoreLoot = (game: Game, snap: Snapshot): void => {
  const { combat, world } = game;
  for (const i of snap.broken) {
    world.destroyTile(i % GRID, Math.floor(i / GRID));
  }
  for (const row of snap.boxes) {
    const spot = world.boxSpots[row.i];
    if (!spot) {
      continue;
    }
    const box = combat.addBox(spot[0], spot[1]);
    box.hp = row.hp;
  }
  for (const cube of snap.cubes) {
    combat.spawnCube(cube.x, cube.z, cube.x, cube.z);
  }
  for (const cube of combat.cubes) {
    cube.t = 1;
  }
};

const restorePhase = (game: Game, snap: Snapshot): void => {
  game.generation = snap.gen;
  game.winner = snap.winner;
  game.matchTime = snap.matchTime;
  game.countdownT = snap.countdownT;
  game.pendingResult = null;
  game.endT = 0;
  if (snap.phase === "countdown") {
    game.state = "countdown";
    game.lastCount = 4;
  } else {
    game.state = snap.phase;
    game.lastCount = 0;
  }
  game.gas.update(0, snap.matchTime, false);
  if (game.autoTime) {
    game.lighting.setTime(snap.hour);
  }
};

/**
 * Promotion: rebuild the sim from the last snapshot in place. Seats whose owner
 * is gone become bots so the brawl keeps its numbers; bullets and bombs in
 * flight are dropped. `departed` is the host we were following: the server's
 * election can land before its `player_left`, so it counts as gone regardless.
 */
export const restoreFromSnapshot = (
  game: Game,
  snap: Snapshot,
  departed: string | null = null,
): void => {
  const { session } = game;
  const players = session?.players ?? {};
  const me = session?.playerId ?? null;
  if (departed !== null) {
    game.picks.delete(departed);
  }
  if (game.world.seed !== snap.seed) {
    game.rebuildWorld(snap.seed);
  }
  game.clearEntities();
  game.world.broken = [];
  restoreLoot(game, snap);
  for (const n of snap.brawlers) {
    const ownerPresent = n.owner !== null && n.owner !== departed && players[n.owner] !== undefined;
    const isLocal = n.owner !== null && n.owner === me;
    const b = spawnFromNet(game, n, "sim", isLocal, ownerPresent ? n.owner : null);
    game.addBrawler(b, !ownerPresent);
    if (isLocal) {
      game.adoptLocalSeat(b);
    }
  }
  restorePhase(game, snap);
  const own = game.player;
  if (own && !own.alive) {
    // A guest promoted after falling still gets its result — and the restart button.
    game.pendingResult = { rank: own.rank, t: 0.5, won: false };
  }
  game.world.aoDirty = true;
  game.world.aoTimer = 0;
};
