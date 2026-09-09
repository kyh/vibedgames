import type { Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { COLORS, MAX_STEPS, STEP } from "../config";
import { bossKind } from "../data/bosses";
import { ENEMIES } from "../data/enemies";
import { HEROES } from "../data/heroes";
import { specialReadiness } from "../data/special-readiness";
import { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import type { ExpeditionCheckpoint } from "../net/checkpoint";
import { parseEnemy, parseHero, readSnapshot } from "../net/parse";
import type { NetSession } from "../net/session";
import type { NetBoss, NetEnemy, NetPlayer, NetProj, Snapshot } from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { impactRing } from "../sys/fx";
import { NEUTRAL_INPUT } from "../sys/input";
import { vsPhaseFrozen } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { CheckpointSync } from "./checkpoint-sync";
import type { Combat } from "./combat";
import type { LastStand } from "./last-stand";
import type { RoomBuilder } from "./room-builder";
import type { RoomProgress } from "./room-progress";
import type { SceneHooks } from "./scene-hooks";
import type { VersusFlow } from "./versus-flow";

export interface GuestSyncDeps {
  scene: Scene;
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  checkpoint: CheckpointSync;
  combat: Combat;
  lastStand: LastStand;
  progress: RoomProgress;
  rooms: RoomBuilder;
  versus: VersusFlow;
  hooks: SceneHooks;
}

// Guest side of the wire: adopts the accepted checkpoint's room, applies each
// snapshot to the puppets (other player, enemies, boss, projectiles) and
// reconciles the locally-predicted own body against the host's copy.
export class GuestSync {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly checkpoint: CheckpointSync;
  private readonly combat: Combat;
  private readonly lastStand: LastStand;
  private readonly progress: RoomProgress;
  private readonly rooms: RoomBuilder;
  private readonly versus: VersusFlow;
  private readonly hooks: SceneHooks;

  constructor(deps: GuestSyncDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.checkpoint = deps.checkpoint;
    this.combat = deps.combat;
    this.lastStand = deps.lastStand;
    this.progress = deps.progress;
    this.rooms = deps.rooms;
    this.versus = deps.versus;
    this.hooks = deps.hooks;
  }

  // Guest: apply the latest room + snapshot, run my OWN body through the real
  // fixed-step sim on local input (client-side prediction — movement responds
  // this frame, not after a round-trip), then re-lerp the puppet views. The
  // host still resolves ALL combat: damage/knockback/hearts arrive via the
  // snapshot and fold into the predicted body in reconcileSelf.
  step(dts: number) {
    const sess = this.seat.session;
    if (!sess?.live) {
      return;
    }
    if (!this.applyAuthority(sess)) {
      return;
    }
    // the snapshot ended the run (co-op death)
    if (this.run.state !== "active") {
      return;
    }
    this.versus.noticeOpponentGone(sess);
    // Prediction: mirror the host's versus freeze (round intro / match end) so
    // the local body doesn't fight the authority while inputs are dropped.
    const frozen =
      this.seat.mode === "versus" &&
      this.run.matchNet !== null &&
      vsPhaseFrozen(this.run.matchNet.phase);
    this.seat.player.buffer(frozen || this.seat.controlsPaused ? NEUTRAL_INPUT : this.seat.guestIn);
    this.run.acc += dts;
    let steps = 0;
    while (this.run.acc >= STEP && steps < MAX_STEPS) {
      this.seat.player.step(STEP);
      this.room.guest.reconciler.record(this.seat.player.body.x, this.seat.player.body.y);
      this.run.acc -= STEP;
      steps += 1;
    }
    // Prediction is movement-only: combat intents resolve on the host.
    this.seat.player.body.pendingShot = null;
    this.seat.player.body.pendingHeal = 0;
    this.seat.player.render(Math.min(this.run.acc / STEP, 1));
    this.renderViews(dts);
    this.lastStand.render();
  }

  // Guest: adopt the accepted checkpoint's room, then the newest snapshot that
  // belongs to it. Returns false when there is no usable authority yet.
  private applyAuthority(sess: NetSession): boolean {
    const read = this.checkpoint.accepted();
    const auth = this.seat.authority;
    if (read.kind !== "ready" || auth.kind !== "ready") {
      return false;
    }
    const c = read.value;
    if (c.runId !== auth.runId || c.term !== auth.term || c.room < this.room.seq) {
      return false;
    }
    const changedRoom = c.room !== this.room.seq;
    if (changedRoom) {
      this.expedition.biome = c.run.biome;
      this.expedition.depth = c.run.depth;
      this.expedition.type = c.run.type;
      this.rooms.buildFromNet(read.room, c.run.biome);
      this.room.guest.snapT = -1;
    }
    const snap = readSnapshot(sess.sharedState);
    if (
      snap &&
      snap.t > this.room.guest.snapT &&
      snap.t >= c.tick &&
      snap.room === c.room &&
      snap.runId === c.runId &&
      snap.term === c.term
    ) {
      this.room.guest.snapT = snap.t;
      this.seat.seats = { ...c.seats };
      this.syncProgress(c);
      this.applySnapshot(snap, c.phase.kind === "dead");
      if (c.phase.kind === "dead") {
        this.run.deadT = c.phase.elapsed;
      }
      this.checkpoint.syncRoomFeatures(c, changedRoom);
    }
    return true;
  }

  private applySnapshot(s: Snapshot, terminal = false) {
    const auth = this.seat.authority;
    if (
      auth.kind !== "ready" ||
      s.room !== this.room.seq ||
      s.runId !== auth.runId ||
      s.term !== auth.term
    ) {
      return;
    }
    this.run.hearts = s.hearts;
    this.run.maxHearts = s.maxHearts;
    this.run.gold = s.gold;
    this.expedition.biome = s.biome;
    this.expedition.depth = s.depth;
    if (!this.room.guest.cueBaseline) {
      this.applyRemoteCues(s.players);
    }
    this.room.guest.players = s.players;
    const mine = s.players.find((p) => p.id === this.seat.session?.playerId);
    if (mine) {
      this.reconcileSelf(mine);
    }
    if (this.seat.mode === "versus") {
      // Versus: per-duelist hearts + round state travel on s.vs; the shared
      // hearts / last-stand / shared-death rules don't apply.
      this.versus.applyNet(s.vs ?? null);
      this.applyNetProj(s.proj);
      this.room.guest.cueBaseline = false;
      this.hooks.updateHud();
      return;
    }
    this.lastStand.applyNet(terminal ? { ...s, lastStand: null } : s);
    this.reconcileEnemies(s.enemies);
    this.reconcileBoss(s.boss, s.biome, s.room);
    this.applyPayoffEdges(s);
    this.applyNetProj(s.proj);
    this.room.guest.cueBaseline = false;
    for (const d of this.room.doors) {
      d.setActive(s.cleared);
    }
    this.hooks.updateHud();
    // Hearts hit 0 while a last stand is live → downed, not dead (yet).
    if (terminal || (this.run.hearts <= 0 && !this.run.downedNet)) {
      this.die();
    }
  }

  /** Accepted presentation only: never apply modifiers or bank a guest's rewards. */
  syncProgress(c: ExpeditionCheckpoint) {
    const auth = this.seat.authority;
    if (
      this.seat.role !== "guest" ||
      auth.kind !== "ready" ||
      c.runId !== auth.runId ||
      c.term !== auth.term ||
      c.room !== this.room.seq ||
      c.tick < this.room.guest.progressTick
    ) {
      return;
    }
    this.room.guest.progressTick = c.tick;
    this.run.score = c.score;
    this.run.ownedRelics = new Set(c.relics);
    const mine = c.players.find((p) => p.id === this.seat.session?.playerId);
    this.room.guest.special = mine ? specialReadiness(mine.body) : { kind: "unknown" };
  }

  /** Snapshot edges own remote cues; repeated renders and first admissions stay quiet. */
  private applyRemoteCues(players: NetPlayer[]) {
    for (const next of players) {
      if (next.id === this.seat.session?.playerId) {
        continue;
      }
      const prev = this.room.guest.players.find((p) => p.id === next.id && p.hero === next.hero);
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
        this.combat.showSpecial(
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
    if (s.room !== this.room.seq) {
      return;
    }
    const prev = this.room.guest.payoff;
    if (prev && prev.room === s.room && s.t <= prev.t) {
      return;
    }
    if (prev && prev.room === s.room) {
      if (prev.bossAlive && s.boss?.dead) {
        this.progress.bossDefeatFx(s.boss.x, s.boss.y, this.expedition.biome);
        sfx.boom("essential");
        this.hooks.shake(420, 0.02);
        this.banners.show(`${bossKind(this.expedition.biome).name} SLAIN`, 1800, "payoff");
      }
      if (!prev.cleared && s.cleared) {
        this.progress.roomClearFx(this.expedition.type, this.expedition.biome);
      }
    }
    this.room.guest.payoff = {
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
    if (this.seat.role !== "guest") {
      return "sim";
    }
    return pl === this.seat.player ? "predict" : "puppet";
  }

  // Guest: fold the host's authoritative copy of MY player into the predicted
  // body. Movement normally agrees (same sim, same input), so most snapshots
  // correct nothing; host-only outcomes land here as edges — a hit's knockback
  // or a round respawn snaps (the jerk IS the feedback), small drift blends out
  // via the reconciler's trajectory match.
  private reconcileSelf(net: NetPlayer) {
    const b = this.seat.player.body;
    // Host-resolved combat state, mirrored on its edges.
    if (net.downed && !b.downed) {
      b.down();
      b.snapTo(net.x, net.y, net.vx, net.vy);
      this.room.guest.reconciler.reset();
    } else if (!net.downed && b.downed) {
      b.revive();
    }
    if (net.dead && !b.dead) {
      b.dead = true;
    } else if (!net.dead && b.dead) {
      // Versus round respawn: full reset at the authoritative spawn point.
      b.dead = false;
      this.seat.player.enterRoom(this.room.grid, net.x, net.y);
      this.room.guest.reconciler.reset();
      this.room.guest.selfHurting = net.hurting;
      return;
    }
    if (net.hurting && !this.room.guest.selfHurting) {
      // The host landed a hit on me: reproduce it locally (stun + i-frames +
      // hurt juice via the body hooks) and snap to the authoritative knockback.
      b.applyHurt(Math.sign(net.vx) || net.facing);
      b.snapTo(net.x, net.y, net.vx, net.vy);
      this.room.guest.reconciler.reset();
    } else if (!b.dead && !b.downed) {
      const c = this.room.guest.reconciler.reconcile(net.x, net.y);
      if (c.kind === "snap") {
        b.snapTo(net.x, net.y, net.vx, net.vy);
        this.room.guest.reconciler.reset();
      } else if (c.kind === "blend") {
        b.nudge(c.dx, c.dy);
      }
    }
    this.room.guest.selfHurting = net.hurting;
  }

  private reconcileEnemies(list: NetEnemy[]) {
    const seen = new Set<number>();
    for (const ne of list) {
      seen.add(ne.id);
      let p = this.room.guest.enemyPuppets.get(ne.id);
      if (!p) {
        const view = new Enemy(
          this.scene,
          this.room.grid,
          ENEMIES[parseEnemy(ne.name)],
          ne.x,
          ne.y,
        );
        p = { net: ne, view };
        this.room.guest.enemyPuppets.set(ne.id, p);
      } else if (!this.room.guest.cueBaseline && !p.net.dead) {
        if (ne.dead) {
          impactRing(this.scene, ne.x, ne.y - p.view.body.kind.h / 2, COLORS.teal, 22);
          sfx.kill();
        } else if (ne.flash && !p.net.flash) {
          sfx.hit();
        }
      }
      p.net = ne;
    }
    for (const [id, p] of this.room.guest.enemyPuppets) {
      if (!seen.has(id)) {
        p.view.destroy();
        this.room.guest.enemyPuppets.delete(id);
      }
    }
  }

  private reconcileBoss(nb: NetBoss | null, biome: number, room: number) {
    if (nb && !this.room.guest.bossPuppet) {
      this.room.guest.bossPuppet = { net: nb, view: this.rooms.bossView(nb.x, nb.y, biome) };
    } else if (!nb && this.room.guest.bossPuppet) {
      this.room.guest.bossPuppet.view.destroy();
      this.room.guest.bossPuppet = undefined;
      this.room.bossHp?.destroy();
      this.room.bossHpBg?.destroy();
      this.room.bossHp = undefined;
      this.room.bossHpBg = undefined;
    }
    if (nb && this.room.guest.bossPuppet) {
      if (!this.room.guest.cueBaseline && nb.flash && !this.room.guest.bossPuppet.net.flash) {
        sfx.hit();
      }
      this.room.guest.bossPuppet.net = nb;
      if (this.room.bossHp) {
        this.room.bossHp.width = 258 * nb.hpFrac;
      }
      // A dead/stale first snapshot stays quiet. A later matching live one can
      // establish the encounter even if that earlier packet built the puppet.
      if (!nb.dead && room === this.room.seq) {
        this.progress.announceBoss(biome);
      }
    }
  }

  private applyNetProj(proj: NetProj[]) {
    for (let i = 0; i < proj.length; i += 1) {
      const pj = proj[i];
      if (!pj) {
        continue;
      }
      let spr = this.room.guest.proj[i];
      if (!spr) {
        spr = this.scene.add.sprite(pj.x, pj.y, "fx:arrow").setDepth(40);
        this.room.guest.proj[i] = spr;
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
    for (let i = proj.length; i < this.room.guest.proj.length; i += 1) {
      this.room.guest.proj[i]?.setVisible(false);
    }
  }

  // Guest: re-drive the puppets every frame off the latest snapshot (they lerp
  // toward the authoritative point, so 30Hz reads render smoothly at 60fps).
  // My own body is predicted, not a puppet — it renders from its local sim.
  private renderViews(dt: number) {
    const myId = this.seat.session?.playerId;
    if (this.seat.remote && !this.room.guest.players.some((p) => p.id === this.seat.remoteId)) {
      this.seat.remote.destroy();
      this.seat.remote = undefined;
      this.seat.remoteId = null;
    }
    for (const np of this.room.guest.players) {
      // bodyDrive(player) === "predict"
      if (np.id === myId) {
        continue;
      }
      this.ensureRemote(np.hero);
      this.seat.remoteId = np.id;
      const pup = this.seat.remote;
      if (pup && this.bodyDrive(pup) === "puppet") {
        pup.applyNet(np);
      }
    }
    for (const p of this.room.guest.enemyPuppets.values()) {
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
    if (this.room.guest.bossPuppet) {
      const n = this.room.guest.bossPuppet.net;
      this.room.guest.bossPuppet.view.applyNet(
        n.clip,
        n.x,
        n.y,
        n.flip,
        n.flash,
        n.telegraph,
        n.action,
        dt,
      );
    }
  }

  ensureRemote(heroRaw: string) {
    const hero = parseHero(heroRaw) ?? "axion";
    if (this.seat.remote?.name === hero) {
      return;
    }
    this.seat.remote?.destroy();
    this.seat.remote = this.hooks.spawnPlayer(
      HEROES[hero],
      this.room.grid,
      this.room.roomSpawn.x,
      this.room.roomSpawn.y,
    );
  }

  private die() {
    if (this.run.state === "dead") {
      return;
    }
    this.run.downed = null;
    this.run.downedNet = null;
    this.run.runRecap = this.hooks.trailerActive()
      ? null
      : {
          biome: this.expedition.biome,
          depth: this.expedition.depth,
          gold: this.run.gold,
          hero: this.seat.heroName,
          kind: "coop-guest",
        };
    this.run.state = "dead";
    this.lastStand.destroyUi();
    this.run.deadT = 0;
    this.seat.player.sprite.play(`${this.seat.heroName}:death`);
    sfx.die();
    this.banners.show("YOU FELL — RETURNING TO THE HUB", 2600, "critical");
  }
}
