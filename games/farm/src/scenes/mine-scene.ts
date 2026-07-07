import Phaser from "phaser";
import {
  TILE,
  ZOOM,
  WALK_SPEED,
  RUN_SPEED,
  CHAR_ORIGIN_Y,
  ENERGY_PER_SWING,
  FAINT_GOLD_LOSS_FRAC,
  SWORD_BASE_DAMAGE,
  PLAYER_INVULN_MS,
  DEPTH,
} from "../config";
import { store } from "../systems/store";
import { patchSave } from "../systems/save";
import { makeGameKeys, NUM_KEY_NAMES, type MineKeys } from "../systems/keys";
import type { OreId } from "../data/items";
import { burst, floatText, shake } from "../render/fx";
import { Sound } from "../render/audio";

const MW = 32;
const MH = 24;

declare global {
  interface Window {
    /** DEV-only hook for headless verification. */
    __mine?: MineScene;
  }
}

// generate() lays out plain seeds; buildTiles() turns them into full Nodes
// (sprite included), so a Node's sprite is never observably missing.
type NodeSeed = {
  tx: number;
  ty: number;
  hp: number;
  kind: "stone" | OreId;
};
type Node = NodeSeed & { spr: Phaser.GameObjects.Sprite };
type Enemy = {
  spr: Phaser.GameObjects.Sprite;
  hp: number;
  maxHp: number;
  invuln: number;
  hurt: number;
  dead: boolean;
  kx: number;
  ky: number; // knockback velocity
};

export class MineScene extends Phaser.Scene {
  depth = 1;
  private walls = new Uint8Array(MW * MH);
  private player!: Phaser.GameObjects.Sprite;
  private shadow!: Phaser.GameObjects.Sprite;
  private facing = { x: 0, y: 1 };
  private acting = false;
  private invulnUntil = 0;
  private knock = { x: 0, y: 0 };

  private nodes: Node[] = [];
  private enemies: Enemy[] = [];
  private ladderDown = { tx: 0, ty: 0 };
  private ladderUp = { tx: 0, ty: 0 };
  private keys!: MineKeys;
  private transitioning = false;
  private stepTimer = 0;

  constructor() {
    super("Mine");
  }

  create(data: { depth?: number }): void {
    this.depth = data?.depth ?? 1;
    // reset reused-instance state (scene.restart keeps the instance)
    this.nodes = [];
    this.enemies = [];
    this.transitioning = false;
    this.invulnUntil = 0;
    this.knock = { x: 0, y: 0 };
    this.acting = false;
    this.facing = { x: 0, y: 1 };
    this.cameras.main.setBackgroundColor("#0a0c12");
    this.buildTiles(this.generate());

    this.shadow = this.add
      .sprite(0, 0, "char-shadow-tex")
      .setOrigin(0.5, 0.5)
      .setScale(1.1, 1)
      .setAlpha(0.4)
      .setDepth(DEPTH.entityBase);
    this.player = this.add
      .sprite(this.ladderUp.tx * TILE + 8, (this.ladderUp.ty + 1) * TILE + 8, "p-idle")
      .setOrigin(0.5, CHAR_ORIGIN_Y)
      .play("p-idle");

    const cam = this.cameras.main;
    cam.setBounds(0, 0, MW * TILE, MH * TILE);
    cam.setZoom(ZOOM);
    cam.startFollow(this.player, true, 0.14, 0.14);
    cam.setRoundPixels(true);
    cam.fadeIn(400, 0, 0, 0);

    this.setupInput();
    Sound.startMusic("mine");
    if (!this.scene.isActive("MineHud")) this.scene.launch("MineHud");

    floatText(this, this.player.x, this.player.y - 24, `Mine — Floor ${this.depth}`, "#cdd6e0");
    if (import.meta.env.DEV) window.__mine = this;
  }

  // ---------------------------------------------------------------- generation

  private idx(tx: number, ty: number): number {
    return ty * MW + tx;
  }
  private isWall(tx: number, ty: number): boolean {
    if (tx < 0 || ty < 0 || tx >= MW || ty >= MH) return true;
    return this.walls[this.idx(tx, ty)] === 1;
  }

  private generate(): NodeSeed[] {
    const rng = Phaser.Math.RND;
    this.walls.fill(0);
    for (let tx = 0; tx < MW; tx++) {
      for (let ty = 0; ty < MH; ty++) {
        if (tx === 0 || ty === 0 || tx === MW - 1 || ty === MH - 1)
          this.walls[this.idx(tx, ty)] = 1;
      }
    }
    // interior wall blobs (sparse, keep it open & connected)
    const blobs = 7 + this.depth;
    for (let b = 0; b < blobs; b++) {
      const cx = rng.between(3, MW - 4),
        cy = rng.between(3, MH - 4),
        r = rng.between(1, 2);
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++) {
          if (Math.abs(dx) + Math.abs(dy) <= r && rng.frac() < 0.7) {
            const tx = cx + dx,
              ty = cy + dy;
            if (tx > 1 && ty > 1 && tx < MW - 2 && ty < MH - 2) this.walls[this.idx(tx, ty)] = 1;
          }
        }
    }

    this.ladderUp = { tx: (MW / 2) | 0, ty: 2 };
    this.clearAround(this.ladderUp.tx, this.ladderUp.ty);
    // ladder down: a far open tile
    for (let tries = 0; tries < 200; tries++) {
      const tx = rng.between(3, MW - 4),
        ty = rng.between(MH - 8, MH - 3);
      if (!this.isWall(tx, ty)) {
        this.ladderDown = { tx, ty };
        this.clearAround(tx, ty);
        break;
      }
    }

    // ore nodes — deeper floors yield richer ore
    const seeds: NodeSeed[] = [];
    const nodeCount = 10 + this.depth * 2;
    for (let n = 0; n < nodeCount; n++) {
      const tx = rng.between(2, MW - 3),
        ty = rng.between(2, MH - 3);
      if (this.isWall(tx, ty) || seeds.some((s) => s.tx === tx && s.ty === ty)) continue;
      if (Math.abs(tx - this.ladderUp.tx) + Math.abs(ty - this.ladderUp.ty) < 3) continue;
      const roll = rng.frac() + this.depth * 0.03;
      let kind: "stone" | OreId = "stone";
      if (roll > 0.92) kind = "crystal";
      else if (roll > 0.75) kind = "copper";
      else if (roll > 0.55) kind = "coal";
      seeds.push({ tx, ty, hp: kind === "stone" ? 3 : 4, kind });
    }

    // enemies — more & tougher deeper
    const enemyCount = 2 + Math.floor(this.depth * 1.3);
    for (let e = 0; e < enemyCount; e++) {
      const tx = rng.between(2, MW - 3),
        ty = rng.between(4, MH - 3);
      if (this.isWall(tx, ty)) continue;
      if (Math.abs(tx - this.ladderUp.tx) + Math.abs(ty - this.ladderUp.ty) < 5) continue;
      const maxHp = 4 + this.depth * 2;
      const spr = this.add
        .sprite(tx * TILE + 8, ty * TILE + 8, "e-skel-idle")
        .setOrigin(0.5, CHAR_ORIGIN_Y)
        .play("e-skel-idle");
      this.enemies.push({ spr, hp: maxHp, maxHp, invuln: 0, hurt: 0, dead: false, kx: 0, ky: 0 });
    }
    return seeds;
  }

  private clearAround(tx: number, ty: number): void {
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) {
        const x = tx + dx,
          y = ty + dy;
        if (x > 0 && y > 0 && x < MW - 1 && y < MH - 1) this.walls[this.idx(x, y)] = 0;
      }
  }

  private nodeAt(tx: number, ty: number): Node | undefined {
    return this.nodes.find((n) => n.tx === tx && n.ty === ty && n.hp > 0);
  }

  // ---------------------------------------------------------------- render

  private buildTiles(seeds: NodeSeed[]): void {
    this.add
      .tileSprite(0, 0, MW * TILE, MH * TILE, "t-cavefloor")
      .setOrigin(0, 0)
      .setDepth(DEPTH.ground);
    const wallLayer = this.add.container(0, 0).setDepth(DEPTH.entityBase);
    for (let ty = 0; ty < MH; ty++)
      for (let tx = 0; tx < MW; tx++)
        if (this.walls[this.idx(tx, ty)]) {
          const img = this.add.image(tx * TILE, ty * TILE, "t-cavewall").setOrigin(0, 0);
          img.setDepth(DEPTH.entityBase + (ty + 1) * TILE);
          wallLayer.add(img);
        }
    // ladders
    this.add
      .image(this.ladderUp.tx * TILE + 8, this.ladderUp.ty * TILE + 8, "obj-ladder")
      .setDepth(DEPTH.soil)
      .setTint(0x9fd8ff);
    this.add
      .image(this.ladderDown.tx * TILE + 8, this.ladderDown.ty * TILE + 8, "obj-ladder")
      .setDepth(DEPTH.soil);
    this.add
      .text(this.ladderUp.tx * TILE + 8, this.ladderUp.ty * TILE - 6, "EXIT", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "7px",
        color: "#9fd8ff",
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.crop);
    this.add
      .text(this.ladderDown.tx * TILE + 8, this.ladderDown.ty * TILE - 6, "DOWN", {
        fontFamily: "ui-monospace, monospace",
        fontSize: "7px",
        color: "#ffe27a",
      })
      .setOrigin(0.5, 1)
      .setDepth(DEPTH.crop);
    // node sprites
    for (const seed of seeds) {
      const key = seed.kind === "stone" ? "obj-rock" : `obj-ore-${seed.kind}`;
      const spr = this.add
        .sprite(seed.tx * TILE + 8, (seed.ty + 1) * TILE + 1, key)
        .setOrigin(0.5, 1);
      spr.setDepth(DEPTH.entityBase + (seed.ty + 1) * TILE);
      this.nodes.push({ ...seed, spr });
    }
    for (const e of this.enemies) e.spr.setDepth(DEPTH.entityBase + e.spr.y);
  }

  // ---------------------------------------------------------------- input

  private setupInput(): void {
    const kb = this.input.keyboard;
    if (!kb) return;
    // scene instances + Key objects persist across restart (descend restarts
    // this scene every floor) — clear stale listeners or they double-fire
    this.input.removeAllListeners();
    kb.removeAllListeners();
    kb.on("keydown", () => Sound.resume());
    this.keys = makeGameKeys(kb);
    for (const k of Object.values(this.keys)) k.removeAllListeners();
    NUM_KEY_NAMES.forEach((name, i) => this.keys[name].on("down", () => store.inv.select(i)));
    this.keys.SPACE.on("down", () => this.tryAction());
    this.keys.E.on("down", () => this.tryAction());
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (p.button === 0) this.tryAction();
    });
  }

  // ---------------------------------------------------------------- update

  override update(_t: number, dms: number): void {
    const dt = Math.min(dms, 50) / 1000;
    if (!this.transitioning) {
      this.handleMovement(dt);
      this.updateEnemies(dt);
      this.checkLadders();
    }
    this.player.setDepth(DEPTH.entityBase + this.player.y);
    this.shadow.setPosition(this.player.x, this.player.y + 1).setVisible(this.player.visible);
  }

  private handleMovement(dt: number): void {
    // apply knockback decay
    if (Math.abs(this.knock.x) > 1 || Math.abs(this.knock.y) > 1) {
      this.moveBy(this.knock.x * dt, this.knock.y * dt);
      this.knock.x *= 0.86;
      this.knock.y *= 0.86;
    }
    if (this.acting) return;
    const k = this.keys;
    let dx = 0,
      dy = 0;
    if (k.A.isDown || k.LEFT.isDown) dx -= 1;
    if (k.D.isDown || k.RIGHT.isDown) dx += 1;
    if (k.W.isDown || k.UP.isDown) dy -= 1;
    if (k.S.isDown || k.DOWN.isDown) dy += 1;
    if (dx !== 0 || dy !== 0) {
      if (dx !== 0) this.facing = { x: Math.sign(dx), y: 0 };
      else this.facing = { x: 0, y: Math.sign(dy) };
      const run = k.SHIFT.isDown && store.energy > 0;
      const speed = run ? RUN_SPEED : WALK_SPEED;
      const len = Math.hypot(dx, dy) || 1;
      this.moveBy((dx / len) * speed * dt, (dy / len) * speed * dt);
      this.stepTimer -= dt;
      if (this.stepTimer <= 0) {
        Sound.footstep();
        this.stepTimer = 0.3;
      }
      if (this.player.anims.currentAnim?.key !== "p-walk") this.player.play("p-walk", true);
      if (dx < 0) this.player.setFlipX(true);
      else if (dx > 0) this.player.setFlipX(false);
    } else if (this.player.anims.currentAnim?.key !== "p-idle") {
      this.player.play("p-idle", true);
    }
  }

  private moveBy(mx: number, my: number): void {
    const hw = 4,
      hh = 3;
    const solid = (x: number, y: number) => {
      const tx = Math.floor(x / TILE),
        ty = Math.floor(y / TILE);
      if (this.isWall(tx, ty)) return true;
      return this.nodeAt(tx, ty) !== undefined;
    };
    const hit = (px: number, py: number) =>
      solid(px - hw, py - hh) ||
      solid(px + hw, py - hh) ||
      solid(px - hw, py + hh) ||
      solid(px + hw, py + hh);
    const nx = this.player.x + mx;
    if (!hit(nx, this.player.y)) this.player.x = nx;
    const ny = this.player.y + my;
    if (!hit(this.player.x, ny)) this.player.y = ny;
  }

  private feetTile(): { tx: number; ty: number } {
    return { tx: Math.floor(this.player.x / TILE), ty: Math.floor((this.player.y - 1) / TILE) };
  }

  private tryAction(): void {
    if (this.acting || this.transitioning) return;
    const item = store.inv.selectedItem();
    const f = this.feetTile();
    const target = { tx: f.tx + this.facing.x, ty: f.ty + this.facing.y };
    if (item?.kind === "tool" && item.tool === "sword") {
      this.swing();
      return;
    }
    if (item?.kind === "tool" && item.tool === "pickaxe") {
      const node = this.nodeAt(target.tx, target.ty) ?? this.nodeAt(f.tx, f.ty);
      if (node) {
        this.mineNode(node);
        return;
      }
    }
    // default: a small sword-less swing still lets you hit adjacent enemies
    this.swing();
  }

  private swing(): void {
    if (store.energy <= 0) {
      floatText(this, this.player.x, this.player.y - 20, "Too tired", "#c8b6ff");
      return;
    }
    this.acting = true;
    store.spendEnergy(ENERGY_PER_SWING);
    // brief i-frames while committing to a swing, so trading blows isn't pure punishment
    this.invulnUntil = Math.max(this.invulnUntil, this.time.now + 350);
    this.player.play("p-attack", true);
    Sound.chop();
    this.time.delayedCall(180, () => {
      const hx = this.player.x + this.facing.x * 16;
      const hy = this.player.y - 6 + this.facing.y * 14;
      const reach = 18;
      const dmg = store.skills.swordDamage(SWORD_BASE_DAMAGE);
      let hitAny = false;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (Math.abs(e.spr.x - hx) < reach && Math.abs(e.spr.y - hy) < reach) {
          this.hitEnemy(e, dmg);
          hitAny = true;
        }
      }
      if (hitAny) {
        shake(this, 0.006, 90);
        this.cameras.main.zoomTo(ZOOM * 1.015, 60, "Linear", false);
        this.time.delayedCall(70, () => this.cameras.main.setZoom(ZOOM));
      }
    });
    this.player.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.acting = false;
      this.player.play("p-idle", true);
    });
  }

  private hitEnemy(e: Enemy, dmg: number): void {
    e.hp -= dmg;
    e.hurt = 0.18;
    e.spr.setTint(0xffffff).setTintMode(Phaser.TintModes.FILL);
    Sound.mine();
    const kb = 140;
    e.kx = this.facing.x * kb + (this.facing.x === 0 ? 0 : 0);
    e.ky = this.facing.y * kb;
    if (this.facing.x === 0 && this.facing.y === 0) e.ky = -kb;
    burst(this, e.spr.x, e.spr.y - 14, { colors: [0xffffff, 0xffd34d], count: 6, speed: 60 });
    floatText(this, e.spr.x, e.spr.y - 18, `${dmg}`, "#ffd0d0");
    if (e.hp <= 0) this.killEnemy(e);
  }

  private killEnemy(e: Enemy): void {
    e.dead = true;
    e.spr.clearTint();
    e.spr.play("e-skel-death");
    Sound.thud();
    this.awardCombatLoot(e.spr.x, e.spr.y);
    this.tweens.add({
      targets: e.spr,
      alpha: 0,
      delay: 500,
      duration: 300,
      onComplete: () => e.spr.destroy(),
    });
  }

  private awardCombatLoot(x: number, y: number): void {
    const xp = 14 + this.depth * 2;
    this.awardCombat(xp);
    const coins = 5 + Phaser.Math.Between(0, this.depth * 4);
    store.gold += coins;
    floatText(this, x, y - 22, `+${coins}g`, "#ffe27a");
    if (Math.random() < 0.5) store.inv.add({ kind: "resource", res: "stone" }, 1);
    if (Math.random() < 0.25) store.inv.add({ kind: "resource", res: "coal" }, 1);
    if (Math.random() < 0.08 + this.depth * 0.01)
      store.inv.add({ kind: "resource", res: "crystal" }, 1);
    this.persist();
  }

  private awardCombat(xp: number): void {
    const lv = store.skills.addXP("combat", xp);
    if (lv !== null) {
      floatText(this, this.player.x, this.player.y - 26, `Combat Lv.${lv}!`, "#ffe27a");
      Sound.wake();
    }
  }

  private mineNode(node: Node): void {
    if (store.energy <= 0) {
      floatText(this, this.player.x, this.player.y - 20, "Too tired", "#c8b6ff");
      return;
    }
    this.acting = true;
    store.spendEnergy(ENERGY_PER_SWING);
    this.player.play("p-mine", true);
    Sound.mine();
    this.time.delayedCall(440, () => {
      node.hp -= 1;
      burst(this, node.spr.x, node.spr.y - 8, {
        colors: [0xbfcad6, 0x8a98a8, 0xffffff],
        count: 7,
        speed: 55,
      });
      shake(this, 0.004, 90);
      const lv = store.skills.addXP("mining", 3);
      if (lv !== null)
        floatText(this, this.player.x, this.player.y - 26, `Mining Lv.${lv}!`, "#ffe27a");
      if (node.hp <= 0) {
        Sound.thud();
        this.dropNode(node);
        node.spr.destroy();
      } else {
        this.tweens.add({ targets: node.spr, scaleX: 1.12, scaleY: 0.9, duration: 60, yoyo: true });
      }
    });
    this.player.once(Phaser.Animations.Events.ANIMATION_COMPLETE, () => {
      this.acting = false;
      this.player.play("p-idle", true);
    });
  }

  private dropNode(node: Node): void {
    const bonus = Math.random() < store.skills.oreBonusChance() ? 1 : 0;
    if (node.kind === "stone") {
      store.inv.add({ kind: "resource", res: "stone" }, 1 + bonus);
      floatText(this, node.spr.x, node.spr.y - 12, `+${1 + bonus} Stone`, "#cdd6e0");
    } else {
      store.inv.add({ kind: "resource", res: node.kind }, 1 + bonus);
      const name = node.kind === "coal" ? "Coal" : node.kind === "copper" ? "Copper" : "Crystal";
      store.skills.addXP("mining", 4);
      floatText(
        this,
        node.spr.x,
        node.spr.y - 12,
        `+${1 + bonus} ${name}`,
        node.kind === "crystal" ? "#9fe0ff" : "#ffce8a",
      );
    }
    this.awardCombat(0);
    this.persist();
  }

  // ---------------------------------------------------------------- enemies

  private updateEnemies(dt: number): void {
    const now = this.time.now;
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (e.hurt > 0) {
        e.hurt -= dt;
        if (e.hurt <= 0) e.spr.clearTint();
      }
      // knockback
      if (Math.abs(e.kx) > 2 || Math.abs(e.ky) > 2) {
        this.moveEnemy(e, e.kx * dt, e.ky * dt);
        e.kx *= 0.85;
        e.ky *= 0.85;
      } else {
        const dx = this.player.x - e.spr.x,
          dy = this.player.y - e.spr.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 110 && dist > 12) {
          const sp = (28 + this.depth * 2) * dt;
          this.moveEnemy(e, (dx / dist) * sp, (dy / dist) * sp);
          e.spr.setFlipX(dx < 0);
          if (e.spr.anims.currentAnim?.key !== "e-skel-walk") e.spr.play("e-skel-walk", true);
        } else if (e.spr.anims.currentAnim?.key !== "e-skel-idle" && e.hurt <= 0) {
          e.spr.play("e-skel-idle", true);
        }
        // contact damage
        if (dist < 13 && now > this.invulnUntil) this.damagePlayer(8 + this.depth, dx, dy);
      }
      e.spr.setDepth(DEPTH.entityBase + e.spr.y);
    }
  }

  private moveEnemy(e: Enemy, mx: number, my: number): void {
    const solid = (x: number, y: number) => {
      const tx = Math.floor(x / TILE),
        ty = Math.floor(y / TILE);
      return this.isWall(tx, ty) || this.nodeAt(tx, ty) !== undefined;
    };
    if (!solid(e.spr.x + mx, e.spr.y)) e.spr.x += mx;
    if (!solid(e.spr.x, e.spr.y + my)) e.spr.y += my;
  }

  private damagePlayer(dmg: number, fromDx: number, fromDy: number): void {
    store.damage(dmg);
    this.invulnUntil = this.time.now + PLAYER_INVULN_MS;
    Sound.thud();
    shake(this, 0.008, 160);
    floatText(this, this.player.x, this.player.y - 22, `-${dmg}`, "#ff6b6b");
    const d = Math.hypot(fromDx, fromDy) || 1;
    this.knock = { x: (-fromDx / d) * 180, y: (-fromDy / d) * 180 };
    // flash
    this.player.setTint(0xff4444).setTintMode(Phaser.TintModes.FILL);
    this.tweens.add({
      targets: this.player,
      alpha: 0.4,
      duration: 80,
      yoyo: true,
      repeat: 3,
      onComplete: () => this.player.setAlpha(1),
    });
    this.time.delayedCall(260, () => this.player.clearTint());
    this.persist();
    if (store.hp <= 0) this.faint();
  }

  // ---------------------------------------------------------------- ladders / exit

  private checkLadders(): void {
    const f = this.feetTile();
    if (
      f.tx === this.ladderUp.tx &&
      f.ty === this.ladderUp.ty &&
      (this.keys.SPACE.isDown || this.keys.E.isDown)
    ) {
      this.exitToFarm();
    } else if (
      f.tx === this.ladderDown.tx &&
      f.ty === this.ladderDown.ty &&
      (this.keys.SPACE.isDown || this.keys.E.isDown)
    ) {
      this.descend();
    }
  }

  private descend(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.persist();
    this.cameras.main.fadeOut(350, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.restart({ depth: this.depth + 1 });
    });
  }

  private exitToFarm(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    this.persist();
    this.scene.stop("MineHud");
    this.cameras.main.fadeOut(450, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("Game", { fromMine: true });
    });
  }

  private faint(): void {
    if (this.transitioning) return;
    this.transitioning = true;
    const lost = Math.floor(store.gold * FAINT_GOLD_LOSS_FRAC);
    store.gold = Math.max(0, store.gold - lost);
    store.hp = Math.max(1, Math.floor(store.maxHp() * 0.5));
    store.energy = Math.floor(store.energy * 0.5);
    this.player.play("p-death", true);
    floatText(this, this.player.x, this.player.y - 26, `Fainted! Lost ${lost}g`, "#ff8a8a");
    this.persist();
    this.scene.stop("MineHud");
    this.cameras.main.fadeOut(900, 0, 0, 0);
    this.cameras.main.once(Phaser.Cameras.Scene2D.Events.FADE_OUT_COMPLETE, () => {
      this.scene.start("Game", { fromMine: true, fainted: true });
    });
  }

  private persist(): void {
    patchSave({
      inv: store.inv.toJSON(),
      skills: store.skills.toJSON(),
      gold: store.gold,
      hp: store.hp,
      energy: store.energy,
    });
  }
}
