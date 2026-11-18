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

export interface TrailerStagingDeps {
  scene: Scene;
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  combat: Combat;
  lastStand: LastStand;
  rooms: RoomBuilder;
  chrome: SceneChrome;
  hooks: SceneHooks;
}

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
  private readonly pinBase = new WeakMap<Phaser.GameObjects.GameObject, { x: number; y: number }>();
  pinScale = 1;

  constructor(deps: TrailerStagingDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.combat = deps.combat;
    this.lastStand = deps.lastStand;
    this.rooms = deps.rooms;
    this.chrome = deps.chrome;
    this.hooks = deps.hooks;
  }

  /** Fully restage the world as one trailer shot: fresh solo/duo actors, a
   * seeded room, scene-scoped mods/hearts/gold, HUD policy, and the sim frozen
   * until the shell reveals the scene (freeze(0) on first run frame). */
  stage(o: TrailerStageOpts) {
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
    this.banners.clear();
    this.chrome.fadeRect.setAlpha(0);
    this.hooks.updateHud();
    this.run.freeze = 9999;
  }

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
    this.seat.player.destroy();
    this.seat.remote?.destroy();
    this.seat.remote = undefined;
    this.seat.heroName = o.hero;
  }

  private stageVersus(o: TrailerStageOpts) {
    this.seat.mode = "versus";
    const vs = new VersusMatch();
    this.run.match = vs;
    const g = new Grid();
    this.seat.player = this.hooks.spawnPlayer(HEROES[o.hero], g, 0, 0);
    this.seat.remote = this.hooks.spawnPlayer(HEROES[o.hero2 ?? "reaper"], g, 0, 0);
    this.rooms.buildVersus();
    vs.beginMatch();
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
      for (const d of this.room.doors) {
        d.destroy();
      }

      this.room.doors = [];
    }
  }

  private dropForegroundTrees() {
    this.rooms.parallax = this.rooms.parallax.filter((t) => {
      if (t.name !== FG_TREE_NAME) {
        return true;
      }

      t.destroy();

      return false;
    });
  }

  private hud(hud: NonNullable<TrailerStageOpts["hud"]>) {
    this.chrome.heartsText.setVisible(hud.hearts ?? false);
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
  zoom(z: number) {
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
      o.setScale(
        (o === this.room.sky?.image ? BASE_W / o.width : 1) / z,
        (o === this.room.sky?.image ? BASE_H / o.height : 1) / z,
      );
    }
  }

  /** Spawn one enemy into the live fight (real Enemy + biome HP scaling; the
   * optional affix id recolours/buffs it exactly like an elite-room roll). */
  spawnEnemy(name: EnemyName, x: number, y: number, affixId?: string) {
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
  setInput(provider: (() => TrailerInputs) | null) {
    this.input = provider;
  }

  /** Advance the sim by n fixed steps while the screen is black — pre-rolls
   * velocity/AI so the first visible frame is already mid-action. Bypasses the
   * freeze on purpose. */
  tick(steps: number) {
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

    this.seat.player.render(1);
    this.seat.remote?.render(1);

    for (const e of this.room.enemies) {
      e.render(1);
    }

    this.room.boss?.render(1);
  }

  /** Freeze (seconds — the existing hitstop clock) or unfreeze (0) the sim. */
  freeze(seconds: number) {
    this.run.freeze = seconds;
  }

  /** Mid-shot mod tweak (e.g. arm 100% ward once a last stand is staged). */
  mods(m: Partial<RunMods>) {
    Object.assign(this.run.mods, m);
  }

  /** Fire the game's own centre banner (visible only if the shot's HUD opts in). */
  banner(text: string, ms: number) {
    this.banners.show(text, ms, "critical");
  }

  /** Live handles for choreography: steering reads positions, boss direction
   * calls forceState, versus scripts read the encoded match state. */
  world() {
    return {
      boss: this.room.boss,
      enemies: this.room.enemies,
      p1: this.seat.player,
      p2: this.seat.remote ?? null,
      vs: this.run.match ? this.run.match.encode() : null,
    };
  }
}

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
