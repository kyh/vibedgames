// TRAILER MODE director — stages every scene of the Battle Arena gameplay
// trailer through the REAL sim + render stack (createWorld/step/castAbility →
// WorldView/Fx/Environment). Nothing is mocked: every hit is a PendingStrike
// resolving on its measured contact frame, every explosion is the game's own
// FX pipeline, every kill pays real bounty/loot.
//
// Staging model:
//   - One persistent World, seeded, with camp-respawns/match end suppressed
//     (coins are pushed explicitly per scene, so their landing spot can be
//     framed at authoring time — the sim's own throw picks it from the RNG).
//     A fixed troupe (all six champions at max level + a pool of skeletons +
//     the Frost Golem) is spawned ONCE at boot so per-scene restaging is a
//     teleport, never a spawn — no Spawn_Air / Awaken clips leak into shots.
//   - Every scene's setup() fully re-stages: park everyone, clear transient
//     world state, place the actors, pre-roll a few sim ticks so the first
//     visible frame is mid-motion. The sim HOLDS between a scene's setup and
//     its first run() frame (mirrors GameScene's intro hold), so the shell's
//     dip-to-black cuts never eat choreography time.
//   - Unused champions park at their spawn bases and skeletons at their camps:
//     they double as living set dressing in wide shots.
//   - The camera is View.cinematic() — an explicit pose per frame that keeps
//     every juice channel (trauma shake, kick, FOV punch, flash) alive. ONE
//     scene (players-eye) instead drives View.follow(), the real gameplay
//     chase camera, so the reel answers "what does this look like on my
//     screen" in the game's own framing.
//
// Framing rules this file follows (they are why the camera numbers look the
// way they do), each one earned by a shot that failed without it:
//   1. Never put the lens on the caster→target axis behind the caster: you get
//      the back of a helmet, the target occluding the hero, and the cast VFX
//      column (fx.beam fires AT the caster) swallowing the subject. Shoot the
//      engagement in PROFILE, from a third position.
//   2. Camera height ABOVE look height. The scene has no skybox worth showing
//      (a near-black gradient dome), so a level lens spends a quarter of the
//      frame on dead pixels; tilting down fills it with arena instead.
//   3. Aim the view bearing at the two-story perimeter or the throne, never at
//      open plaza — bright VFX need a dark backdrop or they clip to white.
//   4. Cut on the beat: a shot ends on its impact, not on the walk away.
//
// Dead outside ?trailer=1: main.ts lazy-imports this module in its own chunk.
import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { SIM_DT, XP_CURVE } from "../data/config";
import { BOSS_POS, CAMPS, SPAWNS } from "../data/map";
import { castAbility } from "../sim/abilities";
import { grantXp } from "../sim/economy";
import { groundHeight } from "../sim/elevation";
import { clamp, lerp, norm } from "../sim/math";
import { breakStealth, recomputeStats } from "../sim/stats";
import { ALL_ABILITY_KEYS, nextId, type AbilityKey, type Unit, type World } from "../sim/types";
import {
  createWorld,
  setHeroInput,
  spawnCreep,
  spawnHero,
  step,
  syncAbilityRanks,
  tryJump,
} from "../sim/world";
import { Environment } from "../render/environment";
import { Fx } from "../render/fx";
import { ModelLibrary } from "../render/models";
import { View } from "../render/view";
import { WorldView } from "../render/world-view";
import { runTrailer, type TrailerScene } from "./trailer-shell";

const SEED = 0xba771e; // deterministic sim; only camera shake stays random
const FAR_RESPAWN = 1e15; // pins the dead troupe so cleanup/respawn never takes them
const CAMP_NEVER = 1e8; // finite ≠ POPULATED sentinel → camps never repopulate
const COIN_FLIGHT_MS = 900; // WorldView interpolates a thrown coin over exactly this

const clamp01 = (t: number): number => clamp(t, 0, 1);
const easeInOut = (t: number): number => {
  const c = clamp01(t);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};
/** Eased 0→1 ramp across [t0, t1] (ms). */
const ramp = (t: number, t0: number, t1: number): number => easeInOut((t - t0) / (t1 - t0));

/** Fire-once cue registry, reset per scene replay. */
class Cues {
  private fired = new Set<string>();
  reset(): void {
    this.fired.clear();
  }
  at(hit: boolean, id: string, fn: () => void): void {
    if (!hit || this.fired.has(id)) return;
    this.fired.add(id);
    fn();
  }
}

type SceneSpec = {
  id: string;
  duration: number;
  /**
   * Milliseconds of RENDER-side FX to age off inside setup(), used where a
   * cast's own flash stands on the caster (mage:R's beam, the ranger's launch
   * bloom) and would swallow the subject on the reveal frame.
   *
   * NOT the shell's `hold`, which buys the same thing with WALL CLOCK and
   * charges it to the wrong shot: the shell holds AFTER the cut, so the capture
   * measures that black inside the PREVIOUS scene's span — roster-3's 320ms
   * landed in roster-1's tail (1.03s of picture out of 1.33s) and roster-6's
   * 350ms in roster-5's (1.24s out of 1.64s), both ending on a 100%-black
   * frame. Burning under setup() costs no time at all.
   */
  burn?: number;
  setup: () => void;
  run?: (t: number) => void;
  teardown?: () => void;
};

class Director {
  private readonly world: World;
  private readonly worldView: WorldView;
  private readonly environment: Environment;
  private readonly fx: Fx;

  // the troupe (spawned once — views persist, so restaging never replays spawn clips)
  private readonly knight: Unit;
  private readonly ranger: Unit;
  private readonly mage: Unit;
  private readonly rogue: Unit;
  private readonly bk: Unit; // blackknight (Aurelius)
  private readonly witch: Unit;
  private readonly heroes: Unit[];
  private readonly warriors: Unit[] = [];
  private readonly minions: Unit[] = [];
  private readonly casters: Unit[] = [];
  private readonly golem: Unit;
  private readonly creeps: Unit[] = [];
  private readonly parkSpot = new Map<string, { x: number; y: number; f: number }>();

  // loop state
  private holding = true; // sim frozen between a scene's setup and its first run frame
  /** The active scene's run() body, queued by the shell and fired from this
   *  director's own loop (see the `scene` wrapper). */
  private pending: (() => void) | null = null;
  private acc = 0;
  private focusId = ""; // featured champion — env proximity + Fx juice follow them
  private readonly camPos = new THREE.Vector3(0, 26, 34);
  private readonly camLook = new THREE.Vector3(0, 2, 0);
  private camFov = 52;
  private camMode: "cinematic" | "follow" = "cinematic";
  private musicLevel: 0 | 1 | 2 | 3 = 0; // re-applied when the gesture unlocks audio

  constructor(
    private readonly view: View,
    lib: ModelLibrary,
  ) {
    const w = createWorld(SEED);
    this.world = w;
    // suppress everything on a timer that could wander into a staged shot.
    // Coins are the exception: scenes push them explicitly (see sceneHallReveal)
    // because throwCoin() draws its landing point from the seeded RNG, which
    // can't be framed at authoring time.
    w.nextCoinAt = Number.MAX_SAFE_INTEGER;
    w.nextDeliveryAt = Number.MAX_SAFE_INTEGER;
    w.killGoal = Number.MAX_SAFE_INTEGER;
    w.matchTime = Number.MAX_SAFE_INTEGER;
    for (const camp of CAMPS) w.campRespawnAt[camp.id] = CAMP_NEVER;

    // render stack — same construction order as GameScene
    this.worldView = new WorldView(view.scene, lib);
    this.worldView.localId = ""; // nobody is "the local player": team rings for all
    this.worldView.setupBoss();
    this.environment = new Environment(view.scene, lib);
    this.environment.setup();
    view.refreshShadows();
    this.fx = new Fx(view.scene, view);
    this.worldView.fx = this.fx;
    // Audio stays muted until the shell reports a real gesture (see onGesture);
    // nothing here touches the AudioContext, which Audio itself only creates on
    // that same first click/keypress.

    // champions — max level (R unlocked, real stat growth); the level-up bursts
    // this queues are dropped below, before Fx ever renders them
    this.knight = this.addHero("knight", 0);
    this.ranger = this.addHero("ranger", 1);
    this.mage = this.addHero("mage", 2);
    this.rogue = this.addHero("rogue", 3);
    this.bk = this.addHero("blackknight", 4);
    this.witch = this.addHero("witch", 5);
    this.heroes = [this.knight, this.ranger, this.mage, this.rogue, this.bk, this.witch];

    // skeleton pool + the elite — parked at real camps so wides read as a live arena
    const camp0 = { x: 38.05, y: 0 };
    const camp2 = { x: -19.02, y: 32.95 };
    const camp5 = { x: 19.02, y: -32.95 };
    const lair = { x: 25.01, y: 43.33 };
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      this.warriors.push(
        this.addCreep("skwarrior", camp0.x + Math.cos(a) * 2.2, camp0.y + Math.sin(a) * 2.2),
      );
    }
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.7;
      this.minions.push(
        this.addCreep("skminion", camp2.x + Math.cos(a) * 2.0, camp2.y + Math.sin(a) * 2.0),
      );
    }
    for (let i = 0; i < 2; i++) {
      this.casters.push(this.addCreep("skmage", camp5.x + (i === 0 ? -1.6 : 1.6), camp5.y + 0.8));
    }
    this.golem = this.addCreep("frostgolem", lair.x, lair.y);
    this.parkAll();

    // Boot transients — the six level-up bursts above, plus the first-frame
    // Spawn_Air / Skeletons_Awaken_Floor drop-in (and its dust) every UnitView
    // fires when it is created — used to burn off unseen while the old click
    // gate waited for a click. The shell's 600ms lead-in is shorter than a
    // 1.3s Spawn_Air, so retire them HERE instead: the constructor presents no
    // frame, so this is invisible, and only the RENDER stack moves — no step(),
    // so the sim clock and its seeded RNG stream are untouched.
    w.fx.length = 0; // the level-ups: dropped before Fx ever sees them
    this.worldView.sync(w, 0); // builds the views → fires their spawn clips
    for (let i = 0; i < 30; i++) {
      this.fx.update(w, 0.1);
      this.worldView.sync(w, 0.1); // 3s of clip time > the 2.5s one-shot ceiling
    }
  }

  // ── troupe management ──────────────────────────────────────────────────────

  private addHero(champId: string, slot: number): Unit {
    const u = spawnHero(this.world, {
      id: `star-${champId}`,
      ownerId: `star-${champId}`,
      team: `star-${champId}`,
      champId,
      name: CHAMP_BY_ID[champId]?.name ?? champId,
      isBot: false, // director-driven — AI never touches them
      slot,
    });
    grantXp(this.world, u, 1e6); // level cap: R rank 3, real growth stats
    return u;
  }

  private addCreep(type: string, x: number, y: number): Unit {
    // camp id "troupe" is unknown to tickCamps → this creep is never respawned
    spawnCreep(this.world, type, x, y, { id: "troupe", x, y });
    const u = this.world.units.get(`c${this.world.seq}`);
    if (!u) throw new Error("unreachable: spawnCreep always inserts a unit");
    this.parkSpot.set(u.id, { x, y, f: Math.atan2(-y, -x) });
    this.creeps.push(u);
    return u;
  }

  /** Full unit reset + teleport. WorldView snaps on moves > 6u, so cross-arena
   *  restaging cuts cleanly; the reset covers every field a scene could dirty. */
  private place(u: Unit, x: number, y: number, facing: number): void {
    u.alive = true;
    u.hp = u.maxHp;
    u.respawnAt = 0;
    u.statuses = [];
    u.pendingAttack = null;
    u.queuedCast = null;
    u.kbx = 0;
    u.kby = 0;
    u.kbUntil = 0;
    u.dashUntil = 0;
    u.dashVx = 0;
    u.dashVy = 0;
    u.jumpUntil = 0;
    u.empowerNext = 0;
    u.ambush = false;
    u.steerVx = 0;
    u.steerVy = 0;
    u.vx = 0;
    u.vy = 0;
    u.moveX = 0;
    u.moveY = 0;
    u.attackHeld = false;
    u.x = x;
    u.y = y;
    u.facing = facing;
    u.aimX = Math.cos(facing);
    u.aimY = Math.sin(facing);
    u.swingCount = 0;
    u.lastAttackAt = this.world.now - 9999; // free to swing immediately
    for (const key of ALL_ABILITY_KEYS) u.abilities[key].readyAt = 0;
    if (u.kind === "creep") {
      u.homeX = x; // skeleton AI leashes/aggros around the staged spot
      u.homeY = y;
    }
  }

  private parkAll(): void {
    for (const h of this.heroes) {
      const sp = SPAWNS[h.slot % SPAWNS.length];
      if (sp) this.place(h, sp.x, sp.y, sp.facing);
    }
    for (const c of this.creeps) {
      const p = this.parkSpot.get(c.id);
      if (p) this.place(c, p.x, p.y, p.f);
    }
  }

  /** Clear every transient world entity + park the whole troupe. Each scene
   *  setup starts here, so no scene depends on what the previous one left. */
  private restage(): void {
    const w = this.world;
    w.projectiles.clear();
    w.grounds = [];
    w.strikes = [];
    w.coins = [];
    w.deliveries = [];
    w.fx.length = 0;
    // damage numbers live on their own real-time clock, so without this the
    // previous scene's numbers are still arcing over the new scene's first
    // frames — consecutive cuts read as jump-cuts inside one continuous shot
    this.fx.clearNumbers();
    // revive broken destructible props (mirrors the sim's own prop-respawn
    // block): their natural respawn is 50s of SIM time away, but scenes only
    // accumulate ~36s between visits — without this, every replay/loop/jump
    // plays the destruction scene against an already-emptied cellar
    for (const u of w.units.values()) {
      if (u.kind === "prop" && !u.alive) {
        u.alive = true;
        u.hp = u.maxHp;
        u.respawnAt = 0;
        u.statuses = [];
      }
    }
    this.parkAll();
  }

  /** Dead troupe members must linger as corpses instead of being culled or
   *  respawning mid-shot — a later scene revives them via place(). Heroes are
   *  included so the FFA scrum can hold on a champion's death dissolve (the
   *  cold-ghost corpse) instead of watching them pop back to life. Post-step. */
  private pinDeadTroupe(): void {
    for (const c of this.creeps) {
      if (!c.alive && c.respawnAt < FAR_RESPAWN) c.respawnAt = FAR_RESPAWN;
    }
    for (const h of this.heroes) {
      if (!h.alive && h.respawnAt < FAR_RESPAWN) h.respawnAt = FAR_RESPAWN;
    }
  }

  // ── staging verbs ──────────────────────────────────────────────────────────

  /** Featured champion of the scene: Fx hit-stop/kick/combo-numbers key off
   *  localId; environment proximity decor follows them. */
  private focus(u: Unit): void {
    this.focusId = u.id;
    this.fx.localId = u.id;
    this.fx.localOwnerId = u.ownerId;
  }

  /** Music intensity for the scene. Held as state too: the track only exists
   *  once a gesture unlocks audio, so a late unlock re-applies the last level. */
  private music(level: 0 | 1 | 2 | 3): void {
    this.musicLevel = level;
    this.fx.audio.music?.setIntensity(level);
  }

  /** Per-scene exposure stop. The chain is UnrealBloom(0.6 @ 0.82) → ACES at
   *  exposure 1.0; the loudest ults stack three additive cores on near-white
   *  flagstone and clip the subject out of their own money shot. Stopping down
   *  is the one lens control that changes nothing about the gameplay render.
   *  Reset to 1 by the scene wrapper, so a scene only ever sets it. */
  private expose(stops: number): void {
    this.view.renderer.toneMappingExposure = stops;
  }

  /** Per-scene FLASH stop — the lens control expose() is not.
   *
   *  expose() scales the whole frame, which is the wrong instrument when the
   *  thing clipping stands ON the subject: the level-up beam and Oblivion Slam
   *  are full-height additive columns, so the blown pixels and the champion are
   *  the same pixels and no stop separates them (loot-pop was still 10% of the
   *  frame clipped at 0.78). This scales the additive FX themselves plus the
   *  bloom that smears them — the picture behind keeps its exposure, only the
   *  flash gets quieter, and the subject comes back out of its own payoff.
   *
   *  Reset to 1 by the scene wrapper, so a scene only ever sets it. Applies from
   *  the next spawn on, so call it in setup(), before the cast fires. */
  private damp(gain: number): void {
    this.fx.setFlashGain(gain);
    this.view.bloomScale = gain;
  }

  /** Scripted cast through the REAL ability pipeline. Cooldowns are staging
   *  state, so they're cleared first — the cast itself is authentic. */
  private cast(u: Unit, key: AbilityKey, px: number, py: number): void {
    u.abilities[key].readyAt = 0;
    const d = norm(px - u.x, py - u.y);
    castAbility(this.world, u, key, { point: { x: px, y: py }, dir: d });
  }

  /** Point intent at a target: aim (and optionally move/attack) via the same
   *  setHeroInput the host uses for every player. */
  private aimAt(u: Unit, at: { x: number; y: number }, mx = 0, my = 0, attack = false): void {
    const d = norm(at.x - u.x, at.y - u.y);
    setHeroInput(u, mx, my, d.x, d.y, attack);
  }

  /** Push a real Over Boss coin on a framed arc. WorldView plays the boss's
   *  `Throw` clip for any coin still in flight, races a gold landing telegraph
   *  down with it, and tickCoins does the first-to-touch claim — all the same
   *  code the 12s cadence drives, minus its unframeable random landing spot. */
  private throwCoin(tx: number, ty: number, gold: number): void {
    const w = this.world;
    w.coins.push({
      id: nextId(w, "coin"),
      x: tx,
      y: ty,
      fromX: BOSS_POS.x,
      fromY: BOSS_POS.y,
      gold,
      landAt: w.now + COIN_FLIGHT_MS,
      expireAt: w.now + 600000,
    });
    w.fx.push({ t: "coinThrow", x: BOSS_POS.x, y: BOSS_POS.y, tx, ty });
  }

  /** Age the RENDER stack `ms` forward with the sim frozen — what a shell
   *  `hold` does, minus the wall clock. Only Fx + WorldView move (no step()),
   *  so the sim clock and its seeded RNG stream are untouched; the constructor
   *  runs the identical trick to retire the boot spawn clips. */
  private burnFx(ms: number): void {
    const dt = 1 / 60;
    for (let i = Math.round(ms / 1000 / dt); i > 0; i--) {
      this.fx.update(this.world, dt);
      this.worldView.sync(this.world, dt * this.fx.scaleNow());
    }
  }

  /** Advance the sim n fixed ticks inside setup() (screen is black) so the
   *  first visible frame is mid-motion — never an idle spawn pose. */
  private preRoll(n: number): void {
    for (let i = 0; i < n; i++) {
      step(this.world);
      this.pinDeadTroupe();
    }
  }

  /** Camera pose in sim-plane coords + heights: (px,py) ground position,
   *  ph camera height; (lx,ly,lh) look target. */
  private setCam(
    px: number,
    ph: number,
    py: number,
    lx: number,
    lh: number,
    ly: number,
    fov = 52,
  ): void {
    this.camPos.set(px, ph, py);
    this.camLook.set(lx, lh, ly);
    this.camFov = fov;
  }

  private nearestAlive(list: Unit[], to: Unit): Unit | null {
    let best: Unit | null = null;
    let bestD = Infinity;
    for (const u of list) {
      if (!u.alive) continue;
      const d = (u.x - to.x) ** 2 + (u.y - to.y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  /** Wrap a scene spec: hold the sim through the dip-to-black, release on run. */
  private scene(spec: SceneSpec): TrailerScene {
    const out: TrailerScene = {
      id: spec.id,
      duration: spec.duration,
      setup: () => {
        this.holding = true;
        // Drop anything the outgoing scene queued: it would otherwise fire once
        // against the incoming scene's freshly staged world.
        this.pending = null;
        this.camMode = "cinematic"; // opt-in per scene; everything else is authored
        this.expose(1);
        this.damp(1);
        spec.setup();
        if (spec.burn !== undefined) this.burnFx(spec.burn);
        // Warm pass under the black: builds/compiles whatever this staging
        // newly needs so the hitch doesn't land on the frame the cut reveals.
        this.fx.update(this.world, 0);
        this.worldView.sync(this.world, 0);
      },
      // The shell's rAF fires AFTER this director's own animation loop, so a
      // camPos written straight from here frames the pose of the PREVIOUS
      // frame. With the sim on a fixed SIM_DT accumulator and the display at
      // 120Hz, units advance on alternate frames and the camera on the others,
      // and a shot that tracks a hero (`camPos.set(k.x + 3.5, …)`) square-waves
      // it toward and away from the lens every frame. Queue the body instead
      // and let the loop run it against the pose it is about to draw.
      run: (t) => {
        this.holding = false;
        this.pending = spec.run ? () => spec.run?.(t) : null;
      },
    };
    if (spec.teardown) out.teardown = spec.teardown;
    return out;
  }

  // ── the loop + kickoff ─────────────────────────────────────────────────────

  start(): void {
    const timer = new THREE.Timer();
    this.view.renderer.setAnimationLoop((t) => {
      timer.update(t);
      const frameDt = Math.min(timer.getDelta(), 1 / 30);
      if (this.holding) {
        this.acc = 0; // frozen while black: no real-time gap unwinds on release
      } else {
        this.acc += frameDt;
        let n = 0;
        while (this.acc >= SIM_DT && n < 5) {
          step(this.world);
          this.pinDeadTroupe();
          this.acc -= SIM_DT;
          n++;
        }
      }
      // Scene choreography, in phase with the pose about to be drawn (see the
      // `run` wrapper). Scripted hero input therefore lands one sim step later
      // than it used to, which is 16ms against cue granularity of ~100ms.
      const pending = this.pending;
      this.pending = null;
      pending?.();
      this.fx.update(this.world, frameDt);
      // the HUD normally drains these queues; trailer mode has no HUD
      this.fx.feed.length = 0;
      this.fx.toasts.length = 0;
      this.fx.localHits.length = 0;
      const rdt = frameDt * this.fx.scaleNow(); // hit-stop scales render, never sim
      this.worldView.sync(this.world, rdt);
      const focus = this.world.units.get(this.focusId);
      if (focus) this.environment.setLocalPos(focus.x, focus.y);
      this.environment.update(this.world.gameTime);
      this.view.tickAura(this.world.gameTime);
      if (this.camMode === "follow" && focus) {
        // the real gameplay chase cam, driven by the same arguments GameScene
        // passes — pitch 0 is the neutral look
        this.view.follow(
          focus.x,
          focus.y,
          focus.aimX,
          focus.aimY,
          0,
          rdt,
          groundHeight(focus.x, focus.y),
        );
      } else {
        this.view.cinematic(this.camPos, this.camLook, rdt, this.camFov);
      }
      this.view.render();
    });

    runTrailer({
      // No start gate any more, so the trailer opens silent: unmute on the
      // viewer's first real click/keypress (Audio creates + resumes its context
      // on that same gesture). Ephemeral — setMuted would persist
      // localStorage["ba-muted"]="0" and unmute normal gameplay for good.
      onGesture: () => {
        this.fx.audio.setMutedEphemeral(false);
        this.fx.audio.music?.setIntensity(this.musicLevel);
      },
      scenes: [
        this.sceneColdOpen(),
        this.sceneHallReveal(),
        this.sceneSignature(),
        this.scenePlayersEye(),
        this.sceneRosterRogue(),
        this.sceneRosterRanger(),
        this.sceneRosterWitch(),
        this.sceneRosterMage(),
        this.sceneDestruction(),
        this.sceneLootPop(),
        this.sceneGolemBoss(),
        this.sceneFrenzy(),
        this.sceneFourWay(),
        this.sceneHeroPose(),
      ],
    });
  }

  // ── scene 1: COLD OPEN — Garran vs three skeletons, mid-fight ──────────────
  private sceneColdOpen(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "cold-open-clash",
      // the flanker's chain (chop → slice → 2H SPIN) is 2.1s of real swing
      // intervals and the kill resolves at ~2700; anything shorter plays the
      // whirl, the kill-confirm hit-stop and the bone scatter under the black
      duration: 3000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(1);
        // The opening cleave's impact flash sat at 5.1% clipped over the right
        // third. Damped rather than stopped down: the reel's first frame has to
        // keep its full contrast between torchlight and the dark perimeter.
        // Taken further than the number alone asks for because that flash is a
        // ~100ms transient — a single still of it ranges over three points run
        // to run, so the frame needs headroom, not a value that just clears.
        this.damp(0.5);
        this.place(this.knight, 20, -6, Math.atan2(1.4, -3.1));
        const [w1, w2, w3] = this.warriors;
        if (w1) {
          this.place(w1, 16.9, -4.6, 0);
          w1.hp = 180; // the opening cleave must kill clean
        }
        if (w2) {
          this.place(w2, 16.2, -7.2, 0);
          w2.hp = 180;
        }
        if (w3) {
          this.place(w3, 21.3, -10.1, Math.PI / 2); // flanker — outside the Q cone
          // calibrated so he dies exactly on the 3rd swing, the 2H SPIN (2.5×
          // damage): 89 + 95 leaves him standing, the spin takes the rest. Any
          // change to this number changes WHICH swing is the payoff, and the
          // scene's duration is cut to that swing's contact frame.
          w3.hp = 300;
        }
        // pre-roll: skeletons lunging at the braced knight — motion from frame
        // one. The knight gets ZERO move intent: the sim normalizes intent to
        // full speed (magnitude is ignored), so any drift here would sprint
        // him clean through his own Q kill site.
        this.aimAt(this.knight, { x: 16.5, y: -5.5 });
        this.preRoll(8);
        // PROFILE of the engagement from its north-east flank: the knight faces
        // WNW into the pack, so a lens behind him (the old pose) framed his back
        // with a skeleton in front of it. Perpendicular puts the pack on the left
        // third, the knight on the right, and the flanker duel beyond him — and
        // 2.9u of height over a 1.05u look drops the horizon into the top
        // quarter, where the two-story perimeter fills it instead of black sky.
        this.setCam(20.9, 2.55, -0.2, 18.4, 1.25, -5.6, 50);
      },
      run: (t) => {
        // heavy cleave on its measured contact frame (~250ms after the cast):
        // lands at ~570ms, a fifth into the cut — double kill, bones scatter
        cues.at(t >= 320, "q", () => this.cast(this.knight, "Q", 16.5, -5.5));
        const w3 = this.warriors[2];
        // pivot on the frame the cleave's two kills resolve (600ms), not after:
        // the swing chain that follows is 2.1s long and the shot has to end on
        // its last contact, not on the windup
        if (t >= 600 && w3 && w3.alive) {
          // pivot onto the flanker: chop → slice → SPIN. Aim-only — w3's own AI
          // has already chased into melee (it stops at ~1.76u), so the knight
          // stays planted and every swing connects instead of whiffing mid-sprint.
          this.aimAt(this.knight, w3, 0, 0, true);
        } else if (t >= 600) {
          setHeroInput(this.knight, 0, 0, this.knight.aimX, this.knight.aimY, false);
        }
        // slow lateral truck toward the flanker side; the look leads the pivot
        const kp = ramp(t, 0, 3000);
        const kl = ramp(t, 500, 1300);
        this.camPos.set(lerp(20.9, 22.4, kp), lerp(2.55, 2.35, kp), lerp(-0.2, -2.2, kp));
        this.camLook.set(lerp(18.4, 20.2, kl), lerp(1.25, 1.15, kl), lerp(-5.6, -7.6, kl));
        this.camFov = 50;
      },
    });
  }

  // ── scene 2: HALL REVEAL — the Sunken Court, and what it is worth ──────────
  // The one shot that says WHERE all of this happens: a boom down through the
  // god-ray shafts onto the hexagonal two-story hall, with the Over Boss hurling
  // his 300g coin into the mid-field and all six champions converging inward on
  // it. Objective, geography and roster in a single frame.
  private sceneHallReveal(): TrailerScene {
    const cues = new Cues();
    // On Vesper's lane (her base bearing is exactly 210°), dead centre of frame,
    // and one radial unit CLEAR of the stair run: at r = 13.04 the landing point
    // sat inside the south-west ramp wedge at h ≈ 0.72, and WorldView flies a
    // coin at a flat 0.5 + arc but parks it at terrainHeight + 0.6 — so it sank
    // into the steps and snapped up 0.8u on the landing frame. See sceneHeroPose.
    const COIN = { x: -12.38, y: -7.15 };
    return this.scene({
      id: "hall-reveal",
      duration: 3400,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.rogue); // she is the one who reaches the coin
        this.music(1);
        // every champion mid-lane, already running: base→centre at radius 27
        for (const h of this.heroes) {
          const sp = SPAWNS[h.slot % SPAWNS.length];
          if (!sp) continue;
          const a = Math.atan2(sp.y, sp.x);
          this.place(h, Math.cos(a) * 27, Math.sin(a) * 27, a + Math.PI);
        }
        this.preRoll(6);
        this.setCam(33, 19, 27, 2, 4.5, 2, 56);
      },
      run: (t) => {
        // the boss winds up and throws — the coin flies its real 900ms arc with
        // the gold telegraph sweep racing it to the floor
        cues.at(t >= 150, "coin", () => this.throwCoin(COIN.x, COIN.y, 300));
        // six champions converge on the contested centre. Off-diagonal headings
        // meet the plateau cliff and get slid toward the nearest stair, which is
        // the map's central idea playing out on its own.
        for (const h of this.heroes) {
          const d = norm(-h.x, -h.y);
          setHeroInput(h, d.x, d.y, d.x, d.y, false);
        }
        // boom + dolly down through the shafts toward the throne
        const k = ramp(t, 0, 3400);
        this.camPos.set(lerp(33, 14.5, k), lerp(19, 6.2, k), lerp(27, 13.5, k));
        this.camLook.set(lerp(2, 0.5, k), lerp(4.5, 3.2, k), lerp(2, 0.5, k));
        this.camFov = lerp(56, 50, k);
      },
    });
  }

  // ── scene 3: SIGNATURE — Aurelius' Oblivion Slam, fully readable ───────────
  private sceneSignature(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "signature-clean",
      duration: 2200,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(1);
        // Oblivion Slam's gold column stands on him too — same shape of problem
        // as loot-pop, same split: damp the column, hand the stop back.
        this.expose(0.88);
        this.damp(0.5);
        this.place(this.bk, -16, -14, Math.atan2(2.2, 2.8));
        const w = this.warriors[0];
        if (w) this.place(w, -13.2, -11.8, Math.atan2(-2.2, -2.8)); // dies to the slam
        this.preRoll(6); // skeleton already closing in
        // profile from his left, well INSIDE the partition run at (-30,-6): the
        // old pose sat behind him on the slam axis (back of helmet, bloom core
        // dead centre). 2.7u of height over a 1.4u look keeps the horizon high.
        this.setCam(-20.2, 2.7, -8.7, -15.4, 1.4, -13.2, 48);
      },
      run: (t) => {
        // windup (wings + rising gold) → contact ~830ms → shockwave + kill
        cues.at(t >= 300, "r", () => this.cast(this.bk, "R", this.bk.x, this.bk.y));
        // lateral arc around him rather than a dolly: the subject travels across
        // frame instead of sitting locked at centre
        const k = ramp(t, 0, 2200);
        const az = lerp(2.238, 1.885, k); // 128° → 108° around his mark
        this.camPos.set(-16 + Math.cos(az) * 6.8, lerp(2.7, 2.3, k), -14 + Math.sin(az) * 6.8);
        this.camLook.set(-15.5, 1.4, -13.3);
        this.camFov = 48;
      },
    });
  }

  // ── scene 4: THE PLAYER'S EYE — the real chase camera, no cuts, no lens ────
  // Every other shot is an authored pose. This one is View.follow(): the FPS-
  // framed action-RPG camera the player actually has, out of a base gate,
  // through a hop, into a swing. It is the only answer to "what does this look
  // like on my screen".
  private scenePlayersEye(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "players-eye",
      duration: 2800,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(2);
        // start ON his own base pad: fountain, shop, banner and torch are the
        // first thing in frame, and the chase cam has room behind him
        this.place(this.knight, 38, 22, Math.atan2(-22, -38));
        const [w1, w2] = this.warriors;
        if (w1) {
          this.place(w1, 27.0, 14.6, Math.atan2(7.4, 11));
          w1.hp = 70; // the first contact frame kills — the kill-confirm freeze,
          // gold ring and FOV punch all land inside the chase-cam framing
        }
        if (w2) this.place(w2, 29.2, 17.0, Math.atan2(5, 8.8));
        this.preRoll(3);
        this.camMode = "follow";
        // snap the follow focus (its translation lerp is dt-based, so one call
        // at dt=1 places it) — otherwise the camera glides in from the last pose
        this.view.follow(
          this.knight.x,
          this.knight.y,
          this.knight.aimX,
          this.knight.aimY,
          0,
          1,
          groundHeight(this.knight.x, this.knight.y),
        );
      },
      run: (t) => {
        const k = this.knight;
        // the plain evasive hop — 880ms arc, takeoff/float/land with the squash
        cues.at(t >= 620, "hop", () => tryJump(this.world, k));
        const target = this.nearestAlive(this.warriors, k);
        if (t < 1700 || !target) {
          // sprint the lane while the LOOK swings ~35° off the run heading and
          // back: 1:1 mouse-look with no rotational smoothing is the read
          const inward = norm(-k.x, -k.y);
          const swing = Math.sin(clamp01((t - 800) / 700) * Math.PI) * -0.6;
          const a = Math.atan2(inward.y, inward.x) + swing;
          setHeroInput(k, inward.x, inward.y, Math.cos(a), Math.sin(a), false);
        } else {
          const gap = Math.hypot(target.x - k.x, target.y - k.y);
          const d = norm(target.x - k.x, target.y - k.y);
          const close = gap > 2.6;
          setHeroInput(k, close ? d.x : 0, close ? d.y : 0, d.x, d.y, true);
        }
      },
    });
  }

  // ── scenes 5-8: ROSTER CUTDOWN — one signature per champion, escalating ────
  // Four cuts, not six: Garran and Aurelius already headline their own scenes,
  // and a sixth repeat of "hero at X, pack at X+4, one AoE, pack wipes" is a
  // metronome. Lengths and shot sizes alternate deliberately.
  private sceneRosterRogue(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-1",
      duration: 950,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.rogue);
        this.music(2);
        // the poison-lunge execute detonates on the lens at fov 44, and its core
        // was taking the rogue's whole upper body with it (3.7% of the frame
        // clipped, no hood, no daggers) — damp the burst, keep the throw
        this.damp(0.5);
        this.place(this.rogue, 26, 8, Math.atan2(1.4, -3.4));
        const m = this.minions[0];
        if (m) {
          this.place(m, 22.6, 9.4, Math.atan2(-1.4, 3.4));
          m.hp = 150; // poison lunge executes it
        }
        this.preRoll(4);
        // lens PAST the victim so the lunge comes AT the camera (the old pose
        // sat behind her and the whole cut was a green hood). CLOSE: ~5u throw
        // at fov 44 so she fills the frame, with the partition run behind as a
        // dark backdrop for the twin dagger trails.
        this.setCam(17.7, 2.2, 8.6, 22.0, 1.05, 9.3, 44);
      },
      run: (t) => {
        // lunge OUT of depth — she dashes toward the lens, cut lands mid-frame
        cues.at(t >= 0, "q", () => this.cast(this.rogue, "Q", 22.6, 9.4));
        const k = ramp(t, 150, 700);
        this.camLook.set(lerp(22.0, 22.9, k), lerp(1.05, 1.15, k), lerp(9.3, 9.0, k));
      },
    });
  }

  private sceneRosterRanger(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-3",
      duration: 950,
      // Tempest Volley detonates a 4u additive flash at the moment of the cast;
      // no exposure stop survives it, so the LAUNCH ages off under the black and
      // the cut opens on the apex — spinning, untouchable, arrows already leaving.
      burn: 320,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.ranger);
        // Even after the burn the arrow impacts hazed the bottom half to white
        // and left her a pale speck at 4.2% clipped — the worst frame in the cut
        // once loot-pop was fixed. Damping the impacts is what buys the dark
        // sky and the perimeter wall back, so the stop comes up with it.
        this.expose(0.92);
        this.damp(0.45);
        // staged out at radius 38 and shot OUTWARD: pale arrows over pale
        // flagstone were invisible, so the two-story perimeter has to be the
        // backdrop. Camera below the look height tips the wall into frame.
        this.place(this.ranger, 0, -38, Math.PI / 2);
        const ring = [
          { x: 3.2, y: -36.8 },
          { x: -0.6, y: -34.6 },
          { x: -3.2, y: -39.2 },
          { x: 1.2, y: -41.2 },
        ];
        this.minions.forEach((m, i) => {
          const p = ring[i];
          if (!p) return;
          this.place(m, p.x, p.y, Math.atan2(-38 - p.y, -p.x));
          m.hp = 100; // the ring volley clears all four
        });
        this.preRoll(6); // the ring is closing in
        // surrounded → Tempest Volley: spring up, hang untouchable, 360° ring
        this.cast(this.ranger, "JUMP", 0, -32);
        this.preRoll(9); // 300ms: past the launch flash, into the hang
        // stood off ~10u with the look ABOVE the lens: she springs to 2.8u and
        // fires from the apex, so a tighter/lower pose cropped her out the top
        this.setCam(-6.4, 2.2, -30.6, 1.2, 3.2, -37.0, 50);
      },
      run: (t) => {
        const k = ramp(t, 0, 950);
        this.camPos.set(lerp(-6.4, -5.4, k), lerp(2.2, 2.5, k), lerp(-30.6, -31.8, k));
      },
    });
  }

  private sceneRosterWitch(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-5",
      duration: 1200,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.witch);
        // Grand Hex detonates its seal as one additive core on pale flagstone
        // and the 37% frame sat at 5.2% clipped, with the pack lost inside it.
        // A light damp is enough here — there is no column, just the one core.
        this.damp(0.75);
        // whole staging pulled 2.5u toward the centre, off the shrine-statue
        // axis that was cropping the left edge and bisecting the pack with a post
        this.place(this.witch, 12.4, -20.2, Math.atan2(0.8, 3.3));
        const pack = [
          { u: this.warriors[0], x: 15.2, y: -17.9 },
          { u: this.minions[0], x: 16.6, y: -19.2 },
          { u: this.minions[1], x: 15.4, y: -21.0 },
        ];
        for (const p of pack) {
          if (p.u) this.place(p.u, p.x, p.y, Math.atan2(-20.2 - p.y, 12.4 - p.x));
        }
        this.preRoll(5);
        // yawed ~35° off her back so the pack is in clear profile when it pops
        this.setCam(8.4, 3.2, -24.4, 15.0, 1.2, -19.6);
      },
      run: (t) => {
        // Grand Hex: the seal snaps shut — the whole pack becomes mushrooms
        cues.at(t >= 60, "r", () => this.cast(this.witch, "R", 15.4, -19.2));
        const k = ramp(t, 550, 1050); // drop to mushroom eye-level as they pop
        this.camPos.set(lerp(8.4, 10.0, k), lerp(3.2, 1.6, k), lerp(-24.4, -23.0, k));
      },
    });
  }

  private sceneRosterMage(): TrailerScene {
    return this.scene({
      id: "roster-6",
      duration: 1400,
      // mage:R spawns its cast BEAM standing on the caster, which is what
      // swallowed him for the whole of the old cut. Fx runs on its own clock,
      // so 350ms of it ages off unseen inside setup() while the sim — and the
      // meteor telegraph riding on it — stays frozen.
      burn: 350,
      setup: () => {
        this.restage();
        this.focus(this.mage);
        this.expose(0.84); // the impact clips to pure white at 1.0
        this.place(this.mage, 0, 17, -Math.PI / 2);
        // a pack holding the throne plateau — the meteor takes the high ground
        const pack = [
          { u: this.warriors[0], x: -1.4, y: 8.6 },
          { u: this.warriors[1], x: 1.5, y: 9.4 },
          { u: this.minions[0], x: -0.2, y: 7.2 },
          { u: this.minions[1], x: 1.9, y: 7.8 },
        ];
        for (const p of pack) {
          if (p.u) this.place(p.u, p.x, p.y, -Math.PI / 2);
        }
        // pre-cast + pre-roll: the shot OPENS on the red sweep with the comet
        // already diving (the full 1.2s telegraph doesn't fit the cut)
        this.cast(this.mage, "R", 0, 9);
        this.preRoll(14);
        // flank: caster on the left third in profile, impact on the right
        this.setCam(6.6, 2.6, 19.6, 1.0, 2.4, 12.6, 56);
      },
      run: (t) => {
        // impact ~730ms: obliteration on the dais steps, then the crater burns
        const k = ramp(t, 0, 1400);
        this.camPos.set(lerp(6.6, 5.6, k), lerp(2.6, 2.8, k), lerp(19.6, 18.2, k));
      },
    });
  }

  // ── scene 9: DESTRUCTION — whirlwind through the Cellar keg hoard ──────────
  private sceneDestruction(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "destruction",
      duration: 2050, // the hoard is shredded by ~1.8s; anything past that is a lone spin
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(2);
        // started 2.5u deeper in: the partition-end barrel breaks immediately
        // and the Cellar stash is inside whirlwind reach by ~0.6s, so the shot
        // is chain-detonations end to end instead of a long approach
        this.place(this.knight, -32.0, 1.4, Math.PI);
        setHeroInput(this.knight, -1, 0.1, -1, 0.1, false); // already at full sprint
        this.preRoll(4);
        this.setCam(-28.5, 1.75, 5.7, -33.2, 1.0, 1.1);
      },
      run: (t) => {
        cues.at(t >= 120, "r", () => this.cast(this.knight, "R", this.knight.x - 1, this.knight.y));
        // carve a curve through the keg hoard — crates, barrels, chain-pops
        if (t < 1100) setHeroInput(this.knight, -1, 0.12, -1, 0.12, false);
        else setHeroInput(this.knight, -1, -0.25, -1, -0.25, false);
        // tight truck alongside the cyclone: at the old 8.5u throw the salmon
        // AoE ring was the biggest thing in frame and the hero was 22% of it
        const k = this.knight;
        this.camPos.set(k.x + 3.5, 1.75, k.y + 4.3);
        this.camLook.set(k.x - 2.4, 1.0, k.y - 0.3); // bias ahead: he rides the left third
        this.camFov = 52;
      },
    });
  }

  // ── scene 10: LOOT POP — kill, weapon-bit drop, dash-scoop, level-up ───────
  private sceneLootPop(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "loot-pop",
      duration: 2400,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.ranger);
        // The level-up beam is a full-height additive column and the lens stands
        // where it plays biggest, so it clipped 19.8% of the frame to pure white
        // and erased the archer inside her own payoff. Stopping down took it to
        // 10% and no further — the beam and the archer are the same pixels, so
        // no lens setting separates them. damp() quiets the column instead,
        // which is what lets the stop come back up: the floor, the perimeter and
        // the coins keep their contrast and she stays visible through the beam.
        this.expose(0.88);
        this.damp(0.5);
        // one level below cap so the pickup's XP visibly levels her up
        this.ranger.level = 11;
        this.ranger.xp = (XP_CURVE[11] ?? 4000) - 200; // kill XP (+60) must not tip it early
        syncAbilityRanks(this.ranger);
        recomputeStats(this.ranger);
        this.ranger.hp = this.ranger.maxHp;
        this.place(this.ranger, 24, -14, Math.atan2(2.2, -5.5));
        const sm = this.casters[0];
        if (sm) {
          this.place(sm, 18.5, -11.8, Math.atan2(-2.2, 5.5));
          sm.hp = 40; // one arrow finishes it → weapon-bit drop
        }
        this.preRoll(3);
        // lens BEYOND the loot, so the draw, the roll and the pickup all come
        // toward camera and the level-up beam plays at its biggest. Bearing
        // runs at the slot-5 base, so its banner/fountain/torch back the shot.
        this.setCam(15.6, 2.6, -8.4, 21.4, 1.0, -12.6);
      },
      run: (t) => {
        const sm = this.casters[0];
        if (t < 520 && sm && sm.alive) this.aimAt(this.ranger, sm, 0, 0, true);
        else if (t < 780) {
          setHeroInput(this.ranger, 0, 0, this.ranger.aimX, this.ranger.aimY, false);
        }
        cues.at(t >= 780, "dash", () => {
          const c = this.world.coins[0];
          if (c) this.cast(this.ranger, "DASH", c.x, c.y);
        });
        // pickup fountain ~1.0s → level-up beam right on its heels, with 1.1s
        // of runway left so the column isn't eaten by the dip to black
        cues.at(t >= 1250, "lvl", () => grantXp(this.world, this.ranger, 400));
        // track her live position through the payoff: the roll used to carry
        // her out of a fixed look and the beam played off-frame
        if (t >= 700) {
          const k = ramp(t, 700, 1200);
          this.camLook.set(
            lerp(21.4, this.ranger.x, k),
            lerp(1.0, 1.15, k),
            lerp(-12.6, this.ranger.y, k),
          );
        }
      },
    });
  }

  // ── scene 11: ELITE — trade blows with the Frost Golem, dodge, execute ─────
  private sceneGolemBoss(): TrailerScene {
    const cues = new Cues();
    let dodgedAt = -1;
    /** Where the elite falls — the drop lands on it and she stands on the drop,
     *  so it is the only stable anchor the closing card can be built from (her
     *  own live position keeps moving until the claim). */
    let mark: { x: number; y: number } | null = null;
    return this.scene({
      id: "golem-boss",
      duration: 4400,
      setup: () => {
        cues.reset();
        dodgedAt = -1;
        mark = null;
        this.restage();
        this.focus(this.rogue);
        this.music(3);
        // staged out in the north-east quadrant so the two-story arcade fills
        // the upper half — and clear of slot-0's fountain guard radius
        this.place(this.golem, 28, 22, Math.atan2(4.5, 5.5));
        this.golem.hp = 620; // wounded elite — the execute scales off missing HP
        this.golem.swingCount = 1; // its next swing is the big two-handed SLAM
        this.place(this.rogue, 32, 26, Math.atan2(-4.5, -5.5));
        this.preRoll(6); // the stalk is already on
        // MID, not aerial: the old 44u reveal made the boss 10% of frame height
        this.setCam(17.5, 7.5, 11.5, 28.5, 2.6, 22.5, 55);
      },
      run: (t) => {
        const g = this.golem;
        const r = this.rogue;
        // phase 1: rogue gives ground, golem stalks. Move intent is NORMALIZED
        // to full speed (6.5 vs his 4.4 u/s) and skeleton AI drops any target
        // >14u from camp home — radial flight would break the leash before he
        // ever swings. So she back-strafes diagonally, and only while he's
        // within arm's reach: the pair circles near his staged home, he closes,
        // and at ~1.2s she stands her ground so the SLAM starts ~1.4s and its
        // contact lands ~2.0s, right as the camera dives in.
        if (dodgedAt < 0) {
          const away = norm(r.x - g.x, r.y - g.y);
          const gap = Math.hypot(r.x - g.x, r.y - g.y);
          if (t < 1200 && gap < 5.2) {
            setHeroInput(r, away.x - away.y, away.y + away.x, -away.x, -away.y, false);
          } else {
            this.aimAt(r, g, 0, 0, false);
          }
        }
        // the slam telegraph is the golem's own measured windup: roll through
        // it on i-frames a beat before the contact frame resolves
        const pending = g.pendingAttack;
        const dodgeNow =
          dodgedAt < 0 &&
          ((pending !== null && this.world.now >= pending.resolveAt - 220) || t >= 2600);
        cues.at(dodgeNow, "dodge", () => {
          dodgedAt = t;
          this.cast(r, "DASH", g.x + (g.x - r.x), g.y + (g.y - r.y)); // through him
        });
        // counter: Execute — dash-through X-cut, lethal on the wounded elite
        cues.at(dodgedAt >= 0 && t >= dodgedAt + 450, "execute", () => {
          this.aimAt(r, g, 0, 0, false);
          this.cast(r, "R", g.x, g.y);
        });
        if (mark === null && !g.alive) mark = { x: g.x, y: g.y };
        // The closing card's lens: 5.4u SOUTH-SOUTH-EAST of where the elite
        // fell. The only tall prop in this quadrant is the rune-shrine column
        // at (26.7, 26.7); from this bearing it is 0.63 half-widths off centre
        // (a background edge, and never on the lens→victor segment), and the
        // victor lands at ~44% of frame height. The old settle rode her LIVE
        // position, which put that column 0.46u INSIDE the segment — dead
        // centre of the trailer's boss-kill payoff frame, occluding the only
        // character in it.
        const m = mark ?? g;
        const lensX = m.x + 2.8;
        const lensY = m.y - 4.6;
        // aftermath: walk onto the elite's weapon-bit drop, then HOLD the mark.
        // Without the else-branch the last pre-claim intent stays latched (the
        // sim keeps the previous move vector) and she strolls ~5u out of the
        // shot on stale input — which is what carried her behind the column.
        if (dodgedAt >= 0 && t >= dodgedAt + 1300) {
          const c = this.world.coins[0];
          if (c) {
            const d = norm(c.x - r.x, c.y - r.y);
            setHeroInput(r, d.x * 0.5, d.y * 0.5, d.x, d.y, false);
          } else {
            const toLens = norm(lensX - r.x, lensY - r.y);
            setHeroInput(r, 0, 0, toLens.x, toLens.y, false);
          }
        }
        // camera: quiet mid wide → violent close → settle onto the kill mark,
        // landing the last 600ms locked on the victor standing over the wreck
        const kA = ramp(t, 0, 1400);
        const kB = ramp(t, 1400, 2400);
        const kC = ramp(t, 3000, 3800);
        const px = lerp(lerp(17.5, 19.2, kA), 24, kB);
        const ph = lerp(lerp(7.5, 6.6, kA), 2.6, kB);
        const py = lerp(lerp(11.5, 13.2, kA), 16.5, kB);
        this.camPos.set(lerp(px, lensX, kC), lerp(ph, 2.3, kC), lerp(py, lensY, kC));
        const lx = lerp(28.5, 29.5, kB);
        const lh = lerp(lerp(2.6, 2.3, kA), 1.5, kB);
        const ly = 22.5;
        this.camLook.set(lerp(lx, r.x, kC), lerp(lh, 1.15, kC), lerp(ly, r.y, kC));
        this.camFov = lerp(lerp(55, 50, kB), 46, kC);
      },
    });
  }

  // ── scene 12: CLIMAX (PvE) — V-yx vs the mixed horde, full kit chained ─────
  private sceneFrenzy(): TrailerScene {
    const cues = new Cues();
    /** Exactly the skeletons THIS scene staged. Cue targeting must never run
     *  over the whole troupe: the unused pool is parked at its camps 40u away,
     *  and a nearestAlive() across all of them aimed the finale fireball at a
     *  skeleton standing off-screen at the north camp once the horde was down. */
    const horde: Unit[] = [];
    const BLINK_MS = 2600;
    const JUMP_MS = 3300;
    /** Orbit centre. The blink teleports 9u in one frame; reading the mage's
     *  live position every frame translated the camera with him and read as an
     *  unintended jump cut, so the anchor eases across the teleport instead. */
    const anchor = new THREE.Vector2();
    const preBlink = new THREE.Vector2();
    return this.scene({
      id: "arena-frenzy",
      duration: 4400,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.mage);
        this.music(3);
        // six casts stacking additive cores clipped to white; 0.78 was the
        // furthest the stop could go before the horde went to mud, and the
        // climax was still a white core with numbers on it. Damp the cores and
        // KEEP the stop — this scene's peak is a ~150ms transient, so a single
        // still of it measures anywhere between 0% and 3% clipped on identical
        // builds, and handing exposure back on that evidence is guessing.
        this.expose(0.78);
        this.damp(0.55);
        this.place(this.mage, -4, -18, -Math.PI / 2);
        anchor.set(-4, -18);
        preBlink.set(-4, -18);
        // no Frost Golem in the horde: he dies as the elite one scene earlier,
        // and a second skeleton mage puts the ranged creep attack on screen.
        // TEN bodies, not seven: a max-level V-yx clears seven in 3.3s, which
        // left the last quarter of the trailer's climax with nothing alive in
        // it. The outer three sit past the opening AoEs but inside skeleton
        // aggro (11u), so they arrive as a second rank under their own AI.
        const staging = [
          { u: this.warriors[0], x: -7.5, y: -24.5 },
          { u: this.warriors[1], x: -1.0, y: -25.5 },
          { u: this.warriors[2], x: -4.5, y: -26.5 },
          { u: this.minions[0], x: -9.5, y: -22.5 },
          { u: this.minions[1], x: 1.5, y: -23.0 },
          { u: this.casters[0], x: -10.0, y: -26.0 },
          { u: this.casters[1], x: -1.5, y: -28.6 },
          { u: this.warriors[3], x: -12.5, y: -22.0 },
          { u: this.minions[2], x: 3.5, y: -26.0 },
          { u: this.minions[3], x: -6.5, y: -28.5 },
        ];
        horde.length = 0;
        for (const h of staging) {
          if (!h.u) continue;
          this.place(h.u, h.x, h.y, Math.atan2(-18 - h.y, -4 - h.x));
          horde.push(h.u);
        }
        this.preRoll(12); // the horde is already surging in
        this.setCam(1.5, 3.2, -12.0, -4.5, 1.5, -19.5, 52);
      },
      run: (t) => {
        const m = this.mage;
        // kite-strafe, always facing the nearest threat; a warrior WILL land a
        // hit around ~2s — the honest beat before the aerial escape
        const target = this.nearestAlive(horde, m);
        const sway = Math.sin(t * 0.003) * 0.35;
        if (target) {
          const d = norm(target.x - m.x, target.y - m.y);
          setHeroInput(m, -d.y * sway, d.x * sway, d.x, d.y, false);
        }
        // cues staggered so no two AoEs bloom on the same frame
        cues.at(t >= 100, "e", () => this.cast(m, "E", -4, -23.5));
        cues.at(t >= 800, "q1", () => {
          const at = this.nearestAlive(this.warriors, m);
          this.cast(m, "Q", at ? at.x : -4.5, at ? at.y : -24);
        });
        cues.at(t >= 1800, "w", () => this.cast(m, "W", -3, -22));
        // blink out of the scrum — 8u sideways, NOT away: skeleton AI drops any
        // target more than 14u from its camp home, so a retreat straight back
        // would send the survivors home and end the fight. Lateral keeps them
        // chasing, and they close on him again over the next 700ms.
        cues.at(t >= BLINK_MS, "blink", () => this.cast(m, "DASH", m.x - 8, m.y + 1.5));
        // …then rise out of their reach and detonate the wheel of fire
        cues.at(t >= JUMP_MS, "jump", () => this.cast(m, "JUMP", m.x, m.y - 4));
        // and a last fireball, thrown down from the hover onto whoever is still
        // coming. Positional fallback so an empty field still gets the cast.
        cues.at(t >= 3900, "q2", () => {
          const at = this.nearestAlive(horde, m);
          this.cast(m, "Q", at ? at.x : m.x, at ? at.y : m.y - 6);
        });
        // orbit HIM, not the horde: a fixed 11u orbit around the pack left the
        // featured champion at ~60px and lost him entirely on the blink. The
        // look is offset along the camera's own right vector, so he holds a
        // third of frame instead of sitting locked at centre.
        const az = Math.PI / 3 + (Math.PI / 2) * (t / 4400);
        // Emberburst pins him at hop height for 880ms — the look has to rise
        // with him or the aerial beat crops his hat off the top of the frame
        const air = clamp01((t - JUMP_MS + 50) / 260) * (1 - clamp01((t - JUMP_MS - 820) / 260));
        // 450ms of ease turns the 8u teleport into a whip-pan that keeps him in
        // frame the whole way, instead of a one-frame camera cut. Before the
        // blink preBlink tracks him, so the anchor IS his live position; the
        // frame the cue fires it is already frozen one tick behind the teleport.
        if (t < BLINK_MS) preBlink.set(m.x, m.y);
        const kBlink = ramp(t, BLINK_MS, BLINK_MS + 450);
        anchor.set(lerp(preBlink.x, m.x, kBlink), lerp(preBlink.y, m.y, kBlink));
        // the LENS climbs with the look, not just the look: holding it at 3.0
        // while the aerial beat lifts the target to 3.9 tilted the camera up and
        // spent the top half of the climax's last second on black sky
        this.camPos.set(
          anchor.x + Math.cos(az) * 7.6,
          3.0 + air * 2.1,
          anchor.y + Math.sin(az) * 7.6,
        );
        this.camLook.set(
          anchor.x + Math.cos(az + Math.PI / 2) * 1.2,
          1.9 + air * 2.0,
          anchor.y + Math.sin(az + Math.PI / 2) * 1.2,
        );
        this.camFov = 52;
      },
    });
  }

  // ── scene 13: FOUR-WAY — the FFA the whole game is, on the stairs ──────────
  // Four champions, mutually hostile, contesting the one climb onto the throne
  // plateau: arrows up the ramp, a blink into a Frost Nova, the holder stepping
  // to the lip to bring Oblivion Slam down on the climber a storey below him,
  // and an Execute out of Smoke that ends on a hero corpse dissolving.
  // Objectives, elevation, the defensive slot and the losing side — the four
  // things fourteen PvE shots never say.
  //
  // The elevation is read as HEIGHT, not as a fall. Knockback in this sim is a
  // 260ms decaying impulse (combat.ts applyKnockback → world.ts moveUnit), so
  // the slam's "knockback 8" integrates to 8 × 0.26²/2 ≈ 0.27u of travel — it
  // staggers a body, it cannot throw one off a 2u lip. So the staging puts the
  // difference on screen statically instead: Aurelius on the plateau top at
  // h = 2.0, Sylva held mid-ramp at h ≈ 0.7, and the hammer coming down the step.
  private sceneFourWay(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "four-way",
      duration: 4300,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk); // holder of the high ground until the kill
        this.music(3);
        // Oblivion Slam's contact frame stacks a white core on pale flagstone
        // and takes the champion swinging it with it; 0.86 still clipped
        this.expose(0.8);
        // NE stair: plateau edge r=11, ramp band 11→14.2 on the 45° centreline
        this.place(this.bk, 6.36, 6.36, Math.PI / 4); // top of the run, facing out
        this.place(this.ranger, 12.37, 12.37, (5 * Math.PI) / 4); // foot of the run
        this.place(this.mage, 7.0, 17.0, -Math.PI / 4);
        this.place(this.rogue, 12.6, 16.4, (5 * Math.PI) / 4);
        this.preRoll(4);
        // stood off 9.6u from the stair mouth: at 7u the four of them spanned
        // more than the frame and Aurelius — the one swinging the hammer — was
        // clipped by the right edge for the whole shot
        this.setCam(16.13, 2.6, 2.66, 9.4, 2.0, 9.6, 50);
      },
      run: (t) => {
        const a = this.bk;
        const rv = this.ranger;
        const mg = this.mage;
        const vp = this.rogue;

        // Sylva opens: a Multishot fan up the ramp, then she starts the climb.
        // 700ms of intent walks her onto the stair and stops her at r≈13.1 —
        // h ≈ 0.7, a storey and a third below the lip, still inside the slam's
        // 5.5u radius and inside Execute's reach. Longer and she tops out level
        // with him, which is exactly the height difference the shot is for.
        cues.at(t >= 0, "volley", () => this.cast(rv, "Q", a.x, a.y));
        if (t < 700) this.aimAt(rv, a, -0.707, -0.707, false);
        else if (t < 2500) this.aimAt(rv, a, 0, 0, false);

        // Aurelius answers with the defensive slot — Iron Bastion's armor + mend
        cues.at(t >= 350, "bastion", () => this.cast(a, "E", a.x, a.y));
        // …then walks to the edge of his own plateau to swing down at her. 300ms
        // of outward intent along the stair centreline (45° IS a stair gap, so
        // the cliff lets him through) puts him at r ≈ 10.4, on the lip.
        const stepOut = t >= 1600 && t < 1900;
        if (t < 2400) this.aimAt(a, rv, stepOut ? 0.707 : 0, stepOut ? 0.707 : 0, false);

        // V-yx blinks in off the plaza and rings them both in ice: the nova's
        // spike ring holds for a full second, which is why the crane slows here
        cues.at(t >= 900, "blink", () => this.cast(mg, "DASH", 11.5, 12.5));
        cues.at(t >= 1400, "nova", () => this.cast(mg, "W", rv.x, rv.y));
        if (t >= 1000) this.aimAt(mg, rv, 0, 0, false);

        // Vesper goes to ground — Smoke drops her out of sight for the ambush
        cues.at(t >= 1900, "smoke", () => this.cast(vp, "E", vp.x, vp.y));

        // top up Sylva a beat before the slam: 640 damage would otherwise finish
        // her outright and the execute would have nothing to land on
        cues.at(t >= 2400, "brace", () => {
          rv.hp = rv.maxHp;
        });
        // …and the hammer comes down off the lip: 640 damage, a 1.2s stun and a
        // stagger — enough that she is still standing where she was, held
        cues.at(t >= 2500, "slam", () => this.cast(a, "R", a.x, a.y));

        // Vesper closes down the ramp on the stunned climber and blink-strikes
        // her out of stealth
        if (t >= 2600 && t < 3100) {
          const d = norm(rv.x - vp.x, rv.y - vp.y);
          setHeroInput(vp, d.x, d.y, d.x, d.y, false);
        }
        cues.at(t >= 3050, "focus", () => this.focus(vp)); // kill-confirm is hers
        cues.at(t >= 3100, "execute", () => {
          rv.hp = 60; // wounded: "lethal to the wounded" is the ability's whole text
          setHeroInput(vp, 0, 0, vp.aimX, vp.aimY, false);
          this.aimAt(vp, rv, 0, 0, false);
          this.cast(vp, "R", rv.x, rv.y);
        });
        // the sim only breaks stealth on a BASIC swing (combat.ts), so after an
        // ability kill Vesper stays faded out — and the victor being invisible
        // is the one thing the closing beat cannot afford. Same real call the
        // swing path makes, just on the ability that actually landed.
        cues.at(t >= 3350, "reveal", () => breakStealth(vp));

        // crane: a 42° arc that slows across the nova hold, then settles low on
        // the body. It sweeps OUTWARD (away from the plateau) — swinging the
        // other way put the lens inside the 11u plateau, where the cliff and the
        // throne aura band filled the frame instead of the fight.
        const p = 0.34 * ramp(t, 0, 1400) + 0.14 * ramp(t, 1400, 2400) + 0.52 * ramp(t, 2400, 4300);
        const az = lerp(-0.904, -0.175, p); // -51.8° → -10° around the stair mouth
        const rad = lerp(9.6, 10.4, p);
        const kC = ramp(t, 3200, 4300);
        // the settle holds the VICTOR and the body in one frame — parking on the
        // corpse alone put the stair block between it and the lens
        const sx = (vp.x + rv.x) / 2;
        const sy = (vp.y + rv.y) / 2;
        this.camPos.set(
          lerp(10.2 + Math.cos(az) * rad, sx + 5.4, kC),
          // high enough to look OVER the stair block, which was cutting the
          // victor off at the shoulders on the trailer's last real beat
          lerp(lerp(2.6, 4.4, ramp(t, 600, 2000)) - 1.4 * ramp(t, 2400, 4300), 5.3, kC),
          lerp(10.2 + Math.sin(az) * rad, sy - 6.4, kC),
        );
        this.camLook.set(
          lerp(lerp(9.4, 11.2, p), sx, kC),
          lerp(lerp(2.0, 1.7, p), 1.5, kC),
          lerp(lerp(9.6, 11.4, p), sy, kC),
        );
        this.camFov = 50;
      },
    });
  }

  // ── scene 14: RELEASE — the victor holds the high ground, and is paid ──────
  // Staged on the SOUTH-EAST stair (four-way took the north-east one, and two
  // consecutive shots on the same flight of steps read as one shot): Aurelius
  // holds the plateau lip, the Over Boss pays out at the foot of the run, and
  // he walks the 2u down the ramp into camera to claim it.
  private sceneHeroPose(): TrailerScene {
    const cues = new Cues();
    // On the stair centreline (7π/4): the lip at r ≈ 10.4, the coin at r = 14.8
    // — one radial unit CLEAR of the ramp foot (PLATEAU_R + STAIR_RUN = 14.2).
    // That last unit matters: WorldView flies a coin at a flat 0.5 + arc and
    // then parks it at terrainHeight + 0.6, so a coin that lands on raised
    // ground sinks into the stone on approach and snaps up on the landing frame
    // (2.1u of pop on the plateau top). Landing on the flat plaza, the flight
    // baseline and the ground agree and the arc resolves where it points.
    const LIP = { x: 7.35, y: -7.35 };
    const COIN = { x: 10.47, y: -10.47 };
    const ORBIT = { x: 8.9, y: -8.9 }; // between the two, so neither end drifts
    return this.scene({
      id: "hero-pose",
      // 2400 spent every frame of the shot travelling: the claim resolves at
      // ~1.6s and the old cut then had 800ms of orbit left, so the last image
      // of the trailer was a champion mid-stride with the stair block filling
      // the left half. 3000 buys a 1.2s held card after the payout.
      duration: 3000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(1);
        this.place(this.bk, LIP.x, LIP.y, -Math.PI / 4); // planted on the lip he just took
        // the closing beat is the game's own objective, not dressed props: the
        // Over Boss hurls his coin from the throne, it lands at the foot of his
        // stair, and he comes down and claims it
        this.throwCoin(COIN.x, COIN.y, 300);
        this.setCam(6.83, 4.35, -14.96, LIP.x, 3.25, LIP.y, 45);
      },
      run: (t) => {
        // the coin lands ~900ms; he turns and walks down onto it (claim ~1.5s)
        if (t >= 950) {
          const c = this.world.coins[0];
          if (c) this.aimAt(this.bk, c, c.x - this.bk.x, c.y - this.bk.y, false);
          else setHeroInput(this.bk, 0, 0, this.bk.aimX, this.bk.aimY, false);
        }
        cues.at(t >= 2050, "stop", () => {
          setHeroInput(this.bk, 0, 0, this.bk.aimX, this.bk.aimY, false);
        });
        // Two moves in one lens. The ARC (0→1900) carries the descent past his
        // shoulder — torchlight, throne, hall — and lands square on the stair
        // centreline at -π/4, which is exactly his walking heading, so the
        // orbit finishes with him coming INTO the lens. The SETTLE (1500→2450)
        // then re-centres him and closes to 4.3u: the lateral look offset that
        // made the arc feel like a move (and shoved him 52% right of centre,
        // with the stair run filling the vacated left half) rolls out to zero,
        // and the orbit anchor slides from the mid-point mark onto him.
        // Both heights ride the ground he is on: he drops 2u down the ramp, and
        // a fixed lens would tilt down onto the top of his helmet.
        const k = ramp(t, 0, 1900);
        const kS = ramp(t, 1500, 2450);
        const az = lerp(-1.9, -Math.PI / 4, k);
        const gh = groundHeight(this.bk.x, this.bk.y);
        const rad = lerp(6.4, 4.3, kS);
        const lat = lerp(1.8, 0, kS);
        this.camPos.set(
          lerp(ORBIT.x, this.bk.x, kS) + Math.cos(az) * rad,
          gh + lerp(2.35, 1.95, kS),
          lerp(ORBIT.y, this.bk.y, kS) + Math.sin(az) * rad,
        );
        this.camLook.set(
          this.bk.x + Math.cos(az + Math.PI / 2) * lat,
          gh + lerp(1.25, 1.0, kS),
          this.bk.y + Math.sin(az + Math.PI / 2) * lat,
        );
        this.camFov = 45;
      },
      teardown: () => {
        this.holding = true; // freeze the world under the closing black / loop gap
      },
    });
  }
}

/** Boot trailer mode: assets are already loaded by main(); this owns the
 *  render loop and hands scene control to the shell. */
export function runBattleArenaTrailer(view: View, lib: ModelLibrary): void {
  const director = new Director(view, lib);
  // DEV-only handle for headless checks — the sim state behind the shot, so a
  // frame can be scored against what the world actually held when it drew.
  if (import.meta.env.DEV) Object.assign(window, { __baTrailer: director });
  director.start();
}
