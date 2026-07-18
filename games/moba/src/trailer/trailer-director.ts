// TRAILER MODE director (?trailer=1) — a scripted, letterboxed gameplay trailer
// staged entirely through the real simulation: real heroes, real creeps, real
// towers, real ability code paths (castAbility / issueOrder / dealDamage), real
// FX drained by the real WorldView. No mocks, no video.
//
// Architecture: `launchTrailer` adds one Phaser scene (TrailerStage) that owns a
// World + WorldView exactly like GameScene does (terrain, structures, fixed-step
// sim, fx, camera trauma) but with a director-driven camera instead of a follow
// cam and no HUD/menus/input. Each trailer scene's setup() swaps in a freshly
// staged world (clear unit views, un-rubble structures, seed, place actors,
// pre-roll the sim so the first visible frame is mid-action), then a cue list
// fires casts/orders/kill-guarantees on the shell's scene clock.
//
// This module is only ever loaded via the ?trailer=1 branch in BootScene —
// zero footprint in normal play.

import Phaser from "phaser";

import { SIM_DT, abilityRankCap } from "../data/config";
import type { CreepKind, Team } from "../data/config";
import type { AbilityKey } from "../data/heroes";
import { NEUTRAL_CAMPS, WORLD } from "../data/map";
import type { LaneId } from "../data/map";
import { castAbility } from "../sim/abilities";
import { dealDamage, updateStructureGating } from "../sim/combat";
import { recomputeHeroStats } from "../sim/herokit";
import { createWorld, issueOrder, spawnCreepAt, spawnHero, step } from "../sim/world";
import type { Unit, World } from "../sim/types";
import { isMuted, resumeAudio, setMutedTransient, sfx } from "../render/audio";
import { FONT } from "../render/font";
import { WorldView } from "../render/view";
import { runTrailer } from "./trailer-shell";
import type { TrailerConfig, TrailerScene } from "./trailer-shell";

const ABILITY_KEYS: AbilityKey[] = ["Q", "W", "E", "R"];

// ---- camera rig --------------------------------------------------------------

type CamPose = { x: number; y: number; z: number };
type Ease = (k: number) => number;
const easeInOut: Ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut: Ease = (k) => 1 - Math.pow(1 - k, 3);

type CamMove = { from: CamPose; to: CamPose; dur: number; t: number; ease: Ease };
/** Clamp a camera centre so a `half`-extent view stays inside [0, max]. */
const clampAxis = (v: number, half: number, max: number): number =>
  half * 2 >= max ? max / 2 : Phaser.Math.Clamp(v, half, max - half);
type CamFollow =
  | { kind: "none" }
  | { kind: "unit"; id: string; k: number }
  | { kind: "fireball"; k: number; lastX: number; lastY: number };

// ---- timeline cues -------------------------------------------------------------

type Cue = { at: number; fn: () => void; fired?: boolean };

type SceneScript = {
  cues?: Cue[];
  frame?: (t: number, dt: number) => void;
  done?: () => void;
};

// ---- the stage scene -----------------------------------------------------------

class TrailerStage extends Phaser.Scene {
  private world!: World;
  private view!: WorldView;
  private acc = 0;
  private labelTimer = 0;
  private pose: CamPose = { x: WORLD.width / 2, y: WORLD.height / 2, z: 0.5 };
  private camMove: CamMove | null = null;
  private camFollow: CamFollow = { kind: "none" };
  private overlay: Phaser.GameObjects.GameObject[] = [];
  /** Frozen between a scene's setup() and its first run() tick. The shell masks
   *  the stage after setup (title card 1400ms + 170ms fade, or a dip-to-black),
   *  and any sim/camera time spent under that mask plays the staged action out
   *  behind black and burns the camera glides set in setup. */
  hold = false;

  constructor() {
    super("TrailerStage");
  }

  create(): void {
    this.view = new WorldView(this);
    this.view.buildTerrain();
    this.view.buildStructures();
    const cam = this.cameras.main;
    cam.roundPixels = true;
    cam.setBackgroundColor("#0a0e16");

    // an ambient world behind the start gate / countdown (no combat)
    this.installWorld(7);
    this.cut(WORLD.width / 2, WORLD.height / 2, this.zMap());

    const veil = document.getElementById("veil");
    if (veil) {
      veil.classList.add("hidden");
      setTimeout(() => veil.remove(), 400);
    }

    runTrailer(buildConfig(this));
  }

  // ---- world staging ----------------------------------------------------------

  /** Swap in a freshly staged world: no scheduled waves/camps, clean unit views,
   *  structures restored. Every trailer scene starts here, so no scene depends on
   *  a previous scene's state (incl. `&loop=1` replays). */
  installWorld(seed: number): World {
    const w = createWorld(seed);
    w.nextWaveAt = Number.POSITIVE_INFINITY;
    for (const c of NEUTRAL_CAMPS) w.campRespawnAt[c.id] = Number.POSITIVE_INFINITY;
    this.view.clearUnitViews();
    this.view.setTarget("");
    this.view.playerHeroId = "";
    this.view.playerTeam = "radiant";
    this.world = w;
    this.view.resetStructures(w);
    this.acc = 0;
    this.camMove = null;
    this.camFollow = { kind: "none" };
    this.clearOverlay();
    return w;
  }

  get worldView(): WorldView {
    return this.view;
  }

  /** Pre-roll the simulation (while the shell masks the stage) so the first
   *  visible frame is mid-action: creeps marching, swings winding, arrows flying. */
  pump(seconds: number): void {
    const steps = Math.max(1, Math.round(seconds / SIM_DT));
    for (let i = 0; i < steps; i++) step(this.world, SIM_DT);
  }

  // ---- camera -------------------------------------------------------------------

  /** The visible 16:9 stage (the shell letterboxes the page to this crop). */
  private stageSize(): { w: number; h: number } {
    const sw = Math.min(this.scale.width, (this.scale.height * 16) / 9);
    return { w: sw, h: (sw * 9) / 16 };
  }
  /** Base zoom (mirrors GameScene's height-derived zoom), scaled per shot. */
  zb(f = 1): number {
    return Phaser.Math.Clamp(this.stageSize().h / 900, 0.45, 1.35) * f;
  }
  /** Zoom at which the full map width fills the 16:9 stage. */
  zMap(): number {
    return this.stageSize().w / WORLD.width;
  }

  cut(x: number, y: number, z: number): void {
    this.pose = { x, y, z };
    this.camMove = null;
    this.camFollow = { kind: "none" };
  }
  glide(x: number, y: number, z: number, durMs: number, ease: Ease = easeInOut): void {
    this.camMove = { from: { ...this.pose }, to: { x, y, z }, dur: durMs, t: 0, ease };
  }
  followUnit(id: string, stiffness = 4): void {
    this.camFollow = { kind: "unit", id, k: stiffness };
  }
  followFireball(stiffness = 9): void {
    this.camFollow = { kind: "fireball", k: stiffness, lastX: this.pose.x, lastY: this.pose.y };
  }
  flash(ms = 150): void {
    this.cameras.main.flash(ms, 255, 244, 214);
  }

  private applyCamera(dt: number): void {
    const m = this.camMove;
    if (m) {
      m.t += dt * 1000;
      const k = m.ease(Math.min(1, m.t / m.dur));
      this.pose = {
        x: Phaser.Math.Linear(m.from.x, m.to.x, k),
        y: Phaser.Math.Linear(m.from.y, m.to.y, k),
        z: Phaser.Math.Linear(m.from.z, m.to.z, k),
      };
      if (m.t >= m.dur) this.camMove = null;
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
    const z = this.pose.z;
    cam.setZoom(z);
    // Clamp the STAGE-visible rect (not the whole window) inside the world so the
    // letterboxed crop never shows void — Phaser's setBounds+zoom clamps wrong at
    // corners, so we clamp scroll manually (see memory: phaser4 camera bounds).
    const { w: sw, h: sh } = this.stageSize();
    const cx = clampAxis(this.pose.x, sw / (2 * z), WORLD.width);
    const cy = clampAxis(this.pose.y, sh / (2 * z), WORLD.height);
    cam.setScroll(cx - cam.width / 2 + this.view.shakeX, cy - cam.height / 2 + this.view.shakeY);
    cam.setRotation(this.view.shakeRot);
  }

  // ---- overlays (victory banner) -------------------------------------------------

  /** The game's own result presentation (ribbon + big word), minus the buttons. */
  showVictoryBanner(): void {
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2 - 50;
    const ribbon = this.add
      .nineslice(
        cx,
        cy,
        "ui-ribbon-yellow",
        0,
        Math.min(560, this.scale.width - 24),
        120,
        58,
        58,
        22,
        22,
      )
      .setScrollFactor(0)
      .setDepth(99998)
      .setScale(0);
    const txt = this.add
      .text(cx, cy - 8, "VICTORY", {
        fontFamily: FONT,
        fontSize: "72px",
        color: "#5a3a10",
        stroke: "#fff3c4",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setScrollFactor(0)
      .setDepth(99999)
      .setScale(0);
    this.tweens.add({ targets: [ribbon, txt], scale: 1, duration: 500, ease: "Back.Out" });
    this.overlay.push(ribbon, txt);
  }

  clearOverlay(): void {
    for (const o of this.overlay) o.destroy();
    this.overlay = [];
  }

  // ---- loop ----------------------------------------------------------------------

  override update(_t: number, deltaMs: number): void {
    if (!this.world) return;
    const dt = Math.min(0.05, deltaMs / 1000);
    // While held (masked by the shell) the sim and camera rig freeze, but the
    // view keeps syncing so the card lifts onto a live, fully-drawn frame.
    if (!this.hold) {
      this.acc += dt;
      let steps = 0;
      while (this.acc >= SIM_DT && steps < 5) {
        step(this.world, SIM_DT);
        this.acc -= SIM_DT;
        steps++;
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

// ---- staging helpers -------------------------------------------------------------

/** Sound is opt-in in normal play; a trailer wants its SFX. The click gate is the
 *  unlock gesture — this runs in every setup so replays stay audible too.
 *  Transient on purpose: toggleMute would persist "1" to localStorage and flip
 *  the player's saved preference for NORMAL play off the back of one trailer
 *  view. This unmute lives and dies with the session. */
function ensureAudio(): void {
  if (isMuted()) setMutedTransient(false);
  resumeAudio();
}

type HeroOpts = {
  level?: number;
  bot?: boolean;
  hpFrac?: number;
  facing?: 1 | -1;
  slot?: number;
};

/** Spawn a hero through the real spawn path, move it to its mark, and stage its
 *  level/ranks/pools (the Showcase pattern: rank via cap, recompute, refill). */
function heroAt(
  w: World,
  defId: string,
  team: Team,
  tag: string,
  x: number,
  y: number,
  o: HeroOpts = {},
): Unit {
  const u = spawnHero(w, defId, team, tag, o.bot ?? false, o.slot ?? 0);
  u.x = x;
  u.y = y;
  u.facing = o.facing ?? (team === "radiant" ? 1 : -1);
  const h = u.hero;
  if (h) {
    const level = o.level ?? 16;
    h.level = level;
    h.abilityPoints = 0;
    h.gold = 0;
    for (const k of ABILITY_KEYS) h.abilities[k].rank = abilityRankCap(k, level);
    recomputeHeroStats(u);
    u.hp = u.maxHp;
    u.mp = u.maxMp;
    if (o.hpFrac !== undefined) u.hp = Math.max(1, u.maxHp * o.hpFrac);
  }
  u.order = { type: "hold" };
  return u;
}

/** A tight pack of staged lane creeps around (x,y), spread down-column. */
function creepPack(
  w: World,
  team: Team,
  lane: LaneId,
  kinds: CreepKind[],
  x: number,
  y: number,
  spreadY = 56,
): Unit[] {
  return kinds.map((k, i) =>
    spawnCreepAt(w, team, lane, k, x + (i % 2) * 34, y + (i - (kinds.length - 1) / 2) * spreadY),
  );
}

/** Open a neutral camp now (createWorld schedules them for 60s/300s in). One sim
 *  step after this, the camp pack stands at its authored spot. */
function openCamp(w: World, campId: string): void {
  w.campRespawnAt[campId] = 0;
}

function campUnits(w: World, campId: string): Unit[] {
  const out: Unit[] = [];
  for (const u of w.units.values()) if (u.creep?.camp === campId && u.alive) out.push(u);
  return out;
}

/** Guarantee a filmed kill through the real damage/death path. */
function finish(w: World, attacker: Unit, victim: Unit | undefined, crit = false): void {
  if (!victim || !victim.alive) return;
  dealDamage(w, attacker, victim, 9999, "physical", { crit });
}

/** Stage a cast that must land: top mana + clear cooldown, then the real cast. */
function forceCast(
  w: World,
  u: Unit,
  key: AbilityKey,
  aim: { point?: { x: number; y: number }; targetId?: string } = {},
): void {
  const h = u.hero;
  if (!h || !u.alive) return;
  u.mp = u.maxMp;
  h.abilities[key].readyAt = 0;
  castAbility(w, u, { key, point: aim.point, targetId: aim.targetId });
}

/** Silently retire a structure during staging (off-screen gating only — filmed
 *  structure kills always go through dealDamage so the destruction FX play). */
function retireStructure(w: World, id: string): void {
  const u = w.units.get(id);
  if (!u || u.kind !== "structure") return;
  u.alive = false;
  u.hp = 0;
  updateStructureGating(w);
}

// ---- scene assembly ----------------------------------------------------------------

function scene(
  stage: TrailerStage,
  id: string,
  duration: number,
  card: { title: string; sub?: string } | undefined,
  build: (s: TrailerStage) => SceneScript,
): TrailerScene {
  let cues: Cue[] = [];
  let frame: SceneScript["frame"];
  let done: SceneScript["done"];
  return {
    id,
    duration,
    card,
    setup: (): void => {
      ensureAudio();
      // build() constructs a fresh cue array per invocation, so replays
      // (&loop=1 / the end-card Replay button) start with unfired cues.
      const r = build(stage);
      cues = r.cues ?? [];
      frame = r.frame;
      done = r.done;
      // Freeze until run()'s first tick: the shell keeps the stage masked
      // after setup, and unheld sim time would play the staging out behind
      // the card and consume glides before the shot is visible.
      stage.hold = true;
    },
    run: (t, dt): void => {
      stage.hold = false;
      for (const c of cues) {
        if (!c.fired && t >= c.at) {
          c.fired = true;
          c.fn();
        }
      }
      frame?.(t, dt);
    },
    teardown: (): void => {
      done?.();
      stage.worldView.setTarget("");
      stage.clearOverlay();
    },
  };
}

// =====================================================================================
// The fifteen scenes
// =====================================================================================

function buildConfig(stage: TrailerStage): TrailerConfig {
  const scenes: TrailerScene[] = [
    // ---- 1 · COLD OPEN — a 2v2 dive under a radiant tower; the dive gets punished.
    scene(stage, "cold-open-skirmish", 4000, undefined, (s) => {
      const w = s.installWorld(11);
      // defenders (our side, screen-left) vs divers (screen-right), under r-top-t1
      const dusk = heroAt(w, "duskblade", "radiant", "co-dusk", 1620, 640, { level: 9 });
      const storm = heroAt(w, "stormcaller", "radiant", "co-storm", 1500, 560, { level: 9 });
      const iron = heroAt(w, "ironvow", "dire", "co-iron", 1840, 620, { level: 9, hpFrac: 0.4 });
      const ember = heroAt(w, "emberhex", "dire", "co-ember", 1960, 540, {
        level: 9,
        hpFrac: 0.85,
      });
      creepPack(w, "radiant", "top", ["melee", "melee", "melee", "ranged"], 1740, 690, 50);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "ranged"], 1900, 660, 50);
      issueOrder(w, dusk, { type: "attackUnit", targetId: iron.id });
      issueOrder(w, storm, { type: "attackUnit", targetId: ember.id });
      issueOrder(w, iron, { type: "attackUnit", targetId: dusk.id }); // tower priority: punished
      issueOrder(w, ember, { type: "attackUnit", targetId: storm.id });
      s.worldView.playerHeroId = dusk.id;
      s.pump(1.2); // swings winding, tower shots already arcing in
      s.cut(1755, 590, s.zb(1.05));
      s.glide(1795, 605, s.zb(1.18), 4000, easeInOut);
      return {
        cues: [
          { at: 350, fn: () => forceCast(w, storm, "Q", { point: { x: 2100, y: 620 } }) },
          { at: 850, fn: () => forceCast(w, ember, "Q", { point: { x: dusk.x, y: dusk.y } }) },
          {
            at: 1450,
            fn: () => {
              forceCast(w, dusk, "Q", { point: { x: ember.x, y: ember.y } });
              issueOrder(w, dusk, { type: "attackUnit", targetId: ember.id });
            },
          },
          { at: 2050, fn: () => forceCast(w, iron, "Q", { targetId: dusk.id }) },
          // the kill: the tower/defenders finish the diving Ironvow around 3.2s
          { at: 2900, fn: () => (iron.hp = Math.min(iron.hp, 55)) },
          { at: 3500, fn: () => finish(w, dusk, w.units.get(iron.id)) },
        ],
      };
    }),

    // ---- 2 · MAP REVEAL — pull back from lane level to the whole two-island war.
    scene(stage, "map-reveal", 2500, undefined, (s) => {
      const w = s.installWorld(12);
      const wave: CreepKind[] = ["melee", "melee", "melee", "melee", "ranged", "ranged"];
      creepPack(w, "radiant", "top", wave, 1100, 580, 40);
      creepPack(w, "dire", "top", wave, 3000, 576, 40);
      creepPack(w, "radiant", "bottom", wave, 1100, 2492, 40);
      creepPack(w, "dire", "bottom", wave, 3000, 2496, 40);
      s.pump(0.9); // everyone mid-march
      // open ON the marching radiant wave (motion in frame one), then pull back
      // until the whole two-island war fits the stage
      s.cut(1250, 720, s.zb(0.9));
      s.glide(WORLD.width / 2, WORLD.height / 2, s.zMap(), 2400, easeInOut);
      return {};
    }),

    // ---- 3 · SIGNATURE SOLO — Boomtinker's full Q-W-E-R string on a jungle camp,
    //          reticle pinned to the gnoll (the beat's "mouse reticle visible").
    scene(stage, "signature-solo", 3000, undefined, (s) => {
      const w = s.installWorld(13);
      openCamp(w, "camp-lb"); // large camp: gnoll + two skulls at (1216, 2016)
      const solo = heroAt(w, "boomtinker", "radiant", "solo", 1100, 2080);
      issueOrder(w, solo, { type: "move", to: { x: 1206, y: 2026 } }); // down the ramp, into the camp
      s.pump(0.55); // camp spawned + aggroed; hero mid-descent
      const gnoll = campUnits(w, "camp-lb").find((u) => u.maxHp >= 700);
      if (gnoll) s.worldView.setTarget(gnoll.id);
      s.worldView.playerHeroId = solo.id;
      s.cut(1120, 2030, s.zb(1.18));
      s.glide(1205, 2010, s.zb(1.27), 3000, easeInOut);
      const gnollPos = gnoll ? { x: gnoll.x, y: gnoll.y } : { x: 1216, y: 2016 };
      return {
        cues: [
          { at: 250, fn: () => forceCast(w, solo, "Q", { point: gnollPos }) },
          { at: 800, fn: () => forceCast(w, solo, "W", { point: { x: solo.x + 50, y: solo.y } }) },
          {
            at: 1250,
            fn: () => {
              forceCast(w, solo, "E");
              if (gnoll?.alive) issueOrder(w, solo, { type: "attackUnit", targetId: gnoll.id });
            },
          },
          { at: 1950, fn: () => forceCast(w, solo, "R", { point: { x: 1216, y: 2016 } }) },
          { at: 2500, fn: () => finish(w, solo, campUnits(w, "camp-lb")[0]) },
        ],
      };
    }),

    // ---- 4-9 · ROSTER CUTDOWN — six heroes, six signatures, six backdrops.
    // roster-1: Ironvow — Shield Bash stun on the top-bridge planks.
    scene(stage, "roster-1", 1200, { title: "CHOOSE YOUR ANCIENT" }, (s) => {
      const w = s.installWorld(21);
      const iron = heroAt(w, "ironvow", "radiant", "r1", 1975, 565);
      const [victim] = creepPack(w, "dire", "top", ["melee"], 2105, 565, 0);
      if (victim) issueOrder(w, victim, { type: "hold" });
      s.worldView.playerHeroId = iron.id;
      s.pump(0.35);
      s.cut(2040, 548, s.zb(1.26));
      s.glide(2048, 548, s.zb(1.33), 1200, easeOut);
      return {
        // the attack order fires at t=0 (not in setup) so the whole exchange —
        // wind-up, Shield Bash, hit — plays ON camera, not behind the card.
        cues: [
          {
            at: 0,
            fn: () => victim && issueOrder(w, iron, { type: "attackUnit", targetId: victim.id }),
          },
          {
            at: 180,
            fn: () => victim?.alive && forceCast(w, iron, "Q", { targetId: victim.id }),
          },
        ],
      };
    }),

    // roster-2: Brewkeeper — Hex Bottle bursts over creeps at the fountain plaza.
    scene(stage, "roster-2", 1200, undefined, (s) => {
      const w = s.installWorld(22);
      const brew = heroAt(w, "brewkeeper", "radiant", "r2", 640, 1690);
      creepPack(w, "dire", "top", ["melee", "melee", "melee"], 880, 1700, 50);
      s.worldView.playerHeroId = brew.id;
      s.pump(0.4); // creeps aggro + charge the brewkeeper
      s.cut(775, 1685, s.zb(1.24));
      s.glide(790, 1690, s.zb(1.3), 1200, easeOut);
      return {
        cues: [{ at: 160, fn: () => forceCast(w, brew, "W", { point: { x: 855, y: 1695 } }) }],
      };
    }),

    // roster-3: Duskblade — Death Waltz crit execution in the dark south jungle.
    scene(stage, "roster-3", 1200, undefined, (s) => {
      const w = s.installWorld(23);
      const dusk = heroAt(w, "duskblade", "radiant", "r3", 980, 1920);
      const vic = heroAt(w, "stormcaller", "dire", "r3v", 1140, 1920, {
        level: 9,
        hpFrac: 0.3,
        facing: -1,
      });
      s.worldView.playerHeroId = dusk.id;
      s.pump(0.3);
      s.cut(1060, 1900, s.zb(1.3));
      s.glide(1085, 1902, s.zb(1.36), 1200, easeOut);
      return {
        cues: [
          // one breath of the stalker sizing up the kill, then the waltz
          { at: 300, fn: () => forceCast(w, dusk, "R", { targetId: vic.id }) },
          { at: 750, fn: () => finish(w, dusk, w.units.get(vic.id), true) },
        ],
      };
    }),

    // roster-4: Stormcaller — Piercing Shot skewers a creep line on the high ground.
    scene(stage, "roster-4", 1200, undefined, (s) => {
      const w = s.installWorld(24);
      const storm = heroAt(w, "stormcaller", "radiant", "r4", 830, 940);
      creepPack(w, "dire", "top", ["ranged", "ranged", "ranged"], 1105, 940, 0).forEach((c, i) => {
        c.x = 1030 + i * 75;
        c.y = 936 + (i % 2) * 10;
      });
      s.worldView.playerHeroId = storm.id;
      s.pump(0.45); // the line stops and volleys back — arrows in flight at reveal
      s.cut(1000, 928, s.zb(1.22));
      s.glide(1015, 930, s.zb(1.28), 1200, easeOut);
      return {
        cues: [{ at: 170, fn: () => forceCast(w, storm, "Q", { point: { x: 1650, y: 938 } }) }],
      };
    }),

    // roster-5: Boomtinker — dynamite arcs into a charging camp by the gold mine.
    scene(stage, "roster-5", 1200, undefined, (s) => {
      const w = s.installWorld(25);
      openCamp(w, "camp-rb");
      const boom = heroAt(w, "boomtinker", "radiant", "r5", 2650, 2050);
      s.worldView.playerHeroId = boom.id;
      s.pump(0.45); // camp spawned + charging him
      s.cut(2775, 2010, s.zb(1.24));
      s.glide(2790, 2012, s.zb(1.3), 1200, easeOut);
      return {
        // lead the lob: the camp is mid-charge, so the blast lands on the pack,
        // not on the spot it left
        cues: [{ at: 150, fn: () => forceCast(w, boom, "Q", { point: { x: 2790, y: 2020 } }) }],
      };
    }),

    // roster-6: Emberhex — Conflagration erupts over a pack in the Roshan pit.
    // The set's biggest shot; its blast cuts straight into the TWO LANES card.
    scene(stage, "roster-6", 1200, undefined, (s) => {
      const w = s.installWorld(26);
      const ember = heroAt(w, "emberhex", "radiant", "r6", 1880, 1504);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "melee", "siege"], 2150, 1500, 46);
      s.worldView.playerHeroId = ember.id;
      s.pump(0.25);
      // aim ahead of the pack — they charge her, so the fuse pops right on them
      forceCast(w, ember, "R", { point: { x: 2050, y: 1500 } }); // fuse burns during the cut
      s.pump(0.3); // bloom already on the ground at reveal; detonation ≈ 0.6s in
      s.cut(2030, 1485, s.zb(1.12));
      s.glide(2060, 1490, s.zb(1.18), 1200, easeOut);
      return {};
    }),

    // ---- 10 · LANE PUSH — wave clash → Stormcaller dives in, storm melts the wave,
    //           and the tier-1 tower comes down in the full destruction barrage.
    scene(stage, "lane-push", 4000, { title: "TWO LANES. ONE WAR." }, (s) => {
      const w = s.installWorld(31);
      const tower = w.units.get("d-top-t1");
      if (tower) tower.hp = tower.maxHp * 0.3; // siege in progress: tower already burning
      // the clash sits on dire land at the tower's feet — the bridge corridor is
      // only two cells tall, so wide packs must stage east of it
      creepPack(
        w,
        "radiant",
        "top",
        ["melee", "melee", "melee", "melee", "ranged", "ranged", "siege"],
        2250,
        555,
        44,
      );
      creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        2400,
        555,
        44,
      );
      s.pump(1.1); // the clash is fully developed before the hero arrives
      const storm = heroAt(w, "stormcaller", "radiant", "push", 2050, 570);
      forceCast(w, storm, "E"); // windfoot: she arrives at speed
      issueOrder(w, storm, { type: "move", to: { x: 2360, y: 545 } });
      s.worldView.playerHeroId = storm.id;
      s.cut(2280, 552, s.zb(0.98));
      s.glide(2430, 532, s.zb(1.12), 3800, easeInOut);
      return {
        cues: [
          { at: 700, fn: () => forceCast(w, storm, "R", { point: { x: 2410, y: 540 } }) },
          { at: 3100, fn: () => finish(w, storm, w.units.get("d-top-t1")) },
        ],
      };
    }),

    // ---- 11 · ELEVATION AMBUSH — Duskblade waits on the highland, drops down the
    //           ramp, blinks the last gap, and deletes the passer-by. Real terrain:
    //           the descent is the map's actual ramp + elevation lift.
    scene(stage, "elevation-ambush", 3000, undefined, (s) => {
      const w = s.installWorld(32);
      const dusk = heroAt(w, "duskblade", "radiant", "amb", 1400, 1300);
      const vic = heroAt(w, "emberhex", "dire", "ambv", 1330, 1425, { level: 9, hpFrac: 0.5 });
      issueOrder(w, vic, { type: "move", to: { x: 2100, y: 1425 } }); // marches below the cliff
      s.worldView.playerHeroId = dusk.id;
      s.pump(0.4);
      s.cut(1530, 1330, s.zb(1.12));
      return {
        cues: [
          { at: 700, fn: () => issueOrder(w, dusk, { type: "move", to: { x: 1580, y: 1400 } }) },
          { at: 750, fn: () => s.followUnit(dusk.id, 3) },
          {
            at: 1600,
            fn: () => {
              forceCast(w, dusk, "Q", { point: { x: vic.x, y: vic.y } });
              if (vic.alive) issueOrder(w, dusk, { type: "attackUnit", targetId: vic.id });
            },
          },
          { at: 1900, fn: () => forceCast(w, dusk, "W", { point: { x: vic.x, y: vic.y } }) },
          { at: 2450, fn: () => finish(w, dusk, w.units.get(vic.id), true) },
        ],
      };
    }),

    // ---- 12 · FIREBALL TRACK — the camera rides Emberhex's fireball from the cast,
    //           across the water, into a marching wave. Lead is computed live from
    //           the pack's real position so the blast always centers the crowd.
    scene(stage, "fireball-track", 2500, undefined, (s) => {
      const w = s.installWorld(33);
      const ember = heroAt(w, "emberhex", "radiant", "fb", 1560, 2496);
      const pack = creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "melee", "melee", "melee", "ranged", "ranged"],
        2280,
        2496,
        40,
      );
      s.worldView.playerHeroId = ember.id;
      s.pump(0.8); // wave marching the planks toward her
      // the blast must pay off: rank-4 Q lands ~230 after magic resist, but
      // melee creeps carry 280hp — pre-weaken the pack so the tracked impact
      // drops everything in the radius (skulls + dust dead-center on the
      // camera's landing spot) instead of reading as a whiff.
      for (const c of pack) c.hp = Math.min(c.hp, 150);
      s.cut(1620, 2470, s.zb(1.4));
      return {
        cues: [
          {
            at: 200,
            fn: () => {
              // lead the shot: solve the intercept of a 700px/s fireball with the
              // pack (marching ~240px/s toward the caster)
              const alive = pack.filter((c) => c.alive);
              const cx = alive.length ? alive.reduce((a, c) => a + c.x, 0) / alive.length : 2000;
              const cy = alive.length ? alive.reduce((a, c) => a + c.y, 0) / alive.length : 2496;
              let px = cx;
              for (let i = 0; i < 3; i++) {
                const flight = Math.max(0, (px - ember.x - 40) / 700);
                px = cx - 240 * flight;
              }
              forceCast(w, ember, "Q", { point: { x: px, y: cy } });
              s.followFireball(9);
            },
          },
        ],
      };
    }),

    // ---- 13 · FULL TEAMFIGHT — 3v3 max-rank bots plus creeps collide on the centre
    //           island: every ultimate in the game overlaps in one crowd. The staged
    //           low-HP Brewkeeper falls early (the trailer's honest death).
    scene(stage, "full-teamfight", 5000, undefined, (s) => {
      const w = s.installWorld(34);
      const iron = heroAt(w, "ironvow", "radiant", "tf-iron", 1870, 1500, { bot: true, slot: 0 });
      heroAt(w, "duskblade", "radiant", "tf-dusk", 1850, 1420, { bot: true, slot: 1 });
      const brew = heroAt(w, "brewkeeper", "radiant", "tf-brew", 1830, 1580, {
        bot: true,
        slot: 2,
        hpFrac: 0.2, // staged deep in kill range: level-16 pools + heals made 0.55 unkillable in 5s
      });
      heroAt(w, "emberhex", "dire", "tf-ember", 2230, 1500, { bot: true, slot: 0 });
      heroAt(w, "stormcaller", "dire", "tf-storm", 2250, 1420, { bot: true, slot: 1 });
      heroAt(w, "boomtinker", "dire", "tf-boom", 2240, 1580, { bot: true, slot: 2 });
      creepPack(w, "radiant", "top", ["melee", "melee", "melee", "melee"], 1960, 1500, 50);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "melee"], 2140, 1500, 50);
      s.worldView.playerHeroId = iron.id;
      s.pump(0.55); // bots have committed: first ults already casting at reveal
      s.cut(2050, 1495, s.zb(1.22));
      s.glide(2048, 1500, s.zb(1.0), 5000, easeInOut); // the fight blooms; camera gives it room
      let sweepAt = 0;
      return {
        cues: [
          {
            // the trailer's honest death: if real damage hasn't dropped the
            // staged low-HP Brewkeeper by 3.2s, the nearest dire hero finishes
            // it through dealDamage — kill FX, skull, and trauma land with
            // ~1.5s of shot left either way.
            at: 3200,
            fn: () => {
              const b = w.units.get(brew.id);
              if (!b || !b.alive) return;
              let killer: Unit | undefined;
              let bd = Infinity;
              for (const e of w.units.values()) {
                if (e.kind !== "hero" || e.team !== "dire" || !e.alive) continue;
                const d = (e.x - b.x) ** 2 + (e.y - b.y) ** 2;
                if (d < bd) {
                  bd = d;
                  killer = e;
                }
              }
              if (killer) finish(w, killer, b);
            },
          },
        ],
        frame: (t): void => {
          if (t < sweepAt) return;
          sweepAt = t + 400;
          // keep the brawl a brawl: no bot slinks off to fountain mid-shot, and
          // mana stays topped so kits keep firing (cooldowns stay real).
          for (const u of w.units.values()) {
            if (u.kind !== "hero" || !u.hero?.isBot || !u.alive) continue;
            u.hero.botRetreating = false;
            u.mp = u.maxMp;
            if (u.order.type === "fountain") {
              let foe: Unit | undefined;
              let bd = Infinity;
              for (const e of w.units.values()) {
                if (e.kind !== "hero" || e.team === u.team || !e.alive) continue;
                const d = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
                if (d < bd) {
                  bd = d;
                  foe = e;
                }
              }
              if (foe) issueOrder(w, u, { type: "attackUnit", targetId: foe.id });
            }
          }
        },
      };
    }),

    // ---- 14 · ULT PAYOFF — one quiet beat, then Boomtinker's megabomb: screen
    //           flash, whip zoom-in, slam, kill. The single loudest hit, isolated.
    scene(stage, "ult-payoff", 2200, undefined, (s) => {
      const w = s.installWorld(35);
      const boom = heroAt(w, "boomtinker", "radiant", "ult", 2500, 1250);
      const mark = heroAt(w, "duskblade", "dire", "ult-mark", 3080, 1250, {
        level: 12,
        hpFrac: 0.22,
        facing: -1,
      });
      // a small skirmish anchors the victims in place (real combat, not statues)
      const packDire = creepPack(w, "dire", "top", ["melee", "melee", "ranged"], 3060, 1210, 60);
      creepPack(w, "radiant", "top", ["melee", "melee"], 2990, 1260, 50);
      s.worldView.playerHeroId = boom.id;
      s.pump(0.6);
      s.cut(2700, 1250, s.zb(0.95)); // the quiet beat: wide, still, one breath
      return {
        cues: [
          {
            at: 400,
            fn: () => {
              forceCast(w, boom, "R", { point: { x: 3080, y: 1250 } });
              s.flash(150);
              s.glide(3080, 1245, s.zb(1.5), 300, easeOut);
            },
          },
          { at: 850, fn: () => finish(w, boom, w.units.get(mark.id), true) },
          // The megabomb is AoE — the anchoring skirmish dies IN the blast,
          // pop-pop-pop after the hero kill; the back half of the shot is a
          // kill streak instead of aftermath smoke.
          { at: 1050, fn: () => finish(w, boom, packDire[0]) },
          { at: 1200, fn: () => finish(w, boom, packDire[1], true) },
          { at: 1380, fn: () => finish(w, boom, packDire[2]) },
        ],
      };
    }),

    // ---- 15 · VICTORY — the final blow on the Dire Ancient among the rubble of its
    //           base towers, then the game's own VICTORY ribbon over the hero line.
    scene(stage, "victory", 2500, undefined, (s) => {
      const w = s.installWorld(36);
      // the base already fell off-screen: rubble + open gate to the Ancient
      retireStructure(w, "d-base-1");
      retireStructure(w, "d-base-2");
      // burning, one push from death — 12% so the 0.6s pre-roll of real swings
      // leaves the fall landing ~0.9s ON camera, not during the black
      const ancient = w.units.get("d-ancient");
      if (ancient) ancient.hp = ancient.maxHp * 0.12;
      const iron = heroAt(w, "ironvow", "radiant", "v-iron", 3400, 1560);
      const dusk = heroAt(w, "duskblade", "radiant", "v-dusk", 3430, 1450);
      const storm = heroAt(w, "stormcaller", "radiant", "v-storm", 3300, 1620);
      for (const u of [iron, dusk, storm])
        issueOrder(w, u, { type: "attackUnit", targetId: "d-ancient" });
      s.worldView.playerHeroId = iron.id;
      s.pump(0.6); // swings mid-arc at reveal
      s.cut(3480, 1530, s.zb(1.0));
      s.glide(3560, 1520, s.zb(1.14), 2500, easeInOut);
      return {
        cues: [
          { at: 900, fn: () => finish(w, iron, w.units.get("d-ancient")) },
          { at: 1000, fn: () => sfx.victory(true) },
          { at: 1600, fn: () => s.showVictoryBanner() },
        ],
      };
    }),
  ];

  return {
    title: "ANCIENTS OF ELDERMOOR",
    url: "moba.vibedgames.com",
    tagline: "Keyboard-first action MOBA",
    accent: "#ffe14a",
    fontFamily: FONT,
    scenes,
  };
}

// ---- entry -----------------------------------------------------------------------

/** Called from BootScene's ?trailer=1 branch (after assets + anims are ready). */
export function launchTrailer(game: Phaser.Game): void {
  game.scene.add("TrailerStage", TrailerStage, true);
}
