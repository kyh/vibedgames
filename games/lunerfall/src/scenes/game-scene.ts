import Phaser from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_H, BASE_W, COLORS, TILE } from "../config";
import type { EnemyName, HeroName } from "../data/animations";
import { ENEMIES } from "../data/enemies";
import { HEROES } from "../data/heroes";
import { bankRun, loadMeta } from "../data/meta";
import { baseMods, pickRelics, type Relic, type RunMods } from "../data/relics";
import { type RoomDef, ROOM_LABEL, type RoomType } from "../data/rooms";
import { Boss } from "../entities/boss";
import { Door } from "../entities/door";
import { Enemy } from "../entities/enemy";
import { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import { drawRoom } from "../room";
import { dust, explosion, hitSpark, popText, slash } from "../sys/fx";
import { Grid } from "../sys/grid";
import { type Offer, RunManager } from "../sys/run";
import { Input, type InputState } from "../sys/input";

const STEP = 1 / 60;
const MAX_STEPS = 5;
const MAX_HEARTS = 4;
const DEATH_LINGER = 0.55;
const ARROW_GRAV = 150;

type Arrow = { spr: Phaser.GameObjects.Sprite; x: number; y: number; vx: number; vy: number; life: number; dmg: number };
type Shot = { spr: Phaser.GameObjects.Sprite; x: number; y: number; vx: number; vy: number; life: number; dmg: number; hit: Set<Enemy>; hitBoss: boolean };
type Hazard = { spr: Phaser.GameObjects.Sprite; x: number; y: number; vx: number; life: number; dmg: number; hitPlayer: boolean };
type Feature = { x: number; y: number; used: boolean; g: Phaser.GameObjects.Container };
type MerchantItem = { x: number; y: number; relic: Relic; bought: boolean; g: Phaser.GameObjects.Container };
type SceneState = "active" | "dead" | "transition";

// Phase 5: run-driven scene. RunManager stitches typed rooms; the scene builds
// each room (tiles, enemies, doors, features), resolves combat, and transitions
// through torii doors on the player's chosen path.
export class GameScene extends Phaser.Scene {
  private run = new RunManager();
  private grid!: Grid;
  private player!: Player;
  private controls!: Input;
  private acc = 0;

  private roomLayer?: Phaser.GameObjects.Container;
  private doors: Door[] = [];
  private offers: Offer[] = [];
  private feature: Feature | null = null;
  private enemies: Enemy[] = [];
  private arrows: Arrow[] = [];
  private shots: Shot[] = [];
  private hazards: Hazard[] = [];
  private boss: Boss | null = null;
  private bossHp?: Phaser.GameObjects.Rectangle;
  private bossHpBg?: Phaser.GameObjects.Rectangle;
  private bossDeadT = 0;
  private bossSwingHit = -1;
  private bossSpecialHit = -1;
  private heroName: HeroName = "axion";

  private mustClear = false;
  private cleared = false;
  private mods: RunMods = baseMods();
  private ownedRelics = new Set<string>();
  private merchantItems: MerchantItem[] = [];
  private maxHearts = MAX_HEARTS;
  private hearts = MAX_HEARTS;
  private gold = 0;
  private freeze = 0;
  private lastSwing = -1;
  private lastSpecialHit = -1;
  private hitThisSwing = new Set<Enemy>();
  private hitThisSpecial = new Set<Enemy>();
  private deadTimers = new WeakMap<Enemy, number>();
  private state: SceneState = "active";
  private deadT = 0;
  private transT = 0;
  private transBuilt = false;
  private pendingOffer: Offer | null = null;
  private fadeRect!: Phaser.GameObjects.Rectangle;

  private heartsText!: Phaser.GameObjects.Text;
  private infoText!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;

  private demo = false;
  private demoT = 0;
  private prevJump = false;
  private prevDash = false;
  private prevAtk = false;
  private prevSpecial = false;

  constructor() {
    super("game");
  }

  create() {
    const params = new URLSearchParams(location.search);
    this.demo = params.get("demo") === "1";
    const data = this.scene.settings.data as { hero?: HeroName } | undefined;
    const wanted = (params.get("hero") as HeroName | null) ?? data?.hero ?? this.registry.get("hero");
    this.heroName = wanted && HEROES[wanted as HeroName] ? (wanted as HeroName) : "axion";
    this.mods = baseMods();
    this.ownedRelics = new Set();
    this.merchantItems = [];
    this.maxHearts = this.mods.maxHearts;
    this.hearts = this.maxHearts;
    this.gold = 0;
    this.state = "active";
    this.doors = [];
    this.enemies = [];
    this.arrows = [];
    this.shots = [];
    this.hazards = [];
    this.boss = null;
    this.feature = null;

    this.add.rectangle(0, 0, BASE_W, BASE_H, COLORS.bgDeep).setOrigin(0).setDepth(-10);
    this.add.rectangle(0, BASE_H * 0.35, BASE_W, BASE_H * 0.65, COLORS.bg).setOrigin(0).setDepth(-10);
    this.fadeRect = this.add.rectangle(0, 0, BASE_W, BASE_H, 0x05070b).setOrigin(0).setDepth(100).setAlpha(0);

    this.heartsText = this.add.text(8, 6, "", { fontFamily: "monospace", fontSize: "12px", color: "#ff4d6d" }).setDepth(80);
    this.infoText = this.add
      .text(BASE_W - 8, 7, "", { fontFamily: "monospace", fontSize: "9px", color: "#8b95a1" })
      .setOrigin(1, 0)
      .setDepth(80);
    this.banner = this.add
      .text(BASE_W / 2, BASE_H / 2 - 20, "", { fontFamily: "monospace", fontSize: "15px", color: "#34e5c8" })
      .setOrigin(0.5)
      .setDepth(80)
      .setAlpha(0);
    this.add
      .text(6, BASE_H - 11, "← → move   ↑ jump   J attack   shift dash", { fontFamily: "monospace", fontSize: "8px", color: "#59636f" })
      .setDepth(80);

    this.controls = new Input(this);
    const cam = this.cameras.main;
    const roomParam = new URLSearchParams(location.search).get("room") as RoomType | null;
    const def = roomParam ? this.run.debugEnter(roomParam) : this.run.begin();
    this.player = new Player(this, def.grid, def.playerSpawn.x, def.playerSpawn.y, HEROES[this.heroName], {
      onLand: (impact) => {
        cam.shake(80, Math.min(0.003 + impact * 0.00002, 0.008));
        dust(this, this.player.x, this.player.y);
      },
      onDash: () => {
        cam.shake(60, 0.0025);
        sfx.dash();
      },
      onSwing: (step) => {
        slash(this, this.player.x + this.player.body.facing * 8, this.player.y - 11, this.player.body.facing, 22 + step * 3, HEROES[this.heroName].color);
        cam.shake(50, 0.0015);
        sfx.slash();
      },
      onSpecial: (kind) => this.onSpecialFx(kind),
      onHurt: () => {
        cam.shake(180, 0.012);
        sfx.hurt();
      },
      onJump: () => sfx.jump(),
    });
    this.buildRoom(def);
    this.updateHud();

    sfx.unlock();
    this.input.keyboard?.once("keydown", () => sfx.unlock());
    this.input.once("pointerdown", () => sfx.unlock());
    this.input.keyboard?.on("keydown-M", () => sfx.toggleMute());
  }

  // ── room building ──────────────────────────────────────────────────────────
  private buildRoom(def: RoomDef) {
    this.roomLayer?.destroy();
    this.doors.forEach((d) => d.destroy());
    this.enemies.forEach((e) => e.destroy());
    this.arrows.forEach((a) => a.spr.destroy());
    this.shots.forEach((s) => s.spr.destroy());
    this.hazards.forEach((h) => h.spr.destroy());
    this.merchantItems.forEach((m) => m.g.destroy());
    this.merchantItems = [];
    this.boss?.destroy();
    this.bossHp?.destroy();
    this.bossHpBg?.destroy();
    this.feature?.g.destroy();
    this.doors = [];
    this.enemies = [];
    this.arrows = [];
    this.shots = [];
    this.hazards = [];
    this.boss = null;
    this.bossHp = undefined;
    this.bossHpBg = undefined;
    this.bossDeadT = 0;
    this.feature = null;
    this.deadTimers = new WeakMap();
    this.lastSwing = -1;

    this.grid = def.grid;
    this.roomLayer = drawRoom(this, def.grid).setDepth(0);
    this.player.enterRoom(def.grid, def.playerSpawn.x, def.playerSpawn.y);

    this.mustClear = this.run.isCombat();
    this.cleared = !this.mustClear;

    if (this.run.type === "boss") this.spawnBoss(def);
    else if (this.mustClear) this.spawnEnemies(def);
    else if (this.run.type === "merchant") this.buildMerchant();
    else if (def.featureSpot) this.buildFeature(def.featureSpot.x, def.featureSpot.y);

    this.offers = this.run.offers();
    def.doorSlots.forEach((slot, i) => {
      const offer = this.offers[i];
      if (!offer) return;
      const d = new Door(this, slot.x, slot.y, offer.type, i);
      d.setActive(this.cleared);
      this.doors.push(d);
    });

    this.showBanner(this.mustClear ? ROOM_LABEL[this.run.type] : `${ROOM_LABEL[this.run.type]} — pick a path`, 1100);
  }

  private roster(): EnemyName[] {
    if (this.run.type === "elite") return ["spearman", "warrior", "archer", "spearman", "bomber", "warrior"];
    const early: EnemyName[] = ["warrior", "archer", "warrior", "spearman", "archer", "bomber"];
    return early;
  }

  private spawnEnemies(def: RoomDef) {
    const roster = this.roster();
    const eliteHp = this.run.type === "elite" ? 1 : 0;
    def.enemySpawns.forEach((s, i) => {
      const name = roster[i % roster.length] ?? "warrior";
      const e = new Enemy(this, this.grid, ENEMIES[name], s.x, s.y);
      e.body.hp += eliteHp + Math.floor((this.run.biome - 1) / 2);
      this.enemies.push(e);
    });
  }

  private spawnBoss(def: RoomDef) {
    const bx = def.bossSpawn?.x ?? BASE_W / 2;
    const by = def.bossSpawn?.y ?? (this.grid.rows - 3) * TILE;
    this.boss = new Boss(this, this.grid, bx, by, this.run.biome);
    this.bossDeadT = 0;
    this.bossHpBg = this.add.rectangle(BASE_W / 2, 22, 260, 6, 0x000000, 0.5).setStrokeStyle(1, COLORS.magenta, 0.6).setDepth(85);
    this.bossHp = this.add.rectangle(BASE_W / 2 - 129, 22, 258, 4, COLORS.magenta).setOrigin(0, 0.5).setDepth(86);
    sfx.bossRoar();
    this.showBanner("SALAMANDER", 1600);
  }

  private buildFeature(x: number, y: number) {
    const type = this.run.type;
    const color = type === "rest" ? COLORS.teal : type === "treasure" ? 0xffd15c : COLORS.magenta;
    const g = this.add.container(x, y).setDepth(8);
    const glow = this.add.ellipse(0, -10, 26, 30, color, 0.2);
    const base = this.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
    const orb = this.add.circle(0, -14, 5, color, 0.95);
    const tag = this.add.text(0, -26, ROOM_LABEL[type], { fontFamily: "monospace", fontSize: "7px", color: "#f4f7fb" }).setOrigin(0.5, 1);
    g.add([glow, base, orb, tag]);
    this.tweens.add({ targets: orb, y: -17, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.tweens.add({ targets: glow, scale: 1.2, alpha: 0.32, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
    this.feature = { x, y, used: false, g };
  }

  private buildMerchant() {
    const offers = pickRelics(3, this.ownedRelics);
    const y = (this.grid.rows - 3 + 1) * TILE;
    offers.forEach((relic, i) => {
      const x = (0.3 + i * 0.2) * BASE_W;
      const g = this.add.container(x, y).setDepth(8);
      const glow = this.add.ellipse(0, -12, 24, 30, COLORS.magenta, 0.18);
      const base = this.add.rectangle(0, 0, 16, 6, COLORS.stoneEdge).setOrigin(0.5, 1);
      const orb = this.add.circle(0, -16, 5, COLORS.magenta, 0.95);
      const name = this.add.text(0, -40, relic.name, { fontFamily: "monospace", fontSize: "7px", color: "#f4f7fb" }).setOrigin(0.5);
      const desc = this.add.text(0, -32, relic.desc, { fontFamily: "monospace", fontSize: "6px", color: "#8b95a1" }).setOrigin(0.5);
      const price = this.add.text(0, -25, `⬡ ${relic.price}`, { fontFamily: "monospace", fontSize: "7px", color: "#ffd15c" }).setOrigin(0.5);
      g.add([glow, base, orb, name, desc, price]);
      this.tweens.add({ targets: orb, y: -19, duration: 900, yoyo: true, repeat: -1, ease: "Sine.easeInOut" });
      this.merchantItems.push({ x, y, relic, bought: false, g });
    });
  }

  private applyRelic(relic: Relic) {
    this.ownedRelics.add(relic.id);
    relic.apply(this.mods);
    const before = this.maxHearts;
    this.maxHearts = this.mods.maxHearts;
    this.hearts += Math.max(0, this.maxHearts - before); // new max hearts come filled
    sfx.pickup();
    this.updateHud();
  }

  private stepMerchant() {
    const pb = this.player.body;
    for (const m of this.merchantItems) {
      if (m.bought || this.gold < m.relic.price) continue;
      if (rectsOverlap({ left: m.x - 10, top: m.y - 22, right: m.x + 10, bottom: m.y }, pb.hurtBox())) {
        m.bought = true;
        this.gold -= m.relic.price;
        this.applyRelic(m.relic);
        popText(this, m.x, m.y - 30, m.relic.name, "#e83fa0");
        this.tweens.add({ targets: m.g, alpha: 0, y: m.y - 6, duration: 350, onComplete: () => m.g.destroy() });
      }
    }
  }

  private dmgOut(base: number): number {
    return Math.max(1, Math.round(base * this.mods.dmg));
  }

  private heal(n: number) {
    this.hearts = Math.min(this.maxHearts, this.hearts + n);
    sfx.heal();
    this.updateHud();
  }

  private gainGold(n: number) {
    this.gold += Math.round(n * this.mods.goldMult);
  }

  // ── input ────────────────────────────────────────────────────────────────
  private demoInput(): InputState {
    const cyc = this.demoT % 1.9;
    const jumpHeld = cyc < 0.24;
    const dashWin = cyc > 1.4 && cyc < 1.44;
    const atkWin = (cyc > 0.5 && cyc < 0.54) || (cyc > 0.8 && cyc < 0.84);
    const specWin = cyc > 1.7 && cyc < 1.74;
    const jp = jumpHeld && !this.prevJump;
    const dp = dashWin && !this.prevDash;
    const ap = atkWin && !this.prevAtk;
    const sp = specWin && !this.prevSpecial;
    this.prevJump = jumpHeld;
    this.prevDash = dashWin;
    this.prevAtk = atkWin;
    this.prevSpecial = specWin;
    return { left: false, right: true, up: false, down: false, jumpHeld, jumpPressed: jp, dashPressed: dp, attackPressed: ap, specialPressed: sp };
  }

  update(_t: number, delta: number) {
    const dts = Math.min(delta, 100) / 1000;
    this.demoT += dts;

    if (this.state === "dead") {
      this.deadT += dts;
      this.enemies.forEach((e) => e.render());
      if (this.deadT > 2.4) this.scene.start("select");
      return;
    }
    if (this.state === "transition") {
      this.transT += dts;
      const half = 0.22;
      this.fadeRect.setAlpha(this.transT < half ? this.transT / half : Math.max(0, 1 - (this.transT - half) / half));
      if (!this.transBuilt && this.transT >= half && this.pendingOffer) {
        this.buildRoom(this.run.choose(this.pendingOffer));
        this.updateHud();
        this.transBuilt = true;
      }
      if (this.transT >= half * 2) {
        this.fadeRect.setAlpha(0);
        this.pendingOffer = null;
        this.state = "active";
      }
      this.player.render();
      this.enemies.forEach((e) => e.render());
      this.boss?.render();
      return;
    }

    const snap = this.demo ? this.demoInput() : this.controls.sample();
    this.player.buffer(snap);
    this.acc += dts;
    let steps = 0;
    while (this.acc >= STEP && steps < MAX_STEPS) {
      if (this.freeze > 0) this.freeze -= STEP;
      else this.simStep(STEP);
      this.acc -= STEP;
      steps++;
    }

    this.player.render();
    this.enemies.forEach((e) => e.render());
    this.boss?.render();
    this.updateHud();
  }

  private simStep(dt: number) {
    this.player.step(dt);
    for (const e of this.enemies) e.body.step(dt, this.player.x, this.player.y);
    this.stepBoss(dt);
    this.stepArrows(dt);
    this.stepShots(dt);
    this.stepHazards(dt);
    this.resolveCombat();
    this.stepFeature();
    this.stepMerchant();
    this.cullEnemies(dt);
    this.checkClear();
    this.checkDoors();
  }

  // ── boss ────────────────────────────────────────────────────────────────────
  private stepBoss(dt: number) {
    const boss = this.boss;
    if (!boss) return;
    const pb = this.player.body;
    boss.body.step(dt, pb.x, pb.y);
    if (this.bossHp) this.bossHp.width = 258 * boss.body.hpFrac;

    if (boss.body.dead) {
      if (this.bossDeadT === 0) {
        explosion(this, boss.body.x, boss.body.y - 20, 60);
        sfx.boom();
        this.cameras.main.shake(420, 0.02);
        this.freeze = Math.max(this.freeze, 0.12);
        this.gainGold(25);
        popText(this, boss.body.x, boss.body.y - 44, "+25", "#ffd15c");
        this.showBanner("SALAMANDER SLAIN", 1800);
      }
      this.bossDeadT += dt;
      return;
    }

    if (boss.body.pendingWave) {
      const w = boss.body.pendingWave;
      this.spawnHazard(w.x, w.y, w.vx, w.dmg);
      boss.body.pendingWave = null;
    }
    if (boss.body.pendingBlast) {
      const b = boss.body.pendingBlast;
      explosion(this, b.x, b.y, b.r);
      sfx.boom();
      this.cameras.main.shake(200, 0.014);
      this.freeze = Math.max(this.freeze, 0.07);
      if (Math.hypot(pb.x - b.x, pb.y - 11 - b.y) < b.r + 8) this.hurtPlayer(b.dmg, Math.sign(pb.x - b.x) || 1);
      boss.body.pendingBlast = null;
    }
    if (boss.body.pendingAdds) {
      for (const a of boss.body.pendingAdds) {
        this.enemies.push(new Enemy(this, this.grid, ENEMIES[a.name], Phaser.Math.Clamp(a.x, 24, BASE_W - 24), a.y));
      }
      boss.body.pendingAdds = null;
      this.showBanner("REINFORCEMENTS", 900);
    }
    const atk = boss.body.attackBox();
    if (atk && rectsOverlap(atk, pb.hurtBox())) this.hurtPlayer(atk.dmg, Math.sign(pb.x - boss.body.x) || 1);
    else if (rectsOverlap(boss.body.hurtBox(), pb.hurtBox())) this.hurtPlayer(1, Math.sign(pb.x - boss.body.x) || 1);
  }

  private hitBoss(dmg: number, dir: number, color: number) {
    const boss = this.boss;
    if (!boss || boss.body.dead) return;
    if (!boss.body.takeHit(dmg, 0, dir)) return;
    sfx.hit();
    hitSpark(this, boss.body.x, boss.body.y - 22, color, boss.body.dead ? 12 : 6);
    this.freeze = Math.max(this.freeze, boss.body.dead ? 0.12 : 0.04);
    this.cameras.main.shake(60, 0.003);
  }

  private spawnHazard(x: number, y: number, vx: number, dmg: number) {
    const spr = this.add.sprite(x, y, "fx:flame-wave").setScale(0.9).setDepth(41);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.hazards.push({ spr, x, y, vx, life: 2.6, dmg, hitPlayer: false });
  }

  private stepHazards(dt: number) {
    for (let i = this.hazards.length - 1; i >= 0; i--) {
      const h = this.hazards[i];
      if (!h) continue;
      h.x += h.vx * dt;
      h.life -= dt;
      h.spr.setPosition(Math.round(h.x), Math.round(h.y));
      const pb = this.player.body;
      if (!h.hitPlayer && !pb.dead && rectsOverlap({ left: h.x - 14, top: h.y - 9, right: h.x + 14, bottom: h.y + 9 }, pb.hurtBox())) {
        this.hurtPlayer(h.dmg, Math.sign(h.vx) || 1);
        h.hitPlayer = true;
      }
      if (h.life <= 0 || this.grid.solidInRect(h.x - 4, h.y - 4, h.x + 4, h.y + 4)) {
        h.spr.destroy();
        this.hazards.splice(i, 1);
      }
    }
  }

  private onSpecialFx(kind: string) {
    const px = this.player.x;
    const py = this.player.y - 11;
    const color = HEROES[this.heroName].color;
    if (kind === "blink") hitSpark(this, px, py, color, 12);
    else if (kind === "heal") {
      for (let i = 0; i < 8; i++) {
        const p = this.add.circle(px + (Math.random() - 0.5) * 16, py + 6, 1.5, COLORS.teal, 0.9).setDepth(60);
        this.tweens.add({ targets: p, y: py - 14, alpha: 0, duration: 500 + Math.random() * 200, onComplete: () => p.destroy() });
      }
    } else if (kind === "aoe") {
      explosion(this, px, this.player.y - 6, 30);
      sfx.boom();
      this.cameras.main.shake(140, 0.01);
      this.freeze = Math.max(this.freeze, 0.06);
    } else if (kind === "projectile") {
      hitSpark(this, px + this.player.body.facing * 10, py, color, 5);
    }
  }

  // ── combat resolution ──────────────────────────────────────────────────────
  private resolveCombat() {
    const pb = this.player.body;
    const ab = pb.attackBox();
    if (ab) {
      if (pb.swingId !== this.lastSwing) {
        this.hitThisSwing.clear();
        this.lastSwing = pb.swingId;
      }
      for (const e of this.enemies) {
        if (e.body.dead || this.hitThisSwing.has(e)) continue;
        if (rectsOverlap(ab, e.body.hurtBox())) {
          const dir = Math.sign(e.body.x - pb.x) || pb.facing;
          e.body.takeHit(this.dmgOut(ab.dmg), ab.kb, dir);
          this.hitThisSwing.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.teal, e.body.dead ? 10 : 6);
          this.freeze = Math.max(this.freeze, e.body.dead ? 0.09 : 0.05);
          this.cameras.main.shake(70, e.body.dead ? 0.006 : 0.003);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (this.boss && !this.boss.body.dead && pb.swingId !== this.bossSwingHit && rectsOverlap(ab, this.boss.body.hurtBox())) {
        this.bossSwingHit = pb.swingId;
        this.hitBoss(this.dmgOut(ab.dmg), Math.sign(this.boss.body.x - pb.x) || pb.facing, COLORS.teal);
      }
    }

    // player special: AoE box, launched shot, self-heal
    const sb = pb.specialBox();
    if (sb) {
      if (pb.specialId !== this.lastSpecialHit) {
        this.hitThisSpecial.clear();
        this.lastSpecialHit = pb.specialId;
      }
      for (const e of this.enemies) {
        if (e.body.dead || this.hitThisSpecial.has(e)) continue;
        if (rectsOverlap(sb, e.body.hurtBox())) {
          e.body.takeHit(this.dmgOut(sb.dmg), sb.kb, Math.sign(e.body.x - pb.x) || pb.facing);
          this.hitThisSpecial.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, HEROES[this.heroName].color, 8);
          this.freeze = Math.max(this.freeze, 0.06);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (this.boss && !this.boss.body.dead && pb.specialId !== this.bossSpecialHit && rectsOverlap(sb, this.boss.body.hurtBox())) {
        this.bossSpecialHit = pb.specialId;
        this.hitBoss(this.dmgOut(sb.dmg), Math.sign(this.boss.body.x - pb.x) || pb.facing, HEROES[this.heroName].color);
      }
    }
    if (pb.pendingShot) {
      const s = pb.pendingShot;
      this.spawnShot(s.x, s.y, s.vx, s.vy, s.dmg);
      pb.pendingShot = null;
    }
    if (pb.pendingHeal > 0) {
      this.heal(pb.pendingHeal);
      popText(this, pb.x, pb.y - 26, "+HP", "#34e5c8");
      pb.pendingHeal = 0;
    }

    if (pb.vy > 20) {
      for (const e of this.enemies) {
        if (e.body.dead) continue;
        const top = e.body.y - e.body.kind.h;
        if (pb.y <= top + 8 && pb.y >= top - 12 && Math.abs(pb.x - e.body.x) < e.body.kind.hw + 6) {
          e.body.takeHit(this.dmgOut(2), 60, Math.sign(pb.vx) || 1);
          pb.bounce();
          sfx.hit();
          hitSpark(this, e.body.x, top, COLORS.white, 8);
          this.freeze = Math.max(this.freeze, 0.08);
          this.cameras.main.shake(80, 0.006);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (this.boss && !this.boss.body.dead) {
        const top = this.boss.body.hurtBox().top;
        if (pb.y <= top + 10 && pb.y >= top - 16 && Math.abs(pb.x - this.boss.body.x) < 22) {
          this.hitBoss(1, Math.sign(pb.vx) || 1, COLORS.white);
          pb.bounce();
          this.freeze = Math.max(this.freeze, 0.06);
        }
      }
    }

    for (const e of this.enemies) {
      const eb = e.body;
      if (!eb.dead) {
        const atk = eb.attackBox();
        if (atk && rectsOverlap(atk, pb.hurtBox())) this.hurtPlayer(atk.dmg, Math.sign(pb.x - eb.x) || 1);
        else if (eb.contactDamage() > 0 && rectsOverlap(eb.hurtBox(), pb.hurtBox())) this.hurtPlayer(eb.contactDamage(), Math.sign(pb.x - eb.x) || 1);
      }
      if (eb.pendingProjectile) {
        this.spawnArrow(eb.pendingProjectile.x, eb.pendingProjectile.y, eb.pendingProjectile.vx, eb.pendingProjectile.vy, eb.kind.attackDmg ?? 1);
        eb.pendingProjectile = null;
      }
      if (eb.pendingBlast) {
        const b = eb.pendingBlast;
        explosion(this, b.x, b.y, b.r);
        sfx.boom();
        this.cameras.main.shake(160, 0.01);
        this.freeze = Math.max(this.freeze, 0.06);
        if (Math.hypot(pb.x - b.x, pb.y - eb.kind.h / 2 - b.y) < b.r + 8) this.hurtPlayer(b.dmg, Math.sign(pb.x - b.x) || 1);
        eb.pendingBlast = null;
      }
    }
  }

  private onKill(e: Enemy) {
    this.gainGold(2);
    sfx.kill();
    if (this.mods.lifesteal > 0 && Math.random() < this.mods.lifesteal) this.heal(1);
    popText(this, e.body.x, e.body.y - e.body.kind.h, "+2", "#ffd15c");
  }

  private hurtPlayer(dmg: number, dir: number) {
    if (!this.player.body.applyHurt(dir)) return;
    if (this.mods.armor > 0 && Math.random() < this.mods.armor) {
      popText(this, this.player.x, this.player.y - 24, "WARD", "#9b8cff");
      return; // fully blocked (i-frames already granted by applyHurt)
    }
    this.hearts -= dmg;
    this.freeze = Math.max(this.freeze, 0.06);
    hitSpark(this, this.player.x, this.player.y - 11, COLORS.magenta, 8);
    this.updateHud();
    if (this.hearts <= 0) this.playerDie();
  }

  private playerDie() {
    this.hearts = 0;
    this.state = "dead";
    this.deadT = 0;
    this.player.sprite.play(`${this.heroName}:death`);
    sfx.die();
    const earned = bankRun(loadMeta(), this.gold, this.run.depth, this.run.biome);
    this.showBanner(`YOU FELL   +${earned} ✦`, 2200);
  }

  // ── features (rest fountain / treasure cache) ───────────────────────────────
  private stepFeature() {
    const f = this.feature;
    if (!f || f.used) return;
    const pb = this.player.body;
    if (!rectsOverlap({ left: f.x - 10, top: f.y - 20, right: f.x + 10, bottom: f.y }, pb.hurtBox())) return;
    f.used = true;
    this.tweens.add({ targets: f.g, alpha: 0, y: f.y - 6, duration: 400, onComplete: () => f.g.destroy() });
    if (this.run.type === "rest") {
      this.heal(2);
      popText(this, f.x, f.y - 22, "+HP", "#34e5c8");
    } else {
      // treasure cache: a free relic (or gold if the player owns them all).
      const [relic] = pickRelics(1, this.ownedRelics);
      if (relic) {
        this.applyRelic(relic);
        popText(this, f.x, f.y - 22, relic.name, "#ffd15c");
      } else {
        this.gainGold(20);
        popText(this, f.x, f.y - 22, "+20", "#ffd15c");
      }
    }
    this.updateHud();
  }

  // ── arrows ─────────────────────────────────────────────────────────────────
  private spawnArrow(x: number, y: number, vx: number, vy: number, dmg: number) {
    const spr = this.add.sprite(x, y, "fx:arrow").setScale(0.3).setDepth(40);
    spr.setFlipX(vx < 0);
    this.arrows.push({ spr, x, y, vx, vy, life: 3, dmg });
  }

  private stepArrows(dt: number) {
    for (let i = this.arrows.length - 1; i >= 0; i--) {
      const a = this.arrows[i];
      if (!a) continue;
      a.vy += ARROW_GRAV * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.life -= dt;
      a.spr.setPosition(Math.round(a.x), Math.round(a.y));
      a.spr.setRotation(Math.atan2(a.vy, a.vx) + (a.vx < 0 ? Math.PI : 0));
      const hitWall = this.grid.solidInRect(a.x - 2, a.y - 2, a.x + 2, a.y + 2);
      const pb = this.player.body;
      const hitPlayer = !pb.dead && rectsOverlap({ left: a.x - 3, top: a.y - 3, right: a.x + 3, bottom: a.y + 3 }, pb.hurtBox());
      if (hitPlayer) this.hurtPlayer(a.dmg, Math.sign(a.vx) || 1);
      if (a.life <= 0 || hitWall || hitPlayer) {
        if (hitWall) hitSpark(this, a.x, a.y, COLORS.magenta, 3);
        a.spr.destroy();
        this.arrows.splice(i, 1);
      }
    }
  }

  // ── player shots (Salamander flame-wave) ────────────────────────────────────
  private spawnShot(x: number, y: number, vx: number, vy: number, dmg: number) {
    const spr = this.add.sprite(x, y, "fx:flame-wave").setScale(0.7).setDepth(42);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.shots.push({ spr, x, y, vx, vy, life: 1.4, dmg, hit: new Set(), hitBoss: false });
  }

  private stepShots(dt: number) {
    for (let i = this.shots.length - 1; i >= 0; i--) {
      const s = this.shots[i];
      if (!s) continue;
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      s.spr.setPosition(Math.round(s.x), Math.round(s.y));
      for (const e of this.enemies) {
        if (e.body.dead || s.hit.has(e)) continue;
        if (rectsOverlap({ left: s.x - 12, top: s.y - 8, right: s.x + 12, bottom: s.y + 8 }, e.body.hurtBox())) {
          e.body.takeHit(this.dmgOut(s.dmg), 120, Math.sign(s.vx) || 1);
          s.hit.add(e);
          if (!e.body.dead) sfx.hit();
          hitSpark(this, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.magenta, 6);
          if (e.body.dead) this.onKill(e);
        }
      }
      if (this.boss && !this.boss.body.dead && !s.hitBoss && rectsOverlap({ left: s.x - 12, top: s.y - 8, right: s.x + 12, bottom: s.y + 8 }, this.boss.body.hurtBox())) {
        this.hitBoss(this.dmgOut(s.dmg), Math.sign(s.vx) || 1, COLORS.magenta);
        s.hitBoss = true;
      }
      const hitWall = this.grid.solidInRect(s.x - 4, s.y - 4, s.x + 4, s.y + 4);
      if (s.life <= 0 || hitWall) {
        s.spr.destroy();
        this.shots.splice(i, 1);
      }
    }
  }

  // ── lifecycle ───────────────────────────────────────────────────────────────
  private cullEnemies(dt: number) {
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e || !e.body.dead) continue;
      const t = (this.deadTimers.get(e) ?? 0) + dt;
      this.deadTimers.set(e, t);
      if (t > DEATH_LINGER) {
        e.sprite.setAlpha(Math.max(0, 1 - (t - DEATH_LINGER) * 4));
        if (t > DEATH_LINGER + 0.25) {
          e.destroy();
          this.enemies.splice(i, 1);
        }
      }
    }
  }

  private checkClear() {
    if (!this.mustClear || this.cleared) return;
    const enemiesDone = this.enemies.every((e) => e.body.dead);
    const bossDone = this.boss ? this.boss.body.dead && this.bossDeadT > 0.9 : true;
    if (enemiesDone && bossDone) {
      this.cleared = true;
      this.doors.forEach((d) => d.setActive(true));
      this.showBanner(this.boss ? "DESCEND" : "CLEAR — pick a path", 1400);
    }
  }

  private checkDoors() {
    if (!this.cleared || this.state !== "active") return;
    const hb = this.player.body.hurtBox();
    for (const d of this.doors) {
      if (d.active && rectsOverlap(d.triggerRect(), hb)) {
        this.enterDoor(d.index);
        return;
      }
    }
  }

  private enterDoor(index: number) {
    const offer = this.offers[index];
    if (!offer || this.state !== "active") return;
    this.state = "transition";
    this.transT = 0;
    this.transBuilt = false;
    this.pendingOffer = offer;
    sfx.door();
  }

  private showBanner(text: string, ms: number) {
    this.banner.setText(text).setAlpha(1);
    this.tweens.killTweensOf(this.banner);
    this.tweens.add({ targets: this.banner, alpha: 0, delay: ms, duration: 350 });
  }

  private updateHud() {
    const h = Math.max(0, this.hearts);
    this.heartsText.setText("♥ ".repeat(h) + "♡ ".repeat(Math.max(0, this.maxHearts - h)));
    const relics = this.ownedRelics.size > 0 ? `   ✦ ${this.ownedRelics.size}` : "";
    this.infoText.setText(`BIOME ${this.run.biome}   DEPTH ${this.run.depth}   ⬡ ${this.gold}${relics}`);
  }
}
