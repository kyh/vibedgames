import type Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { RELICS } from "../data/relics";
import { GameScene } from "../scenes/game-scene";
import type { TrailerInputs } from "../scenes/trailer-staging";
import type { InputState } from "../sys/input";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";

const FLOOR_Y = 304;
const BOSS_FLOOR_Y = 320;

const IDLE: InputState = {
  attackPressed: false,
  dashPressed: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  left: false,
  right: false,
  specialPressed: false,
  up: false,
};

const inp = (o: Partial<InputState> = {}) => ({ ...IDLE, ...o });
const solo: (p1: InputState) => TrailerInputs = (p1) => ({ p1, p2: null });

type Press = (key: string, cond: boolean) => boolean;

const presser: () => Press = () => {
  const done = new Set<string>();

  return (key, cond) => {
    if (!cond || done.has(key)) {
      return false;
    }

    done.add(key);

    return true;
  };
};

const repeater: (everyMs: number) => (t: number, cond: boolean) => boolean = (everyMs) => {
  let last = -1e9;

  return (t, cond) => {
    if (!cond || t - last < everyMs) {
      return false;
    }

    last = t;

    return true;
  };
};

const stallJumper: (everyMs?: number) => (t: number, x: number, closing: boolean) => boolean = (
  everyMs = 500,
) => {
  let lastX = Number.NaN;
  let movingSince = 0;
  let lastJump = -1e9;

  return (t, x, closing) => {
    const moved = Math.abs(x - lastX) > 0.5;
    lastX = x;

    if (moved || !closing) {
      movingSince = t;
    }

    if (t - movingSince < 120 || t - lastJump < everyMs) {
      return false;
    }

    lastJump = t;

    return true;
  };
};

const foeDx = (gs: GameScene) => {
  const w = gs.trailerWorld();
  let best = Infinity;

  for (const e of w.enemies) {
    if (e.body.dead) {
      continue;
    }

    const dx = e.body.x - w.p1.x;

    if (Math.abs(dx) < Math.abs(best)) {
      best = dx;
    }
  }

  return best;
};

const WIDE = 1;
const MED = 2;

const followCam = (gs: GameScene, offX = 0, offY = 0, zoom = MED) => {
  gs.trailerZoom(zoom);
  const cam = gs.cameras.main;
  cam.startFollow(gs.trailerWorld().p1.sprite, true, 0.22, 0.24);
  cam.setFollowOffset(offX / zoom, offY / zoom);
  cam.setDeadzone(36 / zoom, 28 / zoom);
};

const lockCam = (gs: GameScene, x: number, y: number, zoom = MED) => {
  gs.trailerZoom(zoom);
  const cam = gs.cameras.main;
  cam.stopFollow();
  cam.centerOn(x, y);
};

interface SceneBits {
  ticks?: number;
  script?: (t: number) => TrailerInputs;
  camera?: () => void;
  onReveal?: () => void;
  during?: (t: number) => void;
  cleanup?: () => void;
}

interface Beat {
  id: string;
  duration: number;
  build: (gs: GameScene) => SceneBits;
}

const toScene: (gs: GameScene, beat: Beat) => TrailerScene = (gs, beat) => {
  let bits: SceneBits = {};
  let revealed = false;
  const clock = { t: -1 };

  return {
    duration: beat.duration,
    id: beat.id,
    run: (t) => {
      clock.t = t;

      if (!revealed) {
        revealed = true;
        gs.trailerFreeze(0);
        bits.onReveal?.();
      }

      bits.during?.(t);
    },
    setup: () => {
      clock.t = -1;
      revealed = false;
      bits = beat.build(gs);
      const { script } = bits;
      gs.trailerSetInput(script ? () => script(clock.t) : null);

      if (bits.ticks !== undefined && bits.ticks !== 0) {
        gs.trailerTick(bits.ticks);
      }

      if (bits.camera) {
        bits.camera();
      } else {
        followCam(gs);
      }
    },
    teardown: () => {
      gs.trailerSetInput(null);
      gs.trailerFreeze(9999);
      bits.cleanup?.();
    },
  };
};

const coldOpen: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 1,
      fgTrees: false,
      hero: "axion",
      hud: { combo: true, hearts: true },
      mods: { dmg: 2 },
      noEnemies: true,
      playerAt: { x: 120, y: FLOOR_Y },
      room: "combat",
      seed: 101,
    });

    for (const x of [196, 250, 300, 352, 404, 452, 498, 544]) {
      gs.trailerSpawnEnemy("warrior", x, FLOOR_Y);
    }

    const press = presser();
    const swing = repeater(220);

    return {
      camera: () => {
        followCam(gs, -46, 6);
      },
      script: (t) =>
        solo(
          inp({
            attackPressed: swing(t, Math.abs(foeDx(gs)) < 30),
            dashPressed: press("d1", t >= 110) || press("d2", t >= 1300),
            right: true,
          }),
        ),
      ticks: 18,
    };
  },
  duration: 2400,
  id: "cold-open-combo",
};

type Spawn = readonly [name: "warrior" | "spearman" | "archer" | "bomber", x: number];

const stageRealm = (
  gs: GameScene,
  hero: "axion" | "reaper" | "riven" | "mooni" | "salamander",
  biome: number,
  seed: number,
  playerX: number,
  spawns: readonly Spawn[],
  hud: { banner?: boolean } = {},
) => {
  gs.trailerStage({
    biome,
    fgTrees: false,
    hero,
    hud,
    mods: { dmg: 2.5 },
    noEnemies: true,
    playerAt: { x: playerX, y: FLOOR_Y },
    room: "combat",
    seed,
  });

  for (const [name, x] of spawns) {
    gs.trailerSpawnEnemy(name, x, FLOOR_Y);
  }
};

const realmEmber: Beat = {
  build: (gs) => {
    stageRealm(gs, "salamander", 2, 104, 316, [
      ["bomber", 380],
      ["bomber", 404],
      ["bomber", 428],
    ]);
    const press = presser();

    return {
      camera: () => {
        followCam(gs, -30, 4);
      },
      script: (t) => {
        const casting = gs.trailerWorld().p1.body.specialActive;

        return solo(
          inp({
            dashPressed: press("d", t >= 200 && !casting),
            right: t >= 300 && !casting,
            specialPressed: press("wave", t >= 60),
          }),
        );
      },
      ticks: 16,
    };
  },
  duration: 1350,
  id: "realm-ember",
};

const realmFrost: Beat = {
  build: (gs) => {
    stageRealm(
      gs,
      "riven",
      3,
      105,
      612,
      [
        ["archer", 500],
        ["archer", 444],
        ["archer", 388],
      ],
      { banner: true },
    );
    const press = presser();
    const swing = repeater(220);

    return {
      camera: () => {
        followCam(gs, 50, 4);
      },
      onReveal: () => {
        gs.trailerBanner("▼  FROSTVAULT  ▼", 900);
      },
      script: (t) => {
        const dx = foeDx(gs);

        return solo(
          inp({
            attackPressed: swing(t, t >= 400 && Math.abs(dx) < 30),
            dashPressed: press("d", t >= 100),
            left: t < 0 ? true : t >= 120 && dx < -34,
            specialPressed: press("blink", t >= 420),
          }),
        );
      },
      ticks: 62,
    };
  },
  duration: 1500,
  id: "realm-frost",
};

const realmVoid: Beat = {
  build: (gs) => {
    stageRealm(gs, "reaper", 5, 107, 350, [
      ["spearman", 268],
      ["warrior", 300],
      ["warrior", 398],
      ["bomber", 426],
      ["archer", 458],
    ]);
    const press = presser();
    const swing = repeater(240);

    return {
      camera: () => {
        followCam(gs, -18, 4);
      },
      script: (t) =>
        solo(
          inp({
            attackPressed: swing(t, t >= 620 && Math.abs(foeDx(gs)) < 34),
            specialPressed: press("spin", t >= 120),
          }),
        ),
      ticks: 20,
    };
  },
  duration: 1400,
  id: "realm-void",
};

const relicSpike: Beat = {
  build: (gs) => {
    const keep = new Set(["fury", "edge", "sanguine"]);
    gs.trailerStage({
      biome: 4,
      depth: 4,
      fgTrees: false,
      gold: 120,
      hearts: 2,
      hero: "salamander",
      hideDoors: true,
      hud: { hearts: true, info: true },
      mods: { dmg: 1 },
      ownedRelics: RELICS.filter((r) => !keep.has(r.id)).map((r) => r.id),
      playerAt: { x: 104, y: FLOOR_Y },
      room: "merchant",
      seed: 108,
    });

    for (const x of [392, 420, 450, 480, 512]) {
      gs.trailerSpawnEnemy("warrior", x, FLOOR_Y);
    }

    const press = presser();
    const swing = repeater(240);

    return {
      camera: () => {
        followCam(gs, -42, 4);
      },
      script: (t) => {
        const { x } = gs.trailerWorld().p1;

        return solo(
          inp({
            attackPressed: swing(t, t >= 1400 && Math.abs(foeDx(gs)) < 32),
            right: x < 352,
            specialPressed: press("wave", x >= 344),
          }),
        );
      },
    };
  },
  duration: 2400,
  id: "relic-spike",
};

const pathCache: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 2,
      depth: 3,
      gold: 46,
      hearts: 3,
      hero: "mooni",
      hud: { banner: true, hearts: true, info: true },
      playerAt: { x: 302, y: 240 },
      room: "treasure",
      score: 640,
      seed: 121,
    });

    return {
      camera: () => {
        lockCam(gs, 352, 200, WIDE);
      },
      onReveal: () => {
        gs.trailerBanner("CACHE — pick a path", 1000);
      },
      script: (t) => solo(inp({ right: t >= 0 && gs.trailerWorld().p1.x < 520 })),
      ticks: 6,
    };
  },
  duration: 1400,
  id: "path-cache",
};

const eliteCrits: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 3,
      depth: 5,
      fgTrees: false,
      hearts: 4,
      hero: "riven",
      hud: { banner: true, hearts: true },
      mods: { crit: 0.55, critMult: 2, dmg: 4 },
      noEnemies: true,
      playerAt: { x: 330, y: FLOOR_Y },
      room: "elite",
      seed: 109,
    });

    for (const [name, x, affix] of [
      ["warrior", 252, "armored"],
      ["warrior", 288, "swift"],
      ["warrior", 372, "brutal"],
      ["warrior", 408, "armored"],
    ] as const) {
      gs.trailerSpawnEnemy(name, x, FLOOR_Y, affix);
    }

    const press = presser();
    const swing = repeater(220);

    return {
      camera: () => {
        followCam(gs, -24, 4);
      },
      onReveal: () => {
        gs.trailerBanner("ELITE", 900);
      },
      script: (t) => {
        const dx = foeDx(gs);

        return solo(
          inp({
            attackPressed: swing(t, t >= 0 && Math.abs(dx) < 30),
            left: dx < -26,
            right: dx > 26,
            specialPressed: press("blink", t >= 900 && Math.abs(dx) > 56),
          }),
        );
      },
      ticks: 26,
    };
  },
  duration: 2300,
  id: "elite-crits",
};

const movementTech: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 1,
      fgTrees: false,
      hero: "mooni",
      hideDoors: true,
      noEnemies: true,
      playerAt: { x: 26, y: 236 },
      room: "start",
      seed: 102,
    });
    const press = presser();

    return {
      camera: () => {
        followCam(gs, -70, 8);
      },
      script: (t) => {
        const b = gs.trailerWorld().p1.body;

        return solo(
          inp({
            dashPressed: press("dash", t >= 1400),
            jumpHeld: (t >= 240 && t < 560) || (t >= 900 && t < 1160),
            jumpPressed:
              press("wallkick", t >= 240 && b.wallDir !== 0) ||
              press("hop", t >= 900 && b.grounded),
            left: t < 240,
            right: t >= 260,
          }),
        );
      },
      ticks: 10,
    };
  },
  duration: 1800,
  id: "movement-tech",
};

const stompChain: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 2,
      fgTrees: false,
      hero: "axion",
      hideDoors: true,
      hud: { combo: true },
      mods: { dmg: 2 },
      noEnemies: true,
      playerAt: { x: 266, y: FLOOR_Y - 62 },
      room: "start",
      seed: 122,
    });

    for (const x of [296, 380, 464]) {
      gs.trailerSpawnEnemy("warrior", x, FLOOR_Y);
    }

    const rehop = repeater(320);

    return {
      camera: () => {
        followCam(gs, -34, -30);
        gs.cameras.main.setDeadzone(18, 44);
      },
      script: (t) => {
        const dx = foeDx(gs);
        const { grounded } = gs.trailerWorld().p1.body;

        return solo(
          inp({
            jumpHeld: true,
            jumpPressed: rehop(t, grounded && Math.abs(dx) < 90),
            left: dx < 4,
            right: dx > 14,
          }),
        );
      },
      ticks: 4,
    };
  },
  duration: 1500,
  id: "stomp-chain",
};

const coopRevive: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 3,
      hearts: 1,
      hero: "axion",
      hero2: "mooni",
      hideDoors: true,
      hud: { banner: true, hearts: true },
      mods: { dmg: 2 },
      noEnemies: true,
      player2At: { x: 620, y: FLOOR_Y },
      playerAt: { x: 510, y: FLOOR_Y },
      room: "start",
      seed: 115,
    });

    for (const x of [578, 662, 706]) {
      gs.trailerSpawnEnemy("warrior", x, FLOOR_Y);
    }

    const press = presser();
    const cue = presser();
    const swing = repeater(260);

    return {
      camera: () => {
        followCam(gs, -40, 0);
      },
      during: () => {
        const { p2 } = gs.trailerWorld();

        if (cue("ward", p2 !== null && p2.body.downed)) {
          gs.trailerMods({ armor: 1 });
        }
      },
      script: (t) => {
        const w = gs.trailerWorld();
        const down = w.p2;
        const target = down ? down.x : w.p1.x;
        const dx = target - w.p1.x;

        const p1 = inp({
          attackPressed: swing(t, t >= 300 && Math.abs(foeDx(gs)) < 30),
          dashPressed: press("d", t >= 120),
          left: t >= 0 && dx < -12,
          right: t < 0 ? false : dx > 12,
        });

        const p2Downed = down !== null && down.body.downed;

        const p2 = inp({
          attackPressed: press("b1", t < 0),
          specialPressed: press("heal", t >= 0 && !p2Downed),
        });

        return { p1, p2 };
      },
      ticks: 95,
    };
  },
  duration: 3200,
  id: "coop-revive",
};

const versusDuel: Beat = {
  build: (gs) => {
    gs.trailerStage({
      hero: "axion",
      hero2: "reaper",
      hud: { banner: true, hearts: true, info: true },
      room: "versus",
      seed: 116,
      vsState: { guestHp: 2, guestScore: 2, hostHp: 5, hostScore: 2, round: 5 },
    });
    const press = presser();
    const hop = stallJumper();
    const swing = repeater(300);

    return {
      camera: () => {
        lockCam(gs, 256, 205);
      },
      script: (t) => {
        const w = gs.trailerWorld();
        const { p2 } = w;

        if (!p2 || w.vs?.phase !== "fighting") {
          return { p1: inp(), p2: inp() };
        }

        const dx = p2.x - w.p1.x;
        const adx = Math.abs(dx);

        const host = inp({
          attackPressed: swing(t, t > 600 && adx < 40 && p2.body.iframes <= 0),
          jumpHeld: true,
          jumpPressed: hop(t, w.p1.x, adx > 26) || press("stomp", t > 320 && adx < 60),
          left: dx < -26,
          right: dx > 26,
        });

        const guest = inp({
          attackPressed: press("b1", t > 520 && adx < 52) || press("b2", t > 1550 && adx < 52),
          jumpHeld: t > 700 && t < 950,
          jumpPressed: press("hop", t > 700 && adx < 90),
          left: -dx < -40,
          right: -dx > 40,
        });

        return { p1: host, p2: guest };
      },
      ticks: 30,
    };
  },
  duration: 2600,
  id: "versus-duel",
};

const deathForge: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 4,
      depth: 6,
      fgTrees: false,
      gold: 37,
      hearts: 1,
      hero: "salamander",
      hud: { banner: true, hearts: true },
      mods: { dmg: 0.3 },
      noEnemies: true,
      playerAt: { x: 350, y: FLOOR_Y },
      room: "elite",
      score: 1480,
      seed: 117,
    });
    gs.trailerSpawnEnemy("warrior", 318, FLOOR_Y, "brutal");
    gs.trailerSpawnEnemy("warrior", 386, FLOOR_Y, "brutal");
    gs.trailerSpawnEnemy("spearman", 300, FLOOR_Y, "swift");
    const swing = repeater(240);

    return {
      camera: () => {
        followCam(gs, 0, 0);
      },
      script: (t) => solo(inp({ attackPressed: swing(t, Math.abs(foeDx(gs)) < 30) })),
      ticks: 10,
    };
  },
  duration: 1450,
  id: "death-forge",
};

const deathRebirth: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 1,
      depth: 1,
      hero: "mooni",
      hideDoors: true,
      hud: { hearts: true, info: true },
      mods: { dmg: 2 },
      noEnemies: true,
      playerAt: { x: 48, y: FLOOR_Y },
      room: "start",
      seed: 118,
    });
    gs.trailerSpawnEnemy("warrior", 244, FLOOR_Y);
    gs.trailerSpawnEnemy("warrior", 430, FLOOR_Y);
    const press = presser();
    const swing = repeater(240);

    return {
      camera: () => {
        followCam(gs, -56, 6);
      },
      script: (t) =>
        solo(
          inp({
            attackPressed: swing(t, Math.abs(foeDx(gs)) < 30),
            dashPressed: press("d", t >= 700),
            right: true,
          }),
        ),
      ticks: 24,
    };
  },
  duration: 1200,
  id: "death-rebirth",
};

const stageBoss = (gs: GameScene, biome: number, seed: number, playerX: number, hearts = 4) => {
  gs.trailerStage({
    biome,
    fgTrees: false,
    hearts,
    hero: "axion",
    hud: { banner: true, bossBar: true, hearts: true },
    mods: { dmg: 3 },
    playerAt: { x: playerX, y: BOSS_FLOOR_Y },
    room: "boss",
    seed,
  });
};

const bossBannerOnReveal = (gs: GameScene) => () => {
  const { boss } = gs.trailerWorld();

  if (boss) {
    gs.trailerBanner(boss.body.kind.banner, 600);
  }
};

const forceBoss = (gs: GameScene, state: "idle" | "wave" | "jump" | "charge" | "punch") => {
  const { boss } = gs.trailerWorld();

  if (boss && !boss.body.dead) {
    boss.body.forceState(state);
  }
};

const bossFan: Beat = {
  build: (gs) => {
    stageBoss(gs, 2, 111, 262);
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();

    return {
      camera: () => {
        lockCam(gs, 340, 300);
      },
      during: (t) => {
        if (cue("wave", t >= 40)) {
          forceBoss(gs, "wave");
        }
      },
      onReveal: bossBannerOnReveal(gs),
      script: (t) =>
        solo(
          inp({
            jumpHeld: t >= 900 && t < 1220,
            jumpPressed: press("j", t >= 900),
          }),
        ),
      ticks: 8,
    };
  },
  duration: 1500,
  id: "boss-fan",
};

const bossPhase: Beat = {
  build: (gs) => {
    stageBoss(gs, 3, 112, 360);
    const { boss } = gs.trailerWorld();

    if (boss) {
      boss.body.hp = Math.floor(boss.body.maxHp / 2) + 5;
      boss.body.forceState("idle");
    }

    const cue = presser();
    const swing = repeater(320);

    return {
      camera: () => {
        followCam(gs, -30, 0);
      },
      during: (t) => {
        const b = gs.trailerWorld().boss;

        if (b && cue("fan", t >= 1700 && b.body.state === "idle")) {
          forceBoss(gs, "wave");
        }
      },
      onReveal: bossBannerOnReveal(gs),
      script: (t) => {
        const w = gs.trailerWorld();
        const b = w.boss;

        if (!b) {
          return solo(inp());
        }

        const dx = b.body.x - w.p1.x;

        return solo(
          inp({
            attackPressed: swing(t, t < 1500 && Math.abs(dx) < 46),
            left: dx < -34 || (t >= 1900 && t < 2150),
            right: dx > 34,
          }),
        );
      },
      ticks: 10,
    };
  },
  duration: 2400,
  id: "boss-phase",
};

const bossCharge: Beat = {
  build: (gs) => {
    stageBoss(gs, 4, 113, 236);
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();

    return {
      camera: () => {
        followCam(gs, 30, -8);
      },
      during: (t) => {
        if (cue("charge", t >= 90)) {
          forceBoss(gs, "charge");
        }

        if (cue("charge2", t >= 900)) {
          forceBoss(gs, "charge");
        }
      },
      onReveal: bossBannerOnReveal(gs),
      script: (t) => {
        const w = gs.trailerWorld();
        const b = w.boss;

        if (!b) {
          return solo(inp());
        }

        const adx = Math.abs(b.body.x - w.p1.x);
        const incoming = b.body.state === "charge" && b.body.stateT > 0.32 && adx < 70;

        return solo(
          inp({
            jumpHeld: t >= 300,
            jumpPressed: press("j1", incoming) || press("j2", t >= 1150 && incoming),
            right: t >= 700,
          }),
        );
      },
      ticks: 8,
    };
  },
  duration: 1500,
  id: "boss-charge",
};

const bossKill: Beat = {
  build: (gs) => {
    stageBoss(gs, 5, 119, 300);
    const { boss } = gs.trailerWorld();

    if (boss) {
      boss.body.hp = 6;
      boss.body.phase = 2;
      boss.body.forceState("idle");
    }

    const press = presser();
    const cue = presser();
    const ground = repeater(400);
    const swing = repeater(300);

    return {
      camera: () => {
        followCam(gs, -36, -6);
      },
      during: (t) => {
        if (cue("slam", t >= 80)) {
          forceBoss(gs, "jump");
        }

        const b = gs.trailerWorld().boss;

        if (b && !b.body.dead && ground(t, t >= 900 && b.body.state === "jump")) {
          forceBoss(gs, "idle");
        }
      },
      onReveal: bossBannerOnReveal(gs),
      script: (t) => {
        const w = gs.trailerWorld();
        const b = w.boss;

        if (!b || b.body.dead) {
          return solo(inp({ right: t >= 2350 }));
        }

        const dx = b.body.x - w.p1.x;
        const adx = Math.abs(dx);

        return solo(
          inp({
            attackPressed: swing(t, t >= 1100 && adx < 50),
            dashPressed: press("d1", t >= 640),
            left: (t >= 620 && t < 820) || (t >= 1000 && dx < -34),
            right: t >= 1000 && dx > 34,
            specialPressed: press("smash", t >= 1700 && adx < 46),
          }),
        );
      },
      ticks: 8,
    };
  },
  duration: 4350,
  id: "boss-kill",
};

const BEATS: Beat[] = [
  coldOpen,
  realmEmber,
  realmFrost,
  realmVoid,
  relicSpike,
  pathCache,
  eliteCrits,
  movementTech,
  stompChain,
  coopRevive,
  versusDuel,
  deathForge,
  deathRebirth,
  bossFan,
  bossPhase,
  bossCharge,
  bossKill,
];

export const initTrailer = (game: Phaser.Game) => {
  if (!sfx.muted) {
    sfx.toggleMute();
  }

  const poll = window.setInterval(() => {
    const scene = game.scene.getScene("game");

    if (!(scene instanceof GameScene) || !game.scene.isActive("game")) {
      return;
    }

    window.clearInterval(poll);
    scene.trailerFreeze(9999);
    runTrailer({
      onGesture: () => {
        if (sfx.muted) {
          sfx.toggleMute();
        }

        sfx.unlock();
      },
      scenes: BEATS.map((b) => toScene(scene, b)),
      vignette: false,
    });
  }, 80);
};
