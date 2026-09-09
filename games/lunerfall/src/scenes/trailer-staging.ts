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
import { Grid } from "../sys/grid";
import type { InputState } from "../sys/input";
import { reseed } from "../sys/rng";
import { VersusMatch } from "../sys/versus";
import type { GameScene } from "./game-scene";
import { applyAffix } from "./room-builder";

type TrailerCtx = Scene &
  Pick<
    GameScene,
    | "banners"
    | "boss"
    | "bossHp"
    | "bossHpBg"
    | "combat"
    | "combo"
    | "comboT"
    | "comboText"
    | "deadT"
    | "doors"
    | "enemies"
    | "fadeRect"
    | "fogRect"
    | "freeze"
    | "gold"
    | "grid"
    | "hearts"
    | "heartsText"
    | "heroName"
    | "infoText"
    | "lastStand"
    | "maxHearts"
    | "mode"
    | "mods"
    | "ownedRelics"
    | "pendingOffer"
    | "player"
    | "remote"
    | "rooms"
    | "run"
    | "runRecap"
    | "score"
    | "simStep"
    | "sky"
    | "spawnPlayer"
    | "state"
    | "transBuilt"
    | "transT"
    | "updateHud"
    | "versus"
  >;

// Staging surface for src/trailer/trailer-director.ts (?trailer=1 only). All
// methods drive the exact same code paths gameplay uses — real rooms, real
// enemies, real combat resolution — they only skip the menu/network plumbing.
// Nothing in normal play calls any of this: `active` and `input` stay unset,
// so the scene's trailer checks are dead code outside the director.
export class TrailerStaging {
  private readonly scene: TrailerCtx;
  active = false;
  input: (() => TrailerInputs) | null = null;
  // Authored (unzoomed) position of every screen-pinned object, so zoom can
  // re-derive the counter-transform from scratch on each shot.
  private readonly pinBase = new WeakMap<Phaser.GameObjects.GameObject, { x: number; y: number }>();
  // Scale every pinned object currently sits at (1/zoom). Anything that animates
  // a pinned object's scale has to multiply through this, or the tween's
  // absolute target silently undoes the counter-transform. 1 in normal play.
  pinScale = 1;

  constructor(scene: TrailerCtx) {
    this.scene = scene;
  }

  /** Fully restage the world as one trailer shot: fresh solo/duo actors, a
   * seeded room, scene-scoped mods/hearts/gold, HUD policy, and the sim frozen
   * until the shell reveals the scene (freeze(0) on first run frame). */
  stage(o: TrailerStageOpts): void {
    this.active = true;
    this.scene.runRecap = null;
    this.scene.banners.clear();
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
      this.scene.player.enterRoom(this.scene.grid, o.playerAt.x, o.playerAt.y);
    }
    if (o.player2At) {
      this.scene.remote?.enterRoom(this.scene.grid, o.player2At.x, o.player2At.y);
    }
    this.hud(o.hud ?? {});
    // Kill the room-build announcement; scenes trigger their own banners.
    this.scene.banners.clear();
    this.scene.fadeRect.setAlpha(0);
    this.scene.updateHud();
    // Hold the sim until the shell reveals the shot (the cut plate is still black).
    this.scene.freeze = 9999;
  }

  // Cross-scene reset: every shot stages from nothing, independent of what
  // the previous shot did (deaths, versus rounds, last stands, relics).
  private reset(o: TrailerStageOpts) {
    this.scene.state = "active";
    this.scene.deadT = 0;
    this.scene.transT = 0;
    this.scene.transBuilt = false;
    this.scene.pendingOffer = null;
    this.scene.freeze = 0;
    this.scene.mods = { ...baseMods(), ...o.mods };
    this.scene.ownedRelics = new Set(o.ownedRelics);
    this.scene.maxHearts = Math.max(1, this.scene.mods.maxHearts);
    this.scene.hearts = o.hearts ?? this.scene.maxHearts;
    this.scene.gold = o.gold ?? 0;
    this.scene.score = o.score ?? 0;
    this.scene.combo = 0;
    this.scene.comboT = 0;
    this.scene.combat.lastCrit = false;
    this.scene.tweens.killTweensOf(this.scene.comboText);
    this.scene.comboText.setAlpha(0);
    this.scene.lastStand.live = null;
    this.scene.lastStand.destroyUi();
    this.scene.mode = "coop";
    this.scene.versus.match = null;
    this.scene.versus.spawns = [];
    this.scene.versus.hitSeq = new WeakMap();
    // Fresh actors — hero kits bind at construction, so scenes swap heroes by
    // rebuilding the Player wrappers (same spawnPlayer path as create()).
    this.scene.player.destroy();
    this.scene.remote?.destroy();
    this.scene.remote = undefined;
    this.scene.heroName = o.hero;
  }

  // Offline duel: both fighters are local bodies through the real VersusMatch
  // machine (sys/versus.ts) — no network, same rules.
  private stageVersus(o: TrailerStageOpts) {
    this.scene.mode = "versus";
    const vs = new VersusMatch();
    this.scene.versus.match = vs;
    const g = new Grid();
    this.scene.player = this.scene.spawnPlayer(HEROES[o.hero], g, 0, 0);
    this.scene.remote = this.scene.spawnPlayer(HEROES[o.hero2 ?? "reaper"], g, 0, 0);
    this.scene.rooms.buildVersus();
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
    const def = this.scene.run.debugEnter(room, o.biome ?? 1, o.depth ?? 2);
    if (o.noEnemies) {
      def.enemySpawns.length = 0;
    }
    this.scene.player = this.scene.spawnPlayer(
      HEROES[o.hero],
      def.grid,
      def.playerSpawn.x,
      def.playerSpawn.y,
    );
    if (o.hero2) {
      this.scene.remote = this.scene.spawnPlayer(
        HEROES[o.hero2],
        def.grid,
        def.playerSpawn.x,
        def.playerSpawn.y,
      );
    }
    this.scene.rooms.build(def);
    if (o.hideDoors) {
      // Scenic shots (e.g. the moonrise release beat) stage the hero where an
      // active exit gate would otherwise pulse in frame. Safe to drop them:
      // checkDoors is trailer-gated and checkClear's setActive no-ops on an
      // empty list, so nothing else reads the doors mid-shot.
      for (const d of this.scene.doors) {
        d.destroy();
      }
      this.scene.doors = [];
    }
  }

  // The nearest parallax layer draws IN FRONT of the actors (depth 40): in a
  // 240-px-wide framing one trunk can swallow the whole fight. Combat shots
  // drop it; scenic ones keep it for the depth cue.
  private dropForegroundTrees() {
    this.scene.rooms.parallax = this.scene.rooms.parallax.filter((t) => {
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
    this.scene.heartsText.setVisible(hud.hearts ?? false);
    // versus HUD bumps to 12
    this.scene.infoText.setVisible(hud.info ?? false).setFontSize(9);
    this.scene.banners.text.setVisible(hud.banner ?? false);
    this.scene.comboText.setVisible(hud.combo ?? false);
    const bossBar = hud.bossBar ?? false;
    this.scene.bossHp?.setVisible(bossBar);
    this.scene.bossHpBg?.setVisible(bossBar);
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
      this.scene.sky?.image,
      this.scene.fogRect,
      this.scene.fadeRect,
      this.scene.heartsText,
      this.scene.infoText,
      this.scene.banners.text,
      this.scene.comboText,
      this.scene.bossHpBg,
      this.scene.bossHp,
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
        (o === this.scene.sky?.image ? BASE_W / o.width : 1) / z,
        (o === this.scene.sky?.image ? BASE_H / o.height : 1) / z,
      );
    }
  }

  /** Spawn one enemy into the live fight (real Enemy + biome HP scaling; the
   * optional affix id recolours/buffs it exactly like an elite-room roll). */
  spawnEnemy(name: EnemyName, x: number, y: number, affixId?: string): void {
    const e = new Enemy(this.scene, this.scene.grid, ENEMIES[name], x, y);
    e.body.hp += Math.floor((this.scene.run.biome - 1) / 2);
    const affix = AFFIXES.find((a) => a.id === affixId);
    if (affix) {
      applyAffix(e, affix);
    }
    this.scene.enemies.push(e);
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
        this.scene.player.buffer(s.p1);
        if (this.scene.remote && s.p2) {
          this.scene.remote.buffer(s.p2);
        }
      }
      this.scene.simStep(STEP);
    }
    // Settle the views so the camera snap targets real positions.
    this.scene.player.render(1);
    this.scene.remote?.render(1);
    for (const e of this.scene.enemies) {
      e.render(1);
    }
    this.scene.boss?.render(1);
  }

  /** Freeze (seconds — the existing hitstop clock) or unfreeze (0) the sim. */
  freeze(seconds: number): void {
    this.scene.freeze = seconds;
  }

  /** Mid-shot mod tweak (e.g. arm 100% ward once a last stand is staged). */
  mods(m: Partial<RunMods>): void {
    Object.assign(this.scene.mods, m);
  }

  /** Fire the game's own centre banner (visible only if the shot's HUD opts in). */
  banner(text: string, ms: number): void {
    this.scene.banners.show(text, ms, "critical");
  }

  /** Live handles for choreography: steering reads positions, boss direction
   * calls forceState, versus scripts read the encoded match state. */
  world(): TrailerWorld {
    return {
      boss: this.scene.boss,
      enemies: this.scene.enemies,
      p1: this.scene.player,
      p2: this.scene.remote ?? null,
      vs: this.scene.versus.match ? this.scene.versus.match.encode() : null,
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
