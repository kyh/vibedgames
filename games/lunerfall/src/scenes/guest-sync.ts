import type Phaser from "phaser";
import type { Scene } from "phaser";

import { Interpolator, RemoteClock } from "@vibedgames/multiplayer";

import { sfx } from "../audio/sfx";
import { COLORS, MAX_LAG, MAX_STEPS, STEP } from "../config";
import { bossKind } from "../data/bosses";
import { ENEMIES } from "../data/enemies";
import { HEROES } from "../data/heroes";
import { parseRoomType } from "../data/rooms";
import { Enemy } from "../entities/enemy";
import type { Player } from "../entities/player";
import { onBossHead, onEnemyHead } from "../entities/player-body";
import type { PlayerBody } from "../entities/player-body";
import type { ExpeditionCheckpoint } from "../net/checkpoint";
import { INTERP_MS, lerpBoss, lerpEnemy, lerpPlayer } from "../net/interp";
import type { JsonValue } from "../net/json";
import { parseEnemy, parseHero, readCast, readSnapshot, readStatus } from "../net/parse";
import { Prediction } from "../net/predict";
import type { Replayed } from "../net/predict";
import type { NetSession } from "../net/session";
import {
  decodeBoss,
  decodeEdge,
  decodeEnemy,
  decodePlayer,
  PROJ_KINDS,
  runTag,
} from "../net/snapshot";
import type {
  BossPose,
  EnemyPose,
  GuestEdge,
  NetCast,
  NetStatus,
  PlayerPose,
  ProjKind,
  Snapshot,
} from "../net/snapshot";
import type { RoomState, SnapPlayer } from "../state/room-state";
import type { RunState } from "../state/run-state";
import type { SeatState } from "../state/seat-state";
import { hitSpark, impactRing } from "../sys/fx";
import { NEUTRAL_INPUT } from "../sys/input";
import { vsPhaseFrozen } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { CheckpointSync } from "./checkpoint-sync";
import { ARROW_GRAV } from "./combat";
import type { Combat } from "./combat";
import type { LastStand } from "./last-stand";
import type { RoomBuilder } from "./room-builder";
import type { RoomProgress } from "./room-progress";
import type { SceneHooks } from "./scene-hooks";
import type { VersusFlow } from "./versus-flow";

// ms time constant over which the visible jump of a replayed edge (the host's
// hit or stomp bounce, learned a round trip late) eases out on the sprite
const DRIFT_MS = 70;
// px; a jump past this is shown at once rather than dragged across the room
const DRIFT_SNAP = 160;
// snapshots held for the frame loop; a stalled tab drops the oldest
const INBOX = 32;
// ms a predicted stomp's hit sound covers the enemy's flash, which arrives
// about a round trip and a render delay later
const STOMP_HUSH = 700;

// One snapshot as it landed, with the cast, status and room beside it.
interface Arrival {
  at: number;
  snap: JsonValue;
  cast: JsonValue | undefined;
  status: JsonValue | undefined;
  room: JsonValue | undefined;
}

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

// Guest side of the wire. Exactly one driver advances each body:
//   predict — my OWN body: the real fixed-step sim on local input, its ticks
//             shipped to the host; host edges replayed into it, drift
//             reconciled at the acked tick (net/predict.ts)
//   puppet  — everyone else: drawn INTERP_MS behind the host's clock between
//             the two snapshots that bracket that moment (net/interp.ts);
//             projectiles dead-reckoned along their flight
// Rooms change when a snapshot names the next one and its layout is in hand;
// checkpoints only dress the room (merchant stock, features) and the relic
// list, so a missing or rejected one never stops the guest.
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
  private readonly prediction = new Prediction();
  // the host's clock: one sender, so every puppet shares its offset
  private readonly clock = new RemoteClock();
  private readonly remote = new Interpolator<PlayerPose>({
    clock: this.clock,
    delayMs: INTERP_MS,
    lerp: lerpPlayer,
  });
  private remotePrev: PlayerPose | null = null;
  private readonly inbox: Arrival[] = [];
  private seenSnap: JsonValue | undefined;
  private castRef: JsonValue | undefined;
  private cast: NetCast | null = null;
  private statusRef: JsonValue | undefined;
  private status: NetStatus | null = null;
  // sprite offset easing out a replayed edge's jump
  private driftX = 0;
  private driftY = 0;

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

  /** NetSession.onShared: every new shared state, as it lands. */
  receive(shared: Record<string, JsonValue>): void {
    const { cast, room, snap, status } = shared;
    if (this.seat.role !== "guest" || snap === undefined || snap === this.seenSnap) {
      return;
    }
    this.seenSnap = snap;
    this.inbox.push({ at: performance.now(), cast, room, snap, status });
    if (this.inbox.length > INBOX) {
      this.inbox.shift();
    }
  }

  /** A new authority adopted: the host's clock and everything predicted before are stale. */
  admit(): void {
    this.prediction.admit();
    this.clock.reset();
    this.remote.clear();
    this.remotePrev = null;
    this.driftX = 0;
    this.driftY = 0;
  }

  /** Pause / reconnect: drop the body's queued input — the host's copy drops
   * it on the same tick. */
  dropQueued(): void {
    this.prediction.dropQueued(this.seat.player.body);
  }

  // Guest frame: apply what the host sent, predict my body, draw the rest.
  step(dts: number) {
    const sess = this.seat.session;
    if (!sess?.live) {
      return;
    }
    this.drainInbox(sess);
    this.syncCheckpoint();
    // the snapshot ended the run (co-op death)
    if (this.run.state !== "active") {
      return;
    }
    this.versus.noticeOpponentGone(sess);
    this.predict(dts, sess);
    this.renderViews();
    this.lastStand.render();
  }

  private drainInbox(sess: NetSession) {
    const auth = this.seat.authority;
    if (auth.kind !== "ready") {
      return;
    }
    const run = runTag(auth.runId);
    for (const arrival of this.inbox.splice(0)) {
      const s = readSnapshot(arrival.snap);
      if (
        !s ||
        s.run !== run ||
        s.term !== auth.term ||
        s.t <= this.room.guest.snapT ||
        s.room < this.room.seq
      ) {
        continue;
      }
      const cast = this.castOf(arrival.cast);
      const status = this.statusOf(arrival.status);
      if (
        !cast ||
        !status ||
        (s.room > this.room.seq && !this.enterRoom(s, status, arrival.room, sess))
      ) {
        continue;
      }
      this.apply(s, cast, status, arrival.at);
      if (this.run.state !== "active") {
        return;
      }
    }
  }

  private castOf(v: JsonValue | undefined): NetCast | null {
    if (v !== this.castRef) {
      this.castRef = v;
      this.cast = readCast(v);
    }
    return this.cast;
  }

  private statusOf(v: JsonValue | undefined): NetStatus | null {
    if (v !== this.statusRef) {
      this.statusRef = v;
      this.status = readStatus(v);
    }
    return this.status;
  }

  // The snapshot is for the next room: build it from the layout that came with it.
  private enterRoom(
    s: Snapshot,
    status: NetStatus,
    value: JsonValue | undefined,
    sess: NetSession,
  ): boolean {
    const layout = this.checkpoint.layoutOf(value);
    if (!layout || layout.seq !== s.room) {
      return false;
    }
    // Ticks predicted in the room being left reach the host as that room's.
    this.flushInput(sess, true);
    this.expedition.biome = status.biome;
    this.expedition.depth = status.depth;
    this.expedition.type = parseRoomType(layout.type) ?? "combat";
    this.rooms.buildFromNet(layout, status.biome);
    this.prediction.reset();
    this.remote.clear();
    this.remotePrev = null;
    this.driftX = 0;
    this.driftY = 0;
    return true;
  }

  private apply(s: Snapshot, cast: NetCast, status: NetStatus, at: number) {
    this.room.guest.snapT = s.t;
    this.clock.observe(s.t, at);
    this.run.hearts = status.hearts;
    this.run.maxHearts = status.maxHearts;
    this.run.gold = status.gold;
    this.run.score = status.score;
    this.expedition.biome = status.biome;
    this.expedition.depth = status.depth;
    const players = s.players.flatMap((row, i): SnapPlayer[] => {
      const named = cast.players[i];
      return named ? [{ ...decodePlayer(row), hero: named[1], id: named[0] }] : [];
    });
    this.room.guest.players = players;
    const myId = this.seat.session?.playerId;
    const mine = players.findIndex((p) => p.id === myId);
    const me = players[mine];
    if (me) {
      this.reconcileSelf(s, me, mine);
    }
    const other = players.find((p) => p.id !== myId);
    if (other) {
      if (this.ensureRemote(other.hero) || this.seat.remoteId !== other.id) {
        this.remote.clear();
        this.remotePrev = null;
      }
      this.seat.remoteId = other.id;
      this.remote.push(s.t, other, at);
    }
    if (this.seat.mode === "versus") {
      // Versus: per-duelist hearts + round state travel on s.vs; the shared
      // hearts / last-stand / shared-death rules don't apply.
      this.versus.applyNet(s.vs);
      this.applyProj(s);
      this.hooks.updateHud();
      return;
    }
    const downed = players.find((p) => p.downed)?.id ?? null;
    this.lastStand.applyNet(status.over ? null : s.lastStand, downed, status.hearts);
    this.applyEnemies(s, cast, at);
    this.applyBoss(s, status.biome, at);
    this.applyPayoffEdges(s, status.cleared);
    this.applyProj(s);
    for (const d of this.room.doors) {
      d.setActive(status.cleared);
    }
    this.hooks.updateHud();
    // Hearts hit 0 while a last stand is live → downed, not dead (yet).
    if (status.over || (this.run.hearts <= 0 && !this.run.downedNet)) {
      this.die();
    }
  }

  // My own row: replay what the host did to my body at the tick it did it,
  // then measure any drift against where I was after the acked tick.
  private reconcileSelf(s: Snapshot, me: SnapPlayer, row: number) {
    const ack = s.acks.find((a) => a.row === row);
    if (!ack) {
      return;
    }
    const { body } = this.seat.player;
    const edges = ack.edges.flatMap((e): GuestEdge[] => {
      const decoded = decodeEdge(e);
      return decoded ? [decoded] : [];
    });
    const jump = this.prediction.replay(body, edges);
    if (jump) {
      this.showJump(jump);
    }
    this.syncLife(me);
    this.prediction.reconcile(me.x, me.y, ack.ack, ack.age);
  }

  // The sim already stands where the host's copy will; the sprite eases over.
  private showJump(jump: Replayed) {
    if (jump.hurt) {
      this.seat.player.cueHurt();
    }
    this.driftX += jump.dx;
    this.driftY += jump.dy;
    if (jump.teleport || Math.hypot(this.driftX, this.driftY) > DRIFT_SNAP) {
      this.driftX = 0;
      this.driftY = 0;
    }
  }

  // After the edges my body's life state matches my row — unless an edge aged
  // out of the log while this tab stalled. Then take the host's word for it.
  private syncLife(me: SnapPlayer) {
    const { player } = this.seat;
    const b = player.body;
    if (me.downed !== b.downed) {
      b.applyEdge(me.downed ? { kind: "down" } : { kind: "revive" });
    }
    if (me.dead && !b.dead) {
      b.applyEdge({ kind: "dead" });
    } else if (!me.dead && b.dead) {
      player.respawn(this.room.grid, me.x, me.y);
      this.prediction.reset();
    }
  }

  // Accepted checkpoints dress the room and carry the relic list; snapshots
  // carry everything that moves. A missing or rejected one only leaves those
  // stale.
  private syncCheckpoint() {
    const read = this.checkpoint.accepted();
    if (read.kind !== "ready") {
      return;
    }
    const baseline = this.room.guest.progressTick < 0;
    if (this.syncProgress(read.value)) {
      this.checkpoint.syncRoomFeatures(read.value, baseline);
    }
  }

  /** Accepted presentation only: never apply modifiers or bank a guest's rewards. */
  syncProgress(c: ExpeditionCheckpoint): boolean {
    const auth = this.seat.authority;
    if (
      this.seat.role !== "guest" ||
      auth.kind !== "ready" ||
      c.runId !== auth.runId ||
      c.term !== auth.term ||
      c.room !== this.room.seq ||
      c.tick <= this.room.guest.progressTick
    ) {
      return false;
    }
    this.room.guest.progressTick = c.tick;
    this.run.ownedRelics = new Set(c.relics);
    return true;
  }

  /** Fresh same-room snapshots only. Initial cleared/dead states are quiet. */
  private applyPayoffEdges(s: Snapshot, cleared: boolean) {
    const boss = s.boss ? decodeBoss(s.boss) : null;
    const prev = this.room.guest.payoff;
    if (prev && prev.room === s.room) {
      if (prev.bossAlive && boss?.state === "dead") {
        this.progress.bossDefeatFx(boss.x, boss.y, this.expedition.biome);
        sfx.boom("essential");
        this.hooks.shake(420, 0.02);
        this.banners.show(`${bossKind(this.expedition.biome).name} SLAIN`, 1800, "payoff");
      }
      if (!prev.cleared && cleared) {
        this.progress.roomClearFx(this.expedition.type, this.expedition.biome);
      }
    }
    this.room.guest.payoff = {
      bossAlive: boss !== null && boss.state !== "dead",
      cleared,
      room: s.room,
      t: s.t,
    };
  }

  private applyEnemies(s: Snapshot, cast: NetCast, at: number) {
    const puppets = this.room.guest.enemyPuppets;
    const listed = new Set<number>();
    for (const row of s.enemies) {
      const [id] = row;
      listed.add(id);
      const pose = decodeEnemy(row);
      let p = puppets.get(id);
      if (!p) {
        const named = cast.enemies.find(([castId]) => castId === id);
        if (!named) {
          continue;
        }
        const [, name, tint] = named;
        const view = new Enemy(
          this.scene,
          this.room.grid,
          ENEMIES[parseEnemy(name)],
          pose.x,
          pose.y,
        );
        view.setBaseTint(tint);
        view.sprite.setVisible(false);
        p = {
          born: s.t,
          gone: null,
          hushUntil: 0,
          interp: new Interpolator<EnemyPose>({
            clock: this.clock,
            delayMs: INTERP_MS,
            lerp: lerpEnemy,
          }),
          prev: null,
          seen: s.t,
          view,
        };
        puppets.set(id, p);
      }
      p.seen = s.t;
      p.gone = null;
      p.interp.push(s.t, pose, at);
    }
    for (const [id, p] of puppets) {
      if (!listed.has(id) && p.gone === null) {
        p.gone = p.seen;
      }
    }
  }

  private applyBoss(s: Snapshot, biome: number, at: number) {
    const g = this.room.guest;
    if (!s.boss) {
      if (g.bossPuppet) {
        g.bossPuppet.view.destroy();
        g.bossPuppet = undefined;
        this.room.bossHp?.destroy();
        this.room.bossHpBg?.destroy();
        this.room.bossHp = undefined;
        this.room.bossHpBg = undefined;
      }
      return;
    }
    const pose = decodeBoss(s.boss);
    g.bossPuppet ??= {
      born: s.t,
      gone: null,
      hushUntil: 0,
      interp: new Interpolator<BossPose>({ clock: this.clock, delayMs: INTERP_MS, lerp: lerpBoss }),
      prev: null,
      seen: s.t,
      view: this.rooms.bossView(pose.x, pose.y, biome),
    };
    g.bossPuppet.seen = s.t;
    g.bossPuppet.interp.push(s.t, pose, at);
    // A dead/stale first snapshot stays quiet. A later live one can
    // establish the encounter even if that earlier packet built the puppet.
    if (pose.state !== "dead") {
      this.progress.announceBoss(biome);
    }
  }

  // Projectiles fly on fixed arcs: keep each one's newest row and draw it
  // dead-reckoned to render time — no stepping between snapshots.
  private applyProj(s: Snapshot) {
    const flying = this.room.guest.proj;
    const listed = new Set<number>();
    for (const row of s.proj) {
      const [id, code, x, y, vx, vy] = row;
      const kind = PROJ_KINDS[code];
      if (!kind) {
        continue;
      }
      listed.add(id);
      const p = flying.get(id);
      if (p) {
        Object.assign(p, { gone: null, t: s.t, vx, vy, x, y });
      } else {
        flying.set(id, {
          born: s.t,
          gone: null,
          kind,
          spr: this.projSprite(kind, vx),
          t: s.t,
          vx,
          vy,
          x,
          y,
        });
      }
    }
    for (const [id, p] of flying) {
      if (!listed.has(id) && p.gone === null) {
        p.gone = p.t;
      }
    }
  }

  // The host's projectile look (combat.ts spawn*), hidden until it is due.
  private projSprite(kind: ProjKind, vx: number): Phaser.GameObjects.Sprite {
    if (kind === "arrow") {
      return this.scene.add
        .sprite(0, 0, "fx:arrow")
        .setScale(0.3)
        .setDepth(40)
        .setFlipX(vx < 0)
        .setVisible(false);
    }
    const spr = this.scene.add
      .sprite(0, 0, "fx:flame-wave")
      .setScale(kind === "shot" ? 0.7 : 0.9)
      .setDepth(kind === "shot" ? 42 : 41)
      .setFlipX(vx < 0)
      .setVisible(false);
    if (kind === "hazard") {
      spr.setTint(bossKind(this.expedition.biome).tint);
    }
    spr.play("fx:flame-wave");
    return spr;
  }

  // Exactly one driver advances my body: the fixed-step sim on my own input.
  // Every tick also queues for the host; two at a time go up (30 Hz).
  private predict(dts: number, sess: NetSession) {
    const frozen =
      this.seat.mode === "versus" &&
      this.run.matchNet !== null &&
      vsPhaseFrozen(this.run.matchNet.phase);
    this.prediction.sample(this.seat.controlsPaused ? NEUTRAL_INPUT : this.seat.guestIn, frozen);
    const { body } = this.seat.player;
    this.run.acc = Math.min(this.run.acc + dts, MAX_LAG);
    let steps = 0;
    while (this.run.acc >= STEP && steps < MAX_STEPS) {
      this.prediction.step(body, this.stomps);
      this.run.acc -= STEP;
      steps += 1;
    }
    this.flushInput(sess);
    // Prediction is movement only: combat intents resolve on the host.
    body.pendingShot = null;
    body.pendingHeal = 0;
    const ease = Math.exp((-dts * 1000) / DRIFT_MS);
    this.driftX *= ease;
    this.driftY *= ease;
    this.seat.player.render(Math.min(this.run.acc / STEP, 1), this.driftX, this.driftY);
  }

  // Co-op stomps are my call, on the heads this screen shows: the bounce lands
  // the tick my feet do instead of a round trip later, and rides that tick to
  // the host, which lands the damage (combat.ts claimedStomp).
  private readonly stomps = (body: PlayerBody): boolean => {
    if (this.seat.mode !== "coop" || body.dead || body.downed || body.vy <= 20) {
      return false;
    }
    const now = performance.now();
    for (const p of this.room.guest.enemyPuppets.values()) {
      const pose = p.prev;
      const { kind } = p.view.body;
      if (
        pose &&
        pose.state !== "dead" &&
        p.view.sprite.visible &&
        onEnemyHead(body.x, body.y, pose.x, pose.y, kind)
      ) {
        p.hushUntil = now + STOMP_HUSH;
        hitSpark(this.scene, pose.x, pose.y - kind.h, COLORS.white, 8);
        sfx.hit();
        return true;
      }
    }
    const boss = this.room.guest.bossPuppet;
    if (
      boss?.prev &&
      boss.prev.state !== "dead" &&
      onBossHead(body.x, body.y, boss.prev.x, boss.view.body.hurtBox().top)
    ) {
      boss.hushUntil = now + STOMP_HUSH;
      sfx.hit();
      return true;
    }
    return false;
  };

  private flushInput(sess: NetSession, force = false) {
    const msg = this.prediction.flush(this.room.seq, force);
    if (msg) {
      sess.sendToHost("in", msg);
    }
  }

  // Puppets render INTERP_MS behind the host's clock; their cues fire off the
  // drawn pose, so a sound lands with the animation it belongs to.
  private renderViews() {
    if (!this.clock.synced) {
      return;
    }
    const now = performance.now();
    const renderAt = this.clock.now(now) - INTERP_MS;
    this.renderRemote(now);
    this.renderEnemies(now, renderAt);
    this.renderBoss(now);
    this.renderProj(renderAt);
  }

  private renderRemote(now: number) {
    const g = this.room.guest;
    if (
      this.seat.remote &&
      g.players.length > 0 &&
      !g.players.some((p) => p.id === this.seat.remoteId)
    ) {
      this.seat.remote.destroy();
      this.seat.remote = undefined;
      this.seat.remoteId = null;
      this.remote.clear();
      this.remotePrev = null;
      return;
    }
    const pup = this.seat.remote;
    const pose = this.remote.sample(now);
    if (!pup || !pose) {
      return;
    }
    if (this.remotePrev) {
      this.remoteCues(this.remotePrev, pose, pup);
    }
    this.remotePrev = pose;
    pup.applyPose(pose);
  }

  private remoteCues(prev: PlayerPose, next: PlayerPose, pup: Player) {
    if (next.dead || next.downed) {
      return;
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
    if (next.specialActive && next.specialId > prev.specialId) {
      const hero = HEROES[pup.name];
      this.combat.showSpecial(
        hero.kit.special.kind,
        next.x,
        next.y,
        next.facing,
        hero.color,
        false,
      );
    }
  }

  private renderEnemies(now: number, renderAt: number) {
    for (const [id, p] of this.room.guest.enemyPuppets) {
      if (p.gone !== null && renderAt > p.gone) {
        p.view.destroy();
        this.room.guest.enemyPuppets.delete(id);
        continue;
      }
      const pose = p.interp.sample(now);
      if (!pose) {
        continue;
      }
      const { prev } = p;
      if (prev && prev.state !== "dead" && pose.state === "dead") {
        impactRing(this.scene, pose.x, pose.y - p.view.body.kind.h / 2, COLORS.teal, 22);
        sfx.kill();
      } else if (prev && pose.flash && !prev.flash && now > p.hushUntil) {
        sfx.hit();
      }
      p.prev = pose;
      p.view.sprite.setVisible(renderAt >= p.born);
      p.view.applyPose(pose);
    }
  }

  private renderBoss(now: number) {
    const p = this.room.guest.bossPuppet;
    const pose = p?.interp.sample(now);
    if (!p || !pose) {
      return;
    }
    if (p.prev && pose.flash && !p.prev.flash && now > p.hushUntil) {
      sfx.hit();
    }
    p.prev = pose;
    p.view.applyPose(pose);
    if (this.room.bossHp) {
      this.room.bossHp.width = 258 * pose.hpFrac;
    }
  }

  private renderProj(renderAt: number) {
    for (const [id, p] of this.room.guest.proj) {
      if (p.gone !== null && renderAt > p.gone) {
        p.spr.destroy();
        this.room.guest.proj.delete(id);
        continue;
      }
      const dt = (renderAt - p.t) / 1000;
      const g = p.kind === "arrow" ? ARROW_GRAV : 0;
      p.spr
        .setVisible(renderAt >= p.born)
        .setPosition(Math.round(p.x + p.vx * dt), Math.round(p.y + p.vy * dt + 0.5 * g * dt * dt));
      if (p.kind === "arrow") {
        p.spr.setRotation(Math.atan2(p.vy + g * dt, p.vx) + (p.vx < 0 ? Math.PI : 0));
      }
    }
  }

  /** The other player's view for this hero; true when it had to be (re)built. */
  ensureRemote(heroRaw: string): boolean {
    const hero = parseHero(heroRaw) ?? "axion";
    if (this.seat.remote?.name === hero) {
      return false;
    }
    this.seat.remote?.destroy();
    this.seat.remote = this.hooks.spawnPlayer(
      HEROES[hero],
      this.room.grid,
      this.room.roomSpawn.x,
      this.room.roomSpawn.y,
    );
    return true;
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
