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
// FRAMING CONTRACT: zb(1) is the live match camera. Because the stage is always
// 16:9, zb(f) shows exactly 1600/f x 900/f world px at ANY viewport — so a shot's
// zoom factor is a direct statement about how much world is in frame. A hero body
// is ~40 world px, i.e. ~5% of frame height at zb(1). Everything here is shot
// tighter than the play camera; the map reveal is the one deliberately wide beat.
//
// This module is only ever loaded via the ?trailer=1 branch in BootScene —
// zero footprint in normal play.

import Phaser from "phaser";

import { SIM_DT, abilityRankCap } from "../data/config";
import type { CreepKind, Team } from "../data/config";
import type { AbilityKey } from "../data/heroes";
import { NEUTRAL_CAMPS, WORLD } from "../data/map";
import type { LaneId } from "../data/map";
import { castAbility, useItem } from "../sim/abilities";
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
import { resumeAudio, setMutedTransient, sfx } from "../render/audio";
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
  /** Frozen between a scene's setup() and its first run() tick. The stage stays
   *  black across setup and the dip-to-black cut, and any sim/camera time spent
   *  under it plays the staged action out behind black and burns the camera
   *  glides set in setup. setup() itself blocks for a while (installWorld +
   *  pump), so the first Phaser tick after it carries an outsized delta. */
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

    // an ambient world behind the shell's lead-in black (no combat)
    this.installWorld(7);
    this.cut(WORLD.width / 2, WORLD.height / 2, this.zMap());

    // The trailer rolls with no user gesture, so the browser keeps the
    // AudioContext suspended and anything scheduled before it resumes is either
    // dropped or piles up to fire at once. Hard-mute the session (a muted SFX
    // synthesises nothing at all) and unmute from the shell's onGesture.
    // Transient on purpose: toggleMute would persist the flip into the player's
    // saved preference for NORMAL play off the back of one trailer view.
    setMutedTransient(true);

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
  private stageSize() {
    const sw = Math.min(this.scale.width, (this.scale.height * 16) / 9);
    return { w: sw, h: (sw * 9) / 16 };
  }
  /** Base zoom (mirrors GameScene's height-derived zoom), scaled per shot.
   *  zb(f) frames 1600/f x 900/f world px regardless of viewport size. */
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

  // ---- loop ----------------------------------------------------------------------

  override update(_t: number, deltaMs: number): void {
    if (!this.world) return;
    const dt = Math.min(0.05, deltaMs / 1000);
    // While held (black) the sim and camera rig freeze, but the view keeps
    // syncing so the cut lifts onto a live, fully-drawn frame.
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

type HeroOpts = {
  level?: number;
  bot?: boolean;
  hpFrac?: number;
  facing?: 1 | -1;
  slot?: number;
  /** Items bought through the REAL shop path. buyItem gates on the fountain
   *  radius, so the purchase has to happen at the spawn mark before the unit is
   *  teleported to its film mark — hence the buy sits inside heroAt. */
  items?: string[];
  /** Seed the XP bar (e.g. just under a level threshold, so a filmed last hit
   *  fires a real level-up through awardCreepKill -> grantXp). */
  xp?: number;
};

/** Spawn a hero through the real spawn path, stage its level/ranks/items/pools
 *  (the Showcase pattern: rank via cap, recompute, refill), then move it to its
 *  mark. Order matters: the shop gate is a distance check against the fountain. */
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
  const h = u.hero;
  if (h) {
    const level = o.level ?? 16;
    h.level = level;
    h.xp = o.xp ?? 0;
    h.abilityPoints = 0;
    for (const k of ABILITY_KEYS) h.abilities[k].rank = abilityRankCap(k, level);
    if (o.items && o.items.length > 0) {
      h.gold = 20000; // a staged wallet; buyItem still runs every real gate
      for (const id of o.items) buyItem(w, u, id);
    }
    h.gold = 0;
    recomputeHeroStats(u);
    u.hp = u.maxHp;
    u.mp = u.maxMp;
    if (o.hpFrac !== undefined) u.hp = Math.max(1, u.maxHp * o.hpFrac);
  }
  u.x = x;
  u.y = y;
  u.facing = o.facing ?? (team === "radiant" ? 1 : -1);
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

/** The live pack member closest to death — the one a last hit should land on. */
function weakest(units: Unit[]): Unit | undefined {
  let best: Unit | undefined;
  for (const u of units) {
    if (!u.alive) continue;
    if (!best || u.hp < best.hp) best = u;
  }
  return best;
}

/** Guarantee a filmed kill through the real damage/death path.
 *  dealDamage mitigates (armor, magic resist, damage reduction) and shields
 *  absorb first, so ONE fixed raw number is not lethal against a level-16 tank
 *  sitting under its own ult — 9999 physical lands as ~1690 on Ironvow. Escalate
 *  until the real death path runs. An Aegis revive counts as "it ran": the hero
 *  comes back at full HP and hitting again would delete the revive the shot is
 *  staged around, so watch the death counter, not just `alive`. */
function finish(w: World, attacker: Unit, victim: Unit | undefined, crit = false): void {
  if (!victim || !victim.alive) return;
  const deaths = victim.hero?.deaths ?? -1;
  for (let raw = 9999; raw < 1e7; raw *= 8) {
    dealDamage(w, attacker, victim, raw, "physical", { crit });
    if (!victim.alive) return;
    if (victim.hero && victim.hero.deaths !== deaths) return;
  }
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
  build: (s: TrailerStage) => SceneScript,
): TrailerScene {
  let cues: Cue[] = [];
  let frame: SceneScript["frame"];
  let done: SceneScript["done"];
  return {
    id,
    duration,
    setup: (): void => {
      // build() constructs a fresh cue array per invocation, so &loop=1 replays
      // start with unfired cues.
      const r = build(stage);
      cues = r.cues ?? [];
      frame = r.frame;
      done = r.done;
      // Freeze until run()'s first tick: the shell keeps the stage black across
      // setup and the cut, and unheld sim time would play the staging out
      // behind that black and consume glides before the shot is visible.
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
    },
  };
}

// =====================================================================================
// The seventeen scenes.
//
// Shape: hook (the biggest blast) -> a fight -> scope -> how it plays (movement,
// laning, economy) -> hero signatures -> objectives -> map craft -> escalation
// (boss, initiation, teamfight, the save) -> the loudest hit -> the win.
// Zoom rule: every shot pushes IN or holds — the map reveal is the one deliberate
// pull-back — and no shot after the mid-point opens wider than zb(1.55).
// =====================================================================================

function buildConfig(stage: TrailerStage): TrailerConfig {
  const scenes: TrailerScene[] = [
    // ---- 1 · HOOK — Emberhex's Conflagration erupting in the Roshan pit. The
    //          biggest single blast in the game, on the map's one dark plate,
    //          already fused at the reveal so frame one is fire.
    scene(stage, "roster-6", 1500, (s) => {
      const w = s.installWorld(26);
      const ember = heroAt(w, "emberhex", "radiant", "r6", 1950, 1468);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "melee", "siege"], 2140, 1500, 46);
      s.worldView.playerHeroId = ember.id;
      s.pump(0.25);
      // aim ahead of the pack — they charge her, so the fuse pops right on them
      forceCast(w, ember, "R", { point: { x: 2060, y: 1500 } }); // 0.9s fuse
      s.pump(0.2); // bloom already burning at reveal; detonation ≈ 0.7s in
      // tight enough that the zone ring's circumference falls outside the crop
      // and only fill + flames remain in frame
      s.cut(2040, 1494, s.zb(2.3));
      s.glide(2058, 1500, s.zb(2.55), 1500, easeOut);
      return {};
    }),

    // ---- 2 · COLD OPEN — a 2v2 dive under a radiant tower; the dive gets punished.
    scene(stage, "cold-open-skirmish", 3400, (s) => {
      const w = s.installWorld(11);
      // defenders (our side, screen-left) vs divers (screen-right), under r-top-t1
      const dusk = heroAt(w, "duskblade", "radiant", "co-dusk", 1660, 640, { level: 9 });
      const storm = heroAt(w, "stormcaller", "radiant", "co-storm", 1560, 570, { level: 9 });
      const iron = heroAt(w, "ironvow", "dire", "co-iron", 1830, 620, { level: 9, hpFrac: 0.4 });
      const ember = heroAt(w, "emberhex", "dire", "co-ember", 1930, 545, {
        level: 9,
        hpFrac: 0.85,
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
      issueOrder(w, dusk, { type: "attackUnit", targetId: iron.id });
      issueOrder(w, storm, { type: "attackUnit", targetId: ember.id });
      issueOrder(w, iron, { type: "attackUnit", targetId: dusk.id }); // tower priority: punished
      issueOrder(w, ember, { type: "attackUnit", targetId: storm.id });
      s.worldView.playerHeroId = dusk.id;
      s.pump(1.2); // swings winding, tower shots already arcing in
      // the brawl collapses east toward the bridge, so lead it: the radiant
      // tower that does the punishing stays frame-left in both poses
      s.cut(1810, 608, s.zb(1.9));
      s.glide(1870, 612, s.zb(2.15), 3400, easeInOut);
      return {
        cues: [
          { at: 300, fn: () => forceCast(w, storm, "Q", { point: { x: 2150, y: 620 } }) },
          { at: 800, fn: () => forceCast(w, ember, "Q", { point: { x: dusk.x, y: dusk.y } }) },
          {
            at: 1250,
            fn: () => {
              forceCast(w, dusk, "Q", { point: { x: ember.x, y: ember.y } });
              issueOrder(w, dusk, { type: "attackUnit", targetId: ember.id });
            },
          },
          { at: 1600, fn: () => forceCast(w, iron, "Q", { targetId: dusk.id }) },
          // the kill lands at ~70% of the shot so the skull, soul wisp and trauma
          // get a full second of reaction instead of being cut on
          { at: 1900, fn: () => (iron.hp = Math.min(iron.hp, 55)) },
          { at: 2400, fn: () => finish(w, dusk, w.units.get(iron.id)) },
        ],
      };
    }),

    // ---- 3 · MAP REVEAL — open on two waves interlocked on the top bridge, then
    //          pull back until the whole two-island war fits the stage.
    scene(stage, "map-reveal", 1800, (s) => {
      const w = s.installWorld(12);
      const wave: CreepKind[] = ["melee", "melee", "melee", "melee", "ranged", "ranged"];
      // staged to COLLIDE: 580px apart at ~240px/s each, so 1.6s of pre-roll has
      // them interlocked on the planks at the reveal
      creepPack(w, "radiant", "top", wave, 1760, 578, 30);
      creepPack(w, "dire", "top", wave, 2340, 578, 30);
      // The bottom crossing is only walkable on grid rows 38-40 (y 2432..2623) —
      // and spawnCreepAt adds ±12px of jitter. A 6-deep column centred on 2498
      // put its lead creep in the water on row 37, where it stood still for the
      // whole reveal; centring on 2528 fits all six between the banks.
      creepPack(w, "radiant", "bottom", wave, 1900, 2528, 30);
      creepPack(w, "dire", "bottom", wave, 2200, 2528, 30);
      // Both centre crossings contested too, and the boss standing in his pit: at
      // reveal scale a body is 4px, so the only thing that keeps the middle third
      // of the frame from being unbroken green is putting units on it.
      const mid: CreepKind[] = ["melee", "melee", "ranged"];
      creepPack(w, "radiant", "top", mid, 1680, 1520, 34);
      creepPack(w, "dire", "top", mid, 1820, 1520, 34);
      creepPack(w, "dire", "bottom", mid, 2400, 1520, 34);
      creepPack(w, "radiant", "bottom", mid, 2260, 1520, 34);
      // and the jungle awake: at reveal scale the island interiors are the only
      // part of the map with nothing standing on them, and camps are exactly what
      // normally occupies them (createWorld schedules them for 60s in).
      for (const c of NEUTRAL_CAMPS) openCamp(w, c.id);
      s.pump(1.6);
      s.cut(2050, 578, s.zb(1.6));
      // stop short of full-map: the world border stays cropped and lane creeps
      // still read as units rather than dust
      s.glide(WORLD.width / 2, WORLD.height / 2, s.zMap() * 1.12, 1700, easeInOut);
      return {};
    }),

    // ---- 4 · THE RUN — the escape. The two universal movement verbs (the F dodge
    //          dash and a bought item's active) shown as what they are FOR: two
    //          dire heroes are on her heels with a fireball already in the air,
    //          she dashes out from under it, blinks the whole bottom channel and
    //          lands under her own tier-1 inside her own wave. It is still the one
    //          shot at play framing, so the ambient layer (foam, water rocks,
    //          planks, running dust) reads for the only time — but with something
    //          at stake in every frame instead of a commute across empty lawn.
    //
    //          Distances are load-bearing: she leaves the mark at ~330px/s (boots),
    //          the dash adds 1150px/s for 0.18s, and the Scepter blink is capped at
    //          600px — which is exactly what it takes to clear the water from the
    //          east bank (x 2176) to her own bank (x <= 1919) in one jump.
    scene(stage, "the-run", 1600, (s) => {
      const w = s.installWorld(45);
      const storm = heroAt(w, "stormcaller", "radiant", "run", 2700, 2496, {
        level: 10,
        items: ["boots", "scepter"], // bought at the fountain through buyItem
      });
      // the threat: two dire heroes chasing her off their side of the map
      const hunter = heroAt(w, "duskblade", "dire", "run-d1", 2905, 2452, {
        level: 12,
        facing: -1,
      });
      const caster = heroAt(w, "emberhex", "dire", "run-d2", 2950, 2548, {
        level: 12,
        facing: -1,
      });
      // home: her own wave marching out of the west bank to meet her, so the
      // landing frame is a friendly line and a tower, not a lone hero on grass
      creepPack(
        w,
        "radiant",
        "bottom",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        1470,
        2500,
        40,
      );
      issueOrder(w, storm, { type: "move", to: { x: 1450, y: 2500 } }); // real A* down the lane
      for (const d of [hunter, caster])
        issueOrder(w, d, { type: "attackUnit", targetId: storm.id });
      // the hunters' own wave running the lane behind them: the shot's back half
      // used to be a hero, two chasers and grass
      for (const c of creepPack(w, "dire", "bottom", ["melee", "melee", "ranged"], 3040, 2496, 44))
        issueOrder(w, c, { type: "attackUnit", targetId: storm.id });
      s.worldView.playerHeroId = storm.id;
      s.pump(0.3); // the chase is already running at the reveal
      s.cut(2600, 2466, s.zb(2.2));
      s.followUnit(storm.id, 3.4);
      return {
        cues: [
          // dodge dash: 1150px/s for 0.18s, west, out from under the fireball
          { at: 120, fn: () => dashHero(w, storm, -1, 0.02) },
          // ...which is aimed where she WAS: it lands behind her on the planks
          {
            at: 220,
            fn: () => forceCast(w, caster, "Q", { point: { x: storm.x - 40, y: storm.y } }),
          },
          // Scepter of Ruin: the 600px blink, fired from the bridge so it clears
          // the whole channel in one jump
          {
            at: 950,
            fn: () => {
              useItem(w, storm, "scepter", { x: storm.x - 620, y: storm.y + 10 });
              s.followUnit(storm.id, 6); // the cam has 600px to make up
            },
          },
          // and she turns at the tower line — the escape ends in a stand, not in
          // more jogging
          {
            at: 1050,
            fn: () => issueOrder(w, storm, { type: "attackMove", to: { x: 2050, y: 2500 } }),
          },
        ],
      };
    }),

    // ---- 5 · THE LANE — the loop that fills most of a match: two waves trading
    //          under the enemy tower, an enemy laner in the mix wearing Hunter's
    //          Mark, last hits paying gold, and the first one tipping a real
    //          level-up.
    scene(stage, "the-lane", 2600, (s) => {
      const w = s.installWorld(46);
      // 130px west of the old marks: the clash now sits on the dire bulge right at
      // the top-bridge mouth, so the planks, the channel and the tower are all in
      // the crop instead of a lane cut out of open field.
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
      // level 5 with the bar 10xp short of level 6: the filmed last hit levels her
      // for real (grantXp -> the gold ring, flash column and rising stars)
      const storm = heroAt(w, "stormcaller", "radiant", "lane", 2120, 632, { level: 5, xp: 2390 });
      // Hunter's Mark refuses any non-hero target (abilities.ts stormcaller:W), so
      // the lane needs an actual opponent: a melee laner who walks into the wave
      // during the pre-roll and takes the mark mid-frame.
      const foe = heroAt(w, "duskblade", "dire", "lane-foe", 2440, 618, {
        level: 5,
        hpFrac: 0.75,
        facing: -1,
      });
      issueOrder(w, storm, { type: "attackMove", to: { x: 2270, y: 600 } });
      const head = mine[0];
      if (head) issueOrder(w, foe, { type: "attackUnit", targetId: head.id });
      s.worldView.playerHeroId = storm.id;
      s.pump(1.4); // the clash is fully developed at the reveal
      s.cut(2225, 552, s.zb(1.6));
      s.glide(2295, 548, s.zb(1.78), 2600, easeInOut);
      return {
        cues: [
          { at: 400, fn: () => forceCast(w, storm, "W", { targetId: foe.id }) },
          // three last hits, spaced so one of the gold/skull pops is always live
          // through the middle of the card
          { at: 800, fn: () => finish(w, storm, weakest(theirs)) },
          { at: 1500, fn: () => finish(w, storm, weakest(theirs)) },
          { at: 2100, fn: () => finish(w, storm, weakest(theirs)) },
        ],
      };
    }),

    // ---- 6 · ROSTER — Stormcaller's Piercing Shot skewers a creep line, shot at
    //          the radiant base gate. The north jungle plateau this used to sit on
    //          is a featureless green table: its one cliff runs along the SOUTH
    //          edge and shooting the interior bought nothing but lawn. The gate has
    //          the only stacked architecture on the radiant island in one crop —
    //          the castle outcrop's stone wall and healing pool frame-left, the
    //          base tower dead centre, a village house under it — and it gives the
    //          skillshot a reason: an invading line walking into her home.
    scene(stage, "roster-4", 1400, (s) => {
      const w = s.installWorld(24);
      // clear of the keep: the ancient's sprite is 544x435 around (480, 1506), so
      // anything west of x~760 is drawn standing on the castle roof
      const storm = heroAt(w, "stormcaller", "radiant", "r4", 772, 1620);
      // Seven bodies in a column, held on the spot. Two constraints set y 1620:
      // the south jungle tree cluster centred (1024, 1920) blocks nav out to r=101
      // and its canopies draw down from y~1663 with depth = their own y, so a line
      // any further south is both shoved out of formation and drawn BEHIND the
      // leaves. Held rather than charging, because a pierce is only legible
      // against a line that is still a line when the arrow arrives.
      const line = creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "ranged", "melee", "ranged", "melee", "melee"],
        1060,
        1620,
        0,
      );
      line.forEach((c, i) => {
        c.x = 980 + i * 30;
        c.y = 1620 + (i % 2) * 14;
        c.order = { type: "hold" };
      });
      s.worldView.playerHeroId = storm.id;
      s.pump(0.3); // arrows already trading; the base tower is already firing
      s.cut(826, 1704, s.zb(2.15));
      s.glide(830, 1712, s.zb(2.25), 1400, easeOut);
      return {
        // fire at ~32% so the pierce, the impact chain and the skull pops all
        // land inside the card instead of the card ending on an empty field
        cues: [{ at: 450, fn: () => forceCast(w, storm, "Q", { point: { x: 1440, y: 1624 } }) }],
      };
    }),

    // ---- 7 · ROSTER — Duskblade's Death Waltz execute, shot on the mid-west
    //          crossing: the victim is backed onto the planks at the mouth of the
    //          Roshan island with open water either side of him.
    //
    //          The dire village apron this used to sit on had one house in the
    //          corner and nothing else — 60% of that frame was unbroken green, the
    //          emptiest card in the cut. The plank crossing is the opposite: two
    //          rails of sawn timber, foam-lapped shoreline top and bottom, and the
    //          pit's dark plate bleeding into frame right. Nothing here is dressed
    //          for the trailer; it is the map's own choke.
    scene(stage, "roster-3", 950, (s) => {
      const w = s.installWorld(23);
      // bridge-mid-west spans x 1600..1855 on rows 23-24 (y 1472..1599); the victim
      // sits just past its east cap, on the island lip, so the crit throws him
      // toward the pit rather than into the channel
      const dusk = heroAt(w, "duskblade", "radiant", "r3", 1730, 1540);
      const vic = heroAt(w, "stormcaller", "dire", "r3v", 1852, 1534, {
        level: 9,
        hpFrac: 0.3,
        facing: -1,
      });
      // his escort, closing on the stalker: two more bodies on the planks so the
      // card is a fight interrupted, not a duel in an empty corridor
      for (const c of creepPack(w, "dire", "top", ["melee", "ranged"], 1900, 1536, 44))
        issueOrder(w, c, { type: "attackUnit", targetId: dusk.id });
      s.worldView.playerHeroId = dusk.id;
      s.pump(0.3);
      s.cut(1756, 1532, s.zb(2.38));
      s.glide(1770, 1536, s.zb(2.5), 950, easeOut);
      return {
        cues: [
          // one breath of the stalker sizing up the kill, then the waltz. The card
          // ENDS inside the crit's debris — the death FX runs ~400ms, so a 950ms
          // card is still carrying it at the cut. Half of the old 1.4s was a hero
          // standing next to a sheep.
          { at: 220, fn: () => forceCast(w, dusk, "R", { targetId: vic.id }) },
          { at: 520, fn: () => finish(w, dusk, w.units.get(vic.id), true) },
        ],
      };
    }),

    // ---- 8 · SIGNATURE SOLO — Boomtinker's kit as one sentence on a jungle camp:
    //          mines down first, powder keg up, then the armed mines detonating
    //          under the charging pack and the dynamite finishing the gnoll.
    //          Staged south of the gold mine so nothing draws over the fight.
    //          (His R belongs to the ult payoff.)
    //
    //          Length is set by the sim, not by taste: the camp is 1200hp total
    //          and rank-3 mines alone are 450, so it CANNOT survive past ~1.6s of
    //          this string at any staging. The shot therefore ends 0.45s after the
    //          last body drops instead of holding on a hero next to skulls.
    scene(stage, "signature-solo", 2000, (s) => {
      const w = s.installWorld(13);
      openCamp(w, "camp-lb"); // large camp: gnoll + two skulls at (1216, 2016)
      // 220px north of the old mark. The camp's landmark is the gold mine headframe
      // drawn at (1216, 1952) — 192x128 of timber and rock — and the old crop sat
      // entirely below it, so the fight played out on bare grass with the one built
      // thing in the pocket off the top of frame. Pulled up, the mine fills the top
      // third and the south jungle plateau's cliff runs along the left.
      const solo = heroAt(w, "boomtinker", "radiant", "solo", 1190, 2075, { level: 6 });
      s.pump(0.4); // camp spawned; it acquires him (420 aggro, inside its 360 leash)
      const gnoll = campUnits(w, "camp-lb").find((u) => u.maxHp >= 700);
      if (gnoll) s.worldView.setTarget(gnoll.id);
      s.worldView.playerHeroId = solo.id;
      s.cut(1212, 1974, s.zb(2.6));
      s.glide(1216, 1996, s.zb(2.85), 2000, easeInOut);
      return {
        cues: [
          // mines first: they arm in 1.2s, which is exactly when the camp arrives.
          // All three sit SOUTH of the headframe's depth line (y 1952) so they draw
          // over the mine, not behind it.
          { at: 120, fn: () => forceCast(w, solo, "W", { point: { x: 1190, y: 2028 } }) },
          { at: 200, fn: () => forceCast(w, solo, "W", { point: { x: 1262, y: 2016 } }) },
          { at: 280, fn: () => forceCast(w, solo, "W", { point: { x: 1126, y: 2016 } }) },
          {
            // powder keg BEFORE the pack lands, so the splash rings are already
            // on his swings when the camp piles onto him
            at: 600,
            fn: () => {
              forceCast(w, solo, "E");
              if (gnoll?.alive) issueOrder(w, solo, { type: "attackUnit", targetId: gnoll.id });
            },
          },
          // dynamite lands at ~1.25s, into the same window the mines pop in: two
          // skulls at 1.33/1.37, then the gnoll at ~1.53 — a crescendo, not a wipe
          {
            at: 1000,
            fn: () =>
              forceCast(w, solo, "Q", { point: { x: gnoll?.x ?? 1216, y: gnoll?.y ?? 2100 } }),
          },
        ],
      };
    }),

    // ---- 9 · LANE PUSH — the storm melts the wave and the tier-1 tower comes down
    //          in the full destruction barrage. The same lane we poked in shot 5,
    //          now taken.
    scene(stage, "lane-push", 4000, (s) => {
      const w = s.installWorld(31);
      const tower = w.units.get("d-top-t1");
      if (tower) tower.hp = tower.maxHp * 0.3; // siege in progress: tower already burning
      // the clash sits on dire land at the tower's feet — the bridge corridor is
      // only two cells tall, so wide packs must stage east of it. 50px further
      // west than before, and the camera trails it, so the planks and the channel
      // stay in the left third for the whole push instead of sliding out of frame.
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
      s.pump(1.1); // the clash is fully developed before the hero arrives
      const storm = heroAt(w, "stormcaller", "radiant", "push", 2030, 570);
      issueOrder(w, storm, { type: "move", to: { x: 2310, y: 545 } });
      s.worldView.playerHeroId = storm.id;
      // rides ~60px high of the lane: the tower keeps the middle of the frame and
      // the north water rim takes the top edge, instead of a quarter-frame of
      // untouched dire field under the fight
      s.cut(2270, 512, s.zb(1.55));
      s.glide(2410, 478, s.zb(1.9), 3800, easeInOut);
      return {
        cues: [
          // Windfoot fires ON camera (it used to be cast in setup, behind black,
          // so its tornado burst was never seen)
          { at: 120, fn: () => forceCast(w, storm, "E") },
          // the rain lands ON the clash centroid, not past it, so the zone's fill
          // sits on bodies instead of on empty grass
          { at: 700, fn: () => forceCast(w, storm, "R", { point: { x: 2330, y: 552 } }) },
          { at: 3100, fn: () => finish(w, storm, w.units.get("d-top-t1")) },
        ],
      };
    }),

    // ---- 10 · ELEVATION AMBUSH — Duskblade prowls the south lip of the mid-north
    //           highland and Shadowsteps straight off it onto a laner below.
    //
    //           Framing is the whole shot. The highland is cells (19..22, 17..20) =
    //           world 1216..1471 x 1088..1343, drawn 48px (ELEV_LIFT) higher than
    //           the flat ground around it, and only its SOUTH edge draws a stone
    //           cliff face — the east and west edges are just grass seams. Shooting
    //           the plateau's INTERIOR therefore buys a featureless green rectangle;
    //           the height only reads where the cliff band is on frame with a unit
    //           standing ON it and a unit standing UNDER it at the same time. So the
    //           crop is pinned to the south-east corner (1472, 1344): high ground
    //           and the ambusher in the top third, the 48px drop across the middle,
    //           the victim and her escort on flat ground below it.
    //
    //           The drop alone was not enough mass: west of the lip is 700px of
    //           uninterrupted field. So the whole ambush is pushed a lane east, to
    //           the strip between the plateau and the coast — the same cliff, but
    //           now with the channel and the mid-west crossing filling the right
    //           third of every frame.
    scene(stage, "elevation-ambush", 2200, (s) => {
      const w = s.installWorld(32);
      // both marks are inside the highland rect, so she is drawn lifted for the
      // whole prowl and the blink is a real fall through 48px of terrain
      const dusk = heroAt(w, "duskblade", "radiant", "amb", 1300, 1200);
      // the victim sits ~100px below the cliff base, on the shore strip
      const vic = heroAt(w, "emberhex", "dire", "ambv", 1580, 1440, { level: 9, hpFrac: 0.5 });
      creepPack(w, "dire", "top", ["melee", "melee"], 1520, 1512, 50);
      creepPack(w, "radiant", "top", ["melee", "melee"], 1636, 1540, 50);
      // the prowl to the lip is issued in SETUP so the first visible frame already
      // has her walking the high ground
      issueOrder(w, dusk, { type: "move", to: { x: 1448, y: 1290 } });
      s.worldView.playerHeroId = dusk.id;
      s.pump(0.2);
      // corner at ~55% width / ~50% height: cliff band across the middle of frame,
      // water and planks down the right edge
      s.cut(1580, 1360, s.zb(2.1));
      s.glide(1620, 1420, s.zb(2.25), 2200, easeInOut);
      return {
        cues: [
          {
            // Shadowstep off the lip — the blink line crosses the cliff face
            at: 900,
            fn: () => {
              forceCast(w, dusk, "Q", { point: { x: vic.x, y: vic.y } });
              if (vic.alive) issueOrder(w, dusk, { type: "attackUnit", targetId: vic.id });
            },
          },
          { at: 1150, fn: () => forceCast(w, dusk, "W", { point: { x: vic.x, y: vic.y } }) },
          { at: 1350, fn: () => finish(w, dusk, w.units.get(vic.id), true) },
        ],
      };
    }),

    // ---- 11 · FIREBALL TRACK — the camera rides Emberhex's fireball from the cast,
    //           across the water, into a marching wave. Lead is computed live from
    //           the pack's real position so the blast always centers the crowd,
    //           then the camera hands off to the second wave still coming.
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
      // a second wave behind the first so the back half of the shot is a wave
      // still marching into frame, not an empty bridge
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
      s.pump(1.0); // wave marching the planks toward her
      // the blast must pay off: rank-4 Q lands ~230 after magic resist, but
      // melee creeps carry 280hp — pre-weaken the pack so the tracked impact
      // drops everything in the radius (skulls + dust dead-center on the
      // camera's landing spot) instead of reading as a whiff.
      for (const c of pack) c.hp = Math.min(c.hp, 150);
      s.cut(1740, 2466, s.zb(1.6));
      return {
        cues: [
          {
            at: 180,
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
          // the fireball is consumed on impact and the follow would freeze on its
          // last position — hand the camera to the wave still walking in
          {
            at: 1050,
            fn: () => {
              const next = tail.find((c) => c.alive);
              if (!next) return;
              s.followUnit(next.id, 2.2);
              s.glide(next.x, next.y, s.zb(2.05), 700, easeOut); // follow drives x/y, this drives zoom
            },
          },
        ],
      };
    }),

    // ---- 12 · ROSHAN — the boss. Opens on all three of them working a 4200hp
    //           Minotaur in the pit and pushes in as he drops. The kill fires the
    //           real awardCreepKill boss branch (gold, the Aegis status onto the
    //           killer, level-up burst over her).
    scene(stage, "roshan", 2650, (s) => {
      const w = s.installWorld(41);
      const iron = heroAt(w, "ironvow", "radiant", "ro-iron", 1958, 1504, { hpFrac: 0.45 });
      const storm = heroAt(w, "stormcaller", "radiant", "ro-storm", 1862, 1430);
      const brew = heroAt(w, "brewkeeper", "radiant", "ro-brew", 1848, 1582);
      openCamp(w, "roshan");
      s.pump(0.1); // one tick of tickNeutrals spawns the Minotaur in its pit
      const boss = campUnits(w, "roshan")[0];
      if (boss) {
        for (const u of [iron, storm, brew])
          issueOrder(w, u, { type: "attackUnit", targetId: boss.id });
        s.worldView.setTarget(boss.id);
      }
      s.worldView.playerHeroId = storm.id;
      s.pump(0.7); // swings landing, boss already hitting back
      // sprites.ts cannot make the Minotaur bigger without changing normal play,
      // so his scale has to come from the crop: zb(2.05) is tight enough that the
      // pit floor fills the frame and he reads as the thing being worked, not as
      // one more body in a wide bone ring. Pushes in, like every back-half shot.
      s.cut(2005, 1500, s.zb(2.2));
      s.glide(2035, 1500, s.zb(2.5), 2550, easeInOut);
      return {
        cues: [
          { at: 400, fn: () => forceCast(w, iron, "W") }, // Oathguard: shield shimmer + reflect
          { at: 1100, fn: () => forceCast(w, brew, "Q", { targetId: iron.id }) }, // +heal on the tank
          // cut ~450ms after the gold/Aegis burst instead of holding a further
          // second on three heroes standing around a skull
          { at: 2200, fn: () => finish(w, storm, boss) },
        ],
      };
    }),

    // ---- 13 · UNBREAKING VOW — the initiation. One tank steps in front of a dying
    //           carry, shields, then taunts three heroes and a creep pack into
    //           walking INTO him with stun stars over every head at once.
    //           Staged on the shore strip under the mid-south highland: the old
    //           mark was the dead middle of the radiant island, eight units on a
    //           table of grass with no edge anywhere in the crop. Here the plateau
    //           and its stone face take the upper left, the channel takes the right,
    //           and the taunt drags everyone into the pocket between them.
    scene(stage, "unbreaking-vow", 2000, (s) => {
      const w = s.installWorld(44);
      const iron = heroAt(w, "ironvow", "radiant", "uv-iron", 1580, 2000);
      const ally = heroAt(w, "stormcaller", "radiant", "uv-ally", 1476, 2044, { hpFrac: 0.28 });
      const foes = [
        heroAt(w, "duskblade", "dire", "uv-d1", 1688, 1932, { facing: -1 }),
        heroAt(w, "emberhex", "dire", "uv-d2", 1698, 2060, { facing: -1 }),
        heroAt(w, "boomtinker", "dire", "uv-d3", 1576, 2140, { facing: -1 }),
      ];
      // six, not four: the taunt's 360 radius reaches all of them, and the extra
      // bodies are what turn the collapse into a crowd. Centred on y 2020 with a
      // 36px spread the whole column stays on grid rows 30-32, where the coast runs
      // at x 1727 — one row further north and the lead creep spawns in the water.
      const kinds: CreepKind[] = ["melee", "melee", "melee", "melee", "ranged", "ranged"];
      const creeps = creepPack(w, "dire", "top", kinds, 1668, 2020, 36);
      for (const f of [...foes, ...creeps])
        issueOrder(w, f, { type: "attackUnit", targetId: ally.id });
      s.worldView.playerHeroId = iron.id;
      s.pump(0.5); // the collapse onto the carry is already under way
      s.cut(1584, 1994, s.zb(1.95));
      s.glide(1580, 1990, s.zb(2.05), 2000, easeOut);
      return {
        cues: [
          { at: 0, fn: () => forceCast(w, iron, "W") }, // armor + shield + melee reflect
          { at: 380, fn: () => forceCast(w, iron, "R") }, // 360-radius taunt + damage reduction
        ],
      };
    }),

    // ---- 14 · FULL TEAMFIGHT — 3v3 max-rank bots plus creeps collide on the centre
    //           island: every ultimate in the game overlaps in one crowd, staged
    //           160px apart so they engage inside the first second. The camera
    //           pushes IN across the climax. Two deaths: the honest one, and one
    //           the Aegis takes back.
    scene(stage, "full-teamfight", 5000, (s) => {
      const w = s.installWorld(34);
      const iron = heroAt(w, "ironvow", "radiant", "tf-iron", 1955, 1490, { bot: true, slot: 0 });
      heroAt(w, "duskblade", "radiant", "tf-dusk", 1935, 1410, { bot: true, slot: 1 });
      const brew = heroAt(w, "brewkeeper", "radiant", "tf-brew", 1990, 1606, {
        bot: true,
        slot: 2,
        // 0.45, not 0.2: at 0.2 he is 109hp of 1680 and real bot damage deleted
        // him at 0.6s, before the fight had read. 0.45 survives the crowd's
        // opening burst, so the death is the one the cue fires at 2400.
        hpFrac: 0.45,
      });
      heroAt(w, "emberhex", "dire", "tf-ember", 2100, 1490, { bot: true, slot: 0 });
      heroAt(w, "stormcaller", "dire", "tf-storm", 2118, 1408, { bot: true, slot: 1 });
      heroAt(w, "boomtinker", "dire", "tf-boom", 2106, 1596, { bot: true, slot: 2 });
      creepPack(w, "radiant", "top", ["melee", "melee", "melee", "melee"], 2008, 1500, 46);
      creepPack(w, "dire", "top", ["melee", "melee", "melee", "melee"], 2064, 1500, 46);
      // Roshan's drop, carried into the fight: the tank dies and comes straight
      // back at full HP where he fell (handleDeath's aegis branch).
      addStatus(iron, { kind: "aegis", until: w.now + 300_000 });
      s.worldView.playerHeroId = iron.id;
      s.pump(0.55); // bots have committed: first ults already casting at reveal
      s.cut(2030, 1495, s.zb(1.55));
      s.glide(2030, 1495, s.zb(1.9), 3400, easeInOut);
      let sweepAt = 0;
      return {
        cues: [
          {
            // the trailer's honest death, on the beat: the staged-low Brewkeeper
            // survives the opening burst, then the nearest dire hero finishes him
            // through dealDamage at the fight's midpoint — kill FX, skull and
            // trauma with 2.5s of shot left to react in.
            at: 2400,
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
          {
            // and the reversal: the Aegis snaps the tank back, full HP, in place
            at: 3500,
            fn: () => {
              const i = w.units.get(iron.id);
              let killer: Unit | undefined;
              let bd = Infinity;
              for (const e of w.units.values()) {
                if (e.kind !== "hero" || e.team !== "dire" || !e.alive || !i) continue;
                const d = (e.x - i.x) ** 2 + (e.y - i.y) ** 2;
                if (d < bd) {
                  bd = d;
                  killer = e;
                }
              }
              if (killer) finish(w, killer, i);
            },
          },
          // a punch in on the revive instead of a cut — the climax's only internal
          // camera beat
          { at: 3600, fn: () => s.glide(2040, 1500, s.zb(2.15), 900, easeOut) },
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

    // ---- 15 · LAST CALL — the save. The cut's one sustained still frame: two
    //           allies at a sliver of HP standing in enemy fire, and the support
    //           pouring a 380-radius heal pool under them, shielding both, then
    //           topping the tank. The only heal ground-zone the engine draws.
    //           Moved onto the bottom lane's own tier-1: the save now happens under
    //           the tower it is protecting, at the mouth of the crossing the divers
    //           came over. The old mark was 400px of blank field south of the jungle
    //           — the emptiest still in the cut after the roster cards. Here the
    //           tower's 346px of stone stands in the left third, the planks cut
    //           across the middle, and open water fills the corners.
    scene(stage, "last-call", 2800, (s) => {
      const w = s.installWorld(42);
      // east of the tower's footprint (sprite x 1554..1726, depth = its own y 2602):
      // marks any further west put the wounded pair — and both ground zones — behind
      // the stonework, which reads as heroes standing inside their own tower
      const brew = heroAt(w, "brewkeeper", "radiant", "lc-brew", 1810, 2500);
      const iron = heroAt(w, "ironvow", "radiant", "lc-iron", 1762, 2548, { hpFrac: 0.16 });
      const dusk = heroAt(w, "duskblade", "radiant", "lc-dusk", 1884, 2552, { hpFrac: 0.2 });
      const ember = heroAt(w, "emberhex", "dire", "lc-ember", 2090, 2440, { facing: -1 });
      // the divers come over the planks; a 30px spread keeps all six on the two
      // walkable bridge rows (y 2432..2559) instead of spawning into the channel
      const pack = creepPack(
        w,
        "dire",
        "bottom",
        ["melee", "melee", "melee", "melee", "ranged", "ranged"],
        1996,
        2496,
        24,
      );
      for (const c of pack) issueOrder(w, c, { type: "attackUnit", targetId: iron.id });
      issueOrder(w, ember, { type: "attackUnit", targetId: dusk.id });
      // burning ground under the wounded pair — the fire is the reason the heal reads
      forceCast(w, ember, "W", { point: { x: 1810, y: 2540 } });
      s.worldView.playerHeroId = brew.id;
      s.pump(0.45);
      s.cut(1842, 2524, s.zb(1.85)); // held: no glide for the first 1.7s
      return {
        cues: [
          { at: 150, fn: () => forceCast(w, brew, "R", { point: { x: brew.x, y: brew.y } }) },
          { at: 700, fn: () => forceCast(w, brew, "E") }, // shield shimmer snaps onto both
          { at: 1400, fn: () => forceCast(w, brew, "Q", { targetId: iron.id }) },
          { at: 1700, fn: () => s.glide(1832, 2530, s.zb(1.95), 1000, easeOut) },
        ],
      };
    }),

    // ---- 16 · ULT PAYOFF — the single loudest hit in the game, isolated on open
    //           ground with nothing between it and the camera: screen flash, whip
    //           zoom, Demolition Run slam that vaporises the pack outright, the
    //           stunned survivor executed, then the siege engine popped.
    //
    //           Demolition Run resolves its 420 magic + 1.8s stun in the SAME tick
    //           as the dash, so anything staged inside its 280 radius under ~420
    //           effective HP is already dead when the dust settles — every cue
    //           after it has to be aimed at something the blast can't kill.
    //
    //           TIMING IS THE SHOT. playAbilityFx gives a radius-280 slam a soft
    //           impact glow (616px across — wider than the whole zb(2.75) crop),
    //           a shockwave ring and trauma, but every one of those tweens is dead
    //           in 380ms; only the 714ms sp-fire fan outlives it. The loudest frame
    //           in the game therefore lasts ~0.4s, and the previous cut spent it at
    //           15-31% of the shot and then held 700ms of grass after the last kill.
    //           So the slam sits at ~35% now, the crit lands while the fan is still
    //           burning, and the shot ends 370ms after the final body.
    //
    //           "Isolated on open ground" turned out to mean "the emptiest frame in
    //           the trailer": at zb(2.75) on mid-island lawn there is literally
    //           nothing in the crop but the blast. Same beat, staged 300px west onto
    //           the dire bank instead — the slam now goes off against the channel,
    //           with the water and the mid-east crossing along the left edge, and
    //           the fire fan still has nothing standing between it and the lens.
    scene(stage, "ult-payoff", 1400, (s) => {
      const w = s.installWorld(35);
      const boom = heroAt(w, "boomtinker", "radiant", "ult", 2748, 1444);
      // 0.5, not 0.22: 612hp survives the slam at ~300 and stands there stunned,
      // so the crit execute is a second beat instead of a cue that no-ops on a
      // corpse the ult already made.
      const mark = heroAt(w, "duskblade", "dire", "ult-mark", 2536, 1442, {
        level: 12,
        hpFrac: 0.5,
        facing: -1,
      });
      // a real skirmish anchors the victims in place (not statues) AND fills the
      // crop: at zb(2.75) the frame is 582x327 world px, so five bodies inside the
      // radius is what turns the slam into a wall of numbers, skulls and dust
      // instead of one flame fan on open lawn. The middle body is a siege creep on
      // purpose: siege takes 40% damage from units, so it is the one thing in the
      // blast radius left standing for the last beat.
      const packDire = creepPack(
        w,
        "dire",
        "top",
        ["melee", "melee", "siege", "melee", "ranged"],
        2548,
        1440,
        48,
      );
      const siege = packDire[2];
      // allies (the blast cannot hurt them) holding the corner behind him
      creepPack(w, "radiant", "top", ["melee", "melee", "ranged"], 2716, 1508, 46);
      s.worldView.playerHeroId = boom.id;
      s.pump(0.6);
      s.cut(2680, 1442, s.zb(1.9)); // the quiet beat: one breath, both actors in frame
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
          // the melee creeps died in the blast; these two land on what survived,
          // both inside the 714ms the fire fan is still on screen
          { at: 760, fn: () => finish(w, boom, w.units.get(mark.id), true) },
          { at: 1030, fn: () => finish(w, boom, siege) },
        ],
      };
    }),

    // ---- 17 · VICTORY — the base falls layer by layer against live resistance: a
    //           burning base tower goes first (barrage, map-wide trauma, rubble
    //           swap), which is what opens the Ancient, and the Ancient follows.
    //           The shot ends inside the collapse — no banner, no card, the
    //           trailer stays pure gameplay to the last frame.
    //
    //           The Ancient's death sets w.phase = "ended" and step() then skips
    //           everything but projectiles, so every unit on screen freezes from
    //           that instant. FX, camera glide and trauma still run, so it reads
    //           as the world holding its breath — but only if it's short. The kill
    //           therefore sits at 1900 of 2500 (600ms), not at half the shot.
    scene(stage, "victory", 2500, (s) => {
      const w = s.installWorld(36);
      // dealDamage refuses a gated structure outright, so the ladder has to be
      // genuinely open before the filmed kills: a lane t2 unlocks the base
      // towers, and both base towers unlock the Ancient. Both retirees are far
      // off-camera; only the last two links fall on screen.
      retireStructure(w, "d-bot-t2");
      retireStructure(w, "d-base-1");
      const gate = w.units.get("d-base-2");
      if (gate) gate.hp = gate.maxHp * 0.15; // burning, one push from falling
      const ancient = w.units.get("d-ancient");
      if (ancient) ancient.hp = ancient.maxHp * 0.1;
      // west of the dire fountain pool: standing IN the enemy healing pool read
      // as a staging accident, and it sat the winners on top of a teal disc
      const iron = heroAt(w, "ironvow", "radiant", "v-iron", 3210, 1730);
      const dusk = heroAt(w, "duskblade", "radiant", "v-dusk", 3238, 1668);
      const storm = heroAt(w, "stormcaller", "radiant", "v-storm", 3196, 1800);
      // live defenders: the last stand, not an undefended building
      const dEmber = heroAt(w, "emberhex", "dire", "v-ember", 3400, 1580, {
        hpFrac: 0.4,
        facing: -1,
      });
      const dBoom = heroAt(w, "boomtinker", "dire", "v-boom", 3440, 1630, {
        hpFrac: 0.4,
        facing: -1,
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
      for (const u of [iron, dusk, storm])
        issueOrder(w, u, { type: "attackUnit", targetId: "d-base-2" });
      for (const d of [dEmber, dBoom]) issueOrder(w, d, { type: "attackUnit", targetId: iron.id });
      s.worldView.playerHeroId = iron.id;
      s.pump(0.6); // swings mid-arc at reveal
      s.cut(3330, 1700, s.zb(1.7));
      s.glide(3410, 1648, s.zb(1.9), 2500, easeInOut);
      return {
        cues: [
          { at: 400, fn: () => finish(w, iron, w.units.get("d-base-2")) },
          {
            // the gate is down, so the Ancient is attackable — the heroes turn
            at: 520,
            fn: () => {
              for (const u of [iron, dusk, storm])
                issueOrder(w, u, { type: "attackUnit", targetId: "d-ancient" });
            },
          },
          { at: 1900, fn: () => finish(w, dusk, w.units.get("d-ancient")) },
          { at: 1960, fn: () => sfx.victory(true) },
        ],
      };
    }),
  ];

  return {
    onGesture: (): void => {
      setMutedTransient(false);
      resumeAudio();
    },
    scenes,
  };
}

// ---- entry -----------------------------------------------------------------------

/** Called from BootScene's ?trailer=1 branch (after assets + anims are ready). */
export function launchTrailer(game: Phaser.Game): void {
  game.scene.add("TrailerStage", TrailerStage, true);
}
