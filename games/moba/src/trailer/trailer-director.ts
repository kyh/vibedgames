import type { Game } from "phaser";
import { Math as PhaserMath, Scene } from "phaser";

import { SIM_DT, abilityRankCap } from "../data/config";
import type { CreepKind, Team } from "../data/config";
import type { AbilityKey } from "../data/heroes";
import { NEUTRAL_CAMPS, WORLD } from "../data/map";
import type { LaneId } from "../data/map";
import { activateItem, castAbility } from "../sim/abilities";
import { dealDamage, updateStructureGating } from "../sim/combat";
import { recomputeHeroStats } from "../sim/herokit";
import { addStatus } from "../sim/stats";
import {
  buyItem,
  createWorld,
  dashHero,
  issueOrder,
  spawnCreepAt,
  spawnHero,
  step,
} from "../sim/world";
import type { Unit, World } from "../sim/types";
import { resetSound, resumeAudio, setMutedTransient, sfx } from "../render/audio";
import { WorldView } from "../render/view";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";

const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

interface CamPose {
  x: number;
  y: number;
  z: number;
}

type Ease = (k: number) => number;

const easeInOut: Ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOut: Ease = (k) => 1 - (1 - k) ** 3;

interface CamMove {
  from: CamPose;
  to: CamPose;
  dur: number;
  t: number;
  ease: Ease;
}

const clampAxis = (v: number, half: number, max: number) =>
  half * 2 >= max ? max / 2 : PhaserMath.Clamp(v, half, max - half);

type CamFollow =
  | { kind: "none" }
  | { kind: "unit"; id: string; k: number }
  | { kind: "fireball"; k: number; lastX: number; lastY: number };

interface Cue {
  at: number;
  fn: () => void;
  fired?: boolean;
}

interface SceneScript {
  cues?: Cue[];
  frame?: (t: number, dt: number) => void;
  done?: () => void;
}

interface HeroOpts {
  level?: number;
  bot?: boolean;
  hpFrac?: number;
  facing?: 1 | -1;
  slot?: number;
  items?: string[];
  xp?: number;
}

const heroAt: (
  w: World,
  defId: string,
  team: Team,
  tag: string,
  x: number,
  y: number,
  o?: HeroOpts,
) => Unit = (w, defId, team, tag, x, y, o = {}) => {
  const u = spawnHero(w, defId, team, tag, o.bot ?? false, o.slot ?? 0);
  const h = u.hero;

  if (h) {
    const level = o.level ?? 16;
    h.level = level;
    h.xp = o.xp ?? 0;
    h.abilityPoints = 0;

    for (const k of ABILITY_KEYS) {
      h.abilities[k].rank = abilityRankCap(k, level);
    }

    if (o.items && o.items.length > 0) {
      h.gold = 20_000;

      for (const id of o.items) {
        buyItem(w, u, id);
      }
    }

    h.gold = 0;
    recomputeHeroStats(u);
    u.hp = u.maxHp;
    u.mp = u.maxMp;

    if (o.hpFrac !== undefined) {
      u.hp = Math.max(1, u.maxHp * o.hpFrac);
    }
  }

  u.x = x;
  u.y = y;
  u.facing = o.facing ?? (team === "radiant" ? 1 : -1);
  u.order = { type: "hold" };

  return u;
};

const creepPack: (
  w: World,
  team: Team,
  lane: LaneId,
  kinds: CreepKind[],
  x: number,
  y: number,
  spreadY?: number,
) => Unit[] = (w, team, lane, kinds, x, y, spreadY = 56) =>
  kinds.map((k, i) =>
    spawnCreepAt(w, team, lane, k, x + (i % 2) * 34, y + (i - (kinds.length - 1) / 2) * spreadY),
  );

const openCamp = (w: World, campId: string) => {
  w.campRespawnAt[campId] = 0;
};

const campUnits = (w: World, campId: string) => {
  const out: Unit[] = [];

  for (const u of w.units.values()) {
    if (u.creep?.camp === campId && u.alive) {
      out.push(u);
    }
  }

  return out;
};

const weakest = (units: Unit[]) => {
  let best: Unit | undefined;

  for (const u of units) {
    if (!u.alive) {
      continue;
    }

    if (!best || u.hp < best.hp) {
      best = u;
    }
  }

  return best;
};

const finish = (w: World, attacker: Unit, victim: Unit | undefined, crit = false) => {
  if (!victim || !victim.alive) {
    return;
  }

  const deaths = victim.hero?.deaths ?? -1;

  for (let raw = 9999; raw < 1e7; raw *= 8) {
    dealDamage(w, attacker, victim, raw, "physical", { crit });

    if (!victim.alive) {
      return;
    }

    if (victim.hero && victim.hero.deaths !== deaths) {
      return;
    }
  }
};

const forceCast = (
  w: World,
  u: Unit,
  key: AbilityKey,
  aim: { point?: { x: number; y: number }; targetId?: string } = {},
) => {
  const h = u.hero;

  if (!h || !u.alive) {
    return;
  }

  u.mp = u.maxMp;
  h.abilities[key].readyAt = 0;
  castAbility(w, u, { key, point: aim.point, targetId: aim.targetId });
};

const retireStructure = (w: World, id: string) => {
  const u = w.units.get(id);

  if (!u || u.kind !== "structure") {
    return;
  }

  u.alive = false;
  u.hp = 0;
  updateStructureGating(w);
};

const scene: (
  stage: TrailerStage,
  id: string,
  duration: number,
  build: (s: TrailerStage) => SceneScript,
) => TrailerScene = (stage, id, duration, build) => {
  let cues: Cue[] = [];
  let frame: SceneScript["frame"];
  let done: SceneScript["done"];

  return {
    duration,
    id,
    run: (t, dt) => {
      stage.hold = false;

      for (const c of cues) {
        if (c.fired !== true && t >= c.at) {
          c.fired = true;
          c.fn();
        }
      }

      frame?.(t, dt);
    },
    setup: () => {
      const r = build(stage);
      cues = r.cues ?? [];
      ({ done, frame } = r);
      stage.hold = true;
    },
    teardown: () => {
      done?.();
      stage.worldView.setTarget("");
    },
  };
};

const buildConfig = (stage: TrailerStage) => {
  const scenes: TrailerScene[] = [
    scene(stage, "roster-6", 1500, (s) => {
      const w = s.installWorld(26);
      const ember = heroAt(w, "emberhex", "radiant", "r6", 1950, 1468);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "melee", "siege"], 2140, 1500, 46);
      s.worldView.playerHeroId = ember.id;
      s.pump(0.25);
      forceCast(w, ember, "R", { point: { x: 2060, y: 1500 } });
      s.pump(0.2);
      s.cut(2040, 1494, s.zb(2.3));
      s.glide(2058, 1500, s.zb(2.55), 1500, easeOut);

      return {};
    }),

    scene(stage, "cold-open-skirmish", 3400, (s) => {
      const w = s.installWorld(11);
      const dusk = heroAt(w, "duskblade", "radiant", "co-dusk", 1660, 640, { level: 9 });
      const storm = heroAt(w, "stormcaller", "radiant", "co-storm", 1560, 570, { level: 9 });
      const iron = heroAt(w, "ironvow", "dire", "co-iron", 1830, 620, { hpFrac: 0.4, level: 9 });

      const ember = heroAt(w, "emberhex", "dire", "co-ember", 1930, 545, {
        hpFrac: 0.85,
        level: 9,
      });

      creepPack(
        w,
        "radiant",
        "top",
        ["melee", "melee", "melee", "ranged", "ranged"],
        1740,
        686,
        44,
      );
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "ranged", "ranged"], 1876, 662, 44);
      issueOrder(w, dusk, { targetId: iron.id, type: "attackUnit" });
      issueOrder(w, storm, { targetId: ember.id, type: "attackUnit" });
      issueOrder(w, iron, { targetId: dusk.id, type: "attackUnit" });
      issueOrder(w, ember, { targetId: storm.id, type: "attackUnit" });
      s.worldView.playerHeroId = dusk.id;
      s.pump(1.2);
      s.cut(1810, 608, s.zb(1.9));
      s.glide(1870, 612, s.zb(2.15), 3400, easeInOut);

      return {
        cues: [
          {
            at: 300,
            fn: () => {
              forceCast(w, storm, "Q", { point: { x: 2150, y: 620 } });
            },
          },
          {
            at: 800,
            fn: () => {
              forceCast(w, ember, "Q", { point: { x: dusk.x, y: dusk.y } });
            },
          },
          {
            at: 1250,
            fn: () => {
              forceCast(w, dusk, "Q", { point: { x: ember.x, y: ember.y } });
              issueOrder(w, dusk, { targetId: ember.id, type: "attackUnit" });
            },
          },
          {
            at: 1600,
            fn: () => {
              forceCast(w, iron, "Q", { targetId: dusk.id });
            },
          },
          { at: 1900, fn: () => (iron.hp = Math.min(iron.hp, 55)) },
          {
            at: 2400,
            fn: () => {
              finish(w, dusk, w.units.get(iron.id));
            },
          },
        ],
      };
    }),

    scene(stage, "map-reveal", 1800, (s) => {
      const w = s.installWorld(12);
      const wave: CreepKind[] = ["melee", "melee", "melee", "melee", "ranged", "ranged"];
      creepPack(w, "radiant", "top", wave, 1760, 578, 30);
      creepPack(w, "dire", "top", wave, 2340, 578, 30);
      creepPack(w, "radiant", "bottom", wave, 1900, 2528, 30);
      creepPack(w, "dire", "bottom", wave, 2200, 2528, 30);
      const mid: CreepKind[] = ["melee", "melee", "ranged"];
      creepPack(w, "radiant", "top", mid, 1680, 1520, 34);
      creepPack(w, "dire", "top", mid, 1820, 1520, 34);
      creepPack(w, "dire", "bottom", mid, 2400, 1520, 34);
      creepPack(w, "radiant", "bottom", mid, 2260, 1520, 34);

      for (const c of NEUTRAL_CAMPS) {
        openCamp(w, c.id);
      }

      s.pump(1.6);
      s.cut(2050, 578, s.zb(1.6));
      s.glide(WORLD.width / 2, WORLD.height / 2, s.zMap() * 1.12, 1700, easeInOut);

      return {};
    }),

    scene(stage, "the-run", 1600, (s) => {
      const w = s.installWorld(45);

      const storm = heroAt(w, "stormcaller", "radiant", "run", 2700, 2496, {
        items: ["boots", "scepter"],
        level: 10,
      });

      const hunter = heroAt(w, "duskblade", "dire", "run-d1", 2905, 2452, {
        facing: -1,
        level: 12,
      });

      const caster = heroAt(w, "emberhex", "dire", "run-d2", 2950, 2548, {
        facing: -1,
        level: 12,
      });

      creepPack(
        w,
        "radiant",
        "bottom",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        1470,
        2500,
        40,
      );
      issueOrder(w, storm, { to: { x: 1450, y: 2500 }, type: "move" });

      for (const d of [hunter, caster]) {
        issueOrder(w, d, { targetId: storm.id, type: "attackUnit" });
      }

      for (const c of creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "ranged"],
        3040,
        2496,
        44,
      )) {
        issueOrder(w, c, { targetId: storm.id, type: "attackUnit" });
      }

      s.worldView.playerHeroId = storm.id;
      s.pump(0.3);
      s.cut(2600, 2466, s.zb(2.2));
      s.followUnit(storm.id, 3.4);

      return {
        cues: [
          {
            at: 120,
            fn: () => {
              dashHero(w, storm, -1, 0.02);
            },
          },
          {
            at: 220,
            fn: () => {
              forceCast(w, caster, "Q", { point: { x: storm.x - 40, y: storm.y } });
            },
          },
          {
            at: 950,
            fn: () => {
              activateItem(w, storm, "scepter", { x: storm.x - 620, y: storm.y + 10 });
              s.followUnit(storm.id, 6);
            },
          },
          {
            at: 1050,
            fn: () => {
              issueOrder(w, storm, { to: { x: 2050, y: 2500 }, type: "attackMove" });
            },
          },
        ],
      };
    }),

    scene(stage, "the-lane", 2600, (s) => {
      const w = s.installWorld(46);
      const ours: CreepKind[] = ["melee", "melee", "melee", "melee", "ranged", "ranged", "siege"];
      const mine = creepPack(w, "radiant", "top", ours, 2190, 575, 40);

      const theirs = creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        2340,
        575,
        40,
      );

      const storm = heroAt(w, "stormcaller", "radiant", "lane", 2120, 632, { level: 5, xp: 2390 });

      const foe = heroAt(w, "duskblade", "dire", "lane-foe", 2440, 618, {
        facing: -1,
        hpFrac: 0.75,
        level: 5,
      });

      issueOrder(w, storm, { to: { x: 2270, y: 600 }, type: "attackMove" });
      const [head] = mine;

      if (head) {
        issueOrder(w, foe, { targetId: head.id, type: "attackUnit" });
      }

      s.worldView.playerHeroId = storm.id;
      s.pump(1.4);
      s.cut(2225, 552, s.zb(1.6));
      s.glide(2295, 548, s.zb(1.78), 2600, easeInOut);

      return {
        cues: [
          {
            at: 400,
            fn: () => {
              forceCast(w, storm, "W", { targetId: foe.id });
            },
          },
          {
            at: 800,
            fn: () => {
              finish(w, storm, weakest(theirs));
            },
          },
          {
            at: 1500,
            fn: () => {
              finish(w, storm, weakest(theirs));
            },
          },
          {
            at: 2100,
            fn: () => {
              finish(w, storm, weakest(theirs));
            },
          },
        ],
      };
    }),

    scene(stage, "roster-4", 1400, (s) => {
      const w = s.installWorld(24);
      const storm = heroAt(w, "stormcaller", "radiant", "r4", 772, 1620);

      const line = creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "ranged", "melee", "ranged", "melee", "melee"],
        1060,
        1620,
        0,
      );

      for (const [i, c] of line.entries()) {
        c.x = 980 + i * 30;
        c.y = 1620 + (i % 2) * 14;
        c.order = { type: "hold" };
      }

      s.worldView.playerHeroId = storm.id;
      s.pump(0.3);
      s.cut(826, 1704, s.zb(2.15));
      s.glide(830, 1712, s.zb(2.25), 1400, easeOut);

      return {
        cues: [
          {
            at: 450,
            fn: () => {
              forceCast(w, storm, "Q", { point: { x: 1440, y: 1624 } });
            },
          },
        ],
      };
    }),

    scene(stage, "roster-3", 950, (s) => {
      const w = s.installWorld(23);
      const dusk = heroAt(w, "duskblade", "radiant", "r3", 1730, 1540);

      const vic = heroAt(w, "stormcaller", "dire", "r3v", 1852, 1534, {
        facing: -1,
        hpFrac: 0.3,
        level: 9,
      });

      for (const c of creepPack(w, "dire", "top", ["melee", "ranged"], 1900, 1536, 44)) {
        issueOrder(w, c, { targetId: dusk.id, type: "attackUnit" });
      }

      s.worldView.playerHeroId = dusk.id;
      s.pump(0.3);
      s.cut(1756, 1532, s.zb(2.38));
      s.glide(1770, 1536, s.zb(2.5), 950, easeOut);

      return {
        cues: [
          {
            at: 220,
            fn: () => {
              forceCast(w, dusk, "R", { targetId: vic.id });
            },
          },
          {
            at: 520,
            fn: () => {
              finish(w, dusk, w.units.get(vic.id), true);
            },
          },
        ],
      };
    }),

    scene(stage, "signature-solo", 2000, (s) => {
      const w = s.installWorld(13);
      openCamp(w, "camp-lb");
      const solo = heroAt(w, "boomtinker", "radiant", "solo", 1190, 2075, { level: 6 });
      s.pump(0.4);
      const gnoll = campUnits(w, "camp-lb").find((u) => u.maxHp >= 700);

      if (gnoll) {
        s.worldView.setTarget(gnoll.id);
      }

      s.worldView.playerHeroId = solo.id;
      s.cut(1212, 1974, s.zb(2.6));
      s.glide(1216, 1996, s.zb(2.85), 2000, easeInOut);

      return {
        cues: [
          {
            at: 120,
            fn: () => {
              forceCast(w, solo, "W", { point: { x: 1190, y: 2028 } });
            },
          },
          {
            at: 200,
            fn: () => {
              forceCast(w, solo, "W", { point: { x: 1262, y: 2016 } });
            },
          },
          {
            at: 280,
            fn: () => {
              forceCast(w, solo, "W", { point: { x: 1126, y: 2016 } });
            },
          },
          {
            at: 600,
            fn: () => {
              forceCast(w, solo, "E");

              if (gnoll?.alive === true) {
                issueOrder(w, solo, { targetId: gnoll.id, type: "attackUnit" });
              }
            },
          },
          {
            at: 1000,
            fn: () => {
              forceCast(w, solo, "Q", { point: { x: gnoll?.x ?? 1216, y: gnoll?.y ?? 2100 } });
            },
          },
        ],
      };
    }),

    scene(stage, "lane-push", 4000, (s) => {
      const w = s.installWorld(31);
      const tower = w.units.get("d-top-t1");

      if (tower) {
        tower.hp = tower.maxHp * 0.3;
      }

      creepPack(
        w,
        "radiant",
        "top",
        ["melee", "melee", "melee", "melee", "ranged", "ranged", "siege"],
        2200,
        555,
        44,
      );
      creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        2350,
        555,
        44,
      );
      s.pump(1.1);
      const storm = heroAt(w, "stormcaller", "radiant", "push", 2030, 570);
      issueOrder(w, storm, { to: { x: 2310, y: 545 }, type: "move" });
      s.worldView.playerHeroId = storm.id;
      s.cut(2270, 512, s.zb(1.55));
      s.glide(2410, 478, s.zb(1.9), 3800, easeInOut);

      return {
        cues: [
          {
            at: 120,
            fn: () => {
              forceCast(w, storm, "E");
            },
          },
          {
            at: 700,
            fn: () => {
              forceCast(w, storm, "R", { point: { x: 2330, y: 552 } });
            },
          },
          {
            at: 3100,
            fn: () => {
              finish(w, storm, w.units.get("d-top-t1"));
            },
          },
        ],
      };
    }),

    scene(stage, "elevation-ambush", 2200, (s) => {
      const w = s.installWorld(32);
      const dusk = heroAt(w, "duskblade", "radiant", "amb", 1300, 1200);
      const vic = heroAt(w, "emberhex", "dire", "ambv", 1580, 1440, { hpFrac: 0.5, level: 9 });
      creepPack(w, "dire", "top", ["melee", "melee"], 1520, 1512, 50);
      creepPack(w, "radiant", "top", ["melee", "melee"], 1636, 1540, 50);
      issueOrder(w, dusk, { to: { x: 1448, y: 1290 }, type: "move" });
      s.worldView.playerHeroId = dusk.id;
      s.pump(0.2);
      s.cut(1580, 1360, s.zb(2.1));
      s.glide(1620, 1420, s.zb(2.25), 2200, easeInOut);

      return {
        cues: [
          {
            at: 900,
            fn: () => {
              forceCast(w, dusk, "Q", { point: { x: vic.x, y: vic.y } });

              if (vic.alive) {
                issueOrder(w, dusk, { targetId: vic.id, type: "attackUnit" });
              }
            },
          },
          {
            at: 1150,
            fn: () => {
              forceCast(w, dusk, "W", { point: { x: vic.x, y: vic.y } });
            },
          },
          {
            at: 1350,
            fn: () => {
              finish(w, dusk, w.units.get(vic.id), true);
            },
          },
        ],
      };
    }),

    scene(stage, "fireball-track", 1800, (s) => {
      const w = s.installWorld(33);
      const ember = heroAt(w, "emberhex", "radiant", "fb", 1520, 2428);

      const pack = creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "melee", "melee", "melee", "ranged", "ranged"],
        2280,
        2496,
        40,
      );

      const tail = creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "melee", "ranged", "ranged"],
        2680,
        2496,
        40,
      );

      s.worldView.playerHeroId = ember.id;
      s.pump(1);

      for (const c of pack) {
        c.hp = Math.min(c.hp, 150);
      }

      s.cut(1740, 2466, s.zb(1.6));

      return {
        cues: [
          {
            at: 180,
            fn: () => {
              const alive = pack.filter((c) => c.alive);
              const cx = alive.length ? alive.reduce((a, c) => a + c.x, 0) / alive.length : 2000;
              const cy = alive.length ? alive.reduce((a, c) => a + c.y, 0) / alive.length : 2496;
              let px = cx;

              for (let i = 0; i < 3; i += 1) {
                const flight = Math.max(0, (px - ember.x - 40) / 700);
                px = cx - 240 * flight;
              }

              forceCast(w, ember, "Q", { point: { x: px, y: cy } });
              s.followFireball(9);
            },
          },
          {
            at: 1050,
            fn: () => {
              const next = tail.find((c) => c.alive);

              if (!next) {
                return;
              }

              s.followUnit(next.id, 2.2);
              s.glide(next.x, next.y, s.zb(2.05), 700, easeOut);
            },
          },
        ],
      };
    }),

    scene(stage, "roshan", 2650, (s) => {
      const w = s.installWorld(41);
      const iron = heroAt(w, "ironvow", "radiant", "ro-iron", 1958, 1504, { hpFrac: 0.45 });
      const storm = heroAt(w, "stormcaller", "radiant", "ro-storm", 1862, 1430);
      const brew = heroAt(w, "brewkeeper", "radiant", "ro-brew", 1848, 1582);
      openCamp(w, "roshan");
      s.pump(0.1);
      const [boss] = campUnits(w, "roshan");

      if (boss) {
        for (const u of [iron, storm, brew]) {
          issueOrder(w, u, { targetId: boss.id, type: "attackUnit" });
        }

        s.worldView.setTarget(boss.id);
      }

      s.worldView.playerHeroId = storm.id;
      s.pump(0.7);
      s.cut(2005, 1500, s.zb(2.2));
      s.glide(2035, 1500, s.zb(2.5), 2550, easeInOut);

      return {
        cues: [
          {
            at: 400,
            fn: () => {
              forceCast(w, iron, "W");
            },
          },
          {
            at: 1100,
            fn: () => {
              forceCast(w, brew, "Q", { targetId: iron.id });
            },
          },
          {
            at: 2200,
            fn: () => {
              finish(w, storm, boss);
            },
          },
        ],
      };
    }),

    scene(stage, "unbreaking-vow", 2000, (s) => {
      const w = s.installWorld(44);
      const iron = heroAt(w, "ironvow", "radiant", "uv-iron", 1580, 2000);
      const ally = heroAt(w, "stormcaller", "radiant", "uv-ally", 1476, 2044, { hpFrac: 0.28 });

      const foes = [
        heroAt(w, "duskblade", "dire", "uv-d1", 1688, 1932, { facing: -1 }),
        heroAt(w, "emberhex", "dire", "uv-d2", 1698, 2060, { facing: -1 }),
        heroAt(w, "boomtinker", "dire", "uv-d3", 1576, 2140, { facing: -1 }),
      ];

      const kinds: CreepKind[] = ["melee", "melee", "melee", "melee", "ranged", "ranged"];
      const creeps = creepPack(w, "dire", "top", kinds, 1668, 2020, 36);

      for (const f of [...foes, ...creeps]) {
        issueOrder(w, f, { targetId: ally.id, type: "attackUnit" });
      }

      s.worldView.playerHeroId = iron.id;
      s.pump(0.5);
      s.cut(1584, 1994, s.zb(1.95));
      s.glide(1580, 1990, s.zb(2.05), 2000, easeOut);

      return {
        cues: [
          {
            at: 0,
            fn: () => {
              forceCast(w, iron, "W");
            },
          },
          {
            at: 380,
            fn: () => {
              forceCast(w, iron, "R");
            },
          },
        ],
      };
    }),

    scene(stage, "full-teamfight", 5000, (s) => {
      const w = s.installWorld(34);
      const iron = heroAt(w, "ironvow", "radiant", "tf-iron", 1955, 1490, { bot: true, slot: 0 });
      heroAt(w, "duskblade", "radiant", "tf-dusk", 1935, 1410, { bot: true, slot: 1 });

      const brew = heroAt(w, "brewkeeper", "radiant", "tf-brew", 1990, 1606, {
        bot: true,
        hpFrac: 0.45,
        slot: 2,
      });

      heroAt(w, "emberhex", "dire", "tf-ember", 2100, 1490, { bot: true, slot: 0 });
      heroAt(w, "stormcaller", "dire", "tf-storm", 2118, 1408, { bot: true, slot: 1 });
      heroAt(w, "boomtinker", "dire", "tf-boom", 2106, 1596, { bot: true, slot: 2 });
      creepPack(w, "radiant", "top", ["melee", "melee", "melee", "melee"], 2008, 1500, 46);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "melee"], 2064, 1500, 46);
      addStatus(iron, { kind: "aegis", until: w.now + 300_000 });
      s.worldView.playerHeroId = iron.id;
      s.pump(0.55);
      s.cut(2030, 1495, s.zb(1.55));
      s.glide(2030, 1495, s.zb(1.9), 3400, easeInOut);
      let sweepAt = 0;

      return {
        cues: [
          {
            at: 2400,
            fn: () => {
              const b = w.units.get(brew.id);

              if (!b || !b.alive) {
                return;
              }

              let killer: Unit | undefined;
              let bd = Infinity;

              for (const e of w.units.values()) {
                if (e.kind !== "hero" || e.team !== "dire" || !e.alive) {
                  continue;
                }

                const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;

                if (d < bd) {
                  bd = d;
                  killer = e;
                }
              }

              if (killer) {
                finish(w, killer, b);
              }
            },
          },
          {
            at: 3500,
            fn: () => {
              const i = w.units.get(iron.id);
              let killer: Unit | undefined;
              let bd = Infinity;

              for (const e of w.units.values()) {
                if (e.kind !== "hero" || e.team !== "dire" || !e.alive || !i) {
                  continue;
                }

                const d = (e.x - i.x) ** 2 + (e.y - i.y) ** 2;

                if (d < bd) {
                  bd = d;
                  killer = e;
                }
              }

              if (killer) {
                finish(w, killer, i);
              }
            },
          },
          {
            at: 3600,
            fn: () => {
              s.glide(2040, 1500, s.zb(2.15), 900, easeOut);
            },
          },
        ],
        frame: (t) => {
          if (t < sweepAt) {
            return;
          }

          sweepAt = t + 400;

          for (const u of w.units.values()) {
            if (u.kind !== "hero" || u.hero?.isBot !== true || !u.alive) {
              continue;
            }

            u.hero.botRetreating = false;
            u.mp = u.maxMp;

            if (u.order.type === "fountain") {
              let foe: Unit | undefined;
              let bd = Infinity;

              for (const e of w.units.values()) {
                if (e.kind !== "hero" || e.team === u.team || !e.alive) {
                  continue;
                }

                const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;

                if (d < bd) {
                  bd = d;
                  foe = e;
                }
              }

              if (foe) {
                issueOrder(w, u, { targetId: foe.id, type: "attackUnit" });
              }
            }
          }
        },
      };
    }),

    scene(stage, "last-call", 2800, (s) => {
      const w = s.installWorld(42);
      const brew = heroAt(w, "brewkeeper", "radiant", "lc-brew", 1810, 2500);
      const iron = heroAt(w, "ironvow", "radiant", "lc-iron", 1762, 2548, { hpFrac: 0.16 });
      const dusk = heroAt(w, "duskblade", "radiant", "lc-dusk", 1884, 2552, { hpFrac: 0.2 });
      const ember = heroAt(w, "emberhex", "dire", "lc-ember", 2090, 2440, { facing: -1 });

      const pack = creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        1996,
        2496,
        24,
      );

      for (const c of pack) {
        issueOrder(w, c, { targetId: iron.id, type: "attackUnit" });
      }

      issueOrder(w, ember, { targetId: dusk.id, type: "attackUnit" });
      forceCast(w, ember, "W", { point: { x: 1810, y: 2540 } });
      s.worldView.playerHeroId = brew.id;
      s.pump(0.45);
      s.cut(1842, 2524, s.zb(1.85));

      return {
        cues: [
          {
            at: 150,
            fn: () => {
              forceCast(w, brew, "R", { point: { x: brew.x, y: brew.y } });
            },
          },
          {
            at: 700,
            fn: () => {
              forceCast(w, brew, "E");
            },
          },
          {
            at: 1400,
            fn: () => {
              forceCast(w, brew, "Q", { targetId: iron.id });
            },
          },
          {
            at: 1700,
            fn: () => {
              s.glide(1832, 2530, s.zb(1.95), 1000, easeOut);
            },
          },
        ],
      };
    }),

    scene(stage, "ult-payoff", 1400, (s) => {
      const w = s.installWorld(35);
      const boom = heroAt(w, "boomtinker", "radiant", "ult", 2748, 1444);

      const mark = heroAt(w, "duskblade", "dire", "ult-mark", 2536, 1442, {
        facing: -1,
        hpFrac: 0.5,
        level: 12,
      });

      const packDire = creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "siege", "melee", "ranged"],
        2548,
        1440,
        48,
      );

      const siege = packDire.at(2);
      creepPack(w, "radiant", "top", ["melee", "melee", "ranged"], 2716, 1508, 46);
      s.worldView.playerHeroId = boom.id;
      s.pump(0.6);
      s.cut(2680, 1442, s.zb(1.9));

      return {
        cues: [
          {
            at: 480,
            fn: () => {
              forceCast(w, boom, "R", { point: { x: 2552, y: 1440 } });
              s.flash(150);
              s.glide(2560, 1430, s.zb(2.75), 260, easeOut);
            },
          },
          {
            at: 760,
            fn: () => {
              finish(w, boom, w.units.get(mark.id), true);
            },
          },
          {
            at: 1030,
            fn: () => {
              finish(w, boom, siege);
            },
          },
        ],
      };
    }),

    scene(stage, "victory", 2500, (s) => {
      const w = s.installWorld(36);
      retireStructure(w, "d-bot-t2");
      retireStructure(w, "d-base-1");
      const gate = w.units.get("d-base-2");

      if (gate) {
        gate.hp = gate.maxHp * 0.15;
      }

      const ancient = w.units.get("d-ancient");

      if (ancient) {
        ancient.hp = ancient.maxHp * 0.1;
      }

      const iron = heroAt(w, "ironvow", "radiant", "v-iron", 3210, 1730);
      const dusk = heroAt(w, "duskblade", "radiant", "v-dusk", 3238, 1668);
      const storm = heroAt(w, "stormcaller", "radiant", "v-storm", 3196, 1800);

      const dEmber = heroAt(w, "emberhex", "dire", "v-ember", 3400, 1580, {
        facing: -1,
        hpFrac: 0.4,
      });

      const dBoom = heroAt(w, "boomtinker", "dire", "v-boom", 3440, 1630, {
        facing: -1,
        hpFrac: 0.4,
      });

      creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "melee", "ranged", "ranged"],
        3410,
        1852,
        44,
      );

      for (const u of [iron, dusk, storm]) {
        issueOrder(w, u, { targetId: "d-base-2", type: "attackUnit" });
      }

      for (const d of [dEmber, dBoom]) {
        issueOrder(w, d, { targetId: iron.id, type: "attackUnit" });
      }

      s.worldView.playerHeroId = iron.id;
      s.pump(0.6);
      s.cut(3330, 1700, s.zb(1.7));
      s.glide(3410, 1648, s.zb(1.9), 2500, easeInOut);

      return {
        cues: [
          {
            at: 400,
            fn: () => {
              finish(w, iron, w.units.get("d-base-2"));
            },
          },
          {
            at: 520,
            fn: () => {
              for (const u of [iron, dusk, storm]) {
                issueOrder(w, u, { targetId: "d-ancient", type: "attackUnit" });
              }
            },
          },
          {
            at: 1900,
            fn: () => {
              finish(w, dusk, w.units.get("d-ancient"));
            },
          },
          {
            at: 1960,
            fn: () => {
              sfx.victory(true);
            },
          },
        ],
      };
    }),
  ];

  return {
    onGesture: () => {
      setMutedTransient(false);
      resumeAudio();
    },
    scenes,
  };
};

class TrailerStage extends Scene {
  private world!: World;
  private view!: WorldView;
  private acc = 0;
  private labelTimer = 0;
  private pose: CamPose = { x: WORLD.width / 2, y: WORLD.height / 2, z: 0.5 };
  private camMove: CamMove | null = null;
  private camFollow: CamFollow = { kind: "none" };
  hold = false;

  constructor() {
    super("TrailerStage");
  }

  create() {
    this.view = new WorldView(this);
    this.view.buildTerrain();
    this.view.buildStructures();
    const cam = this.cameras.main;
    cam.roundPixels = true;
    cam.setBackgroundColor("#0a0e16");

    this.installWorld(7);
    this.cut(WORLD.width / 2, WORLD.height / 2, this.zMap());

    setMutedTransient(true);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, resetSound);

    runTrailer(buildConfig(this));
  }

  installWorld(seed: number) {
    resetSound();
    const w = createWorld(seed);
    w.nextWaveAt = Number.POSITIVE_INFINITY;

    for (const c of NEUTRAL_CAMPS) {
      w.campRespawnAt[c.id] = Number.POSITIVE_INFINITY;
    }

    this.view.clearUnitViews();
    this.view.setTarget("");
    this.view.playerHeroId = "";
    this.view.playerTeam = "radiant";
    this.world = w;
    this.view.resetStructures(w);
    this.acc = 0;
    this.camMove = null;
    this.camFollow = { kind: "none" };

    return w;
  }

  get worldView() {
    return this.view;
  }

  pump(seconds: number) {
    const steps = Math.max(1, Math.round(seconds / SIM_DT));

    for (let i = 0; i < steps; i += 1) {
      step(this.world, SIM_DT);
    }
  }

  private stageSize() {
    const sw = Math.min(this.scale.width, (this.scale.height * 16) / 9);

    return { h: (sw * 9) / 16, w: sw };
  }
  zb(f = 1) {
    return PhaserMath.Clamp(this.stageSize().h / 900, 0.45, 1.35) * f;
  }
  zMap() {
    return this.stageSize().w / WORLD.width;
  }

  cut(x: number, y: number, z: number) {
    this.pose = { x, y, z };
    this.camMove = null;
    this.camFollow = { kind: "none" };
  }
  glide(x: number, y: number, z: number, durMs: number, ease: Ease = easeInOut) {
    this.camMove = { dur: durMs, ease, from: { ...this.pose }, t: 0, to: { x, y, z } };
  }
  followUnit(id: string, stiffness = 4) {
    this.camFollow = { id, k: stiffness, kind: "unit" };
  }
  followFireball(stiffness = 9) {
    this.camFollow = { k: stiffness, kind: "fireball", lastX: this.pose.x, lastY: this.pose.y };
  }
  flash(ms = 150) {
    this.cameras.main.flash(ms, 255, 244, 214);
  }

  private applyCamera(dt: number) {
    const m = this.camMove;

    if (m) {
      m.t += dt * 1000;
      const k = m.ease(Math.min(1, m.t / m.dur));
      this.pose = {
        x: PhaserMath.Linear(m.from.x, m.to.x, k),
        y: PhaserMath.Linear(m.from.y, m.to.y, k),
        z: PhaserMath.Linear(m.from.z, m.to.z, k),
      };

      if (m.t >= m.dur) {
        this.camMove = null;
      }
    }

    const f = this.camFollow;

    if (f.kind === "unit") {
      const u = this.world.units.get(f.id);

      if (u) {
        const k = 1 - Math.exp(-f.k * dt);
        this.pose.x += (u.x - this.pose.x) * k;
        this.pose.y += (u.y - 30 - this.pose.y) * k;
      }
    } else if (f.kind === "fireball") {
      for (const p of this.world.projectiles.values()) {
        if (p.kind === "fireball") {
          f.lastX = p.x;
          f.lastY = p.y;
          break;
        }
      }

      const k = 1 - Math.exp(-f.k * dt);
      this.pose.x += (f.lastX - this.pose.x) * k;
      this.pose.y += (f.lastY - this.pose.y) * k;
    }

    const cam = this.cameras.main;
    const { z } = this.pose;
    cam.setZoom(z);
    const { w: sw, h: sh } = this.stageSize();
    const cx = clampAxis(this.pose.x, sw / (2 * z), WORLD.width);
    const cy = clampAxis(this.pose.y, sh / (2 * z), WORLD.height);
    cam.setScroll(cx - cam.width / 2 + this.view.shakeX, cy - cam.height / 2 + this.view.shakeY);
    cam.setRotation(this.view.shakeRot);
  }

  override update(_t: number, deltaMs: number) {
    if (!this.world) {
      return;
    }

    const dt = Math.min(0.05, deltaMs / 1000);

    if (!this.hold) {
      this.acc += dt;
      let steps = 0;

      while (this.acc >= SIM_DT && steps < 5) {
        step(this.world, SIM_DT);
        this.acc -= SIM_DT;
        steps += 1;
      }
    }

    this.view.sync(this.world, dt);
    this.labelTimer += dt;

    if (this.labelTimer > 0.25) {
      this.labelTimer = 0;
      this.view.refreshLabels(this.world);
    }

    this.applyCamera(this.hold ? 0 : dt);
  }
}

/** Called from BootScene's ?trailer=1 branch (after assets + anims are ready). */
export const launchTrailer = (game: Game) => {
  game.scene.add("TrailerStage", TrailerStage, true);
};
