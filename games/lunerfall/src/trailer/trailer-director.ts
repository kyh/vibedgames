// trailer-director.ts — LUNERFALL trailer mode (?trailer=1).
//
// Stages the full ~37s gameplay trailer through the game's REAL systems: every
// enemy is a live EnemyBody, every swing goes through PlayerBody's combo
// machine, versus runs the real VersusMatch, the co-op revive is the real
// last-stand sim with a second local Player, and the closing DESCEND comes from
// the room's own checkClear. The shell (trailer-shell.ts) owns the letterbox and
// the cuts; this file owns what the camera sees.
//
// Choreography model: each beat's build() restages the world via the
// GameScene trailer hooks, hands back a per-frame input script (closed-loop —
// it steers off live positions, so frame-rate drift can't strand a shot), and
// optionally pre-rolls the sim while the screen is still black so the first
// visible frame is already mid-action.
//
// Cast rule: one hero per beat, and no two neighbouring beats share a biome
// palette — five kits and five worlds are the game's headline content, and a
// montage that never changes its fighter or its colour reads as one level.

import type Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { RELICS } from "../data/relics";
import { GameScene } from "../scenes/game-scene";
import type { TrailerInputs } from "../scenes/game-scene";
import type { InputState } from "../sys/input";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";

// Feet-row y for the standard 21-row rooms and the one-row-taller boss arena.
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
const inp = (o: Partial<InputState> = {}): InputState => ({ ...IDLE, ...o });
const solo = (p1: InputState): TrailerInputs => ({ p1, p2: null });

// Edge-press helper: fires true exactly once, on the first sample where the
// condition holds — scripts stay declarative, edges stay edges.
type Press = (key: string, cond: boolean) => boolean;
const presser = (): Press => {
  const done = new Set<string>();
  return (key, cond) => {
    if (!cond || done.has(key)) {
      return false;
    }
    done.add(key);
    return true;
  };
};

// Re-arming press for verbs a beat repeats (the combo chain): fires at most
// once per `everyMs`, and only while the condition holds. Swings run 0.64-1.68s
// but a queued press cancels the tail at 50%, so ~220ms keeps the chain fed
// without spamming the 0.12s input buffer.
const repeater = (everyMs: number): ((t: number, cond: boolean) => boolean) => {
  let last = -1e9;
  return (t, cond) => {
    if (!cond || t - last < everyMs) {
      return false;
    }
    last = t;
    return true;
  };
};

// Jump when a grounded approach stops making ground. The versus arena's centre
// riser is a head-height slab, so a duelist who walks into it runs on the spot
// forever; a player hops it without thinking. Re-arms every `everyMs` so a hop
// that lands short tries again.
const stallJumper = (everyMs = 500): ((t: number, x: number, closing: boolean) => boolean) => {
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

/** Signed distance to the nearest live enemy (+ = to the hero's right). */
const foeDx = (gs: GameScene): number => {
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

// ── camera vocabulary ─────────────────────────────────────────────────────────
// Two integer lenses (fractional zoom shimmers pixel art). WIDE is the play
// camera itself — the room is the subject. MEDIUM doubles subject scale, which
// is what a 22px-tall body needs to read at all in a 16:9 export; the HUD is
// counter-transformed by trailerZoom so it stays 1:1 either way.
const WIDE = 1;
const MED = 2;

// Offsets are authored in SCREEN px and divided by the lens, so a lead reads as
// the same fraction of frame at any zoom.
const followCam = (gs: GameScene, offX = 0, offY = 0, zoom = MED): void => {
  gs.trailerZoom(zoom);
  const cam = gs.cameras.main;
  cam.startFollow(gs.trailerWorld().p1.sprite, true, 0.22, 0.24);
  cam.setFollowOffset(offX / zoom, offY / zoom);
  cam.setDeadzone(36 / zoom, 28 / zoom);
};
const lockCam = (gs: GameScene, x: number, y: number, zoom = MED): void => {
  gs.trailerZoom(zoom);
  const cam = gs.cameras.main;
  cam.stopFollow();
  cam.centerOn(x, y);
};

// ── beat plumbing ─────────────────────────────────────────────────────────────
interface SceneBits {
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
}
interface Beat {
  id: string;
  duration: number;
  build: (gs: GameScene) => SceneBits;
}

const toScene = (gs: GameScene, beat: Beat): TrailerScene => {
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
        // motion resumes under the cut fade-out
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
      if (bits.ticks) {
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
      // hold the world until the next beat stages
      gs.trailerFreeze(9999);
      bits.cleanup?.();
    },
  };
};

// ── the beats ─────────────────────────────────────────────────────────────────

// 1 · COLD OPEN — Axion already sprinting through a warrior line, dash into it
// and chain kills until the streak counter goes red. Closed-loop swings (fire
// when a body is inside reach) so every press connects instead of cutting air.
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
      camera: () => followCam(gs, -46, 6),
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

// 2-4 · THREE REALMS, THREE KITS — one biome palette and one hero per shot, all
// on the same follow-cam grammar so the constant framing reads as a roster.
type Spawn = readonly [name: "warrior" | "spearman" | "archer" | "bomber", x: number];
const stageRealm = (
  gs: GameScene,
  hero: "axion" | "reaper" | "riven" | "mooni" | "salamander",
  biome: number,
  seed: number,
  playerX: number,
  spawns: readonly Spawn[],
  hud: { banner?: boolean } = {},
): void => {
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

// Emberdeep · SALAMANDER — the flame wave pierces the bomber line and their own
// fuses finish the job: three chained blasts, one press.
const realmEmber: Beat = {
  build: (gs) => {
    stageRealm(gs, "salamander", 2, 104, 316, [
      ["bomber", 380],
      ["bomber", 404],
      ["bomber", 428],
    ]);
    const press = presser();
    return {
      camera: () => followCam(gs, -30, 4),
      script: (t) => {
        // The cast ROOTS the body, and each blast adds hit-stop, so the wave
        // outlives its 0.5s on the wall clock — every earlier attempt to move
        // during it was swallowed. Steer off specialActive, not off a timer.
        const casting = gs.trailerWorld().p1.body.specialActive;
        return solo(
          inp({
            dashPressed: press("d", t >= 200 && !casting),
            // Stride into the wreckage once the cast lets go — but not before
            // it: a step forward on frame one walks him into his own chain
            // reaction's blast radius.
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

// Frostvault · RIVEN — the descent banner the game itself fires, then a blink
// through the archers' volley into the fastest combo in the game.
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
      camera: () => followCam(gs, 50, 4),
      onReveal: () => gs.trailerBanner("▼  FROSTVAULT  ▼", 900),
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
      // ~1s of pre-roll: the archers' aggro + 0.46s draw has to complete before
      // the reveal or the "volley" is three bystanders standing still.
      ticks: 62,
    };
  },
  duration: 1500,
  id: "realm-frost",
};

// Voidsanctum · REAPER — the reaping spin opens on a five-strong mixed swarm
// while every one of them is still alive, then the scythe cleans up.
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
      camera: () => followCam(gs, -18, 4),
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

// 5 · 23 RELICS — the merchant shrine with deterministic offers (everything
// else pre-owned): three real purchases on one run past the pedestals, gold
// visibly draining on the HUD, then the build lands — the flame wave shears a
// pack that the same hero could not one-shot a second earlier, and the lifesteal
// he just bought puts hearts back on the row.
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
      // Left of the first pedestal (they sit at 0.3/0.5/0.7 × 480 = 144/240/336)
      // with no pre-roll, so all THREE purchases land on camera. Starting at 118
      // with a run-up put buy #1 behind the cut.
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
      camera: () => followCam(gs, -42, 4),
      script: (t) => {
        const { x } = gs.trailerWorld().p1;
        return solo(
          inp({
            attackPressed: swing(t, t >= 1400 && Math.abs(foeDx(gs)) < 32),
            right: x < 352,
            // Past the third pedestal, not on a blind timer: the wave is the
            // payoff for the build the run past them just bought.
            specialPressed: press("wave", x >= 344),
          }),
        );
      },
    };
  },
  duration: 2400,
  id: "relic-spike",
};

// 6 · THE RUN — the wide breather, and the only shot whose subject is the room:
// a CACHE with its free relic on the dais and BOTH lit torii gates in frame with
// their labels, under the game's own "pick a path" banner. This is the roguelite
// structure the rest of the cut takes for granted.
const pathCache: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 2,
      depth: 3,
      gold: 46,
      hearts: 3,
      hero: "mooni",
      hud: { banner: true, hearts: true, info: true },
      // On the dais, a stride left of the orb: the cache sits 4 rows above the
      // floor, and a shot this short has no time for the climb.
      playerAt: { x: 302, y: 240 },
      room: "treasure",
      score: 640,
      seed: 121,
    });
    return {
      // Safe rooms are 44 cols; this framing holds the left gate (x 136), the
      // cache orb (344) and the right gate (568) in one 480px view. y is 200,
      // not the room's middle: a 21-row room is barely taller than the view, so
      // the camera's own bounds clamp scrollY to 66 whatever we ask for, and a
      // number that survives the clamp is the only honest one to write here.
      camera: () => lockCam(gs, 352, 200, WIDE),
      onReveal: () => gs.trailerBanner("CACHE — pick a path", 1000),
      // Walk through the orb, off the dais, then hold: the visible band ends at
      // world x 592 and a subject that strolls out of a LOCKED frame leaves the
      // last half-second of the shot empty.
      script: (t) => solo(inp({ right: t >= 0 && gs.trailerWorld().p1.x < 520 })),
      ticks: 6,
    };
  },
  duration: 1400,
  id: "path-cache",
};

// 7 · ELITE ROOM — every enemy in the room rolls an affix, so the frame is
// wall-to-wall tint-coded threat (blue-grey armored, yellow swift, red brutal),
// and a crit build answers with gold CRIT pops. Hearts on: the hit he takes here
// is meant to cost something.
const eliteCrits: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 3,
      depth: 5,
      fgTrees: false,
      hearts: 4,
      hero: "riven",
      hud: { banner: true, hearts: true },
      // dmg 4, not 2: armored elites carry dmgTakenMult 0.45 on 4 HP, so at 2 a
      // full 2.6s of Riven's fastest combo killed ONE of them. At 4 a plain hit
      // is 2 and a crit one-shots — which is the crit build the beat advertises.
      // (Kept at 4 kills in ~1.3s, so the shot no longer outlives its own room.)
      mods: { crit: 0.55, critMult: 2, dmg: 4 },
      noEnemies: true,
      playerAt: { x: 330, y: FLOOR_Y },
      room: "elite",
      seed: 109,
    });
    // All four are melee: spearmen are `charger` behaviour and a charge is
    // 200px of straight line, so an affixed spearman leaves a 240px frame and
    // takes its tint with it. Warriors close and hold, which is what "the whole
    // room is elite" needs to look like.
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
      camera: () => followCam(gs, -24, 4),
      onReveal: () => gs.trailerBanner("ELITE", 900),
      script: (t) => {
        const dx = foeDx(gs);
        return solo(
          inp({
            // t >= 0: a swing during the pre-roll spends the shot's first kill
            // behind the cut, and at this damage every clean hit is a kill.
            attackPressed: swing(t, t >= 0 && Math.abs(dx) < 30),
            left: dx < -26,
            right: dx > 26,
            // Blink as what it is — a gap-closer — rather than on a timer that
            // teleported him away from the last elite standing.
            specialPressed: press("blink", t >= 900 && Math.abs(dx) > 56),
          }),
        );
      },
      // 26 pre-roll ticks (~0.43s): the elites' aggro walk is already in motion
      // on frame one, so the shot opens mid-brawl rather than at a standoff —
      // but not so long that the first kill happens behind the cut.
      ticks: 26,
    };
  },
  duration: 2300,
  id: "elite-crits",
};

// 8 · MOVEMENT TECH — the traversal kit with no combat in it: wall slide down
// the arena wall, wall-kick out of it, run out, air-dash away. Doors hidden —
// an active gate outshouts the hero in this room.
const movementTech: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 1,
      fgTrees: false,
      // Mooni for the light sprite: Moonwood's mid-grey wall swallows the dark
      // heroes, and this is the one beat with no hit flash to find them by.
      hero: "mooni",
      hideDoors: true,
      noEnemies: true,
      // Staged airborne against the left wall so the shot OPENS on the slide.
      playerAt: { x: 26, y: 236 },
      room: "start",
      seed: 102,
    });
    const press = presser();
    return {
      camera: () => followCam(gs, -70, 8),
      script: (t) => {
        const b = gs.trailerWorld().p1.body;
        return solo(
          inp({
            dashPressed: press("dash", t >= 1400),
            jumpHeld: (t >= 240 && t < 560) || (t >= 900 && t < 1160),
            jumpPressed:
              press("wallkick", t >= 240 && b.wallDir !== 0) ||
              press("hop", t >= 900 && b.grounded),
            // hold into the wall: that's what sustains the slide
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

// 9 · STOMP CHAIN — the TowerFall verb: no attack button at all, just fall on
// their heads. Each landing does 2, bounces 300 up, and carries into the next.
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
      // The hand-authored room, in the open span between its left step (solid
      // out to x 256) and its right ledge (starts at 496): a proc-gen room puts
      // platforms at bounce height and the chain lands on tiles instead of
      // heads. Dropped clear of the step and just short of the first head, so
      // the opening stomp lands ON camera rather than during the pre-roll.
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
        // Tall deadzone: the chain arcs 40px a hop, and a tight vertical follow
        // pumps the frame up and down with it and drops the floor out of shot.
        gs.cameras.main.setDeadzone(18, 44);
      },
      // Air-steer onto the next head instead of holding right blindly: a stomp
      // bounce carries ~130px while the heads sit ~85px apart and walk toward
      // you, so an open-loop run overshoots head 3 and the chain dies at x2.
      // Asymmetric deadband because air momentum lags the input: stop pushing
      // while the head is still 14px out, then brake with `left` once inside 4,
      // or the last few frames of accel carry him past the 15px stomp window.
      script: (t) => {
        const dx = foeDx(gs);
        const { grounded } = gs.trailerWorld().p1.body;
        return solo(
          inp({
            jumpHeld: true,
            // A bounce that lands short would otherwise end the chain on the
            // floor; hop back onto the next head instead.
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

// 10 · CO-OP LAST STAND — the real last-stand sim: Mooni is already down when
// the shot opens (the pre-roll eats the walk-up), Axion fights through the
// ambush, holds the ring to fill the revive bar, and Mooni answers with a heal.
// Shared hearts on: one row, two players.
const coopRevive: Beat = {
  build: (gs) => {
    gs.trailerStage({
      biome: 3,
      hearts: 1,
      hero: "axion",
      hero2: "mooni",
      // Start rooms are auto-cleared, so the exit door renders as an ACTIVE
      // pink FIGHT gate mid-frame — hide it, the revive is the subject.
      hideDoors: true,
      hud: { banner: true, hearts: true },
      mods: { dmg: 2 },
      noEnemies: true,
      player2At: { x: 620, y: FLOOR_Y },
      // 40px closer than the ambush needs: the whole down → clear → hold →
      // REVIVED → +HP chain has to fit, and every 100px of approach is 0.4s the
      // payoff doesn't get.
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
      camera: () => followCam(gs, -40, 0),
      during: () => {
        // Arm 100% ward the moment the down actually lands (closed-loop, not a
        // timer — a timer could beat the fatal hit and WARD-block the down
        // itself): the rescuer can be pressured (WARD pops) but a stray hit can
        // never wipe the staged last stand.
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
          // Close on the downed ally, then hold the overlap: the revive meter
          // only fills while the rescuer is inside the ring.
          right: t < 0 ? false : dx > 12,
        });
        const p2Downed = down !== null && down.body.downed;
        const p2 = inp({
          // brave whiff into the ambush
          attackPressed: press("b1", t < 0),
          // Armed off the revive EDGE, not a clock: she is down from frame one,
          // so !downed first goes true on the frame she gets up, whenever the
          // fight in front of her actually ends. A fixed 2600ms fired after the
          // revive on a fast run and never on a slow one.
          specialPressed: press("heal", t >= 0 && !p2Downed),
        });
        return { p1, p2 };
      },
      // ~1.6s of pre-roll: the ambush, the fatal hit and the down have all
      // already happened when the cut opens, instead of a lone hero walking.
      ticks: 95,
    };
  },
  duration: 3200,
  id: "coop-revive",
};

// 11 · ONLINE VERSUS — mirrored duel staged mid-match (2-2, hearts worn down):
// the host vaults the centre riser into the guest's half, stomp + finisher take
// the round. Both fighters are local bodies through the real VersusMatch
// machine. The arena floor is cut into four pens by the two side ledges and the
// riser (all head-height above a standing body), so crossing it is a jump —
// hence the stall-jumper below rather than a straight walk.
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
      // The duel stage is only 17 rows: centre LOW or the camera's own bounds
      // clamp leaves both fighters standing under the bottom edge.
      camera: () => lockCam(gs, 256, 205),
      script: (t) => {
        const w = gs.trailerWorld();
        const { p2 } = w;
        if (!p2 || w.vs?.phase !== "fighting") {
          return { p1: inp(), p2: inp() };
        }
        const dx = p2.x - w.p1.x;
        const adx = Math.abs(dx);
        const host = inp({
          // Swing when the opponent is actually hittable, not on a schedule: a
          // landed hit grants 0.9s of i-frames and a swing runs ~0.8s, so a
          // fixed cadence spends most of its presses on an invulnerable target.
          // Two clean hits take the round (the duel is staged at 2 hearts).
          attackPressed: swing(t, t > 600 && adx < 40 && p2.body.iframes <= 0),
          // holding is what makes a hop a full jump, not a stub
          jumpHeld: true,
          // The riser splits the arena floor into pens: walking at the opponent
          // only ever reaches its face, so the approach itself has to clear it.
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
      // The duelists spawn 144px apart; 30 ticks of approach opens the shot on
      // an exchange rather than a standing start.
      ticks: 30,
    };
  },
  duration: 2600,
  id: "versus-duel",
};

// 12 · ROGUELITE HONESTY, part 1 — overwhelmed and killed on screen, early
// enough that the death banner (score + the shards the run banks) holds. The
// hero is deliberately under-powered here: this room wins.
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
      camera: () => followCam(gs, 0, 0),
      script: (t) => solo(inp({ attackPressed: swing(t, Math.abs(foeDx(gs)) < 30) })),
      ticks: 10,
    };
  },
  // Death lands ~0.85s in and `state = "dead"` stops the sim dead — the room
  // behind the banner is a freeze-frame from that moment on, so the shot holds
  // the yield just long enough to read and cuts before the stillness registers.
  duration: 1450,
  id: "death-forge",
};

// 12b · ROGUELITE HONESTY, part 2 — instant new-run drop-in: fresh hero, depth
// 1, the first kill of the next descent already landing. Run info HUD on so the
// reset reads (MOONWOOD 1 · DEPTH 1 · everything back to zero).
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
    // Two, spaced a dash apart: one warrior at 196 died inside the first 100ms
    // and left 1.1s of a lone hero jogging through an empty room.
    gs.trailerSpawnEnemy("warrior", 244, FLOOR_Y);
    gs.trailerSpawnEnemy("warrior", 430, FLOOR_Y);
    const press = presser();
    const swing = repeater(240);
    return {
      camera: () => followCam(gs, -56, 6),
      script: (t) =>
        solo(
          inp({
            attackPressed: swing(t, Math.abs(foeDx(gs)) < 30),
            dashPressed: press("d", t >= 700),
            right: true,
          }),
        ),
      // ~0.4s of run-up: enough that the hero is at speed on the reveal, short
      // enough that the first kill still lands on camera.
      ticks: 24,
    };
  },
  duration: 1200,
  id: "death-rebirth",
};

// 13-15 · THE LORDS — three of the five biome bosses, one per attack pattern
// and one per camera grammar: Cinderking's flame fan (locked wide), Rimewarden's
// phase flip (follow, the fight's only structural beat), Blightmaw's arena
// charge. Axion runs the gauntlet; the fifth Lord is saved for the climax.
const stageBoss = (
  gs: GameScene,
  biome: number,
  seed: number,
  playerX: number,
  hearts = 4,
): void => {
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
const bossBannerOnReveal =
  (gs: GameScene): (() => void) =>
  // 600ms, not the full shot: the name is context, the Lord is the subject.
  () => {
    const { boss } = gs.trailerWorld();
    if (boss) {
      gs.trailerBanner(boss.body.kind.banner, 600);
    }
  };
const forceBoss = (gs: GameScene, state: "idle" | "wave" | "jump" | "charge" | "punch"): void => {
  const { boss } = gs.trailerWorld();
  if (boss && !boss.body.dead) {
    boss.body.forceState(state);
  }
};

// Lord 2 — Cinderking's triple flame fan at staggered heights; hero leaps the
// low wave. Locked wide so the whole fan travels through frame.
const bossFan: Beat = {
  build: (gs) => {
    stageBoss(gs, 2, 111, 262);
    // skip the intro pose: it walks at the hero, eating the shot
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();
    return {
      camera: () => lockCam(gs, 340, 300),
      during: (t) => {
        if (cue("wave", t >= 40)) {
          forceBoss(gs, "wave");
        }
      },
      onReveal: bossBannerOnReveal(gs),
      script: (t) =>
        solo(
          // The fan emits 0.5s into the wind-up and crosses the 146px gap in
          // ~0.8s, so the leap is timed to the waves, not to the cast.
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

// Lord 3 — RIMEWARDEN, the phase flip: two hits cross 50% HP, the Lord white-
// flashes into its 0.6s invulnerable phase state, and its archers materialise
// under the game's own REINFORCEMENTS banner before the barrage resumes.
const bossPhase: Beat = {
  build: (gs) => {
    stageBoss(gs, 3, 112, 360);
    const { boss } = gs.trailerWorld();
    if (boss) {
      // maxHp 70: five over the halfway mark, so the SECOND scripted swing
      // trips the phase through the real takeHit path.
      boss.body.hp = Math.floor(boss.body.maxHp / 2) + 5;
      boss.body.forceState("idle");
    }
    const cue = presser();
    const swing = repeater(320);
    return {
      camera: () => followCam(gs, -30, 0),
      during: (t) => {
        const b = gs.trailerWorld().boss;
        // Once the adds are in, let the Lord open on them: a fan across its own
        // reinforcements is the picture the beat exists for.
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

// Lord 4 — Blightmaw's 300px/s arena charge, ghost-trailed so the lunge reads
// as a lunge; hero jumps it and drifts out into open frame.
const bossCharge: Beat = {
  build: (gs) => {
    stageBoss(gs, 4, 113, 236);
    forceBoss(gs, "idle");
    const press = presser();
    const cue = presser();
    return {
      camera: () => followCam(gs, 30, -8),
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
        // Jump the lunge when it's actually arriving (closed-loop): the wind-up
        // is 0.4s and the body-check is only live for the 0.42s after it.
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

// 16 · CLIMAX — VOID SOVEREIGN at a sliver of HP in phase two. Survive the
// leap-slam, close in, chain into the super-smash: hitstop, 420ms shake, gold
// burst, "VOID SOVEREIGN SLAIN". Then the room's own checkClear lights the exit
// and calls DESCEND — the loop closes on the frame the trailer ends on.
const bossKill: Beat = {
  build: (gs) => {
    stageBoss(gs, 5, 119, 300);
    const { boss } = gs.trailerWorld();
    if (boss) {
      // maxHp 120 — the bar opens on a sliver
      boss.body.hp = 6;
      boss.body.phase = 2;
      boss.body.forceState("idle");
    }
    const press = presser();
    const cue = presser();
    const ground = repeater(400);
    const swing = repeater(300);
    return {
      camera: () => followCam(gs, -36, -6),
      during: (t) => {
        if (cue("slam", t >= 80)) {
          forceBoss(gs, "jump");
        }
        // Keep the Lord grounded after its opening slam. Left to its own phase-2
        // rhythm it leaps every 0.5s and the hero never gets inside smash range,
        // which is how the old cut reached its climax without landing a hit.
        const b = gs.trailerWorld().boss;
        if (b && !b.body.dead && ground(t, t >= 900 && b.body.state === "jump")) {
          forceBoss(gs, "idle");
        }
      },
      onReveal: bossBannerOnReveal(gs),
      script: (t) => {
        const w = gs.trailerWorld();
        const b = w.boss;
        // Kill landed: walk on toward the exit. The room's checkClear needs the
        // 0.9s death hold before it lights the gate and calls DESCEND, but the
        // hero starts moving as soon as the explosion's shake decays — waiting
        // for the banner left a full second of a man standing in an empty arena.
        if (!b || b.body.dead) {
          return solo(inp({ right: t >= 2350 }));
        }
        const dx = b.body.x - w.p1.x;
        const adx = Math.abs(dx);
        return solo(
          inp({
            attackPressed: swing(t, t >= 1100 && adx < 50),
            dashPressed: press("d1", t >= 640),
            // Back out of the slam's landing ring, then hunt it down. (Hearts
            // stay at 4: this retreat is early enough that the slam misses.)
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

// ── entry ─────────────────────────────────────────────────────────────────────
export const initTrailer = (game: Phaser.Game): void => {
  // The trailer rolls with no user gesture, so mute the synth up front: while
  // muted sfx never even builds an AudioContext, which is the point — tones
  // scheduled against a suspended context pile up and blat all at once when a
  // later gesture resumes it. onGesture below unmutes if the viewer clicks.
  if (!sfx.muted) {
    sfx.toggleMute();
  }
  const poll = window.setInterval(() => {
    const scene = game.scene.getScene("game");
    if (!(scene instanceof GameScene) || !game.scene.isActive("game")) {
      return;
    }
    window.clearInterval(poll);
    // hold the boot room still through the lead-in black
    scene.trailerFreeze(9999);
    runTrailer({
      onGesture: () => {
        if (sfx.muted) {
          sfx.toggleMute();
        }
        sfx.unlock();
      },
      scenes: BEATS.map((b) => toScene(scene, b)),
      // keeps the pixel art crisp edge to edge,
      vignette: false,
    });
  }, 80);
};
