// trailer-director.ts — STARFALL trailer mode (?trailer=1).
//
// The shell (trailer-shell.ts) owns the letterbox/cards/cuts; this file owns
// the game: it installs the staging overrides (GameScene.trailerStage()),
// forces the offline solo session, and choreographs the 12-scene escalation
// arc from the beat sheet. Every scene's setup() fully re-stages the world —
// no scene depends on RNG luck, the network, or a previous scene's state.
//
// Escalation contract (the product): on-screen entity count grows scene over
// scene — 4 → 20 → 26+ → wave+squad → 46 → boss+horde — and the camera
// language changes every shot (follow, tight, fixed, pull-back, wide, locked
// midpoint, drift-in) so no two consecutive scenes read the same.

import type Phaser from "phaser";
import type { Player, PlayerMap } from "@vibedgames/multiplayer";

import { sfx } from "../audio/sfx";
import { GameScene } from "../scenes/game-scene";
import { ENEMY_SPECS } from "../shared/constants";
import type { EnemyKind, EnemyState, SerializedBeam, Vec } from "../shared/constants";
import { runTrailer } from "./trailer-shell";
import type { TrailerScene } from "./trailer-shell";
import type { TrailerStageApi } from "./trailer-staging";

const TAU = Math.PI * 2;

/** Deterministic per-scene jitter (never the game RNG — staging layouts stay
 *  identical across replays regardless of how much rand() the sim consumed). */
function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const angleTo = (from: Vec, to: Vec): number => Math.atan2(to.y - from.y, to.x - from.x);
/** Wrap an angle difference into [-π, π]. */
const wrapAngle = (a: number): number => {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r < -Math.PI) r += TAU;
  return r;
};
const dist = (a: Vec, b: Vec): number => Math.hypot(a.x - b.x, a.y - b.y);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.max(0, Math.min(1, t));
/** Smoothstep ease for zoom/camera glides. */
const ease = (t: number): number => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

// ---- fake peers (scenes 8 + 12) --------------------------------------------------
// Offline "remote players": Player entries whose state records feed the real
// peer pipeline (readNetState → ship gfx, shield rings, remote beams, enemy
// targeting, beacon occupancy, sector standings). Bolts they fire are visual
// SerializedBeams paired with real damageEnemy() calls so kills produce the
// genuine death FX + loot.

type Bolt = { x: number; y: number; vx: number; vy: number; traveled: number };

type FakePeer = {
  player: Player;
  state: Record<string, unknown>;
  post: Vec;
  orbitR: number;
  angVel: number;
  phase0: number;
  baseAim: number;
  level: number;
  score: number;
  tint: number;
  nextShotAt: number;
  bolts: Bolt[];
  x: number;
  y: number;
  angle: number;
};

const PEER_COLORS = ["#7ae0ff", "#ff7ad1", "#8dff9e", "#c9a2ff", "#ffd166"];
const PEER_TINTS = [0x7ae0ff, 0xff7ad1, 0x8dff9e, 0xc9a2ff, 0xffd166];
const BOLT_SPEED = 560;
const BOLT_RANGE = 740;
const BOLT_DAMAGE = 26; // one-shots fodder (drone 20 / wasp 25), like a beam hit

const show = (node: HTMLElement | null, on: boolean): void => {
  if (node) node.style.display = on ? "" : "none";
};

export function bootTrailerDirector(game: Phaser.Game): void {
  const tryBoot = (): void => {
    const scene = game.scene.getScene("Game");
    if (scene instanceof GameScene && game.scene.isActive("Game")) {
      direct(scene);
      return;
    }
    window.setTimeout(tryBoot, 60);
  };
  tryBoot();
}

function direct(scene: GameScene): void {
  const api: TrailerStageApi = scene.trailerStage();
  const staging = api.staging;
  const cam = scene.cameras.main;

  // Straight into the offline solo arena — no start overlay, no attract mode.
  api.forceStart();

  // The shell's click gate is the audio gesture: unmute for this session only
  // (direct field write — toggleMute would persist the choice) and build the
  // AudioContext inside the gesture so SFX play from scene 1.
  window.addEventListener(
    "pointerdown",
    () => {
      sfx.muted = false;
      sfx.unlock();
    },
    { capture: true, once: true },
  );

  // ---- HUD policy -----------------------------------------------------------------
  // Everything hidden by default; scenes restore only what sells the shot
  // (level-up loadout pop, boss bar, sector tally). Canvas-side HUD (minimap,
  // edge pips) is suppressed by the trailer guards inside game-scene.
  const hud = {
    root: document.getElementById("hud"),
    left: document.querySelector<HTMLElement>("#hud > div:first-of-type"),
    right: document.getElementById("hudright"),
    players: document.getElementById("players"),
    boss: document.getElementById("bossbar"),
    combo: document.getElementById("combo"),
    pulse: document.getElementById("pulse"),
    recap: document.getElementById("recap"),
  };
  const hudBaseline = (): void => {
    show(hud.root, false);
    show(hud.boss, false);
    show(hud.combo, false);
    show(hud.pulse, false);
    show(hud.recap, false);
    show(hud.left, true);
    show(hud.right, true);
    show(hud.players, true);
  };
  hudBaseline();

  // ---- shared choreography state ----------------------------------------------------
  const camLock: Vec = { x: 0, y: 0 };
  let crew: FakePeer[] = [];
  let peerMap: PlayerMap | null = null;

  const steer = (angle: number, thrust: number): void => {
    staging.steer = { angle, thrust };
  };
  const anchor = (dx: number, dy: number): Vec => {
    const { w, h } = api.worldSize();
    return { x: w / 2 + dx, y: h / 2 + dy };
  };
  /** Shield floor: staged crowds land real hits (arcs, flashes, sfx) but can
   *  never chain into an unscripted death. The floor tops up once per rAF, yet
   *  within one sim step enemy shots bypass contact i-frames and stack — e.g.
   *  sniper 55 + drone 30 = 85, lancer 80 + anything ≥ 5 — and any hit that
   *  zeroes the shield kills. Default 85 covers the sparse scenes (heaviest
   *  single hit is lancer 80); dense bullet-weather scenes pass 130 (the
   *  setShieldHp overheal clamp), which survives 80+30 and 55+30+30. */
  const floorShield = (min = 85): void => {
    const p = api.player();
    if (p.alive && p.shieldHp < min) api.setShieldHp(min);
  };
  const nearestEnemy = (
    from: Vec,
    maxD: number,
    exclude?: (e: Readonly<EnemyState>) => boolean,
  ): Readonly<EnemyState> | null => {
    let best: Readonly<EnemyState> | null = null;
    let bestD = maxD;
    for (const e of api.enemies()) {
      if (exclude?.(e)) continue;
      const d = Math.hypot(e.x - from.x, e.y - from.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  };
  /** Ring of enemies around a center, aimed at a target — the staple crowd. */
  const spawnRing = (
    rnd: () => number,
    kinds: readonly EnemyKind[],
    count: number,
    center: Vec,
    rMin: number,
    rMax: number,
    aimAt: Vec,
    arc?: { from: number; to: number },
  ): void => {
    for (let i = 0; i < count; i++) {
      const span = arc ? arc.to - arc.from : TAU;
      const base = arc ? arc.from : 0;
      const ang = base + (span * (i + 0.5)) / count + (rnd() - 0.5) * (span / count) * 0.8;
      const r = rMin + rnd() * (rMax - rMin);
      const kind = kinds[i % kinds.length] ?? "drone";
      api.spawnEnemy(kind, center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r, aimAt);
    }
  };
  const spawnShardRing = (rnd: () => number, center: Vec, count: number, rMax: number): void => {
    for (let i = 0; i < count; i++) {
      const ang = (TAU * (i + 0.5)) / count + (rnd() - 0.5) * 0.5;
      const r = rMax * (0.7 + 0.3 * rnd());
      api.spawnShards(1, center.x + Math.cos(ang) * r, center.y + Math.sin(ang) * r);
    }
  };

  // ---- fake-peer crew ---------------------------------------------------------------
  const addPeer = (
    id: string,
    colorIdx: number,
    post: Vec,
    opts: {
      orbitR: number;
      angVel: number;
      phase0: number;
      baseAim: number;
      level: number;
      score: number;
    },
  ): void => {
    const state: Record<string, unknown> = {
      x: post.x,
      y: post.y,
      angle: opts.baseAim,
      vx: 0,
      vy: 0,
      alive: true,
      present: true,
      level: opts.level,
      shieldHp: 100,
      sectorScore: opts.score,
      weaponName: "BEAM",
      beams: [],
    };
    const player: Player = {
      id,
      color: PEER_COLORS[colorIdx % PEER_COLORS.length] ?? "#7ae0ff",
      state,
    };
    crew.push({
      player,
      state,
      post,
      orbitR: opts.orbitR,
      angVel: opts.angVel,
      phase0: opts.phase0,
      baseAim: opts.baseAim,
      level: opts.level,
      score: opts.score,
      tint: PEER_TINTS[colorIdx % PEER_TINTS.length] ?? 0x7ae0ff,
      nextShotAt: 200 + colorIdx * 90,
      bolts: [],
      x: post.x,
      y: post.y,
      angle: opts.baseAim,
    });
    if (peerMap) peerMap[id] = player;
  };
  const installPeers = (): void => {
    peerMap = { solo: { id: "solo" } };
    staging.peers = peerMap;
  };
  const clearPeers = (): void => {
    crew = [];
    peerMap = null;
    staging.peers = null;
  };
  /** Per-frame crew choreography: orbit the post, face (and in combat, shoot)
   *  the nearest hostile; bolts advance and land REAL damage on contact. */
  const updateCrew = (t: number, dt: number, combat: boolean): void => {
    const dts = dt / 1000;
    for (const b of crew) {
      const phase = b.phase0 + (b.angVel * t) / 1000;
      b.x = b.post.x + Math.cos(phase) * b.orbitR;
      b.y = b.post.y + Math.sin(phase) * b.orbitR;
      const vx = -Math.sin(phase) * b.orbitR * b.angVel;
      const vy = Math.cos(phase) * b.orbitR * b.angVel;
      const target = combat ? nearestEnemy(b, 760) : null;
      b.angle = target ? angleTo(b, target) : b.baseAim;
      if (target && t >= b.nextShotAt) {
        b.nextShotAt = t + 240 + (b.nextShotAt % 7) * 23; // deterministic stagger
        const nose = { x: b.x + Math.cos(b.angle) * 10, y: b.y + Math.sin(b.angle) * 10 };
        b.bolts.push({
          x: nose.x,
          y: nose.y,
          vx: Math.cos(b.angle) * BOLT_SPEED,
          vy: Math.sin(b.angle) * BOLT_SPEED,
          traveled: 0,
        });
      }
      const kept: Bolt[] = [];
      for (const bolt of b.bolts) {
        bolt.x += bolt.vx * dts;
        bolt.y += bolt.vy * dts;
        bolt.traveled += BOLT_SPEED * dts;
        if (bolt.traveled > BOLT_RANGE) continue;
        let hit = false;
        for (const e of api.enemies()) {
          const rad = ENEMY_SPECS[e.kind].hitRadius + 8;
          if (Math.hypot(e.x - bolt.x, e.y - bolt.y) <= rad) {
            api.damageEnemy(e.id, BOLT_DAMAGE);
            hit = true;
            break;
          }
        }
        if (!hit) kept.push(bolt);
      }
      b.bolts = kept;
      // Publish this frame's pose + bolts through the real wire schema.
      const beams: SerializedBeam[] = b.bolts.map((bolt) => {
        const inv = 1 / BOLT_SPEED;
        return {
          hx: bolt.x,
          hy: bolt.y,
          tx: bolt.x - bolt.vx * inv * 14,
          ty: bolt.y - bolt.vy * inv * 14,
          tint: b.tint,
          width: 1,
          exploding: false,
          explosionRadius: 0,
          power: 0.25,
        };
      });
      b.state["x"] = b.x;
      b.state["y"] = b.y;
      b.state["angle"] = b.angle;
      b.state["vx"] = vx;
      b.state["vy"] = vy;
      b.state["beams"] = beams;
    }
  };

  /** Common scene opener: baseline HUD, wipe the world, unlock the camera. */
  const stage = (): void => {
    hudBaseline();
    api.clearWorld();
    staging.camPos = null;
    staging.steer = null;
    staging.fire = false;
  };
  const sceneReset = (): void => {
    staging.steer = null;
    staging.fire = false;
    staging.camPos = null;
    clearPeers();
  };

  // ==== the 12 scenes ==================================================================

  // -- 1. calm-open — COLD OPEN baseline: one ship, starter BEAM, four fodder.
  // Camera: default follow, zoom 1. Motion pre-rolled (ship already at speed).
  const calmOpen: TrailerScene = {
    id: "calm-open",
    duration: 3000,
    setup: () => {
      stage();
      cam.setZoom(1);
      const a = anchor(-800, -200);
      api.setLevel(1);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 250, vy: 0 });
      // A sparse picket ahead-right — the whole fight fits one screen and the
      // action aims where the ship is already flying.
      api.spawnEnemy("drone", a.x + 520, a.y - 140, a);
      api.spawnEnemy("drone", a.x + 700, a.y + 40, a);
      api.spawnEnemy("drone", a.x + 880, a.y - 60, a);
      api.spawnEnemy("wasp", a.x + 610, a.y + 240, a);
    },
    run: () => {
      const p = api.player();
      const e = nearestEnemy(p, 900);
      if (e) {
        steer(angleTo(p, e), 0.34);
        staging.fire = true;
      } else {
        // Field cleared early: cruise on, cease fire — a beat of open space.
        steer(0, 0.55);
        staging.fire = false;
      }
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 2. level-up — orbs vacuum in, threshold crossed on camera: ring +
  // converge + hull morph + pitched cue. HUD left cluster ON (the loadout pop:
  // BEAM → BEAM Lv2). Camera: tight follow (zoom 1.06) to sell the hull change.
  let s2SecondRing = false;
  const levelUp: TrailerScene = {
    id: "level-up",
    duration: 2500,
    setup: () => {
      stage();
      s2SecondRing = false;
      cam.setZoom(1.06);
      show(hud.root, true);
      show(hud.right, false); // "solo · offline" line stays out of frame
      const a = anchor(600, 260);
      api.setLevel(1, 54); // 4 orbs from the threshold — pops mid-stream
      api.setPlayerPose({ x: a.x, y: a.y, angle: -Math.PI / 2, vx: 0, vy: -60 });
      api.grantBooster("magnet");
      spawnShardRing(mulberry(2), a, 20, 250);
    },
    run: (t) => {
      const wobble = 0.15 * Math.sin(t * 0.002);
      steer(-Math.PI / 2 + wobble, 0.12);
      staging.fire = false;
      if (!s2SecondRing && t >= 1200) {
        s2SecondRing = true;
        spawnShardRing(mulberry(22), api.player(), 18, 240);
      }
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 3. weapon-a — CHAIN REACTOR: cyan lightning web through a converging
  // pack. Card masks the stage; the pack pre-rolls toward the ship during it.
  // Camera: near-fixed hold (brake drift), action right of center.
  const weaponA: TrailerScene = {
    id: "weapon-a",
    duration: 1500,
    card: { title: "LEVEL UP OR DIE" },
    setup: () => {
      stage();
      cam.setZoom(0.95);
      const a = anchor(-400, 250);
      const rnd = mulberry(3);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 70, vy: 0 });
      api.grantWeapon("CHAIN REACTOR");
      // Distances budget the 1400ms card: drones close ~100px, wasps ~340px
      // while masked, so the reveal lands with the pack just entering range.
      for (let i = 0; i < 6; i++) {
        api.spawnEnemy("drone", a.x + 590 + rnd() * 110, a.y - 170 + rnd() * 340, a);
      }
      for (let i = 0; i < 3; i++) {
        api.spawnEnemy("wasp", a.x + 880 + rnd() * 100, a.y - 150 + rnd() * 300, a);
      }
      for (let i = 0; i < 4; i++) {
        api.spawnEnemy("drone", a.x + 820 + rnd() * 80, a.y - 120 + rnd() * 240, a);
      }
    },
    run: () => {
      const p = api.player();
      const e = nearestEnemy(p, 900);
      if (e) steer(angleTo(p, e), 0.06);
      else steer(0, 0.1);
      // Arc is hitscan with a 460px cast range — hold fire until a target is
      // inside it so every trigger is a full-screen web, never a fizzle.
      staging.fire = e !== null && dist(p, e) <= 440;
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 4. weapon-b — SEEKER SWARM: six staggered pink homing missiles curving
  // into scattered orbiters. Different composition (diagonal, up-right) and
  // firing pattern from scene 3's horizontal web.
  const weaponB: TrailerScene = {
    id: "weapon-b",
    duration: 1500,
    setup: () => {
      stage();
      cam.setZoom(0.95);
      const a = anchor(900, -300);
      const rnd = mulberry(4);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: -0.6, vx: 40, vy: -30 });
      api.grantWeapon("SEEKER SWARM");
      // A fan of wasps in the upper-right quadrant — live orbiting targets so
      // the missiles visibly CURVE instead of flying straight.
      for (let i = 0; i < 7; i++) {
        const ang = -0.17 - (i / 6) * 1.22 + (rnd() - 0.5) * 0.12;
        const r = 300 + rnd() * 140;
        api.spawnEnemy("wasp", a.x + Math.cos(ang) * r, a.y + Math.sin(ang) * r, a);
      }
      api.spawnEnemy("drone", a.x + 360, a.y - 80, a);
      api.spawnEnemy("drone", a.x + 240, a.y - 300, a);
    },
    run: () => {
      const p = api.player();
      const e = nearestEnemy(p, 900);
      if (e) steer(angleTo(p, e), 0.12);
      else steer(-0.6, 0.15);
      staging.fire = e !== null && dist(p, e) <= 420; // inside homing acquire range
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 5. weapon-c — SUPERNOVA: the rule-of-three closer. A ring closes on the
  // ship, the 500ms charge glow swells (quiet beat), then the 360px screen-
  // clear ring deletes the crowd — 14 simultaneous kill bursts of trauma.
  const weaponC: TrailerScene = {
    id: "weapon-c",
    duration: 1500,
    setup: () => {
      stage();
      cam.setZoom(0.9);
      const a = anchor(-100, 0);
      const rnd = mulberry(5);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: -Math.PI / 2, vx: 0, vy: 0 });
      api.grantWeapon("SUPERNOVA");
      spawnRing(rnd, ["drone", "drone", "wasp"], 14, a, 350, 470, a);
      // Second wave marches in from farther out — survivors crossing the
      // blast ring keep the frame alive after the payoff.
      spawnRing(rnd, ["drone"], 8, a, 780, 870, a);
    },
    run: (t) => {
      steer(-Math.PI / 2 + t * 0.0002, 0.02); // slow pivot; nose glow readable
      staging.fire = true; // held: real windup → blast at ~520ms
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 6. escalation-1 — the crowd doubles. Kiting arc: thrust away, flip,
  // rake the chasers with the Lv3 fan, flip back. Camera eases back the whole
  // scene (0.85 → 0.72) to reveal how much arena the swarm fills.
  let s6Reinforced = false;
  const escalation1: TrailerScene = {
    id: "escalation-1",
    duration: 3500,
    setup: () => {
      stage();
      s6Reinforced = false;
      cam.setZoom(0.85);
      const a = anchor(-400, 150);
      const rnd = mulberry(6);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 240, vy: 0 });
      // Chase pack behind-left; wasps pace the ship, drones string into a
      // comet tail as the arc opens up.
      spawnRing(rnd, ["drone"], 18, a, 500, 850, a, { from: Math.PI * 0.55, to: Math.PI * 1.45 });
      spawnRing(rnd, ["wasp"], 6, a, 400, 700, a, { from: Math.PI * 0.6, to: Math.PI * 1.4 });
      api.spawnEnemy("splitter", a.x - 600, a.y - 120, a);
      api.spawnEnemy("splitter", a.x - 640, a.y + 160, a);
    },
    run: (t) => {
      cam.setZoom(lerp(0.85, 0.72, ease(t / 3500)));
      const p = api.player();
      if (!s6Reinforced && t >= 1600) {
        s6Reinforced = true;
        // The count visibly doubles mid-shot: a cut-off group ahead.
        spawnRing(mulberry(66), ["drone"], 10, p, 700, 900, p, { from: -0.9, to: 0.9 });
      }
      const dir = t * 0.00016; // heading bends gently downrange over the shot
      const cycle = t % 760;
      if (cycle < 460) {
        steer(dir, 0.8); // run
        staging.fire = false;
      } else {
        const e = nearestEnemy(p, 700);
        steer(e ? angleTo(p, e) : dir + Math.PI, 0.05); // the kite flip
        staging.fire = true;
      }
      floorShield(130); // dense chase pack: same-frame shot stacking
    },
    teardown: sceneReset,
  };

  // -- 7. elite-spike — a LANCER carves through the fodder screen: red windup
  // telegraph, 640px/s charge, sidestep dodge (near-miss), then focused fire
  // drops it in a burst + loot. Camera: tight duel follow.
  let s7 = { lancerId: "", dodged: false, dodgeUntil: -1, finished: false };
  const eliteSpike: TrailerScene = {
    id: "elite-spike",
    duration: 3000,
    setup: () => {
      stage();
      s7 = { lancerId: "", dodged: false, dodgeUntil: -1, finished: false };
      cam.setZoom(1);
      const a = anchor(-900, 100);
      const rnd = mulberry(7);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 60, vy: 0 });
      for (let i = 0; i < 8; i++) {
        api.spawnEnemy("drone", a.x + 380 + rnd() * 270, a.y - 220 + rnd() * 440, a);
      }
      s7.lancerId = api.spawnEnemy("lancer", a.x + 620, a.y, a);
      // Level-3 stamp is ~970hp (a ~1.6s point-blank melt); trim it so the
      // duel resolves inside the shot with margin for the dodge.
      api.setEnemyHp(s7.lancerId, 560);
    },
    run: (t) => {
      const p = api.player();
      const lancer = api.enemies().find((e) => e.id === s7.lancerId && e.hp > 0);
      const charging = lancer !== undefined && Math.hypot(lancer.vx, lancer.vy) > 400;
      if (charging && !s7.dodged) {
        s7.dodged = true;
        s7.dodgeUntil = t + 380;
      }
      if (t < s7.dodgeUntil) {
        // Sidestep across the charge line — the near-miss beat.
        if (lancer) steer(angleTo(p, lancer) + Math.PI / 2, 1);
        staging.fire = false;
      } else if (lancer) {
        const opener = t < 600 ? nearestEnemy(p, 500, (e) => e.kind === "lancer") : null;
        const target = opener ?? lancer;
        steer(angleTo(p, target), 0.08);
        staging.fire = true;
        if (t > 2700 && !s7.finished) {
          s7.finished = true;
          api.damageEnemy(lancer.id, lancer.hp + 10); // guarantee the burst before the cut
        }
      } else {
        const e = nearestEnemy(p, 700);
        steer(e ? angleTo(p, e) : 0, 0.2);
        staging.fire = e !== null;
      }
      floorShield();
    },
    teardown: sceneReset,
  };

  // -- 8. beacon-event — the squad holds the zone. Camera locked WIDE on the
  // beacon (not the player): arm-flash ~600ms in, gold control ring + motes,
  // five staged wingmates on the perimeter pouring crossfire into the wave.
  let s8 = { beacon: { x: 0, y: 0 }, wave2: false, wave3: false };
  const beaconEvent: TrailerScene = {
    id: "beacon-event",
    duration: 4500,
    card: { title: "HOLD THE BEACON" },
    caption: "32-PLAYER ONLINE",
    setup: () => {
      stage();
      const b = anchor(0, -250);
      s8 = { beacon: b, wave2: false, wave3: false };
      cam.setZoom(0.78);
      camLock.x = b.x;
      camLock.y = b.y;
      staging.camPos = camLock;
      api.setLevel(3);
      // Me inside the zone (sole occupant → controller: motes stream my way).
      api.setPlayerPose({ x: b.x - 40, y: b.y + 150, angle: -Math.PI / 2, vx: -40, vy: 0 });
      api.spawnBeacon(b.x, b.y, 2, 40); // arm flash lands ~600ms after reveal
      installPeers();
      for (let i = 0; i < 5; i++) {
        const ang = Math.PI / 2 + (TAU * i) / 5;
        const post = { x: b.x + Math.cos(ang) * 505, y: b.y + Math.sin(ang) * 505 };
        addPeer(`wing-${i + 1}`, i, post, {
          orbitR: 55,
          angVel: 2.2,
          phase0: ang,
          baseAim: ang, // guard posture: noses outward
          level: 2 + (i % 2),
          score: 150 + i * 40,
        });
      }
      const rnd = mulberry(8);
      // Wave distances budget the card: at reveal the first drones are just
      // crossing the wingmates' fire lanes, wasps arcing in behind them.
      spawnRing(rnd, ["drone"], 8, b, 620, 780, b);
      spawnRing(rnd, ["drone"], 4, b, 880, 950, b);
      spawnRing(rnd, ["wasp"], 6, b, 1150, 1400, b);
    },
    run: (t, dt) => {
      updateCrew(t, dt, true);
      if (!s8.wave2 && t >= 1500) {
        s8.wave2 = true;
        spawnRing(mulberry(88), ["wasp"], 6, s8.beacon, 800, 950, s8.beacon);
      }
      if (!s8.wave3 && t >= 2600) {
        s8.wave3 = true;
        spawnRing(mulberry(888), ["drone"], 8, s8.beacon, 620, 720, s8.beacon);
      }
      // Me: orbit inside the zone; break to aim-fire at the nearest hostile.
      const p = api.player();
      const cycle = t % 900;
      if (cycle < 500) {
        const oa = Math.PI / 2 + t * 0.0009;
        const point = { x: s8.beacon.x + Math.cos(oa) * 210, y: s8.beacon.y + Math.sin(oa) * 210 };
        steer(angleTo(p, point), Math.min(0.9, dist(p, point) / 200));
        staging.fire = false;
      } else {
        const e = nearestEnemy(p, 700);
        steer(e ? angleTo(p, e) : -Math.PI / 2, 0.05);
        staging.fire = e !== null;
      }
      floorShield(130); // wave crossfire + fake-peer PvP bolts stack
    },
    teardown: sceneReset,
  };

  // -- 9. escalation-2 — widest shot of the trailer (0.62): the screen is
  // mostly hostiles, the ship a small dot threading the density. Sniper sight
  // lines + wasp bursts supply the bullet weather.
  const escalation2: TrailerScene = {
    id: "escalation-2",
    duration: 3500,
    setup: () => {
      stage();
      cam.setZoom(0.62);
      const a = anchor(-700, 0);
      const rnd = mulberry(9);
      api.setLevel(3);
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0, vx: 270, vy: 0 });
      spawnRing(rnd, ["drone"], 26, a, 500, 1000, a);
      spawnRing(rnd, ["wasp"], 12, a, 420, 900, a);
      spawnRing(rnd, ["wasp"], 8, a, 330, 420, a); // already in burst range
      spawnRing(rnd, ["sniper"], 4, a, 850, 1050, a);
      api.spawnEnemy("splitter", a.x + 700, a.y - 300, a);
      api.spawnEnemy("splitter", a.x - 650, a.y + 350, a);
      api.spawnEnemy("lancer", a.x + 880, a.y + 200, a);
      api.spawnEnemy("lancer", a.x - 900, a.y - 250, a);
    },
    run: (t) => {
      const p = api.player();
      const heading = 0.85 * Math.sin(t * 0.0036); // serpentine weave east
      const burstWindow = t % 1000;
      if (burstWindow < 240) {
        const e = nearestEnemy(p, 500);
        if (e && Math.abs(wrapAngle(angleTo(p, e) - heading)) < 1.1) {
          steer(angleTo(p, e), 0.5);
          staging.fire = true;
        } else {
          steer(heading, 0.9);
          staging.fire = false;
        }
      } else {
        steer(heading, 0.9);
        staging.fire = false;
      }
      floorShield(130); // heaviest bullet weather of the trailer
    },
    teardown: sceneReset,
  };

  // -- 10. death-beat — the honesty shot. Shield already low, boxed in, a real
  // escape attempt, real hits, real death: shatter + white flash + trauma +
  // DESTROYED overlay + the XP death tax. No shield floor here — on purpose.
  let s10Killed = false;
  const deathBeat: TrailerScene = {
    id: "death-beat",
    duration: 2000,
    setup: () => {
      stage();
      s10Killed = false;
      cam.setZoom(0.8);
      const a = anchor(300, -100);
      const rnd = mulberry(10);
      api.setLevel(2, 30); // mid-level: the tax visibly costs progress
      api.setPlayerPose({ x: a.x, y: a.y, angle: 0.3, vx: 200, vy: -60 });
      api.setShieldHp(30); // two hits from gone
      spawnRing(rnd, ["drone"], 12, a, 210, 300, a);
      spawnRing(rnd, ["wasp"], 8, a, 260, 340, a);
    },
    run: (t) => {
      const p = api.player();
      if (!p.alive) {
        staging.steer = null;
        staging.fire = false;
        return;
      }
      // Escape script: dash for the gap, get cut off, flip — then the burst.
      if (t < 550) steer(0.9, 1);
      else steer(Math.PI + 0.6, 0.95);
      staging.fire = false;
      if (!s10Killed && t > 1150) {
        s10Killed = true; // the swarm usually gets there first; this is the floor
        api.killPlayer("WASP");
      }
    },
    teardown: sceneReset,
  };

  // -- 11. boss-chaos — CLIMAX. Phase-3 DREADNOUGHT (planted, 16-shot novas,
  // mite births) + full horde + PLASMA STORM airbursts on overdrive. Camera
  // locked to the player↔boss midpoint, drifting toward the boss. Boss bar ON.
  let s11 = { bossId: "", nextChip: 0, wave2: false, wave3: false };
  const bossChaos: TrailerScene = {
    id: "boss-chaos",
    duration: 5000,
    setup: () => {
      stage();
      s11 = { bossId: "", nextChip: 600, wave2: false, wave3: false };
      cam.setZoom(0.75);
      show(hud.boss, true);
      const a = anchor(500, 0);
      const rnd = mulberry(11);
      api.setLevel(3);
      const start = { x: a.x, y: a.y + 210, angle: -Math.PI / 2, vx: -120, vy: 0 };
      api.setPlayerPose(start);
      api.grantWeapon("PLASMA STORM");
      api.grantBooster("overdrive");
      s11.bossId = api.spawnEnemy("dreadnought", a.x, a.y - 260, start);
      api.setEnemyHp(s11.bossId, 4300); // ≤33% → phase 3 script from frame one
      // Rings tightened INSIDE the 0.75-zoom frame (~±850px half-width):
      // the old 380-800 spread parked half the horde off-camera and the
      // climax read sparse. More bodies, closer — plasma airbursts land in
      // the thick of them on screen.
      spawnRing(rnd, ["drone", "wasp", "drone"], 30, a, 250, 520, start);
      spawnRing(rnd, ["wasp", "drone"], 14, a, 300, 620, start);
      api.spawnEnemy("warden", a.x - 550, a.y + 80, start);
      api.spawnEnemy("warden", a.x + 560, a.y - 40, start);
      api.spawnEnemy("spawner", a.x + 650, a.y - 150, start);
      api.spawnEnemy("sniper", a.x - 950, a.y - 200, start);
      api.spawnEnemy("sniper", a.x + 930, a.y + 260, start);
      camLock.x = a.x;
      camLock.y = a.y;
      staging.camPos = camLock;
    },
    run: (t) => {
      const p = api.player();
      const boss = api.enemies().find((e) => e.id === s11.bossId);
      // Camera: midpoint, biased ever harder toward the boss (the push-in).
      if (boss) {
        const bias = lerp(0.5, 0.64, ease(t / 5000));
        camLock.x = p.x + (boss.x - p.x) * bias;
        camLock.y = p.y + (boss.y - p.y) * bias;
      }
      if (!s11.wave2 && t >= 1500) {
        s11.wave2 = true;
        spawnRing(mulberry(111), ["drone", "wasp"], 16, p, 480, 680, p);
      }
      if (!s11.wave3 && t >= 3000) {
        s11.wave3 = true;
        spawnRing(mulberry(1111), ["drone", "wasp"], 16, p, 480, 720, p);
      }
      // Orbit under the planted boss; airbursts chew the horde en route, and
      // the aim-breaks plant shells on the hull so the bar visibly drains.
      const cycle = t % 1000;
      if (boss && cycle >= 650) {
        steer(angleTo(p, boss), 0.1);
      } else if (boss) {
        const oa = Math.PI / 2 + t * 0.0011;
        const point = { x: boss.x + Math.cos(oa) * 300, y: boss.y + Math.sin(oa) * 300 };
        steer(angleTo(p, point), Math.min(0.95, Math.max(0.3, dist(p, point) / 200)));
      } else {
        steer(0, 0.4);
      }
      staging.fire = true;
      // Steady chip damage keeps the boss bar falling on camera (the 8s phase
      // floor means it cannot die here — the climax ends at peak, not payoff).
      if (boss && t >= s11.nextChip) {
        s11.nextChip = t + 600;
        api.damageEnemy(boss.id, 130);
      }
      floorShield(130); // boss novas + horde + snipers stack in one step
    },
    teardown: sceneReset,
  };

  // -- 12. survivors — RELEASE. Calm after the storm: the squad regrouped
  // around a fresh beacon, gold motes to the holder, orbs drifting in, the
  // sector tally ticking up. Slow push-in, then the end card.
  const survivors: TrailerScene = {
    id: "survivors",
    duration: 2500,
    setup: () => {
      stage();
      const b = anchor(0, 200);
      cam.setZoom(0.88);
      show(hud.root, true);
      show(hud.left, false);
      show(hud.players, false); // the sector tally line only
      api.setLevel(3);
      api.setShieldHp(100);
      api.setPlayerPose({ x: b.x - 260, y: b.y + 40, angle: 0, vx: 60, vy: 0 });
      api.grantBooster("magnet");
      api.spawnBeacon(b.x, b.y, 1, 45); // soft gold arm-pulse ~1s in
      camLock.x = b.x;
      camLock.y = b.y;
      staging.camPos = camLock;
      installPeers();
      const posts = [0.6, 2.2, 3.8, 5.3];
      const scores = [240, 180, 120, 88];
      for (let i = 0; i < 4; i++) {
        const ang = posts[i] ?? 0;
        const post = { x: b.x + Math.cos(ang) * 470, y: b.y + Math.sin(ang) * 470 };
        addPeer(`squad-${i + 1}`, i, post, {
          orbitR: 22,
          angVel: 0.5,
          phase0: ang,
          baseAim: ang, // parade rest, noses outward
          level: 3,
          score: scores[i] ?? 100,
        });
      }
      // Spoils of the run, strewn along the drift path. The ship crosses
      // ~[-260..-130] at ~50px/s; every cluster sits within the 260px magnet
      // reach of that line so the whole field hoovers in on camera.
      const rnd = mulberry(12);
      const clusters = [
        { x: b.x - 180, y: b.y - 60 },
        { x: b.x - 60, y: b.y + 30 },
        { x: b.x + 30, y: b.y - 90 },
        { x: b.x - 120, y: b.y + 170 },
        { x: b.x + 60, y: b.y + 120 },
      ];
      for (const c of clusters) {
        for (let i = 0; i < 5; i++) {
          api.spawnShards(1, c.x + (rnd() - 0.5) * 90, c.y + (rnd() - 0.5) * 90);
        }
      }
    },
    run: (t, dt) => {
      cam.setZoom(lerp(0.88, 0.97, ease(t / 2500)));
      updateCrew(t, dt, false);
      steer(0.06 * Math.sin(t * 0.001), 0.14);
      staging.fire = false;
      floorShield(100); // pristine — the storm is over
    },
    teardown: sceneReset,
  };

  runTrailer({
    title: "STARFALL",
    url: "starfall.vibedgames.com",
    accent: "#ffd166", // beacon gold
    tagline: "32-player arena shooter",
    fontFamily: "Inter, system-ui, -apple-system, sans-serif",
    // The game draws its own screen vignette (energy-barrier) — stacking the
    // shell's would double-darken the neon edges.
    vignette: false,
    scenes: [
      calmOpen,
      levelUp,
      weaponA,
      weaponB,
      weaponC,
      escalation1,
      eliteSpike,
      beaconEvent,
      escalation2,
      deathBeat,
      bossChaos,
      survivors,
    ],
  });
}
