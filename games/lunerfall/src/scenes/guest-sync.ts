import type Phaser from "phaser";
import type { Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { BASE_W, COLORS, MAX_STEPS, STEP } from "../config";
import { biomePalette } from "../data/biomes";
import { bossKind } from "../data/bosses";
import { ENEMIES } from "../data/enemies";
import { HEROES } from "../data/heroes";
import type { RoomType } from "../data/rooms";
import { specialReadiness } from "../data/special-readiness";
import type { SpecialReadiness } from "../data/special-readiness";
import { Boss } from "../entities/boss";
import { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import type { ExpeditionCheckpoint } from "../net/checkpoint";
import { parseEnemy, parseHero, readSnapshot } from "../net/parse";
import { Reconciler } from "../net/predict";
import type { NetSession } from "../net/session";
import type { NetBoss, NetEnemy, NetPlayer, NetProj, Snapshot } from "../net/snapshot";
import { impactRing } from "../sys/fx";
import { NEUTRAL_INPUT } from "../sys/input";
import { gameInset } from "../sys/screen";
import { vsPhaseFrozen } from "../sys/versus";
import type { GameScene } from "./game-scene";

type GuestCtx = Scene &
  Pick<
    GameScene,
    | "acc"
    | "authority"
    | "banners"
    | "bossHp"
    | "bossHpBg"
    | "checkpoint"
    | "combat"
    | "controlsPaused"
    | "deadT"
    | "doors"
    | "gold"
    | "grid"
    | "guestIn"
    | "hearts"
    | "heroName"
    | "lastStand"
    | "maxHearts"
    | "mode"
    | "ownedRelics"
    | "player"
    | "progress"
    | "remote"
    | "remoteId"
    | "role"
    | "roomSpawn"
    | "rooms"
    | "run"
    | "runRecap"
    | "score"
    | "seats"
    | "session"
    | "shake"
    | "spawnPlayer"
    | "state"
    | "trailer"
    | "updateHud"
    | "versus"
  >;

// Guest side of the wire: adopts the accepted checkpoint's room, applies each
// snapshot to the puppets (other player, enemies, boss, projectiles) and
// reconciles the locally-predicted own body against the host's copy.
export class GuestSync {
  private readonly scene: GuestCtx;
  // room seq it has built
  roomSeq = -1;
  // last snapshot applied
  snapT = -1;
  // projectile puppets
  proj: Phaser.GameObjects.Sprite[] = [];
  readonly enemyPuppets = new Map<number, { view: Enemy; net: NetEnemy }>();
  bossPuppet?: { view: Boss; net: NetBoss };
  cueBaseline = true;
  progressTick = -1;
  special: SpecialReadiness = { kind: "unknown" };
  // latest wire players (re-lerped each frame)
  players: NetPlayer[] = [];
  // Prediction: my own body runs the real fixed-step sim on local input
  // (instant response); each snapshot's authoritative copy folds back in here.
  readonly reconciler = new Reconciler();
  // my player's hurting flag last snapshot (edge detect)
  selfHurting = false;
  // HUD biome/depth (host uses scene.run)
  biome = 1;
  depth = 1;
  roomType: RoomType = "combat";
  payoff: { room: number; t: number; cleared: boolean; bossAlive: boolean } | null = null;

  constructor(scene: GuestCtx) {
    this.scene = scene;
  }

  // Guest: apply the latest room + snapshot, run my OWN body through the real
  // fixed-step sim on local input (client-side prediction — movement responds
  // this frame, not after a round-trip), then re-lerp the puppet views. The
  // host still resolves ALL combat: damage/knockback/hearts arrive via the
  // snapshot and fold into the predicted body in reconcileSelf.
  step(dts: number) {
    const sess = this.scene.session;
    if (!sess?.live) {
      return;
    }
    if (!this.applyAuthority(sess)) {
      return;
    }
    // the snapshot ended the run (co-op death)
    if (this.scene.state !== "active") {
      return;
    }
    this.scene.versus.noticeOpponentGone(sess);
    // Prediction: mirror the host's versus freeze (round intro / match end) so
    // the local body doesn't fight the authority while inputs are dropped.
    const frozen =
      this.scene.mode === "versus" &&
      this.scene.versus.net !== null &&
      vsPhaseFrozen(this.scene.versus.net.phase);
    this.scene.player.buffer(
      frozen || this.scene.controlsPaused ? NEUTRAL_INPUT : this.scene.guestIn,
    );
    this.scene.acc += dts;
    let steps = 0;
    while (this.scene.acc >= STEP && steps < MAX_STEPS) {
      this.scene.player.step(STEP);
      this.reconciler.record(this.scene.player.body.x, this.scene.player.body.y);
      this.scene.acc -= STEP;
      steps += 1;
    }
    // Prediction is movement-only: combat intents resolve on the host.
    this.scene.player.body.pendingShot = null;
    this.scene.player.body.pendingHeal = 0;
    this.scene.player.render(Math.min(this.scene.acc / STEP, 1));
    this.renderViews(dts);
    this.scene.lastStand.render();
  }

  // Guest: adopt the accepted checkpoint's room, then the newest snapshot that
  // belongs to it. Returns false when there is no usable authority yet.
  private applyAuthority(sess: NetSession): boolean {
    const read = this.scene.checkpoint.accepted();
    const auth = this.scene.authority;
    if (read.kind !== "ready" || auth.kind !== "ready") {
      return false;
    }
    const c = read.value;
    if (c.runId !== auth.runId || c.term !== auth.term || c.room < this.roomSeq) {
      return false;
    }
    const changedRoom = c.room !== this.roomSeq;
    if (changedRoom) {
      this.biome = c.run.biome;
      this.depth = c.run.depth;
      this.scene.run.type = c.run.type;
      this.scene.rooms.buildFromNet(read.room);
      this.snapT = -1;
    }
    const snap = readSnapshot(sess.sharedState);
    if (
      snap &&
      snap.t > this.snapT &&
      snap.t >= c.tick &&
      snap.room === c.room &&
      snap.runId === c.runId &&
      snap.term === c.term
    ) {
      this.snapT = snap.t;
      this.scene.seats = { ...c.seats };
      this.syncProgress(c);
      this.applySnapshot(snap, c.phase.kind === "dead");
      if (c.phase.kind === "dead") {
        this.scene.deadT = c.phase.elapsed;
      }
      this.scene.checkpoint.syncRoomFeatures(c, changedRoom);
    }
    return true;
  }

  private applySnapshot(s: Snapshot, terminal = false) {
    const auth = this.scene.authority;
    if (
      auth.kind !== "ready" ||
      s.room !== this.roomSeq ||
      s.runId !== auth.runId ||
      s.term !== auth.term
    ) {
      return;
    }
    this.scene.hearts = s.hearts;
    this.scene.maxHearts = s.maxHearts;
    this.scene.gold = s.gold;
    this.biome = s.biome;
    this.depth = s.depth;
    if (!this.cueBaseline) {
      this.applyRemoteCues(s.players);
    }
    this.players = s.players;
    const mine = s.players.find((p) => p.id === this.scene.session?.playerId);
    if (mine) {
      this.reconcileSelf(mine);
    }
    if (this.scene.mode === "versus") {
      // Versus: per-duelist hearts + round state travel on s.vs; the shared
      // hearts / last-stand / shared-death rules don't apply.
      this.scene.versus.applyNet(s.vs ?? null);
      this.applyNetProj(s.proj);
      this.cueBaseline = false;
      this.scene.updateHud();
      return;
    }
    this.scene.lastStand.applyNet(terminal ? { ...s, lastStand: null } : s);
    this.reconcileEnemies(s.enemies);
    this.reconcileBoss(s.boss, s.biome, s.room);
    this.applyPayoffEdges(s);
    this.applyNetProj(s.proj);
    this.cueBaseline = false;
    for (const d of this.scene.doors) {
      d.setActive(s.cleared);
    }
    this.scene.updateHud();
    // Hearts hit 0 while a last stand is live → downed, not dead (yet).
    if (terminal || (this.scene.hearts <= 0 && !this.scene.lastStand.net)) {
      this.die();
    }
  }

  /** Accepted presentation only: never apply modifiers or bank a guest's rewards. */
  syncProgress(c: ExpeditionCheckpoint) {
    const auth = this.scene.authority;
    if (
      this.scene.role !== "guest" ||
      auth.kind !== "ready" ||
      c.runId !== auth.runId ||
      c.term !== auth.term ||
      c.room !== this.roomSeq ||
      c.tick < this.progressTick
    ) {
      return;
    }
    this.progressTick = c.tick;
    this.scene.score = c.score;
    this.scene.ownedRelics = new Set(c.relics);
    const mine = c.players.find((p) => p.id === this.scene.session?.playerId);
    this.special = mine ? specialReadiness(mine.body) : { kind: "unknown" };
  }

  /** Snapshot edges own remote cues; repeated renders and first admissions stay quiet. */
  private applyRemoteCues(players: NetPlayer[]) {
    for (const next of players) {
      if (next.id === this.scene.session?.playerId) {
        continue;
      }
      const prev = this.players.find((p) => p.id === next.id && p.hero === next.hero);
      if (!prev || next.dead || next.downed) {
        continue;
      }
      if (next.hurting && !prev.hurting) {
        sfx.hurt("routine");
      }
      if (next.dashing && !prev.dashing) {
        sfx.dash();
      }
      if (!next.grounded && prev.grounded && next.vy < 0) {
        sfx.jump();
      }
      if (next.attackStep > 0 && next.swingId > prev.swingId) {
        sfx.slash();
      }
      const hero = parseHero(next.hero);
      if (hero && next.specialActive && next.specialId > prev.specialId) {
        this.scene.combat.showSpecial(
          HEROES[hero].kit.special.kind,
          next.x,
          next.y,
          next.facing,
          HEROES[hero].color,
          false,
        );
      }
    }
  }

  /** Fresh same-room snapshots only. Initial cleared/dead states are quiet. */
  private applyPayoffEdges(s: Snapshot) {
    if (s.room !== this.roomSeq) {
      return;
    }
    const prev = this.payoff;
    if (prev && prev.room === s.room && s.t <= prev.t) {
      return;
    }
    if (prev && prev.room === s.room) {
      if (prev.bossAlive && s.boss?.dead) {
        this.scene.progress.bossDefeatFx(s.boss.x, s.boss.y, this.biome);
        sfx.boom("essential");
        this.scene.shake(420, 0.02);
        this.scene.banners.show(`${bossKind(this.biome).name} SLAIN`, 1800, "payoff");
      }
      if (!prev.cleared && s.cleared) {
        this.scene.progress.roomClearFx(this.roomType, this.biome);
      }
    }
    this.payoff = {
      bossAlive: s.boss !== null && !s.boss.dead,
      cleared: s.cleared,
      room: s.room,
      t: s.t,
    };
  }

  // Exactly one driver advances each player body every frame:
  //   sim     — this client runs the authoritative sim (solo/host, both bodies)
  //   predict — guest's OWN body: local sim for instant input, reconciled to
  //             the host's authoritative copy on every snapshot
  //   puppet  — guest's view of the OTHER player: driven purely from snapshots
  private bodyDrive(pl: Player): "sim" | "predict" | "puppet" {
    if (this.scene.role !== "guest") {
      return "sim";
    }
    return pl === this.scene.player ? "predict" : "puppet";
  }

  // Guest: fold the host's authoritative copy of MY player into the predicted
  // body. Movement normally agrees (same sim, same input), so most snapshots
  // correct nothing; host-only outcomes land here as edges — a hit's knockback
  // or a round respawn snaps (the jerk IS the feedback), small drift blends out
  // via the reconciler's trajectory match.
  private reconcileSelf(net: NetPlayer) {
    const b = this.scene.player.body;
    // Host-resolved combat state, mirrored on its edges.
    if (net.downed && !b.downed) {
      b.down();
      b.snapTo(net.x, net.y, net.vx, net.vy);
      this.reconciler.reset();
    } else if (!net.downed && b.downed) {
      b.revive();
    }
    if (net.dead && !b.dead) {
      b.dead = true;
    } else if (!net.dead && b.dead) {
      // Versus round respawn: full reset at the authoritative spawn point.
      b.dead = false;
      this.scene.player.enterRoom(this.scene.grid, net.x, net.y);
      this.reconciler.reset();
      this.selfHurting = net.hurting;
      return;
    }
    if (net.hurting && !this.selfHurting) {
      // The host landed a hit on me: reproduce it locally (stun + i-frames +
      // hurt juice via the body hooks) and snap to the authoritative knockback.
      b.applyHurt(Math.sign(net.vx) || net.facing);
      b.snapTo(net.x, net.y, net.vx, net.vy);
      this.reconciler.reset();
    } else if (!b.dead && !b.downed) {
      const c = this.reconciler.reconcile(net.x, net.y);
      if (c.kind === "snap") {
        b.snapTo(net.x, net.y, net.vx, net.vy);
        this.reconciler.reset();
      } else if (c.kind === "blend") {
        b.nudge(c.dx, c.dy);
      }
    }
    this.selfHurting = net.hurting;
  }

  private reconcileEnemies(list: NetEnemy[]) {
    const seen = new Set<number>();
    for (const ne of list) {
      seen.add(ne.id);
      let p = this.enemyPuppets.get(ne.id);
      if (!p) {
        const view = new Enemy(
          this.scene,
          this.scene.grid,
          ENEMIES[parseEnemy(ne.name)],
          ne.x,
          ne.y,
        );
        p = { net: ne, view };
        this.enemyPuppets.set(ne.id, p);
      } else if (!this.cueBaseline && !p.net.dead) {
        if (ne.dead) {
          impactRing(this.scene, ne.x, ne.y - p.view.body.kind.h / 2, COLORS.teal, 22);
          sfx.kill();
        } else if (ne.flash && !p.net.flash) {
          sfx.hit();
        }
      }
      p.net = ne;
    }
    for (const [id, p] of this.enemyPuppets) {
      if (!seen.has(id)) {
        p.view.destroy();
        this.enemyPuppets.delete(id);
      }
    }
  }

  reconcileBoss(nb: NetBoss | null, biome: number, room: number) {
    if (nb && !this.bossPuppet) {
      const view = new Boss(this.scene, this.scene.grid, nb.x, nb.y, biome);
      const barCol = biomePalette(biome).oneway;
      this.scene.bossHpBg = this.scene.add
        .rectangle(BASE_W / 2, 47 + gameInset(this.scene).top, 260, 6, 0x00_00_00, 0.5)
        .setStrokeStyle(1, barCol, 0.6)
        .setScrollFactor(0)
        .setDepth(85);
      this.scene.bossHp = this.scene.add
        .rectangle(BASE_W / 2 - 129, 47 + gameInset(this.scene).top, 258, 4, barCol)
        .setOrigin(0, 0.5)
        .setScrollFactor(0)
        .setDepth(86);
      this.bossPuppet = { net: nb, view };
    } else if (!nb && this.bossPuppet) {
      this.bossPuppet.view.destroy();
      this.bossPuppet = undefined;
      this.scene.bossHp?.destroy();
      this.scene.bossHpBg?.destroy();
      this.scene.bossHp = undefined;
      this.scene.bossHpBg = undefined;
    }
    if (nb && this.bossPuppet) {
      if (!this.cueBaseline && nb.flash && !this.bossPuppet.net.flash) {
        sfx.hit();
      }
      this.bossPuppet.net = nb;
      if (this.scene.bossHp) {
        this.scene.bossHp.width = 258 * nb.hpFrac;
      }
      // A dead/stale first snapshot stays quiet. A later matching live one can
      // establish the encounter even if that earlier packet built the puppet.
      if (!nb.dead && room === this.roomSeq) {
        this.scene.progress.announceBoss(biome);
      }
    }
  }

  private applyNetProj(proj: NetProj[]) {
    for (let i = 0; i < proj.length; i += 1) {
      const pj = proj[i];
      if (!pj) {
        continue;
      }
      let spr = this.proj[i];
      if (!spr) {
        spr = this.scene.add.sprite(pj.x, pj.y, "fx:arrow").setDepth(40);
        this.proj[i] = spr;
      }
      spr.setVisible(true).setPosition(pj.x, pj.y);
      if (pj.k === "arrow") {
        spr
          .setTexture("fx:arrow")
          .setScale(0.3)
          .setRotation(pj.vx < 0 ? Math.PI : 0);
      } else {
        if (spr.anims.currentAnim?.key !== "fx:flame-wave") {
          spr.play("fx:flame-wave");
        }
        spr
          .setScale(0.6)
          .setFlipX(pj.vx < 0)
          .setRotation(0);
      }
    }
    for (let i = proj.length; i < this.proj.length; i += 1) {
      this.proj[i]?.setVisible(false);
    }
  }

  // Guest: re-drive the puppets every frame off the latest snapshot (they lerp
  // toward the authoritative point, so 30Hz reads render smoothly at 60fps).
  // My own body is predicted, not a puppet — it renders from its local sim.
  private renderViews(dt: number) {
    const myId = this.scene.session?.playerId;
    if (this.scene.remote && !this.players.some((p) => p.id === this.scene.remoteId)) {
      this.scene.remote.destroy();
      this.scene.remote = undefined;
      this.scene.remoteId = null;
    }
    for (const np of this.players) {
      // bodyDrive(player) === "predict"
      if (np.id === myId) {
        continue;
      }
      this.ensureRemote(np.hero);
      this.scene.remoteId = np.id;
      const pup = this.scene.remote;
      if (pup && this.bodyDrive(pup) === "puppet") {
        pup.applyNet(np);
      }
    }
    for (const p of this.enemyPuppets.values()) {
      p.view.applyNet(
        p.net.clip,
        p.net.x,
        p.net.y,
        p.net.flip,
        p.net.flash,
        p.net.action,
        p.net.tint,
        dt,
      );
    }
    if (this.bossPuppet) {
      const n = this.bossPuppet.net;
      this.bossPuppet.view.applyNet(n.clip, n.x, n.y, n.flip, n.flash, n.telegraph, n.action, dt);
    }
  }

  ensureRemote(heroRaw: string) {
    const hero = parseHero(heroRaw) ?? "axion";
    if (this.scene.remote?.name === hero) {
      return;
    }
    this.scene.remote?.destroy();
    this.scene.remote = this.scene.spawnPlayer(
      HEROES[hero],
      this.scene.grid,
      this.scene.roomSpawn.x,
      this.scene.roomSpawn.y,
    );
  }

  private die() {
    if (this.scene.state === "dead") {
      return;
    }
    this.scene.lastStand.live = null;
    this.scene.lastStand.net = null;
    this.scene.runRecap = this.scene.trailer.active
      ? null
      : {
          biome: this.biome,
          depth: this.depth,
          gold: this.scene.gold,
          hero: this.scene.heroName,
          kind: "coop-guest",
        };
    this.scene.state = "dead";
    this.scene.lastStand.destroyUi();
    this.scene.deadT = 0;
    this.scene.player.sprite.play(`${this.scene.heroName}:death`);
    sfx.die();
    this.scene.banners.show("YOU FELL — RETURNING TO THE HUB", 2600, "critical");
  }
}
