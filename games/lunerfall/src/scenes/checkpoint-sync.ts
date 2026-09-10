import type { Scene } from "phaser";

import { sfx } from "../audio/sfx";
import { COLORS, TILE } from "../config";
import { ENEMIES } from "../data/enemies";
import { HEROES } from "../data/heroes";
import { RARITY_COLOR, RELICS } from "../data/relics";
import type { BossBodyCheckpoint } from "../entities/boss-body";
import { Enemy } from "../entities/enemy";
import { readCheckpoint } from "../net/checkpoint";
import type {
  CheckpointPhase,
  CheckpointPlayer,
  CheckpointRead,
  ExpeditionCheckpoint,
} from "../net/checkpoint";
import type { JsonValue } from "../net/json";
import { parseHero } from "../net/parse";
import type { NetRoom } from "../net/snapshot";
import type { RoomState } from "../state/room-state";
import type { RunState } from "../state/run-state";
import { combatState, duelHits, livePlayers, ownerId, seatPlayer } from "../state/seat-state";
import type { SeatState } from "../state/seat-state";
import { impactRing, popText } from "../sys/fx";
import { checkpointRng, restoreRng } from "../sys/rng";
import { VersusMatch } from "../sys/versus";
import type { RunManager } from "../sys/run";
import type { BannerHud } from "./banner-hud";
import type { Combat } from "./combat";
import type { RoomBuilder } from "./room-builder";
import type { SceneChrome, SceneHooks } from "./scene-hooks";
import type { VersusFlow } from "./versus-flow";

export interface CheckpointSyncDeps {
  scene: Scene;
  run: RunState;
  expedition: RunManager;
  room: RoomState;
  seat: SeatState;
  banners: BannerHud;
  combat: Combat;
  rooms: RoomBuilder;
  versus: VersusFlow;
  chrome: SceneChrome;
  hooks: SceneHooks;
}

// The expedition checkpoint: the host encodes its full private state for a
// takeover; a promoted host adopts it, and a guest replays its room features.
// Reads of the shared checkpoint are cached by reference so a frame never
// re-validates unchanged wire JSON.
export class CheckpointSync {
  private readonly scene: Scene;
  private readonly run: RunState;
  private readonly expedition: RunManager;
  private readonly room: RoomState;
  private readonly seat: SeatState;
  private readonly banners: BannerHud;
  private readonly combat: Combat;
  private readonly rooms: RoomBuilder;
  private readonly versus: VersusFlow;
  private readonly chrome: SceneChrome;
  private readonly hooks: SceneHooks;
  private ref: JsonValue | undefined;
  private roomRef: JsonValue | undefined;
  private cache: CheckpointRead = { kind: "absent" };
  adoptedTerminal: ExpeditionCheckpoint | null = null;

  constructor(deps: CheckpointSyncDeps) {
    this.scene = deps.scene;
    this.run = deps.run;
    this.expedition = deps.expedition;
    this.room = deps.room;
    this.seat = deps.seat;
    this.banners = deps.banners;
    this.combat = deps.combat;
    this.rooms = deps.rooms;
    this.versus = deps.versus;
    this.chrome = deps.chrome;
    this.hooks = deps.hooks;
  }

  accepted(): CheckpointRead {
    const shared = this.seat.session?.sharedState ?? null;
    if (shared?.checkpoint !== this.ref || shared?.room !== this.roomRef) {
      this.ref = shared?.checkpoint;
      this.roomRef = shared?.room;
      this.cache = readCheckpoint(shared);
    }
    return this.cache;
  }

  phase(): CheckpointPhase {
    if (this.run.state === "dead") {
      return { elapsed: this.run.deadT, kind: "dead" };
    }
    if (this.run.state === "transition" && this.run.pendingOffer) {
      return {
        built: this.run.transBuilt,
        elapsed: this.run.transT,
        kind: "transition",
        offer: this.run.pendingOffer.type,
      };
    }
    return { kind: "active" };
  }

  encode(): ExpeditionCheckpoint | null {
    const auth = this.seat.authority;
    const writer = this.seat.session?.playerId;
    if (auth.kind !== "ready" || !writer) {
      return null;
    }
    // An unassigned late successor cannot replace either terminal roster body.
    // Keep the accepted result intact until an explicit same-party restart.
    if (this.run.state === "dead" && this.adoptedTerminal) {
      return {
        ...structuredClone(this.adoptedTerminal),
        phase: { elapsed: this.run.deadT, kind: "dead" },
        term: auth.term,
        tick: this.run.tick,
        writer,
      };
    }
    const enemies = this.room.enemies.map((e) => {
      let id = this.room.enemyIds.get(e);
      if (id === undefined) {
        id = this.room.nextEnemyId;
        this.room.nextEnemyId += 1;
        this.room.enemyIds.set(e, id);
      }
      return {
        body: e.body.checkpoint(),
        deathAge: this.room.deadTimers.get(e) ?? null,
        id,
        name: e.body.kind.name,
        tint: e.baseTint,
      };
    });
    const liveEnemies = new Set(this.room.enemies);
    const enemyIds = (set: Set<Enemy>): number[] =>
      [...set].flatMap((e) => {
        const id = liveEnemies.has(e) ? this.room.enemyIds.get(e) : undefined;
        return id === undefined ? [] : [id];
      });
    const players: CheckpointPlayer[] = [];
    for (const pl of livePlayers(this.seat)) {
      const id = ownerId(this.seat, pl);
      if (!id) {
        continue;
      }
      const hero = parseHero(pl.encode(id).hero);
      if (!hero) {
        continue;
      }
      const c = combatState(this.seat, pl);
      players.push({
        body: pl.body.checkpoint(),
        combat: {
          bossSpecial: c.bossSpecial,
          bossSwing: c.bossSwing,
          hitSpecial: enemyIds(c.hitSpecial),
          hitSwing: enemyIds(c.hitSwing),
          lastSpecial: c.lastSpecial,
          lastSwing: c.lastSwing,
        },
        hero,
        id,
        versusHits: { ...duelHits(this.seat, pl) },
      });
    }
    const playerIds = new Set(players.map((p) => p.id));
    const common = {
      accumulator: this.run.acc,
      arrows: this.room.arrows.map((a) => ({
        dmg: a.dmg,
        life: a.life,
        vx: a.vx,
        vy: a.vy,
        x: a.x,
        y: a.y,
      })),
      boss: this.room.boss?.body.checkpoint() ?? null,
      bossDeathAge: this.run.bossDeadT,
      cleared: this.run.cleared,
      combo: this.run.combo,
      comboTime: this.run.comboT,
      enemies,
      feature: this.room.feature
        ? { used: this.room.feature.used, x: this.room.feature.x, y: this.room.feature.y }
        : null,
      freeze: this.run.freeze,
      gold: this.run.gold,
      hazards: this.room.hazards.map((h) => ({
        dmg: h.dmg,
        hitPlayer: h.hitPlayer,
        life: h.life,
        vx: h.vx,
        x: h.x,
        y: h.y,
      })),
      hearts: this.run.hearts,
      maxHearts: this.run.maxHearts,
      merchant: this.room.merchantItems.map((m) => ({
        bought: m.bought,
        relic: m.relic.id,
        x: m.x,
        y: m.y,
      })),
      mods: { ...this.run.mods },
      nextEnemyId: this.room.nextEnemyId,
      phase: this.phase(),
      players,
      relics: [...this.run.ownedRelics],
      rng: checkpointRng(),
      room: this.room.seq,
      run: {
        biome: this.expedition.biome,
        depth: this.expedition.depth,
        offers: this.run.offers.map((o) => o.type),
        type: this.expedition.type,
      },
      runId: auth.runId,
      score: this.run.score,
      seats: { ...this.seat.seats },
      shots: this.room.shots.map((s) => {
        const owner = s.owner ? ownerId(this.seat, s.owner) : null;
        return {
          dmg: s.dmg,
          hit: enemyIds(s.hit),
          hitBoss: s.hitBoss,
          hitP: [...s.hitP].flatMap((p) => {
            const id = ownerId(this.seat, p);
            return id && playerIds.has(id) ? [id] : [];
          }),
          life: s.life,
          owner: owner && playerIds.has(owner) ? owner : null,
          vx: s.vx,
          vy: s.vy,
          x: s.x,
          y: s.y,
        };
      }),
      term: auth.term,
      tick: this.run.tick,
      version: 1,
      writer,
    } satisfies Omit<ExpeditionCheckpoint, "mode" | "versus" | "lastStand">;
    if (this.seat.mode === "versus" && this.run.match) {
      return {
        ...common,
        lastStand: null,
        mode: "versus",
        versus: this.run.match.checkpoint(),
      };
    }
    const downedId = this.run.downed ? ownerId(this.seat, this.run.downed.pl) : null;
    return {
      ...common,
      lastStand:
        this.run.downed && downedId
          ? {
              bleed: this.run.downed.bleedT,
              id: downedId,
              revive: this.run.downed.reviveT,
            }
          : null,
      mode: "coop",
      versus: null,
    };
  }

  /** Restore accepted simulation data without rerolling or replaying rewards. */
  adopt(c: ExpeditionCheckpoint, room: NetRoom): void {
    this.adoptedTerminal = c.phase.kind === "dead" ? structuredClone(c) : null;
    this.seat.mode = c.mode;
    this.expedition.biome = c.run.biome;
    this.expedition.depth = c.run.depth;
    this.expedition.type = c.run.type;
    this.rooms.buildFromNet(room, c.run.biome);
    this.banners.clear();
    this.room.bossAnnounced = true;
    this.adoptProgress(c);
    this.adoptPlayers(c);
    const byEnemyId = this.adoptEnemies(c);
    this.adoptCombat(c, byEnemyId);
    if (c.boss) {
      this.adoptBoss(c.boss, c.run.biome);
    }
    this.adoptProjectiles(c, byEnemyId);
    this.syncRoomFeatures(c, true);
    this.run.match = c.mode === "versus" ? new VersusMatch() : null;
    if (c.mode === "versus") {
      this.run.match?.restore(c.versus);
    }
    this.room.vsSpawns = [
      this.room.roomSpawn,
      { x: this.room.grid.cols * TILE - this.room.roomSpawn.x, y: this.room.roomSpawn.y },
    ];
    this.adoptLastStand(c);
    this.run.downedNet = null;
    this.run.matchNet = null;
    this.seat.remoteInputOwner = null;
    this.room.guest.payoff = null;
    this.room.guest.snapT = -1;
    this.room.guest.reconciler.reset();
    this.adoptPhase(c);
    this.chrome.fadeRect.setAlpha(0);
    this.seat.player.sprite.setVisible(true);
    this.rooms.setupCamera();
    this.hooks.updateHud();
    this.versus.showAdoptedResult();
    // construction above has no gameplay draws; restore last
    restoreRng(c.rng);
  }

  private adoptProgress(c: ExpeditionCheckpoint) {
    this.room.seq = c.room;
    this.run.tick = c.tick;
    this.room.enemyIds = new WeakMap();
    this.room.nextEnemyId = c.nextEnemyId;
    this.seat.seats = { ...c.seats };
    this.run.mods = { ...c.mods };
    this.run.ownedRelics = new Set(c.relics);
    this.run.offers = c.run.offers.map((type) => ({ type }));
    this.run.hearts = c.hearts;
    this.run.maxHearts = c.maxHearts;
    this.run.gold = c.gold;
    this.run.score = c.score;
    this.run.combo = c.combo;
    this.run.comboT = c.comboTime;
    this.run.freeze = c.freeze;
    this.run.acc = c.accumulator;
    this.run.cleared = c.cleared;
    for (const door of this.room.doors) {
      door.setActive(c.cleared);
    }
    this.run.bossDeadT = c.bossDeathAge;
  }

  // My body restores in place (respawned only on a hero mismatch); the peer's
  // body is rebuilt from whichever checkpoint player is not me.
  private adoptPlayers(c: ExpeditionCheckpoint) {
    const me = c.players.find((p) => p.id === this.seat.session?.playerId);
    if (me && me.hero !== this.seat.heroName) {
      this.seat.player.destroy();
      this.seat.heroName = me.hero;
      this.seat.player = this.hooks.spawnPlayer(
        HEROES[me.hero],
        this.room.grid,
        me.body.x,
        me.body.y,
      );
    }
    if (me) {
      this.seat.player.body.restore(me.body);
    }
    if (this.seat.controlsPaused || this.seat.neutralOnAdmission) {
      this.seat.player.body.clearInput();
    }
    this.seat.neutralOnAdmission = false;
    this.seat.remote?.destroy();
    this.seat.remote = undefined;
    this.seat.remoteId = null;
    const peerId = this.seat.session?.otherPlayer()?.id;
    const other =
      c.players.find((p) => p.id === peerId) ??
      c.players.find((p) => p.id !== this.seat.session?.playerId);
    if (other) {
      this.seat.remote = this.hooks.spawnPlayer(
        HEROES[other.hero],
        this.room.grid,
        other.body.x,
        other.body.y,
      );
      this.seat.remote.body.restore(other.body);
      this.seat.remoteId = other.id;
    }
  }

  private adoptEnemies(c: ExpeditionCheckpoint): Map<number, Enemy> {
    const byEnemyId = new Map<number, Enemy>();
    for (const data of c.enemies) {
      const e = new Enemy(this.scene, this.room.grid, ENEMIES[data.name], data.body.x, data.body.y);
      e.body.restore(data.body);
      e.baseTint = data.tint;
      e.sprite.setTint(data.tint);
      this.room.enemies.push(e);
      this.room.enemyIds.set(e, data.id);
      byEnemyId.set(data.id, e);
      if (data.deathAge !== null) {
        this.room.deadTimers.set(e, data.deathAge);
      }
    }
    return byEnemyId;
  }

  // Per-player hit dedup sets, re-pointed at the rebuilt enemy objects.
  private adoptCombat(c: ExpeditionCheckpoint, byEnemyId: Map<number, Enemy>) {
    const enemiesOf = (ids: number[]) =>
      new Set(
        ids.flatMap((id) => {
          const e = byEnemyId.get(id);
          return e ? [e] : [];
        }),
      );
    for (const p of c.players) {
      const pl = seatPlayer(this.seat, p.id);
      if (!pl) {
        continue;
      }
      this.seat.combatStates.set(pl, {
        ...p.combat,
        hitSpecial: enemiesOf(p.combat.hitSpecial),
        hitSwing: enemiesOf(p.combat.hitSwing),
      });
      this.seat.duelHits.set(pl, { ...p.versusHits });
    }
  }

  private adoptBoss(boss: BossBodyCheckpoint, biome: number) {
    const view = this.rooms.bossView(boss.x, boss.y, biome);
    view.body.restore(boss);
    this.room.boss = view;
  }

  private adoptProjectiles(c: ExpeditionCheckpoint, byEnemyId: Map<number, Enemy>) {
    for (const a of c.arrows) {
      this.combat.spawnArrow(a.x, a.y, a.vx, a.vy, a.dmg);
      const view = this.room.arrows.at(-1);
      if (view) {
        view.life = a.life;
      }
    }
    for (const s of c.shots) {
      this.combat.spawnShot(
        s.x,
        s.y,
        s.vx,
        s.vy,
        s.dmg,
        s.owner ? (seatPlayer(this.seat, s.owner) ?? null) : null,
      );
      const view = this.room.shots.at(-1);
      if (view) {
        view.life = s.life;
        view.hitBoss = s.hitBoss;
        view.hit = new Set(
          s.hit.flatMap((id) => {
            const e = byEnemyId.get(id);
            return e ? [e] : [];
          }),
        );
        view.hitP = new Set(
          s.hitP.flatMap((id) => {
            const p = seatPlayer(this.seat, id);
            return p ? [p] : [];
          }),
        );
      }
    }
    for (const h of c.hazards) {
      this.combat.spawnHazard(h.x, h.y, h.vx, h.dmg);
      const view = this.room.hazards.at(-1);
      if (view) {
        view.life = h.life;
        view.hitPlayer = h.hitPlayer;
      }
    }
  }

  private adoptLastStand(c: ExpeditionCheckpoint) {
    const downed = c.lastStand ? seatPlayer(this.seat, c.lastStand.id) : undefined;
    this.run.downed =
      c.lastStand && downed
        ? { bleedT: c.lastStand.bleed, pl: downed, reviveT: c.lastStand.revive }
        : null;
    // A seat the server has already dropped gets the same one-heart relief as a
    // partner leaving mid-last-stand.
    if (
      c.phase.kind !== "dead" &&
      c.lastStand &&
      !downed &&
      !this.seat.session?.players[c.lastStand.id]
    ) {
      this.run.hearts = Math.max(this.run.hearts, 1);
    }
  }

  private adoptPhase(c: ExpeditionCheckpoint) {
    this.run.state = c.phase.kind;
    if (c.phase.kind !== "dead") {
      this.run.runRecap = null;
    }
    this.run.deadT = c.phase.kind === "dead" ? c.phase.elapsed : 0;
    this.run.transT = c.phase.kind === "transition" ? c.phase.elapsed : 0;
    this.run.transBuilt = c.phase.kind === "transition" && c.phase.built;
    this.run.pendingOffer = c.phase.kind === "transition" ? { type: c.phase.offer } : null;
    if (c.phase.kind === "dead") {
      this.observeTerminal(c);
    }
  }

  observeTerminal(c: ExpeditionCheckpoint): void {
    // Receipts belong to local storage. An adopted result never banks twice or
    // claims the former host's banked amount as this client's earnings.
    if (!this.run.runRecap) {
      this.run.runRecap = {
        biome: c.run.biome,
        depth: c.run.depth,
        gold: c.gold,
        hero: this.seat.heroName,
        kind: "coop-guest",
      };
    }
    this.run.state = "dead";
    this.run.deadT = c.phase.kind === "dead" ? c.phase.elapsed : 0;
    this.seat.player.sprite.play(`${this.seat.heroName}:death`);
  }

  syncRoomFeatures(c: ExpeditionCheckpoint, baseline: boolean): void {
    for (let i = 0; i < c.merchant.length; i += 1) {
      const offer = c.merchant[i];
      if (!offer) {
        continue;
      }
      let item = this.room.merchantItems[i];
      if (!item) {
        const relic = RELICS.find((r) => r.id === offer.relic);
        if (!relic) {
          continue;
        }
        this.rooms.buildMerchantItem(relic, offer.x, offer.y, offer.bought);
        item = this.room.merchantItems[i];
      }
      if (!item) {
        continue;
      }
      const boughtNow = !item.bought && offer.bought;
      item.bought = offer.bought;
      item.g.setVisible(!offer.bought);
      if (boughtNow && !baseline) {
        impactRing(this.scene, item.x, item.y - 16, RARITY_COLOR[item.relic.rarity], 24);
        popText(this.scene, item.x, item.y - 30, item.relic.name, "#e83fa0");
        popText(this.scene, item.x, item.y - 12, `⬡ -${item.relic.price}`, "#ffd15c");
        sfx.pickup("local");
      }
    }
    if (c.feature) {
      if (!this.room.feature) {
        this.rooms.buildFeature(c.feature.x, c.feature.y);
      }
      const f = this.room.feature;
      if (f) {
        const usedNow = !f.used && c.feature.used;
        f.used = c.feature.used;
        f.g.setVisible(!f.used);
        if (usedNow && !baseline) {
          impactRing(this.scene, f.x, f.y - 14, COLORS.teal, 24);
          sfx.pickup("local");
        }
      }
    }
  }
}
