// Bots: fighters the host plays so a thin room still has a match. They sit in
// the rules roster like anyone (rules.ts seats them), so kills, respawns and
// the scoreboard need nothing of their own. The host thinks for them with the
// shared soldier brain and publishes their bodies under BOTS_KEY; every
// client — the host included — turns that record into ordinary player reports
// (`botPlayers`), so bots are drawn, interpolated and shot exactly like people.
import type { JsonRecord, JsonValue, PlayerMap } from "@vibedgames/multiplayer";
import { Vector3 } from "three";

import type { StrikeforceGame } from "../core/types";
import { SoldierBrain } from "../soldier/soldier-brain";
import type { Combatant, Orders, Profile, Shot } from "../soldier/soldier-brain";
import { safestSpawn } from "./map";
import type { Spawn } from "./map";
import { q3 } from "./protocol";
import { isBot } from "./rules";
import type { Fighter, Point } from "./rules";
import { isRecord, nums } from "./wire";

const PROFILE: Profile = {
  aim: {
    burst: [3, 6],
    cadence: 0.14,
    damage: 16,
    falloff: 0.011,
    headChance: 0.06,
    hit: 0.62,
    minHit: 0.12,
    pause: [0.45, 0.9],
    reaction: [0.45, 0.8],
  },
  gait: { hold: 22, run: 4.5, strafe: 2.4, turn: 6, walk: 4.2 },
  senses: { cone: Math.cos((100 * Math.PI) / 180), lose: 1.5, range: 60, search: 4 },
};

/** How far from somebody a roaming bot heads, so a big dock still finds its fights. */
const ROAM = 30;

interface Seat {
  brain: SoldierBrain;
  /** The life (rules.ts) this bot was last placed as. */
  life: number;
}

export class Bots {
  private readonly brains = new Map<string, Seat>();
  private readonly game: StrikeforceGame;
  private readonly spawns: readonly Spawn[];
  private people: readonly Combatant[] = [];
  private live = false;
  private fire: ((shot: Shot) => void) | null = null;
  private readonly orders: Orders = {
    fire: (shot) => this.fire?.(shot),
    mayOpenFire: () => this.live,
    wander: (bot) => {
      const others = this.people.filter((p) => p.id !== bot.id);
      const near = others[Math.floor(Math.random() * others.length)];
      return this.game.physics.nav.randomPoint(
        near ? new Vector3(near.pos.x, 0, near.pos.z) : bot.pos,
        ROAM,
      );
    },
  };

  constructor(game: StrikeforceGame, spawns: readonly Spawn[]) {
    this.game = game;
    this.spawns = spawns;
  }

  /**
   * Think and move every bot seated in `roster`. `people` are the players
   * still standing; `seed` is where a bot was last seen, for a host that
   * inherits bots it did not place. `live`: shots count.
   */
  update(
    dt: number,
    roster: ReadonlyMap<string, Fighter>,
    people: readonly Combatant[],
    seed: (id: string) => Point | undefined,
    live: boolean,
    fire: (shot: Shot) => void,
  ): void {
    for (const [id, bot] of this.brains) {
      if (!roster.has(id)) {
        bot.brain.stop(this.orders);
        this.brains.delete(id);
      }
    }
    this.live = live;
    this.fire = fire;
    this.people = [...people, ...this.standing(roster)];
    for (const [id, fighter] of roster) {
      if (!isBot(id)) {
        continue;
      }
      const bot = this.brains.get(id) ?? this.seat(id, fighter, seed(id));
      if (!fighter.alive) {
        bot.brain.stop(this.orders);
        continue;
      }
      if (bot.life !== fighter.life) {
        this.place(bot.brain);
        bot.life = fighter.life;
      }
      bot.brain.update(dt, this.people, this.orders);
    }
  }

  /** A bot was shot from `from`: it turns to deal with it. */
  alert(id: string, from: Point | undefined): void {
    const bot = this.brains.get(id);
    if (bot && from) {
      bot.brain.investigate(from);
    }
  }

  /** Every bot's body, for BOTS_KEY: `{ [id]: [t, x, y, z, yaw, pitch] }`. */
  encode(now: number): JsonRecord {
    const out: JsonRecord = {};
    for (const [id, { brain }] of this.brains) {
      out[id] = [
        Math.round(now),
        q3(brain.pos.x),
        q3(brain.pos.y),
        q3(brain.pos.z),
        q3(brain.yaw),
        q3(brain.pitch),
      ];
    }
    return out;
  }

  private seat(id: string, fighter: Fighter, from: Point | undefined): Seat {
    const brain = new SoldierBrain(id, this.game.physics, PROFILE);
    // Inherited mid-life (a promoted host): carry on from where it stood.
    const bot = { brain, life: from ? fighter.life : -1 };
    if (from) {
      brain.place(from, 0, this.orders);
    }
    this.brains.set(id, bot);
    return bot;
  }

  private standing(roster: ReadonlyMap<string, Fighter>): Combatant[] {
    const out: Combatant[] = [];
    for (const [id, { brain }] of this.brains) {
      if (roster.get(id)?.alive) {
        out.push({ crouch: false, id, moving: true, pos: brain.pos });
      }
    }
    return out;
  }

  private place(brain: SoldierBrain): void {
    const spawn = safestSpawn(
      this.spawns,
      this.people.filter((p) => p.id !== brain.id).map((p) => p.pos),
    );
    if (spawn) {
      brain.place(spawn.pos, spawn.yaw, this.orders);
    }
  }
}

/**
 * The bots in a BOTS_KEY record as player reports, alive and life from the
 * match roster, so `Players` treats them like anyone else.
 */
export const botPlayers = (
  raw: JsonValue | undefined,
  roster: ReadonlyMap<string, Fighter> | undefined,
): PlayerMap => {
  const out: PlayerMap = {};
  if (!isRecord(raw) || !roster) {
    return out;
  }
  for (const [id, body] of Object.entries(raw)) {
    const v = nums(body, 6);
    const fighter = roster.get(id);
    if (!v || !fighter) {
      continue;
    }
    const [t = 0, x = 0, y = 0, z = 0, yaw = 0, pitch = 0] = v;
    out[id] = {
      id,
      state: {
        a: fighter.alive ? 1 : 0,
        c: 0,
        d: 1,
        hp: fighter.hp,
        l: fighter.life,
        pitch,
        t,
        x,
        y,
        yaw,
        z,
      },
    };
  }
  return out;
};
