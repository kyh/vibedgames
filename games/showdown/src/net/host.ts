// Host-side roster: which humans hold seats, seating late arrivals during the
// countdown, dropping leavers, feeding guests' intents through the same
// brawler API the local player uses — recording which one each body last ran,
// for the guest's time alignment — and rebuilding the sim from the room's
// state when this client is promoted to host.
import { BRAWLERS, TUNING } from "../config";
import type { BrawlerId } from "../config";
import { Brawler } from "../entities/brawler";
import type { BrawlerDrive } from "../entities/brawler";
import { leapPoint } from "../entities/movement";
import type { Game } from "../game";
import { cleanName } from "../hud-lobby";
import { directionVector, lookAngle } from "./input-intent";
import { maxHpFor } from "./interpolation";
import { seatId } from "./protocol";
import type { SequencedIntent } from "./protocol";
import type { BrawlerState, Identity, WorldState } from "./snapshot";
import { GRID } from "../world/grid";
import { terrainHeight } from "../world/terrain";

/** A remote evade may land this early on the host's cooldown: the guest's ran on its own clock (s). */
const EVADE_GRACE = 0.1;

/** Where a guest last saw its own body, kept across a promotion so the player does not jump. */
export interface OwnPose {
  x: number;
  z: number;
}

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

/** Build a brawler from a roster identity and its frame row, carrying every field the row holds. */
export const spawnFromNet = (
  game: Game,
  identity: Identity,
  n: BrawlerState,
  drive: BrawlerDrive,
  isLocal: boolean,
  owner: string | null = identity.owner,
): Brawler => {
  const b = new Brawler(game, BRAWLERS[identity.kit], {
    drive,
    hueShift: identity.hue,
    isPlayer: isLocal,
    name: identity.name,
    netId: identity.id,
    owner,
    x: n.x,
    z: n.z,
  });
  b.root.position.y = terrainHeight(n.x, n.z);
  const { super: special } = b.def;
  if (n.leap && drive === "sim" && special.kind === "leap") {
    // A promoted host finishes the leap from where the old host left it.
    b.leap = { ...n.leap, a: special };
    leapPoint(b.leap, special.flight, terrainHeight, b.root.position);
  } else if (n.leap && drive === "puppet") {
    b.netAir = true;
    b.netLeap = { ...n.leap };
  }
  b.meleeCue = n.melee ? { ...n.melee } : null;
  b.rangedCue = n.alive && n.ranged ? { ...n.ranged } : null;
  b.evasion = n.alive && n.evasion ? { ...n.evasion } : null;
  b.evadeCooldown = n.evadeCooldown;
  b.evadeResult = n.evade;
  b.knockSeq = n.knockSeq;
  b.hp = n.hp;
  b.maxHp = maxHpFor(b.def, n.cubes);
  b.ammo = n.ammo;
  b.reloadT = n.reload;
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
      b.lookAngle = null;
    }
  }
  if (removed) {
    game.afterRosterChange();
  }
  if (game.state === "countdown") {
    seatLateArrivals(game);
  }
};

/** Play one guest intent on its body; an evade's verdict is kept for the guest's row. */
const applyIntent = (b: Brawler, intent: SequencedIntent): void => {
  if (intent.kind === "evade") {
    b.evadeResult = b.evade(intent.dx, intent.dz, EVADE_GRACE) ? intent.seq : -intent.seq;
    return;
  }
  if (!b.alive) {
    return;
  }
  if (intent.kind === "input") {
    const move = directionVector(intent.dir);
    b.moveX = move.x;
    b.moveZ = move.z;
    b.lookAngle = lookAngle(intent.look);
  } else if (intent.kind === "attack") {
    b.attack(intent.dx, intent.dz, intent.x, intent.z);
  } else {
    b.useSuper(intent.dx, intent.dz, intent.x, intent.z);
  }
};

/**
 * Drain the intent queue into picks and brawler actions. Guests only learn
 * picks from it. `stepStartMs` is the sim time this step began: each body
 * remembers the newest intent it ran and since when, which its row reports.
 */
export const applyRemoteIntents = (game: Game, stepStartMs: number): void => {
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
    if (b?.ack.take(intent.seq, stepStartMs)) {
      applyIntent(b, intent);
    }
  }
};

const restoreLoot = (game: Game, snap: WorldState): void => {
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

const restorePhase = (game: Game, world: WorldState): void => {
  const { frame, match } = world;
  game.generation = match.gen;
  game.winner = match.winner;
  game.pendingResult = null;
  game.endT = 0;
  if (frame.phase === "countdown") {
    game.state = "countdown";
    game.countdownT = frame.clock;
    game.lastCount = 4;
  } else {
    game.state = frame.phase;
    game.matchTime = frame.clock;
    game.lastCount = 0;
  }
  game.gas.update(0, game.matchTime, false);
};

/** Seat every roster entry as a sim body; a seat whose owner is gone gets a bot brain. */
const restoreRoster = (
  game: Game,
  world: WorldState,
  departed: string | null,
  own: OwnPose | null,
): void => {
  const players = game.session?.players ?? {};
  const me = game.session?.playerId ?? null;
  for (const [i, identity] of world.match.roster.entries()) {
    const n = world.frame.brawlers[i];
    const { owner } = identity;
    if (n) {
      const present = owner !== null && owner !== departed && players[owner] !== undefined;
      const isLocal = owner !== null && owner === me;
      const state = isLocal && own && !n.leap ? { ...n, x: own.x, z: own.z } : n;
      const b = spawnFromNet(game, identity, state, "sim", isLocal, present ? owner : null);
      game.addBrawler(b, !present);
      if (isLocal) {
        game.adoptLocalSeat(b);
      }
    }
  }
};

/**
 * Promotion: rebuild the sim from the room's state in place. Seats whose owner
 * is gone become bots so the brawl keeps its numbers; bullets and bombs in
 * flight are dropped. `departed` is the host we were following: the server's
 * election can land before its `player_left`, so it counts as gone regardless.
 * `own` is where this client's predicted body stood — newer than the frame.
 */
export const restoreFromWorld = (
  game: Game,
  world: WorldState,
  departed: string | null = null,
  own: OwnPose | null = null,
): void => {
  if (departed !== null) {
    game.picks.delete(departed);
  }
  if (game.world.seed !== world.match.seed) {
    game.rebuildWorld(world.match.seed);
  }
  game.clearEntities();
  game.world.broken = [];
  restoreLoot(game, world);
  restoreRoster(game, world, departed, own);
  restorePhase(game, world);
  const { player } = game;
  if (player && !player.alive) {
    // A guest promoted after falling still gets its result — and the restart button.
    game.pendingResult = { rank: player.rank, t: 0.5, won: false };
  }
  game.world.aoDirty = true;
  game.world.aoTimer = 0;
};
