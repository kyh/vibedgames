import type Phaser from "phaser";
import type { Scene } from "phaser";

import { BASE_H, BASE_W, STEP } from "../config";
import type { EnemyName, HeroName } from "../data/animations";
import { AFFIXES } from "../data/affixes";
import { ENEMIES } from "../data/enemies";
import { HEROES } from "../data/heroes";
import { baseMods } from "../data/relics";
import type { RunMods } from "../data/relics";
import type { RoomType } from "../data/rooms";
import type { Boss } from "../entities/boss";
import { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import type { NetVersus } from "../net/snapshot";
import { FG_TREE_NAME } from "../parallax";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";
import { reseed } from "../sys/rng";
import { VersusMatch } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { Combat } from "./combat";
import type { LastStand } from "./last-stand";
import { applyAffix } from "./room-builder";
import type { RoomBuilder } from "./room-builder";
import type { SceneChrome, SceneHooks } from "./scene-hooks";

// Staging surface for src/trailer/trailer-director.ts (?trailer=1 only). All
// methods drive the exact same code paths gameplay uses — real rooms, real
// enemies, real combat resolution — they only skip the menu/network plumbing.
// Nothing in normal play calls any of this: `active` and `input` stay unset,
// so the scene's trailer checks are dead code outside the director.
export class TrailerStaging {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly combat: Combat;
  private readonly lastStand: LastStand;
  private readonly rooms: RoomBuilder;
  private readonly chrome: SceneChrome;
  private readonly hooks: SceneHooks;
  active = false;
  input: (() => TrailerInputs) | null = null;
  // Authored (unzoomed) position of every screen-pinned object, so zoom can
  // re-derive the counter-transform from scratch on each shot.
  private readonly pinBase = new WeakMap<Phaser.GameObjects.GameObject, { x: number; y: number }>();
  // Scale every pinned object currently sits at (1/zoom). Anything that animates
  // a pinned object's scale has to multiply through this, or the tween's
  // absolute target silently undoes the counter-transform. 1 in normal play.
  pinScale = 1;

  constructor(
    scene: Scene,
    run: RunState,
    expedition: RunManager,
    room: RoomState,
    seat: SeatState,
    banners: BannerHud,
    combat: Combat,
    lastStand: LastStand,
    rooms: RoomBuilder,
    chrome: SceneChrome,
    hooks: SceneHooks,
  ) {
    this.scene = scene;
    this.run = run;
    this.expedition = expedition;
    this.room = room;
    this.seat = seat;
    this.banners = banners;
    this.combat = combat;
    this.lastStand = lastStand;
    this.rooms = rooms;
    this.chrome = chrome;
    this.hooks = hooks;
  }

  /** Fully restage the world as one trailer shot: fresh solo/duo actors, a
   * seeded room, scene-scoped mods/hearts/gold, HUD policy, and the sim frozen
   * until the shell reveals the scene (freeze(0) on first run frame). */
  stage(o: TrailerStageOpts): void {
    this.active = true;
    this.run.runRecap = null;
    this.banners.clear();
    if (o.seed !== undefined) {
      reseed(o.seed);
    }
    this.reset(o);
    if (o.room === "versus") {
      this.stageVersus(o);
    } else {
      this.stageRoom(o, o.room);
    }
    if (o.fgTrees === false) {
      this.dropForegroundTrees();
    }
    if (o.playerAt) {
      this.seat.player.enterRoom(this.room.grid, o.playerAt.x, o.playerAt.y);
    }
    if (o.player2At) {
      this.seat.remote?.enterRoom(this.room.grid, o.player2At.x, o.player2At.y);
    }
    this.hud(o.hud ?? {});
    // Kill the room-build announcement; scenes trigger their own banners.
    this.banners.clear();
    this.chrome.fadeRect.setAlpha(0);
    this.hooks.updateHud();
    // Hold the sim until the shell reveals the shot (the cut plate is still black).
    this.run.freeze = 9999;
  }

  // Cross-scene reset: every shot stages from nothing, independent of what
  // the previous shot did (deaths, versus rounds, last stands, relics).
  private reset(o: TrailerStageOpts) {
    this.run.state = "active";
    this.run.deadT = 0;
    this.run.transT = 0;
    this.run.transBuilt = false;
    this.run.pendingOffer = null;
    this.run.freeze = 0;
    this.run.mods = { ...baseMods(), ...o.mods };
    this.run.ownedRelics = new Set(o.ownedRelics);
    this.run.maxHearts = Math.max(1, this.run.mods.maxHearts);
    this.run.hearts = o.hearts ?? this.run.maxHearts;
    this.run.gold = o.gold ?? 0;
    this.run.score = o.score ?? 0;
    this.run.combo = 0;
    this.run.comboT = 0;
    this.combat.lastCrit = false;
    this.scene.tweens.killTweensOf(this.chrome.comboText);
    this.chrome.comboText.setAlpha(0);
    this.run.downed = null;
    this.lastStand.destroyUi();
    this.seat.mode = "coop";
    this.run.match = null;
    this.room.vsSpawns = [];
    this.seat.duelHits = new WeakMap();
    // Fresh actors — hero kits bind at construction, so scenes swap heroes by
    // rebuilding the Player wrappers (same spawnPlayer path as create()).
    this.seat.player.destroy();
    this.seat.remote?.destroy();
    this.seat.remote = undefined;
    this.seat.heroName = o.hero;
  }

  // Offline duel: both fighters are local bodies through the real VersusMatch
  // machine (sys/versus.ts) — no network, same rules.
  private stageVersus(o: TrailerStageOpts) {
    this.seat.mode = "versus";
    const vs = new VersusMatch();
    this.run.match = vs;
    const g = new Grid();
    this.seat.player = this.hooks.spawnPlayer(HEROES[o.hero], g, 0, 0);
    this.seat.remote = this.hooks.spawnPlayer(HEROES[o.hero2 ?? "reaper"], g, 0, 0);
    this.rooms.buildVersus();
    vs.beginMatch();
    // collapse the round-intro freeze: FIGHT! lands on reveal
    vs.t = 0.03;
    const st = o.vsState;
    if (st) {
      vs.hp.host = st.hostHp ?? vs.hp.host;
      vs.hp.guest = st.guestHp ?? vs.hp.guest;
      vs.score.host = st.hostScore ?? vs.score.host;
      vs.score.guest = st.guestScore ?? vs.score.guest;
      vs.round = st.round ?? vs.round;
    }
  }

  private stageRoom(o: TrailerStageOpts, room: RoomType) {
    const def = this.expedition.debugEnter(room, o.biome ?? 1, o.depth ?? 2);
    if (o.noEnemies) {
      def.enemySpawns.length = 0;
    }
    this.seat.player = this.hooks.spawnPlayer(
      HEROES[o.hero],
      def.grid,
      def.playerSpawn.x,
      def.playerSpawn.y,
    );
    if (o.hero2) {
      this.seat.remote = this.hooks.spawnPlayer(
        HEROES[o.hero2],
        def.grid,
        def.playerSpawn.x,
        def.playerSpawn.y,
      );
    }
    this.rooms.build(def);
    if (o.hideDoors) {
      // Scenic shots (e.g. the moonrise release beat) stage the hero where an
      // active exit gate would otherwise pulse in frame. Safe to drop them:
      // checkDoors is trailer-gated and checkClear's setActive no-ops on an
      // empty list, so nothing else reads the doors mid-shot.
      for (const d of this.room.doors) {
        d.destroy();
      }
      this.room.doors = [];
    }
  }

  // The nearest parallax layer draws IN FRONT of the actors (depth 40): in a
  // 240-px-wide framing one trunk can swallow the whole fight. Combat shots
  // drop it; scenic ones keep it for the depth cue.
  private dropForegroundTrees() {
    this.rooms.parallax = this.rooms.parallax.filter((t) => {
      if (t.name !== FG_TREE_NAME) {
        return true;
      }
      t.destroy();
      return false;
    });
  }

  // HUD policy: everything hidden unless the shot opts in; visibility (not
  // alpha) so banners.show/updateHud can't resurrect a hidden element.
  private hud(hud: NonNullable<TrailerStageOpts["hud"]>) {
    this.chrome.heartsText.setVisible(hud.hearts ?? false);
    // versus HUD bumps to 12
    this.chrome.infoText.setVisible(hud.info ?? false).setFontSize(9);
    this.banners.text.setVisible(hud.banner ?? false);
    this.chrome.comboText.setVisible(hud.combo ?? false);
    const bossBar = hud.bossBar ?? false;
    this.room.bossHp?.setVisible(bossBar);
    this.room.bossHpBg?.setVisible(bossBar);
  }

  /** Trailer-only lens: an INTEGER world zoom (1 = the play camera, 2 = twice
   * the subject size). Phaser scales screen-pinned (scrollFactor 0) objects
   * about the camera midpoint along with the world, so a raw setZoom would
   * double the HUD and shove the corner-anchored parts off-frame. Counter-
   * transform the pinned set instead — hearts/info/banner/combo/boss bar and
   * the sky/fog/fade plates land pixel-for-pixel where they were authored,
   * while the world gets the lens. Integer steps only: a fractional zoom
   * shimmers pixel art. */
  zoom(z: number): void {
    this.scene.cameras.main.setZoom(z);
    this.pinScale = 1 / z;
    const cx = BASE_W / 2;
    const cy = BASE_H / 2;
    const pinned: (
      | Phaser.GameObjects.Rectangle
      | Phaser.GameObjects.Text
      | Phaser.GameObjects.Image
      | undefined
    )[] = [
      this.room.sky?.image,
      this.room.fogRect,
      this.chrome.fadeRect,
      this.chrome.heartsText,
      this.chrome.infoText,
      this.banners.text,
      this.chrome.comboText,
      this.room.bossHpBg,
      this.room.bossHp,
    ];
    for (const o of pinned) {
      if (!o) {
        continue;
      }
      let base = this.pinBase.get(o);
      if (!base) {
        base = { x: o.x, y: o.y };
        this.pinBase.set(o, base);
      }
      o.setPosition((base.x - cx) / z + cx, (base.y - cy) / z + cy);
      // The sky texture is half-resolution; retain its logical display size.
      o.setScale(
        (o === this.room.sky?.image ? BASE_W / o.width : 1) / z,
        (o === this.room.sky?.image ? BASE_H / o.height : 1) / z,
      );
    }
  }

  /** Spawn one enemy into the live fight (real Enemy + biome HP scaling; the
   * optional affix id recolours/buffs it exactly like an elite-room roll). */
  spawnEnemy(name: EnemyName, x: number, y: number, affixId?: string): void {
    const e = new Enemy(this.scene, this.room.grid, ENEMIES[name], x, y);
    e.body.hp += Math.floor((this.expedition.biome - 1) / 2);
    const affix = AFFIXES.find((a) => a.id === affixId);
    if (affix) {
      applyAffix(e, affix);
    }
    this.room.enemies.push(e);
  }

  /** Scripted input source: sampled once per frame in place of the keyboard
   * (p1 = local hero, p2 = the staged second hero). null restores normal input. */
  setInput(provider: (() => TrailerInputs) | null): void {
    this.input = provider;
  }

  /** Advance the sim by n fixed steps while the screen is black — pre-rolls
   * velocity/AI so the first visible frame is already mid-action. Bypasses the
   * freeze on purpose. */
  tick(steps: number): void {
    for (let i = 0; i < steps; i += 1) {
      const s = this.input ? this.input() : null;
      if (s) {
        this.seat.player.buffer(s.p1);
        if (this.seat.remote && s.p2) {
          this.seat.remote.buffer(s.p2);
        }
      }
      this.hooks.simStep(STEP);
    }
    // Settle the views so the camera snap targets real positions.
    this.seat.player.render(1);
    this.seat.remote?.render(1);
    for (const e of this.room.enemies) {
      e.render(1);
    }
    this.room.boss?.render(1);
  }

  /** Freeze (seconds — the existing hitstop clock) or unfreeze (0) the sim. */
  freeze(seconds: number): void {
    this.run.freeze = seconds;
  }

  /** Mid-shot mod tweak (e.g. arm 100% ward once a last stand is staged). */
  mods(m: Partial<RunMods>): void {
    Object.assign(this.run.mods, m);
  }

  /** Fire the game's own centre banner (visible only if the shot's HUD opts in). */
  banner(text: string, ms: number): void {
    this.banners.show(text, ms, "critical");
  }

  /** Live handles for choreography: steering reads positions, boss direction
   * calls forceState, versus scripts read the encoded match state. */
  world(): TrailerWorld {
    return {
      boss: this.room.boss,
      enemies: this.room.enemies,
      p1: this.seat.player,
      p2: this.seat.remote ?? null,
      vs: this.run.match ? this.run.match.encode() : null,
    };
  }
}

// ── trailer-mode types (consumed by src/trailer/trailer-director.ts) ─────────
export interface TrailerInputs {
  p1: InputState;
  p2: InputState | null;
}
export interface TrailerHudOpts {
  hearts?: boolean;
  info?: boolean;
  banner?: boolean;
  combo?: boolean;
  bossBar?: boolean;
}
export interface TrailerStageOpts {
  hero: HeroName;
  /** Stage a second local hero (offline co-op / versus scenes). */
  hero2?: HeroName;
  room: RoomType | "versus";
  biome?: number;
  depth?: number;
  /** Seeds the gameplay RNG (rooms, crits, relic offers) for repeatable shots. */
  seed?: number;
  mods?: Partial<RunMods>;
  hearts?: number;
  gold?: number;
  score?: number;
  /** Pre-owned relic ids — narrows merchant/cache offers deterministically. */
  ownedRelics?: readonly string[];
  /** Strip the room template's enemy spawns (the shot places its own). */
  noEnemies?: boolean;
  /** Destroy the room's exit doors after build — for still/scenic shots where
   * an active gate's pulsing glow + label would sit in frame. */
  hideDoors?: boolean;
  /** Draw the in-front parallax tree layer (default true). false for combat
   * shots, where a foreground trunk otherwise occludes the fight. */
  fgTrees?: boolean;
  playerAt?: { x: number; y: number };
  player2At?: { x: number; y: number };
  hud?: TrailerHudOpts;
  /** Versus only: mid-match state (hearts / round pips) staged before the shot. */
  vsState?: {
    hostHp?: number;
    guestHp?: number;
    hostScore?: number;
    guestScore?: number;
    round?: number;
  };
}
export interface TrailerWorld {
  p1: Player;
  p2: Player | null;
  boss: Boss | null;
  enemies: readonly Enemy[];
  vs: NetVersus | null;
}
