import type { Game } from "phaser";
import { keyTapper } from "@vibedgames/playtest";
import type { Diagnostics, PlaytestManifest, Reflex } from "@vibedgames/playtest";

import { CAN_MAX, DAY_END_MIN, MAP_H, MAP_W, TILE } from "./config";
import { CROPS, isMature } from "./data/crops";
import type { Item, ToolId } from "./data/items";
import { GameScene } from "./scenes/game-scene";
import { HudScene } from "./scenes/hud-scene";
import { MineScene } from "./scenes/mine-scene";
import { flood } from "./systems/pathfind";
import { store, workScore } from "./systems/store";
import type { Work } from "./systems/store";
import { GROUND, inBounds, tileIdx } from "./world/world";
import type { World } from "./world/world";

const CHORES = [
  "till",
  "plant",
  "water",
  "harvest",
  "forage",
  "chop",
  "ship",
  "refill",
  "sleep",
] as const;
type ChoreId = (typeof CHORES)[number];
type Step = -1 | 0 | 1;

/** One chore's nearest target, as the farmer would size it up from where they stand. */
interface Chore {
  /** Tiles from the farmer to the target tile. */
  dx: number;
  dy: number;
  /** Walking distance, in tiles, to where the chore can be done from; fences and ponds included. */
  steps: number;
  /** The direction to hold this frame: along the route, or to turn towards the target. */
  stepX: Step;
  stepY: Step;
  /** Beside the target and facing it — the action key lands on it. */
  facing: boolean;
}

type HeldSlot = "hoe" | "can" | "axe" | "seeds";

interface FarmView {
  tile: { x: number; y: number };
  facing: "up" | "down" | "left" | "right";
  /** What the selected hotbar slot holds, and its 1-based number. */
  held: string | null;
  slot: number;
  /** 1-based hotbar slot of each thing a chore needs; absent when the bag has none. */
  slots: Partial<Record<HeldSlot, number>>;
  /** Mid-swing, mid-fade or behind a modal: input is ignored until it clears. */
  busy: boolean;
  modal: boolean;
  /** The open modal is the farmhouse's "Rest for the night?". */
  sleepPrompt: boolean;
  energy: number;
  water: number;
  seeds: number;
  /** Everything the shipping bin would pay for, seeds aside. */
  goods: number;
  gold: number;
  day: number;
  clock: string;
  minutesToPassOut: number;
  weather: string;
  work: Work;
  plots: { empty: number; dry: number; growing: number; ripe: number };
  chores: Record<ChoreId, Chore | null>;
}

export type FarmDiagnostics = Diagnostics & { phase: "farm" | "mine" | "menu" } & Partial<FarmView>;

interface Plan {
  tx: number;
  ty: number;
  /** Already standing where the chore is done from. */
  there: boolean;
  steps: number;
  /** The next cell along the route (the standing cell once there). */
  nx: number;
  ny: number;
  standOn: boolean;
}

const NEIGHBOURS = [
  { x: 0, y: -1 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
  { x: 1, y: 0 },
] as const;

const sign = (n: number): Step => {
  if (n > 0) {
    return 1;
  }
  return n < 0 ? -1 : 0;
};

/** Hotbar keys reach slots 1–9 and 0; the last two slots are wheel-only. */
const KEYED_SLOTS = 10;
const slotOf = (wants: (item: Item) => boolean): number | undefined => {
  const i = store.inv.slots.findIndex((s, n) => n < KEYED_SLOTS && s !== null && wants(s.item));
  return i === -1 ? undefined : i + 1;
};
const toolSlot = (tool: ToolId): number | undefined =>
  slotOf((it) => it.kind === "tool" && it.tool === tool);

const heldName = (item: Item | null): string | null => {
  if (!item) {
    return null;
  }
  return item.kind === "tool" ? item.tool : item.kind;
};

const clockText = (timeMin: number): string => {
  const h = Math.floor(timeMin / 60) % 24;
  const m = Math.floor(timeMin % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
};

const facingName = (f: { x: number; y: number }): FarmView["facing"] => {
  if (f.x !== 0) {
    return f.x < 0 ? "left" : "right";
  }
  return f.y < 0 ? "up" : "down";
};

const countPlots = (world: World): FarmView["plots"] => {
  const plots = { dry: 0, empty: 0, growing: 0, ripe: 0 };
  for (let i = 0; i < MAP_W * MAP_H; i += 1) {
    if (!world.tilled[i]) {
      continue;
    }
    const cs = world.crops.get(i);
    if (!cs) {
      plots.empty += 1;
    } else if (isMature(CROPS[cs.crop], cs.daysGrown)) {
      plots.ripe += 1;
    } else if (world.watered[i]) {
      plots.growing += 1;
    } else {
      plots.dry += 1;
    }
  }
  return plots;
};

/**
 * The nearest tile `wants` accepts, by walking distance to a cell the chore
 * can be done from: an orthogonal neighbour (the farmer acts on the tile they
 * face), or the tile itself for walk-over pickups.
 */
const planFor = (
  scene: GameScene,
  route: ReturnType<typeof flood>,
  start: number,
  wants: (tx: number, ty: number) => boolean,
  standOn: boolean,
): Plan | null => {
  let best: { cost: number; stand: number; tx: number; ty: number } | null = null;
  for (let ty = 0; ty < MAP_H; ty += 1) {
    for (let tx = 0; tx < MAP_W; tx += 1) {
      if (!wants(tx, ty)) {
        continue;
      }
      for (const n of standOn ? [{ x: 0, y: 0 }] : NEIGHBOURS) {
        const sx = tx + n.x;
        const sy = ty + n.y;
        const d = inBounds(sx, sy) ? (route.dist[tileIdx(sx, sy)] ?? -1) : -1;
        if (d < 0) {
          continue;
        }
        // Among equals, the target already faced costs no turn.
        const faced = d === 0 && scene.facing.x === -n.x && scene.facing.y === -n.y;
        const cost = d * 2 + (faced ? 0 : 1);
        if (!best || cost < best.cost) {
          best = { cost, stand: tileIdx(sx, sy), tx, ty };
        }
      }
    }
  }
  if (!best) {
    return null;
  }
  let next = best.stand;
  for (let p = route.parent[next] ?? -1; p !== -1 && p !== start; p = route.parent[next] ?? -1) {
    next = p;
  }
  return {
    nx: next % MAP_W,
    ny: Math.trunc(next / MAP_W),
    standOn,
    steps: route.dist[best.stand] ?? 0,
    there: best.stand === start,
    tx: best.tx,
    ty: best.ty,
  };
};

/** Evening: from here the farmhouse is worth the walk whatever is left undone. */
const BEDTIME_MIN = 20 * 60;
const SWING_ENERGY = 2;
const isLate = (scene: GameScene): boolean => scene.timeMin >= BEDTIME_MIN;

const planChores = (scene: GameScene, plots: FarmView["plots"]): Record<ChoreId, Plan | null> => {
  const { world } = scene;
  const feet = scene.feetTile();
  const start = tileIdx(feet.tx, feet.ty);
  const route = flood(world, start);
  const season = scene.season();
  const hasEnergy = store.energy > 0;
  const seeds = slotOf((it) => it.kind === "seed" && CROPS[it.crop].seasons.includes(season));
  const goods = store.inv.count((it) => it.kind !== "tool" && it.kind !== "seed");
  // Crops only grow overnight: once today's are in and watered, bed is the next chore.
  const farmed =
    plots.ripe === 0 &&
    plots.dry === 0 &&
    (seeds === undefined || (plots.empty === 0 && !hasEnergy));
  const crop = (tx: number, ty: number) => world.crops.get(tileIdx(tx, ty));
  const plan = (able: boolean, wants: (tx: number, ty: number) => boolean, standOn = false) =>
    able ? planFor(scene, route, start, wants, standOn) : null;
  return {
    chop: plan(
      hasEnergy && toolSlot("axe") !== undefined,
      (tx, ty) => world.objectAt(tx, ty)?.type === "tree",
    ),
    forage: plan(true, (tx, ty) => world.objectAt(tx, ty)?.type === "forage", true),
    harvest: plan(true, (tx, ty) => {
      const cs = crop(tx, ty);
      return cs !== undefined && isMature(CROPS[cs.crop], cs.daysGrown);
    }),
    plant: plan(
      seeds !== undefined,
      (tx, ty) =>
        world.tilled[tileIdx(tx, ty)] === 1 && !crop(tx, ty) && world.objectAt(tx, ty) === null,
    ),
    refill: plan(
      toolSlot("can") !== undefined && hasEnergy && scene.canCharge <= CAN_MAX / 8,
      (tx, ty) => world.getGround(tx, ty) === GROUND.water,
    ),
    ship: plan(goods > 0, (tx, ty) => world.objectAt(tx, ty)?.type === "bin"),
    sleep: plan(
      isLate(scene) || store.energy < SWING_ENERGY || farmed,
      (tx, ty) => world.objectAt(tx, ty)?.type === "house",
    ),
    till: plan(hasEnergy && toolSlot("hoe") !== undefined, (tx, ty) => world.canTill(tx, ty)),
    water: plan(hasEnergy && scene.canCharge > 0 && toolSlot("can") !== undefined, (tx, ty) => {
      const cs = crop(tx, ty);
      return (
        cs !== undefined &&
        world.watered[tileIdx(tx, ty)] !== 1 &&
        !isMature(CROPS[cs.crop], cs.daysGrown)
      );
    }),
  };
};

/** The route changes only when the farmer changes tile or the farm changes under them. */
let planned: { key: string; plans: Record<ChoreId, Plan | null>; plots: FarmView["plots"] } | null =
  null;
const plansFor = (scene: GameScene): NonNullable<typeof planned> => {
  const feet = scene.feetTile();
  const { facing } = scene;
  const key = [
    tileIdx(feet.tx, feet.ty),
    facing.x,
    facing.y,
    scene.day,
    isLate(scene),
    scene.canCharge,
    store.energy,
    scene.world.objects.length,
    scene.world.crops.size,
    store.inv.count((it) => it.kind !== "tool"),
    workScore(store.work),
  ].join(":");
  if (planned?.key !== key) {
    const plots = countPlots(scene.world);
    planned = { key, plans: planChores(scene, plots), plots };
  }
  return planned;
};

/** Steering deadzone: a walking frame covers ~1–2 px, so closer than this is "on the waypoint". */
const ARRIVED_PX = 1.5;
/** How far past mid-cell, towards the target, a turn may still start from. */
const TURN_ROOM_PX = 2;

const liveChore = (scene: GameScene, plan: Plan | null): Chore | null => {
  if (!plan) {
    return null;
  }
  const feet = scene.feetTile();
  const base = { dx: plan.tx - feet.tx, dy: plan.ty - feet.ty, steps: plan.steps };
  if (plan.there && !plan.standOn) {
    if (scene.facing.x === base.dx && scene.facing.y === base.dy) {
      return { ...base, facing: true, stepX: 0, stepY: 0 };
    }
    // Turning means walking a frame or two towards the target, and farmland
    // is walkable: from the near edge that crosses onto it and the target
    // becomes the tile behind. Back off to mid-cell first, then turn.
    const lean =
      (scene.player.x - (feet.tx * TILE + TILE / 2)) * base.dx +
      (scene.player.y - (feet.ty * TILE + TILE / 2 + 1)) * base.dy;
    const turn = lean > TURN_ROOM_PX ? -1 : 1;
    return {
      ...base,
      facing: false,
      stepX: sign(base.dx * turn),
      stepY: sign(base.dy * turn),
    };
  }
  // Waypoints sit where click-to-move puts them: the cell's centre, a pixel low.
  const vx = plan.nx * TILE + TILE / 2 - scene.player.x;
  const vy = plan.ny * TILE + TILE / 2 + 1 - scene.player.y;
  const stepX = Math.abs(vx) > ARRIVED_PX ? sign(vx) : 0;
  const stepY = Math.abs(vy) > ARRIVED_PX ? sign(vy) : 0;
  // A pickup only fires while walking; dead-centre on it still needs a nudge.
  return { ...base, facing: false, stepX: stepX === 0 && stepY === 0 ? 1 : stepX, stepY };
};

const farmView = (scene: GameScene, modal: boolean, sleepPrompt: boolean): FarmView => {
  const feet = scene.feetTile();
  const { plans, plots } = plansFor(scene);
  const season = scene.season();
  return {
    busy: scene.acting || scene.uiOpen || scene.transitioning || scene.controlsPaused,
    chores: {
      chop: liveChore(scene, plans.chop),
      forage: liveChore(scene, plans.forage),
      harvest: liveChore(scene, plans.harvest),
      plant: liveChore(scene, plans.plant),
      refill: liveChore(scene, plans.refill),
      ship: liveChore(scene, plans.ship),
      sleep: liveChore(scene, plans.sleep),
      till: liveChore(scene, plans.till),
      water: liveChore(scene, plans.water),
    },
    clock: clockText(scene.timeMin),
    day: scene.day,
    energy: store.energy,
    facing: facingName(scene.facing),
    gold: store.gold,
    goods: store.inv.count((it) => it.kind !== "tool" && it.kind !== "seed"),
    held: heldName(store.inv.selectedItem()),
    minutesToPassOut: Math.round(DAY_END_MIN - scene.timeMin),
    modal,
    plots,
    seeds: store.inv.count((it) => it.kind === "seed"),
    sleepPrompt,
    slot: store.inv.selected + 1,
    slots: {
      axe: toolSlot("axe"),
      can: toolSlot("can"),
      hoe: toolSlot("hoe"),
      seeds: slotOf((it) => it.kind === "seed" && CROPS[it.crop].seasons.includes(season)),
    },
    tile: { x: feet.tx, y: feet.ty },
    water: scene.canCharge,
    weather: scene.weather,
    work: store.work,
  };
};

export const readDiagnostics = (game: Game): FarmDiagnostics => {
  const scene = game.scene
    .getScenes(true)
    .find((s) => s instanceof GameScene || s instanceof MineScene);
  const base = { complete: false, frame: game.loop.frame, score: workScore(store.work) };
  if (scene instanceof GameScene) {
    const hud = game.scene.getScene("Hud");
    const prompt = hud instanceof HudScene ? hud.openModal : null;
    const modal = prompt !== null || game.scene.isActive("Inventory");
    return {
      ...base,
      entities: scene.world.objects.length,
      phase: "farm",
      player: { x: scene.player.x, y: scene.player.y },
      ...farmView(scene, modal, prompt === "sleep"),
    };
  }
  if (scene instanceof MineScene) {
    return { ...base, phase: "mine", player: { x: scene.player.x, y: scene.player.y } };
  }
  return { ...base, phase: "menu" };
};

const NO_INPUT = { keys: [] };
/** Walk-only below this many tiles: a sprint overshoots the cell it has to stop in. */
const RUN_BEYOND_STEPS = 3;

/**
 * A chore as one held intent: pick the tool, walk the route, turn to the tile,
 * use the tool — then on to the next nearest, for as long as the model keeps
 * choosing it. Facing is tile-exact and the action key is edge-triggered, so
 * none of it survives a decision's latency; which chore is worth doing next is
 * the judgment left to the model. A modal in the way is backed out of, bar
 * the one this chore came for: `confirms` answers the bed's prompt with the
 * same action key that raised it.
 */
const choreReflex = (
  id: ChoreId,
  needs: HeldSlot | null,
  confirms: "sleepPrompt" | null = null,
): Reflex<FarmDiagnostics> => {
  const tap = keyTapper({ downFrames: 3, upFrames: 6 });
  return (diag) => {
    if (diag?.modal) {
      return { keys: tap([confirms && diag[confirms] ? "Space" : "Escape"]) };
    }
    const chore = diag?.chores?.[id];
    if (!diag || !chore || diag.busy) {
      tap([]);
      return NO_INPUT;
    }
    const slot = needs ? diag.slots?.[needs] : undefined;
    if (slot !== undefined && slot !== diag.slot) {
      tap([]);
      return { keys: [`Digit${slot % 10}`] };
    }
    if (chore.facing) {
      return { keys: tap(["Space"]) };
    }
    tap([]);
    const keys: string[] = [];
    if (chore.stepX !== 0) {
      keys.push(chore.stepX < 0 ? "ArrowLeft" : "ArrowRight");
    }
    if (chore.stepY !== 0) {
      keys.push(chore.stepY < 0 ? "ArrowUp" : "ArrowDown");
    }
    if (chore.steps > RUN_BEYOND_STEPS) {
      keys.push("ShiftLeft");
    }
    return { keys };
  };
};

export const farmManifest: PlaytestManifest<FarmDiagnostics> = {
  goal: [
    "You are a farmer on a new farm with a hoe, a watering can, an axe and parsnip seeds. Nothing kills you and nothing wins; game.score counts finished work and only goes up: +1 for each tile tilled, each seed planted and each crop watered, +2 per mushroom foraged, +3 per tree felled, +5 per ripe crop harvested, plus every gold coin earned at the shipping bin.",
    "Each move is a whole chore: choose it and the farmer walks to the nearest place for it, faces the tile and uses the right tool, then carries on to the next one for as long as you keep choosing it. A swing takes about a second, so a chore needs several decisions in a row to score — keep choosing it.",
    "game.plots counts farmland: empty (tilled, no seed), dry (seeded, not watered), growing, ripe. Crops grow one stage per night and only if they were watered that day, so a harvest takes several days: farm, sleep, water again. Choose by this priority, top first: (1) `harvest` if plots.ripe > 0. (2) `water` if plots.dry > 0. (3) `plant` if plots.empty > 0 and game.seeds > 0. (4) `till` if game.seeds > 0 and game.energy > 0. (5) `ship` if game.goods > 0. (6) `sleep` if game.chores.sleep is not null — the day's farming is done, it is late, or game.energy has run out; sleeping starts the next day with full energy and a full can. (7) otherwise `forage` or `chop`, whichever has the smaller game.chores.<move>.steps.",
    "game.chores.<move> is that chore's nearest target: dx/dy in tiles from the farmer, steps the walking distance. It is null when the chore is impossible right now (nothing to do it on, no seeds, no energy, empty can) — NEVER choose a move whose game.chores entry is null, the farmer would stand still.",
    "till, water and chop cost 2 game.energy a swing; plant, harvest, forage, ship and sleep are free. `ship` sells the crops, wood and mushrooms in the bag; tools and seeds stay. `refill` only when game.water is 0. At game.minutesToPassOut 0 the farmer collapses and wakes with half energy, so sleep before then.",
  ].join(" "),
  move: {
    chop: {
      description:
        "Chop the nearest tree with the axe (3 swings fell it, +3). Only when there is no farming left (game.seeds is 0, plots.dry is 0) and game.chores.chop is not null",
      reflex: choreReflex("chop", "axe"),
    },
    forage: {
      description:
        "Walk to the nearest wild mushroom and pick it up (+2, but usually a long walk: game.chores.forage.steps). Only when there is no farming left (game.seeds is 0, plots.dry is 0) and game.chores.forage is not null",
      reflex: choreReflex("forage", null),
    },
    harvest: {
      description: "Harvest the nearest ripe crop (+5 each). Whenever game.plots.ripe is above 0",
      reflex: choreReflex("harvest", null),
    },
    plant: {
      description:
        "Plant a seed in tilled, empty soil (+1). Whenever game.plots.empty is above 0 and game.seeds is above 0, unless a crop is dry",
      reflex: choreReflex("plant", "seeds"),
    },
    refill: {
      description:
        "Refill the watering can at the nearest water. Only when game.water is 0 (game.chores.refill is not null)",
      reflex: choreReflex("refill", "can"),
    },
    ship: {
      description:
        "Carry the bag to the shipping bin and sell its crops, wood and mushrooms for gold (seeds and tools are kept). Whenever game.goods is above 0 and no crop needs harvesting, watering or planting",
      reflex: choreReflex("ship", null),
    },
    sleep: {
      description:
        "Walk home, go to bed and confirm: ends the day, grows every watered crop a stage, refills energy and the can. Whenever game.chores.sleep is not null and no crop needs harvesting, watering or planting — it is the only way to reach the next day",
      reflex: choreReflex("sleep", null, "sleepPrompt"),
    },
    till: {
      description:
        "Hoe fresh grass into farmland (+1 per tile). The default chore: whenever game.plots.empty is 0, game.plots.dry is 0 and game.seeds is above 0",
      reflex: choreReflex("till", "hoe"),
    },
    water: {
      description:
        "Water a planted crop that is still dry (+1). Top priority whenever game.plots.dry is above 0",
      reflex: choreReflex("water", "can"),
    },
  },
};
