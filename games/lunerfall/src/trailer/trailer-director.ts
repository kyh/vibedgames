// trailer-director.ts — LUNERFALL trailer mode (?trailer=1).
//
// Stages the full ~45s gameplay trailer through the game's REAL systems: every
// enemy is a live EnemyBody, every swing goes through PlayerBody's combo
// machine, versus runs the real VersusMatch, the co-op revive is the real
// last-stand sim with a second local Player. The shell (trailer-shell.ts)
// owns letterbox/cards/cuts; this file owns what the camera sees.
//
// Choreography model: each beat's build() restages the world via the
// GameScene trailer hooks, hands back a per-frame input script (closed-loop —
// it steers off live positions, so frame-rate drift can't strand a shot), and
// optionally pre-rolls the sim while the screen is still black so the first
// visible frame is already mid-action.

import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_W } from "../config";
import { RELICS } from "../data/relics";
import { GameScene, type TrailerInputs } from "../scenes/game-scene";
import { ensureGlow } from "../sys/fx";
import type { InputState } from "../sys/input";
import { runTrailer, type TrailerCard, type TrailerScene } from "./trailer-shell";

// Feet-row y for the standard 21-row rooms and the one-row-taller boss arena.
const FLOOR_Y = 304;
const BOSS_FLOOR_Y = 320;

const IDLE: InputState = {
  left: false,
  right: false,
  up: false,
  down: false,
  jumpHeld: false,
  jumpPressed: false,
  dashPressed: false,
  attackPressed: false,
  specialPressed: false,
};
const inp = (o: Partial<InputState> = {}): InputState => ({ ...IDLE, ...o });
const solo = (p1: InputState): TrailerInputs => ({ p1, p2: null });

// Edge-press helper: fires true exactly once, on the first sample where the
// condition holds — scripts stay declarative, edges stay edges.
type Press = (key: string, cond: boolean) => boolean;
function presser(): Press {
  const done = new Set<string>();
  return (key, cond) => {
    if (!cond || done.has(key)) return false;
    done.add(key);
    return true;
  };
}

// ── camera vocabulary ─────────────────────────────────────────────────────────
// Follow with a lead offset (viewer sees where the action is going), or a
// locked wide frame. No zoom anywhere: fractional zoom shimmers pixel art.
function followCam(gs: GameScene, offX = 0, offY = 0): void {
  const cam = gs.cameras.main;
  cam.startFollow(gs.trailerWorld().p1.sprite, true, 0.22, 0.24);
  cam.setFollowOffset(offX, offY);
  cam.setDeadzone(36, 28);
}
function lockCam(gs: GameScene, x: number, y: number): void {
  const cam = gs.cameras.main;
  cam.stopFollow();
  cam.centerOn(x, y);
}

// ── beat plumbing ─────────────────────────────────────────────────────────────
type SceneBits = {
  /** Fixed sim steps run while the screen is still black — velocity pre-roll. */
  ticks?: number;
  /** Per-frame scripted input (t = ms since reveal; t < 0 during the pre-roll). */
  script?: (t: number) => TrailerInputs;
  /** Camera setup after staging + pre-roll (default: follow the hero). */
  camera?: () => void;
  /** Fired on the first visible frame (banners, boss cues). */
  onReveal?: () => void;
  /** Per-visible-frame direction (boss forceState timing, mid-shot mods). */
  during?: (t: number) => void;
  cleanup?: () => void;
};
type Beat = {
  id: string;
  duration: number;
  card?: TrailerCard;
  caption?: string;
  build: (gs: GameScene) => SceneBits;
};

function toScene(gs: GameScene, beat: Beat, index: number): TrailerScene {
  let bits: SceneBits = {};
  let revealed = false;
  const clock = { t: -1 };
  return {
    id: beat.id,
    duration: beat.duration,
    card: beat.card,
    caption: beat.caption,
    setup: () => {
      clock.t = -1;
      revealed = false;
      if (index === 0) {
        // First staging happens after the click gate — a real gesture exists,
        // so let the synth run (initTrailer muted it to avoid the stale-tone
        // pile-up a suspended AudioContext dumps on resume).
        if (sfx.muted) sfx.toggleMute();
        sfx.unlock();
      }
      bits = beat.build(gs);
      const script = bits.script;
      gs.trailerSetInput(script ? () => script(clock.t) : null);
      if (bits.ticks) gs.trailerTick(bits.ticks);
      if (bits.camera) bits.camera();
      else followCam(gs);
    },
    run: (t) => {
      clock.t = t;
      if (!revealed) {
        revealed = true;
        gs.trailerFreeze(0); // motion resumes under the card/cut fade-out
        bits.onReveal?.();
      }
      bits.during?.(t);
    },
    teardown: () => {
      gs.trailerSetInput(null);
      gs.trailerFreeze(9999); // hold the world until the next beat stages
      bits.cleanup?.();
    },
  };
}

// ── the beats ─────────────────────────────────────────────────────────────────

// 1 · COLD OPEN — Axion already sprinting, dash through a pair, five chained
// kills, combo counter climbing. Combo HUD only.
const coldOpen: Beat = {
  id: "cold-open-combo",
  duration: 3000,
  build: (gs) => {
    gs.trailerStage({
      hero: "axion",
      room: "combat",
      biome: 1,
      seed: 101,
      noEnemies: true,
      mods: { dmg: 2 },
      playerAt: { x: 90, y: FLOOR_Y },
      hud: { combo: true },
    });
    for (const x of [195, 260, 310, 370, 430, 485]) gs.trailerSpawnEnemy("warrior", x, FLOOR_Y);
    const press = presser();
    return {
      ticks: 18,
      camera: () => followCam(gs, -46, 6),
      script: (t) =>
        solo(
          inp({
            right: true,
            dashPressed: press("d1", t >= 110) || press("d2", t >= 1350),
            attackPressed:
              press("a1", t >= 260) ||
              press("a2", t >= 660) ||
              press("a3", t >= 1060) ||
              press("a4", t >= 1480) ||
              press("a5", t >= 1880) ||
              press("a6", t >= 2280),
            jumpPressed: press("j", t >= 2700),
            jumpHeld: t >= 2700,
          }),
        ),
    };
  },
};

// 2 · MOVEMENT TECH — Riven, no combat: run → jump → up-dash onto the step →
// jump → air-dash to the one-way → blink → dash — one unbroken left-to-right
// flow across the start room's parallax.
const movementTech: Beat = {
  id: "movement-tech",
  duration: 2500,
  build: (gs) => {
    gs.trailerStage({
      hero: "riven",
      room: "start",
      biome: 1,
      seed: 102,
      noEnemies: true,
      playerAt: { x: 48, y: FLOOR_Y },
    });
    const press = presser();
    return {
      ticks: 16,
      camera: () => followCam(gs, -60, 8),
      script: () => {
        const x = gs.trailerWorld().p1.x;
        return solo(
          inp({
            right: true,
            up: x >= 104 && x <= 160, // aims the air-dash up-right onto the step
            jumpHeld: true,
            jumpPressed: press("j1", x >= 96) || press("j2", x >= 262) || press("j3", x >= 604),
            dashPressed: press("d1", x >= 120) || press("d2", x >= 540),
            specialPressed: press("blink", x >= 426),
          }),
        );
      },
    };
  },
};

// 3-7 · FIVE REALMS — one shot per biome palette, each mid-action against that
// biome's own roster, escalating enemy counts. Reaper carries the montage.
function stageMontage(
  gs: GameScene,
  biome: number,
  seed: number,
  playerX: number,
  spawns: readonly (readonly [name: "warrior" | "spearman" | "archer" | "bomber", x: number])[],
): void {
  gs.trailerStage({
    hero: "reaper",
    room: "combat",
    biome,
    seed,
    noEnemies: true,
    mods: { dmg: 2.5 },
    playerAt: { x: playerX, y: FLOOR_Y },
  });
  for (const [name, x] of spawns) gs.trailerSpawnEnemy(name, x, FLOOR_Y);
}

// b1 Moonwood: one wide sweep, two kills.
const biome1: Beat = {
  id: "biome-1",
  duration: 1100,
  card: { title: "FIVE REALMS" },
  build: (gs) => {
    stageMontage(gs, 1, 103, 120, [
      ["warrior", 175],
      ["warrior", 192],
    ]);
    const press = presser();
    return {
      ticks: 20,
      camera: () => followCam(gs, -44, 6),
      script: (t) =>
        solo(
          inp({
            right: true,
            attackPressed: press("a", t >= 60),
            jumpPressed: press("j", t >= 700),
            jumpHeld: t >= 700,
          }),
        ),
    };
  },
};

// b2 Emberdeep: bomber rush — one kill detonates the line, back-dash out of
// the chain blasts, cut on the third explosion.
const biome2: Beat = {
  id: "biome-2",
  duration: 1100,
  build: (gs) => {
    stageMontage(gs, 2, 104, 380, [
      ["bomber", 440],
      ["bomber", 462],
      ["bomber", 484],
    ]);
    const press = presser();
    return {
      ticks: 20,
      script: (t) =>
        solo(
          inp({
            left: t >= 480 && t < 780,
            attackPressed: press("a", t >= 200),
            dashPressed: press("d", t >= 500),
          }),
        ),
    };
  },
};

// b3 Frostvault (reversed flow): arrows already in the air, dash THROUGH the
// volley right-to-left, cut down the nearest archer mid-retreat.
const biome3: Beat = {
  id: "biome-3",
  duration: 1100,
  build: (gs) => {
    stageMontage(gs, 3, 105, 640, [
      ["archer", 470],
      ["archer", 440],
      ["archer", 410],
    ]);
    const press = presser();
    return {
      ticks: 25,
      camera: () => followCam(gs, 50, 4),
      script: (t) => {
        const x = gs.trailerWorld().p1.x;
        return solo(
          inp({
            left: t < 0 ? x > 562 : t >= 380 && x > 436,
            dashPressed: press("d", t >= 250),
            attackPressed: press("a", t >= 640),
          }),
        );
      },
    };
  },
};

// b4 Venomhollow: four spearmen cross-charge, reaper leaps the intersection.
const biome4: Beat = {
  id: "biome-4",
  duration: 1100,
  build: (gs) => {
    stageMontage(gs, 4, 106, 320, [
      ["spearman", 210],
      ["spearman", 240],
      ["spearman", 410],
      ["spearman", 440],
    ]);
    const press = presser();
    return {
      ticks: 22,
      camera: () => lockCam(gs, 330, 260),
      script: (t) =>
        solo(
          inp({
            jumpPressed: press("j", t >= 520),
            jumpHeld: t >= 520 && t < 900,
          }),
        ),
    };
  },
};

// b5 Voidsanctum: five-strong mixed swarm converging — slash, reaping spin,
// bomber blast at the frame edge. The montage's arena-filling closer.
const biome5: Beat = {
  id: "biome-5",
  duration: 1100,
  build: (gs) => {
    stageMontage(gs, 5, 107, 350, [
      ["warrior", 300],
      ["spearman", 275],
      ["warrior", 415],
      ["archer", 520],
      ["bomber", 462],
    ]);
    const press = presser();
    return {
      ticks: 24,
      script: (t) =>
        solo(
          inp({
            right: t >= 0 && t < 140,
            attackPressed: press("a1", t >= 150) || press("a2", t >= 700),
            specialPressed: press("spin", t >= 450),
          }),
        ),
    };
  },
};

// 8 · 23 RELICS — the merchant shrine, deterministic offers (everything else
// pre-owned), three real purchases in one run past the pedestals, then the
// power spike lands on screen: the warrior that tanked a punch pre-buy dies to
// one flame wave post-buy, and the wave keeps going through the pack.
const relicSpike: Beat = {
  id: "relic-spike",
  duration: 3500,
  card: { title: "23 RELICS", sub: "STACK. SYNERGIZE." },
  build: (gs) => {
    const keep = new Set(["fury", "edge", "keen"]);
    gs.trailerStage({
      hero: "salamander",
      room: "merchant",
      biome: 4,
      seed: 108,
      mods: { dmg: 1 },
      gold: 100,
      ownedRelics: RELICS.filter((r) => !keep.has(r.id)).map((r) => r.id),
      playerAt: { x: 64, y: FLOOR_Y },
    });
    gs.trailerSpawnEnemy("warrior", 430, FLOOR_Y);
    gs.trailerSpawnEnemy("spearman", 600, FLOOR_Y);
    gs.trailerSpawnEnemy("warrior", 630, FLOOR_Y);
    gs.trailerSpawnEnemy("bomber", 655, FLOOR_Y);
    gs.trailerSpawnEnemy("spearman", 680, FLOOR_Y);
    const press = presser();
    return {
      ticks: 14,
      camera: () => followCam(gs, -42, 4),
      script: (t) => {
        const x = gs.trailerWorld().p1.x;
        return solo(
          inp({
            right: x < 356,
            specialPressed: press("wave", t >= 1350),
            attackPressed:
              press("p1", t >= 1750) || press("p2", t >= 2450) || press("p3", t >= 2950),
          }),
        );
      },
    };
  },
};

// 9 · ELITE CRITS — three affix-tinted elites (armored/swift/brutal), a crit
// build spraying CRIT pops, one honest hit taken, blink-out through the tank.
const eliteCrits: Beat = {
  id: "elite-crits",
  duration: 3000,
  build: (gs) => {
    gs.trailerStage({
      hero: "riven",
      room: "combat",
      biome: 3,
      seed: 109,
      noEnemies: true,
      mods: { dmg: 3, crit: 0.55, critMult: 2 },
      playerAt: { x: 140, y: FLOOR_Y },
    });
    // Brutal warrior close enough that swing 1 CONNECTS on-screen — at 215
    // the first ~0.7s of the cut was Riven running at a distant target.
    gs.trailerSpawnEnemy("warrior", 192, FLOOR_Y, "brutal");
    gs.trailerSpawnEnemy("spearman", 330, FLOOR_Y, "swift");
    gs.trailerSpawnEnemy("warrior", 60, FLOOR_Y, "armored");
    const press = presser();
    return {
      // 40 pre-roll ticks (~0.65s): the elites' aggro walk is already in
      // motion on frame one, so the shot opens mid-brawl, not at a standoff.
      ticks: 40,
      script: (t) => {
        const x = gs.trailerWorld().p1.x;
        return solo(
          inp({
            right: t < 1000 && x < 178,
            left: t >= 2100 && x > 150,
            attackPressed:
              press("a1", t >= 60) ||
              press("a2", t >= 420) ||
              press("a3", t >= 800) ||
              press("a4", t >= 1450) ||
              press("a5", t >= 1850),
            specialPressed: press("blink", t >= 2100 && x <= 238),
          }),
        );
      },
    };
  },
};

// 10-14 · FIVE LORDS — each biome boss gets one menacing beat, escalating:
// punch telegraph → triple wave fan → dash-through barrage → charge whip-by →
// phase-two leap-slam. Boss name banner + HP bar on; Axion runs the gauntlet.
function stageBoss(gs: GameScene, biome: number, seed: number, playerX: number): void {
  gs.trailerStage({
    hero: "axion",
    room: "boss",
    biome,
    seed,
    mods: { dmg: 3 },
    playerAt: { x: playerX, y: BOSS_FLOOR_Y },
    hud: { banner: true, bossBar: true },
  });
}
function bossBannerOnReveal(gs: GameScene): () => void {
  return () => {
    const boss = gs.trailerWorld().boss;
    if (boss) gs.trailerBanner(boss.body.kind.banner, 1250);
  };
}
function forceBoss(gs: GameScene, state: "idle" | "wave" | "jump" | "charge" | "punch"): void {
  const boss = gs.trailerWorld().boss;
  if (boss && !boss.body.dead) boss.body.forceState(state);
}

// Lord 1 — Salamander stalks in, punch telegraph, hero back-dashes the swing.
const bossTease1: Beat = {
  id: "boss-tease-1",
  duration: 1300,
  card: { title: "FIVE LORDS" },
  build: (gs) => {
    stageBoss(gs, 1, 110, 300);
    forceBoss(gs, "idle"); // skip the intro pose: it walks at the hero under the card
    const press = presser();
    const cue = presser();
    return {
      ticks: 12,
      camera: () => followCam(gs, -30, 0),
      onReveal: bossBannerOnReveal(gs),
      during: (t) => {
        if (cue("punch", t >= 150)) forceBoss(gs, "punch");
      },
      script: (t) =>
        solo(
          inp({
            right: t < 80,
            left: t >= 330 && t < 540,
            dashPressed: press("d", t >= 340),
          }),
        ),
    };
  },
};

// Lord 2 — Cinderking's triple flame fan; hero leaps the low wave. Locked wide.
const bossTease2: Beat = {
  id: "boss-tease-2",
  duration: 1300,
  build: (gs) => {
    stageBoss(gs, 2, 111, 300);
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();
    return {
      ticks: 8,
      camera: () => lockCam(gs, 354, 300),
      onReveal: bossBannerOnReveal(gs),
      during: (t) => {
        if (cue("wave", t >= 40)) forceBoss(gs, "wave");
      },
      script: (t) =>
        solo(
          inp({
            jumpPressed: press("j", t >= 830),
            jumpHeld: t >= 830 && t < 1150,
          }),
        ),
    };
  },
};

// Lord 3 — Rimewarden's fast double barrage from the left; hero dashes THROUGH
// the waves (reversed screen direction for the montage's mid-beat).
const bossTease3: Beat = {
  id: "boss-tease-3",
  duration: 1300,
  build: (gs) => {
    stageBoss(gs, 3, 112, 552);
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();
    return {
      ticks: 8,
      camera: () => followCam(gs, 40, 0),
      onReveal: bossBannerOnReveal(gs),
      during: (t) => {
        if (cue("wave", t >= 40)) forceBoss(gs, "wave");
      },
      script: (t) => {
        const x = gs.trailerWorld().p1.x;
        return solo(
          inp({
            left: t < 60 || (t >= 660 && x > 480),
            dashPressed: press("d", t >= 700),
          }),
        );
      },
    };
  },
};

// Lord 4 — Blightmaw's arena charge whips through a fixed wide frame; hero
// jumps it and drifts clear.
const bossTease4: Beat = {
  id: "boss-tease-4",
  duration: 1300,
  build: (gs) => {
    stageBoss(gs, 4, 113, 236);
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();
    return {
      ticks: 8,
      camera: () => lockCam(gs, 330, 300),
      onReveal: bossBannerOnReveal(gs),
      during: (t) => {
        if (cue("charge", t >= 90)) forceBoss(gs, "charge");
      },
      script: (t) =>
        solo(
          inp({
            jumpPressed: press("j", t >= 540),
            jumpHeld: t >= 540 && t < 900,
            left: t >= 560,
          }),
        ),
    };
  },
};

// Lord 5 — Void Sovereign, phase two, leap-slam right at the hero; escape dash,
// blast fills the frame. Biggest of the five, straight into the co-op beat.
const bossTease5: Beat = {
  id: "boss-tease-5",
  duration: 1300,
  build: (gs) => {
    stageBoss(gs, 5, 114, 330);
    const boss = gs.trailerWorld().boss;
    if (boss) {
      boss.body.phase = 2;
      boss.body.forceState("idle");
    }
    const press = presser();
    const cue = presser();
    return {
      ticks: 8,
      camera: () => followCam(gs, 50, -4),
      onReveal: bossBannerOnReveal(gs),
      during: (t) => {
        if (cue("jump", t >= 60)) forceBoss(gs, "jump");
      },
      script: (t) =>
        solo(
          inp({
            left: t >= 360 && t < 700,
            dashPressed: press("d", t >= 380),
          }),
        ),
    };
  },
};

// 15 · TOGETHER OR NOT AT ALL — real last stand: Mooni goes down under the
// ambush, Axion fights through, revives inside the ring while a straggler
// hammers his ward, and Mooni answers with a heal. Shared hearts on.
const coopRevive: Beat = {
  id: "coop-revive",
  duration: 4000,
  card: { title: "TOGETHER OR NOT AT ALL" },
  caption: "ONLINE CO-OP",
  build: (gs) => {
    gs.trailerStage({
      hero: "axion",
      hero2: "mooni",
      room: "start",
      biome: 2,
      seed: 115,
      noEnemies: true,
      mods: { dmg: 2 },
      hearts: 1,
      playerAt: { x: 200, y: FLOOR_Y },
      player2At: { x: 555, y: FLOOR_Y },
      hud: { hearts: true, banner: true },
      // Start rooms are auto-cleared, so the exit door renders as an ACTIVE
      // pink FIGHT gate mid-frame — hide it, the revive is the subject.
      hideDoors: true,
    });
    gs.trailerSpawnEnemy("warrior", 610, FLOOR_Y);
    gs.trailerSpawnEnemy("warrior", 632, FLOOR_Y);
    gs.trailerSpawnEnemy("warrior", 665, FLOOR_Y);
    const press = presser();
    const cue = presser();
    return {
      ticks: 24,
      camera: () => followCam(gs, -40, 0),
      during: () => {
        // Arm 100% ward the moment the down actually lands (closed-loop, not a
        // timer — a timer could beat the fatal hit and WARD-block the down
        // itself): the rescuer can be pressured (WARD pops) but a stray hit can
        // never wipe the staged last stand.
        const p2 = gs.trailerWorld().p2;
        if (cue("ward", p2 !== null && p2.body.downed)) gs.trailerMods({ armor: 1 });
      },
      script: (t) => {
        const w = gs.trailerWorld();
        const p1 = inp({
          right: t >= 250 && w.p1.x < 536,
          dashPressed: press("d", t >= 700),
          attackPressed: press("a1", t >= 1900) || press("a2", t >= 2300) || press("a3", t >= 3100),
        });
        const p2Downed = w.p2 !== null && w.p2.body.downed;
        const p2 = inp({
          right: t >= 0 && t < 120,
          attackPressed: press("b1", t >= 40), // brave whiff into the ambush
          specialPressed: press("heal", t >= 3400 && !p2Downed),
        });
        return { p1, p2 };
      },
    };
  },
};

// 16 · ONLINE VERSUS — mirrored duel staged mid-match (2-2, hearts worn down),
// stomp + finisher take the round: score pips flash 3. Both fighters are
// local bodies through the real VersusMatch machine.
const versusDuel: Beat = {
  id: "versus-duel",
  duration: 3000,
  caption: "ONLINE VERSUS",
  build: (gs) => {
    gs.trailerStage({
      hero: "axion",
      hero2: "reaper",
      room: "versus",
      seed: 116,
      vsState: { hostHp: 5, guestHp: 2, hostScore: 2, guestScore: 2, round: 5 },
      hud: { hearts: true, info: true, banner: true },
    });
    const press = presser();
    return {
      camera: () => lockCam(gs, 256, 136),
      script: (t) => {
        const w = gs.trailerWorld();
        const p2 = w.p2;
        if (!p2 || w.vs?.phase !== "fighting") return { p1: inp(), p2: inp() };
        const dx = p2.x - w.p1.x;
        const adx = Math.abs(dx);
        const host = inp({
          right: dx > 34,
          left: dx < -34,
          jumpPressed: press("stomp", t > 480 && adx < 70),
          jumpHeld: t > 480 && t < 950,
          attackPressed:
            press("a1", t > 1250 && adx < 46) ||
            press("a2", t > 1700 && adx < 46) ||
            press("a3", t > 2150 && adx < 46),
        });
        const guest = inp({
          right: -dx > 44,
          left: -dx < -44,
          jumpPressed: press("hop", t > 1000 && adx < 90),
          jumpHeld: t > 1000 && t < 1250,
          attackPressed: press("b1", t > 750 && adx < 52) || press("b2", t > 1900 && adx < 52),
        });
        return { p1: host, p2: guest };
      },
    };
  },
};

// 17 · ROGUELITE HONESTY, part 1 — overwhelmed and killed on screen. The death
// banner shows the shard yield: dying pays. Cut on the crumple.
const deathForge: Beat = {
  id: "death-forge",
  duration: 1400,
  build: (gs) => {
    gs.trailerStage({
      hero: "axion",
      room: "elite",
      biome: 4,
      seed: 117,
      depth: 6,
      noEnemies: true,
      mods: { dmg: 2 },
      hearts: 1,
      gold: 37,
      score: 1480,
      playerAt: { x: 260, y: FLOOR_Y },
      hud: { banner: true },
    });
    gs.trailerSpawnEnemy("warrior", 336, FLOOR_Y);
    gs.trailerSpawnEnemy("warrior", 372, FLOOR_Y);
    gs.trailerSpawnEnemy("bomber", 180, FLOOR_Y); // the killer, fuse-flashing behind
    const press = presser();
    return {
      ticks: 12,
      script: (t) =>
        solo(
          inp({
            right: t >= 0 && t < 150,
            attackPressed: press("a1", t >= 150) || press("a2", t >= 550),
          }),
        ),
    };
  },
};

// 17b · ROGUELITE HONESTY, part 2 — instant new-run drop-in: fresh hero, depth
// 1, first kill of the next descent already landing. Run info HUD on so the
// reset reads. (The beat sheet's 0.8s Moon Forge panel flash is substituted —
// see the deviation note in the delivery report.)
const deathRebirth: Beat = {
  id: "death-rebirth",
  duration: 1100,
  build: (gs) => {
    gs.trailerStage({
      hero: "mooni",
      room: "start",
      biome: 1,
      seed: 118,
      depth: 1,
      noEnemies: true,
      mods: { dmg: 2 },
      playerAt: { x: 48, y: FLOOR_Y },
      hud: { info: true },
    });
    gs.trailerSpawnEnemy("warrior", 330, FLOOR_Y);
    const press = presser();
    return {
      ticks: 14,
      camera: () => followCam(gs, -56, 6),
      script: () => {
        const w = gs.trailerWorld();
        const x = w.p1.x;
        const foe = w.enemies[0];
        const near = foe !== undefined && !foe.body.dead && Math.abs(foe.body.x - x) < 44;
        return solo(
          inp({
            right: true,
            attackPressed: press("a", near),
            dashPressed: press("d", x >= 400),
          }),
        );
      },
    };
  },
};

// 18 · CLIMAX — Void Sovereign at a sliver of HP, phase two. Survive the slam,
// close in, chain into the super-smash finisher: hitstop, 420ms shake, gold
// burst, VOID SOVEREIGN SLAIN.
const bossKill: Beat = {
  id: "boss-kill",
  duration: 4000,
  build: (gs) => {
    stageBoss(gs, 5, 119, 300);
    const boss = gs.trailerWorld().boss;
    if (boss) {
      boss.body.hp = 7; // the finishing-blow shot: bar shows a sliver
      boss.body.phase = 2;
      boss.body.forceState("idle");
    }
    const press = presser();
    const cue = presser();
    return {
      ticks: 8,
      camera: () => followCam(gs, -36, -6),
      onReveal: bossBannerOnReveal(gs),
      during: (t) => {
        if (cue("slam", t >= 80)) forceBoss(gs, "jump");
      },
      script: (t) => {
        const w = gs.trailerWorld();
        const b = w.boss;
        if (!b || b.body.dead) return solo(inp()); // stand over the kill
        const dx = b.body.x - w.p1.x;
        const adx = Math.abs(dx);
        return solo(
          inp({
            // Escape the opening slam, then hunt the boss down.
            left: (t >= 380 && t < 650) || (t >= 1100 && dx < -34),
            right: t >= 1100 && dx > 34,
            dashPressed:
              press("d1", t >= 400) || press("dodge", b.body.state === "charge" && adx < 90),
            attackPressed:
              press("a1", t >= 1900 && adx < 52) ||
              press("a2", t >= 2300 && adx < 52) ||
              press("a3", t >= 3400 && adx < 52),
            specialPressed: press("smash", t >= 2800 && adx < 50),
          }),
        );
      },
    };
  },
};

// 19 · RELEASE — hero on the high ledge, still, facing the moon over the
// four-layer forest. The only manufactured prop in the trailer: a moon built
// from the game's own glow texture, deepest parallax layer.
const moonrise: Beat = {
  id: "moonrise",
  duration: 2000,
  build: (gs) => {
    gs.trailerStage({
      hero: "axion",
      room: "start",
      biome: 1,
      seed: 120,
      noEnemies: true,
      // The hero stands on the exit-door ledge; the start room is auto-cleared,
      // so the gate there would pulse magenta with a FIGHT label mid-frame.
      hideDoors: true,
      playerAt: { x: 560, y: 224 },
    });
    const scrollX = 560 - BASE_W * 0.66;
    const scrollY = 66;
    const sf = 0.1; // deepest layer — drifts least under the slow pan
    const mx = scrollX * sf + BASE_W * 0.3;
    const my = scrollY * sf + 62;
    ensureGlow(gs);
    const halo = gs.add
      .image(mx, my, "fx-glow")
      .setTint(0xcfe0ff)
      .setAlpha(0.85)
      .setBlendMode(Phaser.BlendModes.ADD)
      .setScale(4.6)
      .setDepth(-37)
      .setScrollFactor(sf);
    const core = gs.add.circle(mx, my, 12, 0xe8eefc, 1).setDepth(-37).setScrollFactor(sf);
    return {
      ticks: 4,
      camera: () => {
        const cam = gs.cameras.main;
        cam.stopFollow();
        cam.setScroll(scrollX, scrollY);
      },
      script: (t) => solo(inp({ left: t < 0 })), // pre-roll only: face the moon
      during: (t) => {
        // Barely-perceptible drift toward the moon; parallax layers breathe.
        gs.cameras.main.setScroll(scrollX - t * 0.004, scrollY);
      },
      cleanup: () => {
        // Final beat: the shell runs teardown BEFORE the 400ms end-card fade,
        // so an immediate destroy pops the moon off a fully-visible frame.
        // Delay past the fade; it must still happen — the halo (scrollFactor
        // 0.1, depth -37) survives buildRoom's teardownRoom and would haunt
        // every scene of a &loop=1 replay (earliest ~3s later, never a race).
        gs.time.delayedCall(600, () => {
          halo.destroy();
          core.destroy();
        });
      },
    };
  },
};

const BEATS: Beat[] = [
  coldOpen,
  movementTech,
  biome1,
  biome2,
  biome3,
  biome4,
  biome5,
  relicSpike,
  eliteCrits,
  bossTease1,
  bossTease2,
  bossTease3,
  bossTease4,
  bossTease5,
  coopRevive,
  versusDuel,
  deathForge,
  deathRebirth,
  bossKill,
  moonrise,
];

// ── entry ─────────────────────────────────────────────────────────────────────
export function initTrailer(game: Phaser.Game): void {
  // Mute the synth until the click gate: tones scheduled against a suspended
  // AudioContext pile up and blat all at once when the first gesture resumes
  // it. Scene 1's setup unmutes (a real gesture exists by then).
  if (!sfx.muted) sfx.toggleMute();
  const poll = window.setInterval(() => {
    const scene = game.scene.getScene("game");
    if (!(scene instanceof GameScene) || !game.scene.isActive("game")) return;
    window.clearInterval(poll);
    scene.trailerFreeze(9999); // hold the boot room still behind the gate
    runTrailer({
      title: "LUNERFALL",
      url: "lunerfall.vibedgames.com",
      tagline: "Co-op roguelite — one more descent",
      accent: "#34e5c8",
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      vignette: false, // keeps the pixel art crisp edge to edge
      scenes: BEATS.map((b, i) => toScene(scene, b, i)),
    });
  }, 80);
}
