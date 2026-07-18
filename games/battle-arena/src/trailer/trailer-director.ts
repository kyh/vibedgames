// TRAILER MODE director — stages every scene of the Battle Arena gameplay
// trailer through the REAL sim + render stack (createWorld/step/castAbility →
// WorldView/Fx/Environment). Nothing is mocked: every hit is a PendingStrike
// resolving on its measured contact frame, every explosion is the game's own
// FX pipeline, every kill pays real bounty/loot.
//
// Staging model:
//   - One persistent World, seeded, with coins/deliveries/camp-respawns/match
//     end suppressed. A fixed troupe (all six champions at max level + a pool
//     of skeletons + the Frost Golem) is spawned ONCE at boot so per-scene
//     restaging is a teleport, never a spawn — no Spawn_Air / Awaken clips
//     leak into shots.
//   - Every scene's setup() fully re-stages: park everyone, clear transient
//     world state, place the actors, pre-roll a few sim ticks so the first
//     visible frame is mid-motion. The sim HOLDS between a scene's setup and
//     its first run() frame (mirrors GameScene's intro hold), so title cards
//     and dip-to-black cuts never eat choreography time.
//   - Unused champions park at their spawn bases and skeletons at their camps:
//     they double as living set dressing in wide shots.
//   - The camera is View.cinematic() — an explicit pose per frame that keeps
//     every juice channel (trauma shake, kick, FOV punch, flash) alive.
//
// Dead outside ?trailer=1: main.ts lazy-imports this module in its own chunk.
import * as THREE from "three";
import { CHAMP_BY_ID } from "../data/champions";
import { SIM_DT, XP_CURVE } from "../data/config";
import { CAMPS, SPAWNS } from "../data/map";
import { castAbility } from "../sim/abilities";
import { grantXp } from "../sim/economy";
import { clamp, lerp, norm } from "../sim/math";
import { recomputeStats } from "../sim/stats";
import { ALL_ABILITY_KEYS, nextId, type AbilityKey, type Unit, type World } from "../sim/types";
import {
  createWorld,
  setHeroInput,
  spawnCreep,
  spawnHero,
  step,
  syncAbilityRanks,
} from "../sim/world";
import { Environment } from "../render/environment";
import { Fx } from "../render/fx";
import { ModelLibrary } from "../render/models";
import { View } from "../render/view";
import { WorldView } from "../render/world-view";
import { runTrailer, type TrailerScene } from "./trailer-shell";

const SEED = 0xba771e; // deterministic sim; only camera shake stays random
const FAR_RESPAWN = 1e15; // pins dead troupe creeps so cleanup never deletes them
const CAMP_NEVER = 1e8; // finite ≠ POPULATED sentinel → camps never repopulate

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
  card?: { title: string; sub?: string };
  caption?: string;
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
  private acc = 0;
  private focusId = ""; // featured champion — env proximity + Fx juice follow them
  private readonly camPos = new THREE.Vector3(0, 26, 34);
  private readonly camLook = new THREE.Vector3(0, 2, 0);
  private camFov = 52;

  constructor(
    private readonly view: View,
    lib: ModelLibrary,
  ) {
    const w = createWorld(SEED);
    this.world = w;
    // suppress everything on a timer that could wander into a staged shot
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
    // a trailer wants sound; the shell's click gate is the unlock gesture.
    // Ephemeral: setMuted would persist localStorage["ba-muted"]="0" and
    // permanently unmute normal gameplay on this machine.
    this.fx.audio.setMutedEphemeral(false);

    // champions — max level (R unlocked, real stat growth); level-up beams fire
    // once here, safely masked behind the shell's start gate
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
    // revive broken destructible props (mirrors the sim's own prop-respawn
    // block): their natural respawn is 50s of SIM time away, but scenes only
    // accumulate ~37s between visits — without this, every replay/loop/jump
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

  /** Dead troupe creeps must linger as (fully dissolved) corpses instead of
   *  being culled — a later scene revives them via place(). Runs post-step. */
  private pinDeadTroupe(): void {
    for (const c of this.creeps) {
      if (!c.alive && c.respawnAt < FAR_RESPAWN) c.respawnAt = FAR_RESPAWN;
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

  private music(level: 0 | 1 | 2 | 3): void {
    this.fx.audio.music?.setIntensity(level);
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

  /** Wrap a scene spec: hold the sim through the card/cut, release on run. */
  private scene(spec: SceneSpec): TrailerScene {
    const out: TrailerScene = {
      id: spec.id,
      duration: spec.duration,
      setup: () => {
        this.holding = true;
        spec.setup();
      },
      run: (t) => {
        this.holding = false;
        spec.run?.(t);
      },
    };
    if (spec.card) out.card = spec.card;
    if (spec.caption !== undefined) out.caption = spec.caption;
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
        this.acc = 0; // frozen mid-card: no real-time gap unwinds on release
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
      this.view.cinematic(this.camPos, this.camLook, rdt, this.camFov);
      this.view.render();
    });

    runTrailer({
      title: "BATTLE ARENA",
      url: "battle-arena.vibedgames.com",
      tagline: "Online PvP action-RPG",
      accent: "#ffd24a",
      fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace",
      scenes: [
        this.sceneColdOpen(),
        this.sceneSignature(),
        this.sceneRosterRogue(),
        this.sceneRosterKnight(),
        this.sceneRosterRanger(),
        this.sceneRosterBlackKnight(),
        this.sceneRosterWitch(),
        this.sceneRosterMage(),
        this.sceneCombo(),
        this.sceneDestruction(),
        this.sceneLootPop(),
        this.sceneGolemBoss(),
        this.sceneFrenzy(),
        this.scenePvp(),
        this.sceneHeroPose(),
      ],
    });
  }

  // ── scene 1: COLD OPEN — Garran vs three skeletons, mid-fight ──────────────
  private sceneColdOpen(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "cold-open-clash",
      duration: 4000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.music(1);
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
          // dies exactly on the 3rd-swing SPIN: chop+slice+spin (85+85+214)
          // clears 300 + ~17 regen even at the -12% damage-variance floor
          w3.hp = 300;
        }
        // pre-roll: skeletons lunging at the braced knight — motion from frame
        // one. The knight gets ZERO move intent: the sim normalizes intent to
        // full speed (magnitude is ignored), so any drift here would sprint
        // him clean through his own Q kill site.
        this.aimAt(this.knight, { x: 16.5, y: -5.5 });
        this.preRoll(8);
        this.setCam(26.5, 1.45, -10.5, 16.9, 1.15, -5.0);
      },
      run: (t) => {
        // heavy cleave lands on its measured contact frame (~250ms ≈ frame 15):
        // double kill, bones scatter, triple hit-stop
        cues.at(t >= 0, "q", () => this.cast(this.knight, "Q", 16.5, -5.5));
        const w3 = this.warriors[2];
        if (t >= 550 && w3 && w3.alive) {
          // pivot onto the flanker: chop → slice → SPIN finisher (contact
          // ~2.6s). Aim-only — w3's own AI has already chased into melee
          // (it stops at ~1.76u), so the knight stays planted and every
          // swing connects instead of whiffing mid-sprint.
          this.aimAt(this.knight, w3, 0, 0, true);
        } else if (t >= 550) {
          // kill confirmed — walk onto the dropped weapon-bit (loot button)
          const loot = this.world.coins.find(
            (c) => (c.x - this.knight.x) ** 2 + (c.y - this.knight.y) ** 2 < 64,
          );
          if (loot) {
            const d = norm(loot.x - this.knight.x, loot.y - this.knight.y);
            setHeroInput(this.knight, d.x * 0.55, d.y * 0.55, d.x, d.y, false);
          } else {
            setHeroInput(this.knight, 0, 0, this.knight.aimX, this.knight.aimY, false);
          }
        }
        // low dramatic dolly; the look pans to the flanker duel after the
        // double-kill (w3 fights at ~1.76u SE of the planted knight, so the
        // pan targets that spot — not w3's staged home)
        const kp = ramp(t, 0, 4000);
        const kl = ramp(t, 500, 1400);
        this.camPos.set(lerp(26.5, 25.2, kp), lerp(1.45, 1.8, kp), lerp(-10.5, -8.6, kp));
        this.camLook.set(lerp(16.9, 20.6, kl), lerp(1.15, 1.05, kl), lerp(-5.0, -7.6, kl));
        this.camFov = 52;
      },
    });
  }

  // ── scene 2: SIGNATURE — Aurelius' Oblivion Slam, fully readable ───────────
  private sceneSignature(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "signature-clean",
      duration: 3000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(1);
        this.place(this.bk, -16, -14, Math.atan2(2.2, 2.8));
        const w = this.warriors[0];
        if (w) this.place(w, -13.2, -11.8, Math.atan2(-2.2, -2.8)); // dies to the slam
        this.preRoll(6); // skeleton already closing in
        this.setCam(-10.6, 1.15, -10.2, -15.6, 1.5, -13.6);
      },
      run: (t) => {
        // windup (wings + rising gold) → contact ~830ms → shockwave + kill
        cues.at(t >= 350, "r", () => this.cast(this.bk, "R", this.bk.x, this.bk.y));
        const k = ramp(t, 0, 3000);
        this.camPos.set(lerp(-10.6, -11.9, k), lerp(1.15, 1.05, k), lerp(-10.2, -11.2, k));
        this.camLook.set(-15.6, 1.5, -13.6);
        this.camFov = 52;
      },
    });
  }

  // ── scenes 3-8: ROSTER CUTDOWN — one signature per champion, escalating ────
  private sceneRosterRogue(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-1",
      duration: 1200,
      card: { title: "SIX CHAMPIONS" },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.rogue);
        this.music(2);
        this.place(this.rogue, 26, 8, Math.atan2(1.4, -3.4));
        const m = this.minions[0];
        if (m) {
          this.place(m, 22.6, 9.4, Math.atan2(-1.4, 3.4));
          m.hp = 150; // poison lunge executes it
        }
        this.preRoll(4);
        this.setCam(29.8, 1.5, 7.8, 22.6, 1.0, 9.4);
      },
      run: (t) => {
        // lunge INTO depth — dash away from camera, cut lands mid-frame
        cues.at(t >= 60, "q", () => this.cast(this.rogue, "Q", 22.6, 9.4));
        const k = ramp(t, 200, 700);
        this.camLook.set(lerp(22.6, 21.4, k), lerp(1.0, 0.9, k), lerp(9.4, 9.9, k));
      },
    });
  }

  private sceneRosterKnight(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-2",
      duration: 1200,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.place(this.knight, -8, 25, 0);
        const [w1, w2] = this.warriors;
        if (w1) this.place(w1, -4.6, 25.8, Math.PI);
        if (w2) this.place(w2, -5.0, 24.1, Math.PI);
        this.preRoll(5);
        this.setCam(-6.4, 1.9, 31.2, -6.4, 1.2, 24.8);
      },
      run: (t) => {
        // side-tracked cleave: both skeletons stunned mid-lunge
        cues.at(t >= 80, "q", () => this.cast(this.knight, "Q", -4.8, 25.0));
        const k = ramp(t, 0, 1200);
        this.camPos.set(lerp(-6.4, -4.8, k), 1.9, 31.2);
        this.camLook.set(lerp(-6.4, -5.2, k), 1.2, 24.8);
      },
    });
  }

  private sceneRosterRanger(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-3",
      duration: 1200,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.ranger);
        this.place(this.ranger, 0, -26, Math.PI / 2);
        const ring = [
          { x: 3.2, y: -24.8 },
          { x: -0.6, y: -22.6 },
          { x: -3.2, y: -27.2 },
          { x: 1.2, y: -29.2 },
        ];
        this.minions.forEach((m, i) => {
          const p = ring[i];
          if (!p) return;
          this.place(m, p.x, p.y, Math.atan2(-26 - p.y, -p.x));
          m.hp = 100; // the ring volley clears all four
        });
        this.preRoll(6); // the ring is closing in
        this.setCam(0, 9.5, -34.5, 0, 0.7, -25.4, 54);
      },
      run: (t) => {
        // surrounded → Tempest Volley: spring up, 360° arrow ring, quad kill
        cues.at(t >= 60, "jump", () => this.cast(this.ranger, "JUMP", 0, -20));
        const k = ramp(t, 0, 1200);
        this.camPos.set(0, lerp(9.5, 10.3, k), -34.5);
      },
    });
  }

  private sceneRosterBlackKnight(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "roster-4",
      duration: 1200,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.place(this.bk, -26, -10, 0);
        const [w1, w2] = this.warriors;
        const m = this.minions[0];
        if (w1) this.place(w1, -21.6, -9.2, Math.PI);
        if (w2) this.place(w2, -22.3, -11.0, Math.PI);
        if (m) this.place(m, -20.9, -10.4, Math.PI); // the smite executes it
        this.preRoll(5);
        this.setCam(-31.2, 0.85, -13.8, -22.3, 2.7, -10.0, 56);
      },
      run: (t) => {
        // heaven answers: pillar of light + stun on the pack
        cues.at(t >= 60, "w", () => this.cast(this.bk, "W", -21.6, -10.2));
        const k = ramp(t, 0, 1200);
        this.camPos.set(lerp(-31.2, -30.4, k), lerp(0.85, 0.95, k), lerp(-13.8, -13.2, k));
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
        this.place(this.witch, 14, -22, Math.atan2(1.4, 3.0));
        const pack = [
          { u: this.warriors[0], x: 16.9, y: -19.4 },
          { u: this.minions[0], x: 18.4, y: -20.9 },
          { u: this.minions[1], x: 17.0, y: -22.6 },
        ];
        for (const p of pack) {
          if (p.u) this.place(p.u, p.x, p.y, Math.atan2(-22 - p.y, 14 - p.x));
        }
        this.preRoll(5);
        this.setCam(10.2, 3.5, -27.0, 16.6, 1.0, -20.6);
      },
      run: (t) => {
        // Grand Hex: the seal snaps shut — the whole pack becomes mushrooms
        cues.at(t >= 60, "r", () => this.cast(this.witch, "R", 17.0, -20.8));
        const k = ramp(t, 550, 1050); // drop to mushroom eye-level as they pop
        this.camPos.set(lerp(10.2, 11.4, k), lerp(3.5, 1.55, k), lerp(-27.0, -25.4, k));
      },
    });
  }

  private sceneRosterMage(): TrailerScene {
    return this.scene({
      id: "roster-6",
      duration: 1200,
      setup: () => {
        this.restage();
        this.focus(this.mage);
        this.place(this.mage, 0, 22, -Math.PI / 2);
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
        // already diving (the full 1.2s telegraph doesn't fit a 1.2s cut)
        this.cast(this.mage, "R", 0, 9);
        this.preRoll(14);
        this.setCam(5.0, 1.5, 27.6, 0.2, 7.0, 9.0, 58);
      },
      run: (t) => {
        // impact ~730ms: obliteration on the dais steps → hard cut to the card
        const k = ramp(t, 0, 1200);
        this.camPos.set(lerp(5.0, 4.0, k), lerp(1.5, 1.7, k), lerp(27.6, 26.2, k));
      },
    });
  }

  // ── scene 9: COMBO — contact-frame showcase on the Frost Golem ─────────────
  private sceneCombo(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "combo-string",
      duration: 4500,
      card: { title: "EVERY HIT LANDS", sub: "CONTACT-FRAME COMBAT" },
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.bk);
        this.music(2);
        this.place(this.bk, 6, 22, Math.atan2(3.6, 0.4));
        this.place(this.golem, 6.4, 25.6, Math.atan2(-3.6, -0.4));
        // golem's counter-swing waits one full interval — it answers BETWEEN
        // Aurelius' 2nd and 3rd contacts instead of stealing the opening beat
        this.golem.lastAttackAt = this.world.now;
        // aim + attack only, ZERO move: the staged 3.62u gap is already inside
        // melee reach (2.6 range + 1.4 overreach + 1.25 golem radius = 5.25),
        // and any move intent is full-speed (the sim normalizes it) — Aurelius
        // would bulldoze the golem and separation() would slide the duel out
        // of this scene's fixed camera frame
        this.aimAt(this.bk, this.golem, 0, 0, true);
        this.preRoll(2);
        this.setCam(12.6, 2.6, 28.4, 6.2, 1.6, 23.9);
      },
      run: (t) => {
        // three rotation basics (chop/slice/slice-horizontal, contacts ~0.54s,
        // ~1.41s, ~2.29s) + Q finisher (~3.36s): four readable contact frames
        if (t < 2200) this.aimAt(this.bk, this.golem, 0, 0, true);
        else this.aimAt(this.bk, this.golem, 0, 0, false);
        cues.at(t >= 2950, "q", () => this.cast(this.bk, "Q", this.golem.x, this.golem.y));
        const k = ramp(t, 0, 4500); // the slow push-in — nothing else moves
        this.camPos.set(lerp(12.6, 9.2, k), lerp(2.6, 1.75, k), lerp(28.4, 25.2, k));
        this.camLook.set(6.2, 1.6, 23.9);
        this.camFov = lerp(52, 49, k);
      },
    });
  }

  // ── scene 10: DESTRUCTION — whirlwind through the Cellar stash ─────────────
  private sceneDestruction(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "destruction",
      duration: 3000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.knight);
        this.place(this.knight, -29.5, 0.8, Math.PI);
        setHeroInput(this.knight, -1, 0.1, -1, 0.1, false); // already at full sprint
        this.preRoll(4);
        this.setCam(-24.1, 2.05, 7.4, -31.1, 0.95, 0.6);
      },
      run: (t) => {
        cues.at(t >= 120, "r", () => this.cast(this.knight, "R", this.knight.x - 1, this.knight.y));
        // carve a curve through the keg hoard — crates, barrels, chain-pops
        if (t < 1300) setHeroInput(this.knight, -1, 0.12, -1, 0.12, false);
        else if (t < 2600) setHeroInput(this.knight, -1, -0.25, -1, -0.25, false);
        else setHeroInput(this.knight, 0, 0, this.knight.aimX, this.knight.aimY, false);
        // trucking camera rides alongside the cyclone
        const k = this.knight;
        this.camPos.set(k.x + 5.4, 2.05, k.y + 6.6);
        this.camLook.set(k.x - 1.6, 0.95, k.y - 0.2);
        this.camFov = 52;
      },
    });
  }

  // ── scene 11: LOOT POP — kill, weapon-bit drop, dash-scoop, level-up ───────
  private sceneLootPop(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "loot-pop",
      duration: 2000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.ranger);
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
        this.setCam(26.6, 1.25, -17.8, 19.0, 0.9, -12.0);
      },
      run: (t) => {
        const sm = this.casters[0];
        if (t < 350 && sm && sm.alive) this.aimAt(this.ranger, sm, 0, 0, true);
        else if (t < 800) {
          setHeroInput(this.ranger, 0, 0, this.ranger.aimX, this.ranger.aimY, false);
        }
        cues.at(t >= 800, "dash", () => {
          const c = this.world.coins[0];
          if (c) this.cast(this.ranger, "DASH", c.x, c.y);
        });
        // pickup fountain ~1.0s → level-up beam right on its heels
        cues.at(t >= 1150, "lvl", () => grantXp(this.world, this.ranger, 400));
        const k = ramp(t, 700, 1200);
        this.camLook.set(lerp(19.0, 19.3, k), lerp(0.9, 0.65, k), lerp(-12.0, -12.2, k));
      },
    });
  }

  // ── scene 12: BOSS — wide hall reveal → slam → dodge-through → execute ─────
  private sceneGolemBoss(): TrailerScene {
    const cues = new Cues();
    let dodgedAt = -1;
    return this.scene({
      id: "golem-boss",
      duration: 6000,
      card: { title: "THE HALL AWAITS" },
      setup: () => {
        cues.reset();
        dodgedAt = -1;
        this.restage();
        this.focus(this.rogue);
        this.music(3);
        this.place(this.golem, 16, 8, Math.atan2(4.5, 5.5));
        this.golem.hp = 620; // wounded elite — the execute scales off missing HP
        this.golem.swingCount = 1; // its next swing is the big two-handed SLAM
        this.place(this.rogue, 21.5, 12.5, Math.atan2(-4.5, -5.5));
        this.preRoll(6); // the stalk is already on
        this.setCam(34, 24, 34, 6, 2, 4, 50);
      },
      run: (t) => {
        const g = this.golem;
        const r = this.rogue;
        // phase 1 (wide): rogue gives ground, golem stalks. Move intent is
        // NORMALIZED to full speed (6.5 vs his 4.4 u/s) and skeleton AI drops
        // any target >14u from camp home — radial flight would break the leash
        // before he ever swings. So she back-strafes diagonally, and only while
        // he's within arm's reach: the pair circles near his staged home (kept
        // in the phase-2 dive frame), he closes, and at ~1.4s she stands her
        // ground so the SLAM starts ~1.6s and its contact lands ~2.2s — right
        // as the camera dives in, with the dodge cue reading his REAL windup.
        if (dodgedAt < 0) {
          const away = norm(r.x - g.x, r.y - g.y);
          const gap = Math.hypot(r.x - g.x, r.y - g.y);
          if (t < 1400 && gap < 5.2) {
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
          ((pending !== null && this.world.now >= pending.resolveAt - 220) || t >= 3400);
        cues.at(dodgeNow, "dodge", () => {
          dodgedAt = t;
          this.cast(r, "DASH", g.x + (g.x - r.x), g.y + (g.y - r.y)); // through him
        });
        // counter: Execute — dash-through X-cut, lethal on the wounded elite
        cues.at(dodgedAt >= 0 && t >= dodgedAt + 450, "execute", () => {
          this.aimAt(r, g, 0, 0, false);
          this.cast(r, "R", g.x, g.y);
        });
        // aftermath: walk onto the elite's weapon-bit drop
        if (dodgedAt >= 0 && t >= dodgedAt + 1300) {
          const c = this.world.coins[0];
          if (c) {
            const d = norm(c.x - r.x, c.y - r.y);
            setHeroInput(r, d.x * 0.5, d.y * 0.5, d.x, d.y, false);
          }
        }
        // camera: quiet high wide (sells the two-story hall) → violent close
        const kA = ramp(t, 0, 1900); // slow drift while wide
        const kB = ramp(t, 1900, 3000); // dive down into the duel
        const kC = ramp(t, 4400, 6000); // settle back on the kill
        const px = lerp(lerp(34, 31.5, kA), 26, kB);
        const ph = lerp(lerp(24, 22, kA), 2.3, kB);
        const py = lerp(lerp(34, 31.5, kA), 17.6, kB);
        this.camPos.set(lerp(px, 27, kC), lerp(ph, 2.7, kC), lerp(py, 18.8, kC));
        const lx = lerp(lerp(6, 9, kA), 17.5, kB);
        const lh = lerp(lerp(2, 1.8, kA), 1.5, kB);
        const ly = lerp(lerp(4, 6, kA), 9.3, kB);
        this.camLook.set(lerp(lx, 16, kC), lerp(lh, 1.2, kC), lerp(ly, 8, kC));
        this.camFov = 50;
      },
    });
  }

  // ── scene 13: CLIMAX — V-yx vs the mixed horde, full kit chained ───────────
  private sceneFrenzy(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "arena-frenzy",
      duration: 5000,
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.mage);
        this.music(3);
        this.place(this.mage, -4, -18, -Math.PI / 2);
        const horde = [
          { u: this.warriors[0], x: -7.5, y: -24.5 },
          { u: this.warriors[1], x: -1.0, y: -25.5 },
          { u: this.warriors[2], x: -4.5, y: -26.5 },
          { u: this.minions[0], x: -9.5, y: -22.5 },
          { u: this.minions[1], x: 1.5, y: -23.0 },
          { u: this.casters[0], x: -10.0, y: -26.0 },
          { u: this.golem, x: -4.0, y: -28.6 },
        ];
        for (const h of horde) {
          if (h.u) this.place(h.u, h.x, h.y, Math.atan2(-18 - h.y, -4 - h.x));
        }
        this.preRoll(12); // the horde is already surging in
        this.setCam(1.5, 3.4, -11.5, -4.5, 1.4, -21.3, 56);
      },
      run: (t) => {
        const m = this.mage;
        // kite-strafe, always facing the nearest threat; a warrior WILL land a
        // hit around ~2s — the honest beat before the aerial escape
        const target = this.nearestAlive([...this.warriors, ...this.minions, this.golem], m);
        const sway = Math.sin(t * 0.003) * 0.35;
        if (target) {
          const d = norm(target.x - m.x, target.y - m.y);
          setHeroInput(m, -d.y * sway, d.x * sway, d.x, d.y, false);
        }
        cues.at(t >= 100, "e", () => this.cast(m, "E", -4, -23.5));
        cues.at(t >= 800, "q1", () => {
          const at = this.nearestAlive(this.warriors, m);
          this.cast(m, "Q", at ? at.x : -4.5, at ? at.y : -24);
        });
        cues.at(t >= 1500, "w", () => this.cast(m, "W", -3, -22));
        cues.at(t >= 2400, "jump", () => this.cast(m, "JUMP", m.x, m.y - 4)); // ember ring
        // blink stays lateral so the finale plays inside the orbiting frame
        cues.at(t >= 3400, "blink", () => this.cast(m, "DASH", m.x - 5, m.y + 7.5));
        cues.at(t >= 3800, "q2", () => this.cast(m, "Q", this.golem.x, this.golem.y));
        // constant orbital sweep — the energy never sits still; the look eases
        // toward the blink-out so the eye rides the last fireball back in
        const az = Math.PI / 3 + (Math.PI / 2) * (t / 5000);
        this.camPos.set(-4.5 + Math.cos(az) * 11, 3.4, -21 + Math.sin(az) * 11);
        const kl = ramp(t, 3300, 4100);
        this.camLook.set(lerp(-4.5, -7, kl), lerp(1.4, 1.5, kl), lerp(-21.3, -16.5, kl));
        this.camFov = 56;
      },
    });
  }

  // ── scene 14: ONLINE PVP — Grimelda vs Sylva, dodge → hex → punish ─────────
  private scenePvp(): TrailerScene {
    const cues = new Cues();
    return this.scene({
      id: "pvp-clash",
      duration: 3000,
      caption: "ONLINE PVP",
      setup: () => {
        cues.reset();
        this.restage();
        this.focus(this.witch);
        this.music(3);
        this.place(this.witch, -29, -2.5, Math.atan2(5, 7.5));
        this.place(this.ranger, -21.5, 2.5, Math.atan2(-5, -7.5));
        this.preRoll(6);
        this.setCam(-20.3, 2.0, -7.5, -25.2, 1.15, 0.2, 50);
      },
      run: (t) => {
        const wv = this.witch;
        const rv = this.ranger;
        // both circle — a live duel, not a lineup
        const dw = norm(rv.x - wv.x, rv.y - wv.y);
        if (t < 780) setHeroInput(wv, -dw.y * 0.35, dw.x * 0.35, dw.x, dw.y, false);
        const dr = norm(wv.x - rv.x, wv.y - rv.y);
        setHeroInput(rv, dr.y * 0.3, -dr.x * 0.3, dr.x, dr.y, false);
        // trade: Sylva's Multishot fan…
        cues.at(t >= 250, "volley", () => this.cast(rv, "Q", wv.x, wv.y));
        // …Grimelda broom-surges through it on i-frames…
        cues.at(t >= 780, "dodge", () =>
          this.cast(wv, "DASH", wv.x + dw.x * 6 + dw.y * 6, wv.y + dw.y * 6 - dw.x * 6),
        );
        if (t >= 900 && t < 1250) {
          const d2 = norm(rv.x - wv.x, rv.y - wv.y);
          setHeroInput(wv, d2.x * 0.6, d2.y * 0.6, d2.x, d2.y, false);
        }
        // …and punishes: Grand Hex (mushroom!) into a hex bolt on the helpless hop
        cues.at(t >= 1250, "hex", () => this.cast(wv, "R", rv.x, rv.y));
        cues.at(t >= 1800, "bolt", () => this.cast(wv, "Q", rv.x, rv.y));
        if (t >= 1250) this.aimAt(wv, rv, 0, 0, false);
        const k = ramp(t, 0, 3000);
        this.camPos.set(lerp(-20.3, -21.0, k), lerp(2.0, 1.95, k), lerp(-7.5, -6.4, k));
        this.camLook.set(-25.2, 1.15, 0.2);
        this.camFov = 50;
      },
    });
  }

  // ── scene 15: RELEASE — the victor amid loot, hall towering behind ─────────
  private sceneHeroPose(): TrailerScene {
    return this.scene({
      id: "hero-pose",
      duration: 2500,
      setup: () => {
        this.restage();
        this.focus(this.knight);
        this.music(1);
        this.place(this.knight, 7, 3, 0.35); // planted 2H idle on the plateau edge
        // the spoils: weapon-bit pickups glinting around his feet
        for (let i = 0; i < 6; i++) {
          const a = 0.6 + i * 1.07;
          const r = 1.9 + (i % 3) * 0.7;
          this.world.coins.push({
            id: nextId(this.world, "loot"),
            x: 7 + Math.cos(a) * r,
            y: 3 + Math.sin(a) * r,
            fromX: 7,
            fromY: 3,
            gold: 20,
            landAt: this.world.now,
            expireAt: this.world.now + 600000,
            loot: true,
          });
        }
        this.setCam(13.8, 2.7, -0.5, 7, 3.35, 3, 47);
      },
      run: (t) => {
        // slow low orbit rising past his shoulder — torchlight, throne, hall
        const k = t / 2500;
        const az = lerp(-0.55, 0.6, k);
        this.camPos.set(
          7 + Math.cos(az) * 6.8,
          lerp(2.7, 4.1, easeInOut(k)),
          3 + Math.sin(az) * 6.8,
        );
        this.camLook.set(7, 3.35, 3);
        this.camFov = 47;
      },
      teardown: () => {
        this.holding = true; // freeze the world under the end card
      },
    });
  }
}

/** Boot trailer mode: assets are already loaded by main(); this owns the
 *  render loop and hands scene control to the shell. */
export function runBattleArenaTrailer(view: View, lib: ModelLibrary): void {
  new Director(view, lib).start();
}
