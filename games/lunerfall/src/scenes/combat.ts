import type { Scene } from "phaser";
import { Math as PhaserMath } from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_W, COLORS } from "../config";
import { biomePalette } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { ENEMIES } from "../data/enemies";
import type { Boss } from "../entities/boss";
import type { Blast } from "../entities/boss-body";
import { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import { rectsOverlap } from "../entities/player-body";
import type { AttackBox, PlayerBody, Rect } from "../entities/player-body";
import { explosion, hitSpark, impactRing, popText } from "../sys/fx";
import { rand } from "../sys/rng";
import { REDUCED_MOTION } from "../sys/screen";
import type { GameScene } from "./game-scene";
import type { Shot } from "./scene-types";

// seconds a kill-streak survives without a new kill
const COMBO_WINDOW = 3;
const DEATH_LINGER = 0.55;
const ARROW_GRAV = 150;
const comboColor = (combo: number): string => {
  if (combo >= 8) {
    return "#ff5a5a";
  }
  if (combo >= 5) {
    return "#ff9a3c";
  }
  return "#ffd15c";
};

type CombatCtx = Scene &
  Pick<
    GameScene,
    | "arrows"
    | "banners"
    | "boss"
    | "bossDeadT"
    | "bossHp"
    | "combo"
    | "comboT"
    | "comboText"
    | "cs"
    | "deadTimers"
    | "enemies"
    | "freeze"
    | "grid"
    | "hazards"
    | "hearts"
    | "lastStand"
    | "livePlayers"
    | "maxHearts"
    | "mods"
    | "player"
    | "playerDie"
    | "progress"
    | "run"
    | "score"
    | "shake"
    | "shots"
    | "state"
    | "trailer"
    | "updateHud"
    | "versus"
  >;

// Host-authoritative combat resolution: the damage pipeline, player offense
// against enemies and the boss, enemy/boss offense against players, and the
// projectiles (arrows, shots, hazards) that carry it.
export class Combat {
  private readonly scene: CombatCtx;
  // set by dmgOut so the hit site can flag a crit
  lastCrit = false;

  constructor(scene: CombatCtx) {
    this.scene = scene;
  }

  // Single outgoing-damage choke point: base × (dmg + rage-per-missing-heart),
  // then a crit roll. Called once per landed hit (host-authoritative).
  private dmgOut(base: number): number {
    const rage = this.scene.mods.rage * Math.max(0, this.scene.maxHearts - this.scene.hearts);
    let out = base * (this.scene.mods.dmg + rage);
    this.lastCrit = this.scene.mods.crit > 0 && rand() < this.scene.mods.crit;
    if (this.lastCrit) {
      out *= this.scene.mods.critMult;
    }
    return Math.max(1, Math.round(out));
  }

  // Gold spark + "CRIT" pop when the most recent dmgOut rolled a critical hit —
  // otherwise crit relics land invisibly. Call right after the takeHit.
  private critFeedback(x: number, y: number) {
    if (!this.lastCrit) {
      return;
    }
    popText(this.scene, x, y - 6, "CRIT", "#ffd15c");
    hitSpark(this.scene, x, y, 0xff_d1_5c, 10);
    this.scene.freeze = Math.max(this.scene.freeze, 0.06);
  }

  // Enemies chase whichever live, non-dead (and non-downed) player is closest.
  nearestPlayer(x: number, y: number): Player {
    let best = this.scene.player;
    let bd = Infinity;
    for (const pl of this.scene.livePlayers()) {
      if (pl.body.dead || pl.body.downed) {
        continue;
      }
      const d = Math.hypot(pl.x - x, pl.y - y);
      if (d < bd) {
        bd = d;
        best = pl;
      }
    }
    return best;
  }

  stepBoss(dt: number) {
    const { boss } = this.scene;
    if (!boss) {
      return;
    }
    const target = this.nearestPlayer(boss.body.x, boss.body.y);
    boss.body.step(dt, target.x, target.y);
    if (this.scene.bossHp) {
      this.scene.bossHp.width = 258 * boss.body.hpFrac;
    }

    if (boss.body.dead) {
      if (this.scene.bossDeadT === 0) {
        this.onBossSlain(boss);
      }
      this.scene.bossDeadT += dt;
      return;
    }

    if (boss.body.pendingWaves.length > 0) {
      for (const w of boss.body.pendingWaves) {
        this.spawnHazard(w.x, w.y, w.vx, w.dmg);
      }
      boss.body.pendingWaves.length = 0;
    }
    if (boss.body.pendingBlast) {
      this.resolveBossBlast(boss.body.pendingBlast, boss.body.kind.tint);
      boss.body.pendingBlast = null;
    }
    if (boss.body.pendingAdds) {
      for (const a of boss.body.pendingAdds) {
        this.scene.enemies.push(
          new Enemy(
            this.scene,
            this.scene.grid,
            ENEMIES[a.name],
            PhaserMath.Clamp(a.x, 24, BASE_W - 24),
            a.y,
          ),
        );
      }
      boss.body.pendingAdds = null;
      this.scene.banners.show("REINFORCEMENTS", 900, "status");
    }
    const atk = boss.body.attackBox();
    for (const pl of this.scene.livePlayers()) {
      const pb = pl.body;
      if (pb.dead) {
        continue;
      }
      if (atk && rectsOverlap(atk, pb.hurtBox())) {
        this.hurtPlayer(atk.dmg, Math.sign(pb.x - boss.body.x) || 1, pl);
      } else if (rectsOverlap(boss.body.hurtBox(), pb.hurtBox())) {
        this.hurtPlayer(1, Math.sign(pb.x - boss.body.x) || 1, pl);
      }
    }
  }

  private onBossSlain(boss: Boss) {
    this.scene.progress.bossDefeatFx(boss.body.x, boss.body.y, this.scene.run.biome);
    sfx.boom("essential");
    this.scene.shake(420, 0.02);
    this.scene.freeze = Math.max(this.scene.freeze, 0.12);
    this.scene.progress.gainGold(25);
    this.scene.score += 120 * this.scene.run.biome;
    popText(this.scene, boss.body.x, boss.body.y - 44, "+25", "#ffd15c");
    this.scene.banners.show(`${boss.body.kind.name} SLAIN`, 1800, "payoff");
  }

  private resolveBossBlast(b: Blast, tint: number) {
    explosion(this.scene, b.x, b.y, b.r, tint);
    sfx.boom();
    this.scene.shake(200, 0.014);
    this.scene.freeze = Math.max(this.scene.freeze, 0.07);
    for (const pl of this.scene.livePlayers()) {
      if (!pl.body.dead && Math.hypot(pl.x - b.x, pl.y - 11 - b.y) < b.r + 8) {
        this.hurtPlayer(b.dmg, Math.sign(pl.x - b.x) || 1, pl);
      }
    }
  }

  private hitBoss(dmg: number, dir: number, color: number) {
    const { boss } = this.scene;
    if (!boss || boss.body.dead) {
      return;
    }
    if (!boss.body.takeHit(dmg, 0, dir)) {
      return;
    }
    sfx.hit();
    hitSpark(this.scene, boss.body.x, boss.body.y - 22, color, boss.body.dead ? 12 : 6);
    if (boss.body.dead) {
      impactRing(this.scene, boss.body.x, boss.body.y - 22, boss.body.kind.tint, 40);
    }
    this.scene.freeze = Math.max(this.scene.freeze, boss.body.dead ? 0.12 : 0.04);
    this.scene.shake(60, 0.003);
  }

  spawnHazard(x: number, y: number, vx: number, dmg: number) {
    // Tint the wave with the boss that threw it: the untinted sheet is magenta
    // flame, which read as "fire" in every arena — Rimewarden's frost barrage
    // included — and vanished against Emberdeep's own red walls.
    const spr = this.scene.add
      .sprite(x, y, "fx:flame-wave")
      .setScale(0.9)
      .setDepth(41)
      .setTint(bossKind(this.scene.run.biome).tint);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.scene.hazards.push({ dmg, hitPlayer: false, life: 2.6, spr, vx, x, y });
  }

  stepHazards(dt: number) {
    for (let i = this.scene.hazards.length - 1; i >= 0; i -= 1) {
      const h = this.scene.hazards[i];
      if (!h) {
        continue;
      }
      h.x += h.vx * dt;
      h.life -= dt;
      h.spr.setPosition(Math.round(h.x), Math.round(h.y));
      const box = { bottom: h.y + 9, left: h.x - 14, right: h.x + 14, top: h.y - 9 };
      for (const pl of this.scene.livePlayers()) {
        if (!h.hitPlayer && !pl.body.dead && rectsOverlap(box, pl.body.hurtBox())) {
          this.hurtPlayer(h.dmg, Math.sign(h.vx) || 1, pl);
          h.hitPlayer = true;
        }
      }
      if (h.life <= 0 || this.scene.grid.solidInRect(h.x - 4, h.y - 4, h.x + 4, h.y + 4)) {
        h.spr.destroy();
        this.scene.hazards.splice(i, 1);
      }
    }
  }

  onSpecialFx(kind: string, pl: Player = this.scene.player) {
    this.showSpecial(kind, pl.x, pl.y, pl.body.facing, pl.color, pl === this.scene.player);
    if (kind === "aoe") {
      this.scene.freeze = Math.max(this.scene.freeze, 0.06);
    }
  }

  showSpecial(
    kind: string,
    px: number,
    feetY: number,
    facing: number,
    color: number,
    local: boolean,
  ) {
    const py = feetY - 11;
    if (kind === "blink") {
      hitSpark(this.scene, px, py, color, 12);
    } else if (kind === "heal") {
      for (let i = 0; i < 8; i += 1) {
        const p = this.scene.add
          .circle(px + (Math.random() - 0.5) * 16, py + 6, 1.5, COLORS.teal, 0.9)
          .setDepth(60);
        this.scene.tweens.add({
          alpha: 0,
          duration: 500 + Math.random() * 200,
          onComplete: () => p.destroy(),
          targets: p,
          y: py - 14,
        });
      }
    } else if (kind === "aoe") {
      explosion(this.scene, px, feetY - 6, 30, color);
      sfx.boom(local ? "local" : "routine");
      if (local) {
        this.scene.shake(140, 0.01);
      }
    } else if (kind === "projectile") {
      hitSpark(this.scene, px + facing * 10, py, color, 5);
    }
  }

  // One player's melee / special / stomp against every enemy + the boss.
  playerOffense(pl: Player) {
    const pb = pl.body;
    // a downed player has no offense (incl. stomps)
    if (pb.downed) {
      return;
    }
    const cs = this.scene.cs(pl);
    const ab = pb.attackBox();
    if (ab) {
      if (pb.swingId !== cs.lastSwing) {
        cs.hitSwing.clear();
        cs.lastSwing = pb.swingId;
      }
      this.playerSwing(pl, ab, cs.hitSwing);
      if (this.bossInBox(ab) && pb.swingId !== cs.bossSwing) {
        cs.bossSwing = pb.swingId;
        this.hitBossFrom(pb, this.dmgOut(ab.dmg), COLORS.teal);
      }
    }

    // player special: AoE box, launched shot, self-heal
    const sb = pb.specialBox();
    if (sb) {
      if (pb.specialId !== cs.lastSpecial) {
        cs.hitSpecial.clear();
        cs.lastSpecial = pb.specialId;
      }
      this.playerSpecial(pl, sb, cs.hitSpecial);
      if (this.bossInBox(sb) && pb.specialId !== cs.bossSpecial) {
        cs.bossSpecial = pb.specialId;
        this.hitBossFrom(pb, this.dmgOut(sb.dmg), pl.color);
      }
    }
    if (pb.pendingShot) {
      const s = pb.pendingShot;
      this.spawnShot(s.x, s.y, s.vx, s.vy, s.dmg, pl);
      pb.pendingShot = null;
    }
    if (pb.pendingHeal > 0) {
      this.scene.progress.heal(pb.pendingHeal, pl);
      popText(this.scene, pb.x, pb.y - 26, "+HP", "#34e5c8");
      pb.pendingHeal = 0;
    }
    if (pb.vy > 20) {
      this.playerStomp(pb);
    }
  }

  private bossInBox(box: Rect): boolean {
    return (
      this.scene.boss !== null &&
      !this.scene.boss.body.dead &&
      rectsOverlap(box, this.scene.boss.body.hurtBox())
    );
  }

  private hitBossFrom(pb: PlayerBody, dmg: number, color: number) {
    if (!this.scene.boss) {
      return;
    }
    this.hitBoss(dmg, Math.sign(this.scene.boss.body.x - pb.x) || pb.facing, color);
  }

  // Melee swing: each enemy takes one hit per swing.
  private playerSwing(pl: Player, ab: AttackBox, hit: Set<Enemy>) {
    const pb = pl.body;
    for (const e of this.scene.enemies) {
      if (e.body.dead || hit.has(e) || !rectsOverlap(ab, e.body.hurtBox())) {
        continue;
      }
      const dir = Math.sign(e.body.x - pb.x) || pb.facing;
      e.body.takeHit(this.dmgOut(ab.dmg), ab.kb, dir);
      this.critFeedback(e.body.x, e.body.y - e.body.kind.h / 2);
      hit.add(e);
      if (!e.body.dead) {
        sfx.hit();
      }
      hitSpark(
        this.scene,
        e.body.x,
        e.body.y - e.body.kind.h / 2,
        COLORS.teal,
        e.body.dead ? 10 : 6,
      );
      this.scene.freeze = Math.max(this.scene.freeze, e.body.dead ? 0.09 : 0.05);
      this.scene.shake(70, e.body.dead ? 0.006 : 0.003);
      if (e.body.dead) {
        this.onKill(e);
      }
    }
  }

  // Special AoE: each enemy takes one hit per activation.
  private playerSpecial(pl: Player, sb: AttackBox, hit: Set<Enemy>) {
    const pb = pl.body;
    for (const e of this.scene.enemies) {
      if (e.body.dead || hit.has(e) || !rectsOverlap(sb, e.body.hurtBox())) {
        continue;
      }
      e.body.takeHit(this.dmgOut(sb.dmg), sb.kb, Math.sign(e.body.x - pb.x) || pb.facing);
      this.critFeedback(e.body.x, e.body.y - e.body.kind.h / 2);
      hit.add(e);
      if (!e.body.dead) {
        sfx.hit();
      }
      hitSpark(this.scene, e.body.x, e.body.y - e.body.kind.h / 2, pl.color, 8);
      this.scene.freeze = Math.max(this.scene.freeze, 0.06);
      if (e.body.dead) {
        this.onKill(e);
      }
    }
  }

  // Falling onto a head: bounce off, small damage.
  private playerStomp(pb: PlayerBody) {
    for (const e of this.scene.enemies) {
      if (e.body.dead) {
        continue;
      }
      const top = e.body.y - e.body.kind.h;
      if (pb.y <= top + 8 && pb.y >= top - 12 && Math.abs(pb.x - e.body.x) < e.body.kind.hw + 6) {
        e.body.takeHit(this.dmgOut(2), 60, Math.sign(pb.vx) || 1);
        this.critFeedback(e.body.x, top);
        pb.bounce();
        sfx.hit();
        hitSpark(this.scene, e.body.x, top, COLORS.white, 8);
        this.scene.freeze = Math.max(this.scene.freeze, 0.08);
        this.scene.shake(80, 0.006);
        if (e.body.dead) {
          this.onKill(e);
        }
      }
    }
    if (this.scene.boss && !this.scene.boss.body.dead) {
      const { top } = this.scene.boss.body.hurtBox();
      if (pb.y <= top + 10 && pb.y >= top - 16 && Math.abs(pb.x - this.scene.boss.body.x) < 22) {
        this.hitBoss(1, Math.sign(pb.vx) || 1, COLORS.white);
        pb.bounce();
        this.scene.freeze = Math.max(this.scene.freeze, 0.06);
      }
    }
  }

  // Enemy attacks / contact / blasts against every live player. Enemy intents
  // (projectile spawn, blast) fire once regardless of player count.
  enemyOffense() {
    for (const e of this.scene.enemies) {
      const eb = e.body;
      if (!eb.dead) {
        const atk = eb.attackBox();
        for (const pl of this.scene.livePlayers()) {
          const pb = pl.body;
          if (pb.dead) {
            continue;
          }
          if (atk && rectsOverlap(atk, pb.hurtBox())) {
            this.hurtPlayer(atk.dmg, Math.sign(pb.x - eb.x) || 1, pl);
          } else if (eb.contactDamage() > 0 && rectsOverlap(eb.hurtBox(), pb.hurtBox())) {
            this.hurtPlayer(eb.contactDamage(), Math.sign(pb.x - eb.x) || 1, pl);
          }
        }
      }
      if (eb.pendingProjectile) {
        this.spawnArrow(
          eb.pendingProjectile.x,
          eb.pendingProjectile.y,
          eb.pendingProjectile.vx,
          eb.pendingProjectile.vy,
          eb.kind.attackDmg ?? 1,
        );
        eb.pendingProjectile = null;
      }
      if (eb.pendingBlast) {
        const b = eb.pendingBlast;
        explosion(this.scene, b.x, b.y, b.r, biomePalette(this.scene.run.biome).oneway);
        sfx.boom();
        this.scene.shake(160, 0.01);
        this.scene.freeze = Math.max(this.scene.freeze, 0.06);
        for (const pl of this.scene.livePlayers()) {
          if (!pl.body.dead && Math.hypot(pl.x - b.x, pl.y - eb.kind.h / 2 - b.y) < b.r + 8) {
            this.hurtPlayer(b.dmg, Math.sign(pl.x - b.x) || 1, pl);
          }
        }
        eb.pendingBlast = null;
      }
    }
  }

  private onKill(e: Enemy) {
    this.scene.progress.gainGold(2);
    this.registerKill(e.body.x, e.body.y - e.body.kind.h, 5 + this.scene.run.biome * 2);
    impactRing(this.scene, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.teal, 22);
    sfx.kill();
    if (this.scene.mods.lifesteal > 0 && rand() < this.scene.mods.lifesteal) {
      this.scene.progress.heal(1);
    }
    popText(this.scene, e.body.x, e.body.y - e.body.kind.h, "+2", "#ffd15c");
  }

  // Score a kill and extend the combo. Score per kill scales with the streak, so
  // chaining kills within COMBO_WINDOW is worth far more than picking them off.
  private registerKill(x: number, y: number, base: number) {
    this.scene.combo += 1;
    this.scene.comboT = COMBO_WINDOW;
    this.scene.score += base * this.scene.combo;
    if (this.scene.combo >= 2) {
      popText(this.scene, x, y - 8, `x${this.scene.combo}`, "#ffd15c");
      const col = comboColor(this.scene.combo);
      this.scene.comboText.setText(`COMBO x${this.scene.combo}`).setColor(col).setAlpha(1);
      this.scene.tweens.killTweensOf(this.scene.comboText);
      // Pop RELATIVE to whatever scale the counter is pinned at: under a trailer
      // zoom the HUD is counter-scaled to 1/z, and an absolute "back to 1" here
      // would leave the streak counter rendering at z× everything else.
      const pin = this.scene.trailer.pinScale;
      this.scene.comboText.setScale(REDUCED_MOTION.matches ? pin : 1.35 * pin);
      if (!REDUCED_MOTION.matches) {
        this.scene.tweens.add({
          duration: 200,
          ease: "Back.easeOut",
          scale: pin,
          targets: this.scene.comboText,
        });
      }
    }
    this.scene.updateHud();
  }

  breakCombo() {
    this.scene.combo = 0;
    this.scene.tweens.add({ alpha: 0, duration: 320, targets: this.scene.comboText });
  }

  // Damage lands on a specific player's body; hearts are a shared co-op pool.
  private hurtPlayer(dmg: number, dir: number, pl: Player = this.scene.player) {
    if (this.scene.state === "dead" || !pl.body.applyHurt(dir)) {
      return;
    }
    if (this.scene.mods.armor > 0 && rand() < this.scene.mods.armor) {
      popText(this.scene, pl.x, pl.y - 24, "WARD", "#9b8cff");
      // fully blocked (i-frames already granted by applyHurt)
      return;
    }
    this.scene.hearts -= dmg;
    this.scene.freeze = Math.max(this.scene.freeze, 0.06);
    hitSpark(this.scene, pl.x, pl.y - 11, COLORS.magenta, 8);
    this.scene.updateHud();
    if (this.scene.hearts <= 0) {
      // Co-op last stand: a fatal hit with both players up downs the victim
      // instead of wiping; the partner gets a bleed-out window to revive them.
      if (this.scene.lastStand.can()) {
        this.scene.lastStand.enter(pl);
      } else {
        this.scene.playerDie();
      }
    }
  }

  spawnArrow(x: number, y: number, vx: number, vy: number, dmg: number) {
    const spr = this.scene.add.sprite(x, y, "fx:arrow").setScale(0.3).setDepth(40);
    spr.setFlipX(vx < 0);
    this.scene.arrows.push({ dmg, life: 3, spr, vx, vy, x, y });
  }

  stepArrows(dt: number) {
    for (let i = this.scene.arrows.length - 1; i >= 0; i -= 1) {
      const a = this.scene.arrows[i];
      if (!a) {
        continue;
      }
      a.vy += ARROW_GRAV * dt;
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.life -= dt;
      a.spr.setPosition(Math.round(a.x), Math.round(a.y));
      a.spr.setRotation(Math.atan2(a.vy, a.vx) + (a.vx < 0 ? Math.PI : 0));
      const hitWall = this.scene.grid.solidInRect(a.x - 2, a.y - 2, a.x + 2, a.y + 2);
      const box = { bottom: a.y + 3, left: a.x - 3, right: a.x + 3, top: a.y - 3 };
      let hitPlayer = false;
      for (const pl of this.scene.livePlayers()) {
        if (!pl.body.dead && rectsOverlap(box, pl.body.hurtBox())) {
          this.hurtPlayer(a.dmg, Math.sign(a.vx) || 1, pl);
          hitPlayer = true;
        }
      }
      if (a.life <= 0 || hitWall || hitPlayer) {
        if (hitWall) {
          hitSpark(this.scene, a.x, a.y, COLORS.magenta, 3);
        }
        a.spr.destroy();
        this.scene.arrows.splice(i, 1);
      }
    }
  }

  spawnShot(x: number, y: number, vx: number, vy: number, dmg: number, owner: Player | null) {
    const spr = this.scene.add.sprite(x, y, "fx:flame-wave").setScale(0.7).setDepth(42);
    spr.play("fx:flame-wave");
    spr.setFlipX(vx < 0);
    this.scene.shots.push({
      dmg,
      hit: new Set(),
      hitBoss: false,
      hitP: new Set(),
      life: 1.4,
      owner,
      spr,
      vx,
      vy,
      x,
      y,
    });
  }

  stepShots(dt: number) {
    for (let i = this.scene.shots.length - 1; i >= 0; i -= 1) {
      const s = this.scene.shots[i];
      if (!s) {
        continue;
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.life -= dt;
      s.spr.setPosition(Math.round(s.x), Math.round(s.y));
      const box: Rect = { bottom: s.y + 8, left: s.x - 12, right: s.x + 12, top: s.y - 8 };
      this.shotHitsEnemies(s, box);
      if (this.bossInBox(box) && !s.hitBoss) {
        this.hitBoss(this.dmgOut(s.dmg), Math.sign(s.vx) || 1, COLORS.magenta);
        s.hitBoss = true;
      }
      // Versus: the wave also burns the other duelist (never its own caster).
      if (this.scene.versus.match?.phase === "fighting") {
        this.shotHitsDuelist(s, box);
      }
      const hitWall = this.scene.grid.solidInRect(s.x - 4, s.y - 4, s.x + 4, s.y + 4);
      if (s.life <= 0 || hitWall) {
        s.spr.destroy();
        this.scene.shots.splice(i, 1);
      }
    }
  }

  private shotHitsEnemies(s: Shot, box: Rect) {
    for (const e of this.scene.enemies) {
      if (e.body.dead || s.hit.has(e) || !rectsOverlap(box, e.body.hurtBox())) {
        continue;
      }
      e.body.takeHit(this.dmgOut(s.dmg), 120, Math.sign(s.vx) || 1);
      this.critFeedback(e.body.x, e.body.y - e.body.kind.h / 2);
      s.hit.add(e);
      if (!e.body.dead) {
        sfx.hit();
      }
      hitSpark(this.scene, e.body.x, e.body.y - e.body.kind.h / 2, COLORS.magenta, 6);
      if (e.body.dead) {
        this.onKill(e);
      }
    }
  }

  private shotHitsDuelist(s: Shot, box: Rect) {
    for (const pl of this.scene.livePlayers()) {
      if (pl === s.owner || pl.body.dead || s.hitP.has(pl)) {
        continue;
      }
      if (rectsOverlap(box, pl.body.hurtBox())) {
        s.hitP.add(pl);
        this.scene.versus.hurt(pl, s.dmg, Math.sign(s.vx) || 1);
      }
    }
  }

  cullEnemies(dt: number) {
    for (let i = this.scene.enemies.length - 1; i >= 0; i -= 1) {
      const e = this.scene.enemies[i];
      if (!e || !e.body.dead) {
        continue;
      }
      const t = (this.scene.deadTimers.get(e) ?? 0) + dt;
      this.scene.deadTimers.set(e, t);
      if (t > DEATH_LINGER) {
        e.sprite.setAlpha(Math.max(0, 1 - (t - DEATH_LINGER) * 4));
        if (t > DEATH_LINGER + 0.25) {
          e.destroy();
          this.scene.enemies.splice(i, 1);
        }
      }
    }
  }
}
