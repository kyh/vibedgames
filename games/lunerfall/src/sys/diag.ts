import type Phaser from "phaser";
import {
  isPlaytestRequested,
  publishDiagnostics,
  publishPlaytest,
  publishTestHooks,
} from "@vibedgames/playtest";
import type { ReflexInputs } from "@vibedgames/playtest";

import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { Navigator } from "./nav";
import type { NavPoint, NavStep } from "./nav";
import { Pilot } from "./pilot";
import type { Intent, PilotTarget, PilotView } from "./pilot";
import type { RunManager } from "./run";

// The playtest contract (see the playtest skill's references/model-playtest.md):
// __GAME_DIAGNOSTICS__ is read-only telemetry, __GAME_TEST_HOOKS__ the mutations
// a test may perform, __GAME_PLAYTEST__ the controls a decision model chooses
// between. Diagnostics are a live getter, so a build nobody is playtesting
// never pays for the route-finding behind them.

type Phase = "menu" | "fight" | "loot" | "exit" | "transition" | "dead";

interface Foe {
  kind: string;
  state: string;
  hp: number;
  dx: number;
  dy: number;
}

export interface Diagnostics extends PilotView {
  frame: number;
  score: number;
  complete: boolean;
  player: { x: number; y: number; speed: number; vy: number; facing: number };
  entities: number;
  phase: Phase;
  room: { type: string; depth: number; biome: number; enemiesLeft: number };
  hearts: number;
  maxHearts: number;
  invulnerable: boolean;
  canJump: boolean;
  specialReady: boolean;
  nearestEnemy: (Foe & PilotTarget & { inReach: boolean }) | null;
  otherEnemies: Foe[];
  incoming: { dx: number; dy: number; vx: number } | null;
  exits: (PilotTarget & { open: boolean; leadsTo: string })[];
  pickup: (PilotTarget & { kind: string }) | null;
}

export interface DiagWorld {
  run: RunState;
  room: RoomState;
  seat: SeatState;
  expedition: RunManager;
}

// Swing reach past the enemy's near edge, and the band of the swing's tall hitbox (player-body.ts attackBox).
const REACH = 28;
const REACH_UP = -30;
const REACH_DOWN = 28;
const OTHERS = 2;

const beat = { complete: false, frame: 0, score: 0 };
let world: DiagWorld | null = null;
const foeNav = new Navigator();
const pickupNav = new Navigator();
const exitNavs = [new Navigator(), new Navigator()];

const roundStep = (s: NavStep): NavStep => ({ ...s, dx: Math.round(s.dx), dy: Math.round(s.dy) });

const idle = (): Diagnostics => ({
  ...beat,
  canJump: false,
  dashReady: false,
  entities: 0,
  exits: [],
  grounded: false,
  hearts: 0,
  incoming: null,
  invulnerable: false,
  maxHearts: 0,
  nearestEnemy: null,
  onWall: 0,
  otherEnemies: [],
  phase: "menu",
  pickup: null,
  player: { facing: 1, speed: 0, vy: 0, x: 0, y: 0 },
  room: { biome: 0, depth: 0, enemiesLeft: 0, type: "menu" },
  specialReady: false,
});

interface LiveFoe extends NavPoint {
  kind: string;
  state: string;
  hp: number;
  hw: number;
}

const liveFoes = (room: RoomState): LiveFoe[] => {
  const foes: LiveFoe[] = [];
  for (const e of room.enemies) {
    if (!e.body.dead) {
      const { x, y, hp, state, kind } = e.body;
      foes.push({ hp, hw: kind.hw, kind: kind.name, state, x, y });
    }
  }
  const boss = room.boss?.body;
  if (boss && !boss.dead) {
    const box = boss.hurtBox();
    const hw = (box.right - box.left) / 2;
    foes.push({ hp: boss.hp, hw, kind: "boss", state: boss.state, x: boss.x, y: boss.y });
  }
  return foes;
};

const observe = (w: DiagWorld): Diagnostics => {
  const { body } = w.seat.player;
  // A body rising through a jump-through reads as grounded for the frames its feet are inside the tile.
  const grounded = body.grounded && body.vy >= 0;
  const me = { grounded, x: body.x, y: body.y };
  const rel = (p: NavPoint) => ({ dx: Math.round(p.x - body.x), dy: Math.round(p.y - body.y) });
  const target = (nav: Navigator, p: NavPoint): PilotTarget => ({
    ...rel(p),
    step: roundStep(nav.step(w.room.grid, me, p)),
  });
  const near = (p: NavPoint): number => Math.abs(p.x - body.x) + 2 * Math.abs(p.y - body.y);

  const foes = liveFoes(w.room).toSorted((a, b) => near(a) - near(b));
  const brief = (f: LiveFoe): Foe => ({ hp: f.hp, kind: f.kind, state: f.state, ...rel(f) });
  const [first] = foes;
  let nearestEnemy: Diagnostics["nearestEnemy"] = null;
  if (first) {
    const { dx, dy } = rel(first);
    const inReach = Math.abs(dx) < REACH + first.hw && dy > REACH_UP && dy < REACH_DOWN;
    nearestEnemy = { ...brief(first), inReach, step: target(foeNav, first).step };
  }

  const shots = [...w.room.arrows, ...w.room.hazards].toSorted((a, b) => near(a) - near(b));
  const [shot] = shots;

  const loot: (NavPoint & { kind: string })[] = [];
  if (w.room.feature && !w.room.feature.used) {
    loot.push({ kind: w.expedition.type, x: w.room.feature.x, y: w.room.feature.y });
  }
  for (const item of w.room.merchantItems) {
    if (!item.bought && w.run.gold >= item.relic.price) {
      loot.push({ kind: "relic", x: item.x, y: item.y });
    }
  }
  const [grab] = loot.toSorted((a, b) => near(a) - near(b));

  let phase: Phase = "exit";
  if (w.run.state === "dead") {
    phase = "dead";
  } else if (w.run.state !== "active") {
    phase = "transition";
  } else if (foes.length > 0) {
    phase = "fight";
  } else if (grab) {
    phase = "loot";
  }

  return {
    ...beat,
    canJump: grounded,
    dashReady: body.dashReady,
    entities: w.room.enemies.length + w.room.guest.enemyPuppets.size,
    exits: w.room.doors.slice(0, exitNavs.length).map((d, i) => ({
      ...target(exitNavs[i] ?? foeNav, d),
      leadsTo: w.run.offers[d.index]?.type ?? "unknown",
      open: d.active,
    })),
    grounded,
    hearts: w.run.hearts,
    incoming: shot ? { ...rel(shot), vx: Math.round(shot.vx) } : null,
    invulnerable: body.iframes > 0,
    maxHearts: w.run.maxHearts,
    nearestEnemy,
    onWall: body.wallDir,
    otherEnemies: foes.slice(1, 1 + OTHERS).map((f) => brief(f)),
    phase,
    pickup: grab ? { ...target(pickupNav, grab), kind: grab.kind } : null,
    player: {
      facing: body.facing,
      speed: Math.round(Math.hypot(body.vx, body.vy)),
      vy: Math.round(body.vy),
      x: Math.round(body.x),
      y: Math.round(body.y),
    },
    room: {
      biome: w.expedition.biome,
      depth: w.expedition.depth,
      enemiesLeft: foes.length,
      type: w.expedition.type,
    },
    specialReady: body.specialReadiness.kind === "ready",
  };
};

/** The running GameScene hands over its state in create() and takes it back on shutdown. */
export const attachDiag = (w: DiagWorld | null): void => {
  world = w;
};

/** Once per rendered frame: the heartbeat, and the two fields that outlive the scene (a death is read from the hub). */
export const tickDiag = (): void => {
  beat.frame += 1;
  if (world) {
    beat.score = world.run.score;
    beat.complete = world.run.state === "dead";
  }
};

const restartSolo = (game: Phaser.Game, seed?: number): void => {
  for (const key of ["select", "game", "viewer"]) {
    if (game.scene.isActive(key)) {
      game.scene.stop(key);
    }
  }
  beat.frame = 0;
  beat.score = 0;
  beat.complete = false;
  // Staged state never lands in a live room: a party the hub remembered would reconnect.
  game.registry.set("party", "");
  game.scene.start("game", { hero: "axion", seed });
};

const KEYS = {
  attack: "KeyJ",
  dash: "ShiftLeft",
  down: "KeyS",
  jump: "Space",
  left: "KeyA",
  right: "KeyD",
  // Aim only. W would do, but the arrow keeps the apex dash's up-aim apart from the WASD run keys in a key log.
  up: "ArrowUp",
} satisfies Record<keyof Intent, string>;

const BUTTONS: (keyof Intent)[] = ["attack", "dash", "down", "jump", "left", "right", "up"];

const held = (intent: Intent): ReflexInputs => ({
  keys: BUTTONS.filter((name) => intent[name]).map((name) => KEYS[name]),
});

const GOAL = [
  "Lunerfall is a side-view roguelite platformer. `score` rises ONLY by killing enemies (a quick chain of kills multiplies it), so the job is: kill everything in the room, leave through a door, repeat. The run ends when `hearts` reaches 0.",
  "`phase` says what the room wants: `fight` = enemies alive and the doors are locked, so choose `fight`; `loot` = a free heal/relic is waiting (`pickup`), so choose `loot` then leave; `exit` = nothing left here, so choose a door; `transition` = between rooms, any choice is fine.",
  "Every move is an autopilot that runs, jumps, air-dashes and drops through platforms on its own — you choose WHAT to do, never the keys. `fight` also swings the blade the moment `nearestEnemy.inReach` is true.",
  "`nearestEnemy` {kind, state, hp, dx, dy} is relative to the player (dx>0 = to the right, dy<0 = above). Enemies hurt on touch and with attacks: `state` `windup`/`charge`/`attack` means a hit is coming in about a third of a second. With `hearts` at 1 and an enemy winding up within 60 px, `retreat` for a beat, then `fight` again; otherwise keep fighting — hesitating loses more hearts than trading.",
  "`exits[i]` {leadsTo, open, dx, dy}: doors open when `room.enemiesLeft` is 0. `leadsTo` `combat`/`elite`/`boss` means more kills and more score; `rest` heals 2 hearts, `treasure` and `merchant` give relics. Prefer a fight door unless `hearts` is 2 or less and a `rest` door is offered. `exit_1` takes exits[0], `exit_2` takes exits[1] (or exits[0] when there is only one door). Commit to one door until the room changes.",
  "`special` is a ground-smash that hits everything within ~34 px; use it when `specialReady` and an enemy is within 40 px.",
].join(" ");

const publishManifest = (): void => {
  const pilot = new Pilot();
  publishPlaytest<Diagnostics>({
    actions: {
      special: {
        description:
          "cast the ground-smash special (only when specialReady is true and nearestEnemy is within 40 px on both axes)",
        keys: ["KeyK"],
      },
    },
    goal: GOAL,
    move: {
      exit_1: {
        description:
          "Travel to exits[0] and walk through it — for phase `exit` (or to leave after looting)",
        reflex: (diag) => (diag ? held(pilot.exit(diag, 0)) : null),
      },
      exit_2: {
        description:
          "Travel to exits[1], the other door, and walk through it — when its leadsTo is the better room",
        reflex: (diag) => (diag ? held(pilot.exit(diag, 1)) : null),
      },
      fight: {
        description:
          "Hunt the nearest enemy and strike it when in reach — the default whenever phase is `fight`; this is what scores",
        reflex: (diag) => (diag ? held(pilot.fight(diag)) : null),
      },
      loot: {
        description:
          "Travel to `pickup` (a heal, a free relic, or an affordable shrine relic) — for phase `loot`",
        reflex: (diag) => (diag ? held(pilot.loot(diag)) : null),
      },
      retreat: {
        description:
          "Run away from the nearest enemy for a moment — only at 1 heart with an attack winding up close by",
        reflex: (diag) => (diag ? held(pilot.retreat(diag)) : null),
      },
    },
  });
};

export const installTestHooks = (game: Phaser.Game): void => {
  publishDiagnostics((): Diagnostics => (world ? observe(world) : idle()));
  if (!import.meta.env.DEV && !isPlaytestRequested()) {
    return;
  }
  publishTestHooks({
    // Contract: seed() reseeds the gameplay RNG AND restarts the run, so
    // everything a bot measures is deterministic from this seed (frames
    // rendered before the call were unseeded).
    seed: (n) => restartSolo(game, n),
    setPausedForScreenshot: (paused) => {
      if (paused) {
        game.loop.sleep();
      } else {
        game.loop.wake();
      }
    },
    // 'active-play' = a fresh solo run, skipping the hub. Always offline: it starts the scene with no party.
    setState: (name) => {
      if (name !== "active-play") {
        return;
      }
      restartSolo(game);
      return { state: name };
    },
  });
  publishManifest();
};
