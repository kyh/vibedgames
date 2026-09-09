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
import { impactRing, popText } from "../sys/fx";
import { checkpointRng, restoreRng } from "../sys/rng";
import { VersusMatch } from "../sys/versus";
import type { GameScene } from "./game-scene";

type CheckpointCtx = Scene &
  Pick<
    GameScene,
    | "acc"
    | "arrows"
    | "authority"
    | "banners"
    | "boss"
    | "bossDeadT"
    | "cleared"
    | "combat"
    | "combatStates"
    | "combo"
    | "comboT"
    | "controlsPaused"
    | "cs"
    | "deadT"
    | "deadTimers"
    | "doors"
    | "enemies"
    | "fadeRect"
    | "feature"
    | "freeze"
    | "gold"
    | "grid"
    | "guest"
    | "hazards"
    | "hearts"
    | "heroName"
    | "hostNet"
    | "lastStand"
    | "livePlayers"
    | "maxHearts"
    | "merchantItems"
    | "mode"
    | "mods"
    | "neutralOnAdmission"
    | "offers"
    | "ownedRelics"
    | "ownerId"
    | "pendingOffer"
    | "player"
    | "progress"
    | "remote"
    | "remoteId"
    | "roomSpawn"
    | "rooms"
    | "run"
    | "runRecap"
    | "score"
    | "seatPlayer"
    | "seats"
    | "session"
    | "shots"
    | "spawnPlayer"
    | "state"
    | "transBuilt"
    | "transT"
    | "updateHud"
    | "versus"
  >;

// The expedition checkpoint: the host encodes its full private state for a
// takeover; a promoted host adopts it, and a guest replays its room features.
// Reads of the shared checkpoint are cached by reference so a frame never
// re-validates unchanged wire JSON.
export class CheckpointSync {
  private readonly scene: CheckpointCtx;
  ref: JsonValue | undefined;
  roomRef: JsonValue | undefined;
  cache: CheckpointRead = { kind: "absent" };
  adoptedTerminal: ExpeditionCheckpoint | null = null;

  constructor(scene: CheckpointCtx) {
    this.scene = scene;
  }

  accepted(): CheckpointRead {
    const shared = this.scene.session?.sharedState ?? null;
    if (shared?.checkpoint !== this.ref || shared?.room !== this.roomRef) {
      this.ref = shared?.checkpoint;
      this.roomRef = shared?.room;
      this.cache = readCheckpoint(shared);
    }
    return this.cache;
  }

  phase(): CheckpointPhase {
    if (this.scene.state === "dead") {
      return { elapsed: this.scene.deadT, kind: "dead" };
    }
    if (this.scene.state === "transition" && this.scene.pendingOffer) {
      return {
        built: this.scene.transBuilt,
        elapsed: this.scene.transT,
        kind: "transition",
        offer: this.scene.pendingOffer.type,
      };
    }
    return { kind: "active" };
  }

  encode(): ExpeditionCheckpoint | null {
    const auth = this.scene.authority;
    const writer = this.scene.session?.playerId;
    if (auth.kind !== "ready" || !writer) {
      return null;
    }
    // An unassigned late successor cannot replace either terminal roster body.
    // Keep the accepted result intact until an explicit same-party restart.
    if (this.scene.state === "dead" && this.adoptedTerminal) {
      return {
        ...structuredClone(this.adoptedTerminal),
        phase: { elapsed: this.scene.deadT, kind: "dead" },
        term: auth.term,
        tick: this.scene.hostNet.tick,
        writer,
      };
    }
    const enemies = this.scene.enemies.map((e) => {
      let id = this.scene.hostNet.enemyId.get(e);
      if (id === undefined) {
        id = this.scene.hostNet.enemyIdNext;
        this.scene.hostNet.enemyIdNext += 1;
        this.scene.hostNet.enemyId.set(e, id);
      }
      return {
        body: e.body.checkpoint(),
        deathAge: this.scene.deadTimers.get(e) ?? null,
        id,
        name: e.body.kind.name,
        tint: e.baseTint,
      };
    });
    const liveEnemies = new Set(this.scene.enemies);
    const enemyIds = (set: Set<Enemy>): number[] =>
      [...set].flatMap((e) => {
        const id = liveEnemies.has(e) ? this.scene.hostNet.enemyId.get(e) : undefined;
        return id === undefined ? [] : [id];
      });
    const players: CheckpointPlayer[] = [];
    for (const pl of this.scene.livePlayers()) {
      const id = this.scene.ownerId(pl);
      if (!id) {
        continue;
      }
      const hero = parseHero(pl.encode(id).hero);
      if (!hero) {
        continue;
      }
      const c = this.scene.cs(pl);
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
        versusHits: { ...this.scene.versus.seq(pl) },
      });
    }
    const playerIds = new Set(players.map((p) => p.id));
    const common = {
      accumulator: this.scene.acc,
      arrows: this.scene.arrows.map((a) => ({
        dmg: a.dmg,
        life: a.life,
        vx: a.vx,
        vy: a.vy,
        x: a.x,
        y: a.y,
      })),
      boss: this.scene.boss?.body.checkpoint() ?? null,
      bossDeathAge: this.scene.bossDeadT,
      cleared: this.scene.cleared,
      combo: this.scene.combo,
      comboTime: this.scene.comboT,
      enemies,
      feature: this.scene.feature
        ? { used: this.scene.feature.used, x: this.scene.feature.x, y: this.scene.feature.y }
        : null,
      freeze: this.scene.freeze,
      gold: this.scene.gold,
      hazards: this.scene.hazards.map((h) => ({
        dmg: h.dmg,
        hitPlayer: h.hitPlayer,
        life: h.life,
        vx: h.vx,
        x: h.x,
        y: h.y,
      })),
      hearts: this.scene.hearts,
      maxHearts: this.scene.maxHearts,
      merchant: this.scene.merchantItems.map((m) => ({
        bought: m.bought,
        relic: m.relic.id,
        x: m.x,
        y: m.y,
      })),
      mods: { ...this.scene.mods },
      nextEnemyId: this.scene.hostNet.enemyIdNext,
      phase: this.phase(),
      players,
      relics: [...this.scene.ownedRelics],
      rng: checkpointRng(),
      room: this.scene.hostNet.roomSeq,
      run: {
        biome: this.scene.run.biome,
        depth: this.scene.run.depth,
        offers: this.scene.offers.map((o) => o.type),
        type: this.scene.run.type,
      },
      runId: auth.runId,
      score: this.scene.score,
      seats: { ...this.scene.seats },
      shots: this.scene.shots.map((s) => {
        const owner = s.owner ? this.scene.ownerId(s.owner) : null;
        return {
          dmg: s.dmg,
          hit: enemyIds(s.hit),
          hitBoss: s.hitBoss,
          hitP: [...s.hitP].flatMap((p) => {
            const id = this.scene.ownerId(p);
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
      tick: this.scene.hostNet.tick,
      version: 1,
      writer,
    } satisfies Omit<ExpeditionCheckpoint, "mode" | "versus" | "lastStand">;
    if (this.scene.mode === "versus" && this.scene.versus.match) {
      return {
        ...common,
        lastStand: null,
        mode: "versus",
        versus: this.scene.versus.match.checkpoint(),
      };
    }
    const downedId = this.scene.lastStand.live
      ? this.scene.ownerId(this.scene.lastStand.live.pl)
      : null;
    return {
      ...common,
      lastStand:
        this.scene.lastStand.live && downedId
          ? {
              bleed: this.scene.lastStand.live.bleedT,
              id: downedId,
              revive: this.scene.lastStand.live.reviveT,
            }
          : null,
      mode: "coop",
      versus: null,
    };
  }

  /** Restore accepted simulation data without rerolling or replaying rewards. */
  adopt(c: ExpeditionCheckpoint, room: NetRoom): void {
    this.adoptedTerminal = c.phase.kind === "dead" ? structuredClone(c) : null;
    this.scene.mode = c.mode;
    this.scene.guest.biome = c.run.biome;
    this.scene.guest.depth = c.run.depth;
    this.scene.run.biome = c.run.biome;
    this.scene.run.depth = c.run.depth;
    this.scene.run.type = c.run.type;
    this.scene.rooms.buildFromNet(room);
    this.scene.banners.clear();
    this.scene.progress.bossAnnounced = true;
    this.adoptProgress(c);
    this.adoptPlayers(c);
    const byEnemyId = this.adoptEnemies(c);
    this.adoptCombat(c, byEnemyId);
    if (c.boss) {
      this.adoptBoss(c.boss, c.run.biome, c.room);
    }
    this.adoptProjectiles(c, byEnemyId);
    this.syncRoomFeatures(c, true);
    this.scene.versus.match = c.mode === "versus" ? new VersusMatch() : null;
    if (c.mode === "versus") {
      this.scene.versus.match?.restore(c.versus);
    }
    this.scene.versus.spawns = [
      this.scene.roomSpawn,
      { x: this.scene.grid.cols * TILE - this.scene.roomSpawn.x, y: this.scene.roomSpawn.y },
    ];
    this.adoptLastStand(c);
    this.scene.lastStand.net = null;
    this.scene.versus.net = null;
    this.scene.hostNet.remoteInputOwner = null;
    this.scene.guest.payoff = null;
    this.scene.guest.snapT = -1;
    this.scene.guest.reconciler.reset();
    this.adoptPhase(c);
    this.scene.fadeRect.setAlpha(0);
    this.scene.player.sprite.setVisible(true);
    this.scene.rooms.setupCamera();
    this.scene.updateHud();
    this.scene.versus.showAdoptedResult();
    // construction above has no gameplay draws; restore last
    restoreRng(c.rng);
  }

  private adoptProgress(c: ExpeditionCheckpoint) {
    this.scene.hostNet.roomSeq = c.room;
    this.scene.hostNet.tick = c.tick;
    this.scene.hostNet.acc = 0;
    this.scene.hostNet.checkpointAcc = 0;
    this.scene.hostNet.checkpointMark = null;
    this.scene.hostNet.enemyId = new WeakMap();
    this.scene.hostNet.enemyIdNext = c.nextEnemyId;
    this.scene.seats = { ...c.seats };
    this.scene.mods = { ...c.mods };
    this.scene.ownedRelics = new Set(c.relics);
    this.scene.offers = c.run.offers.map((type) => ({ type }));
    this.scene.hearts = c.hearts;
    this.scene.maxHearts = c.maxHearts;
    this.scene.gold = c.gold;
    this.scene.score = c.score;
    this.scene.combo = c.combo;
    this.scene.comboT = c.comboTime;
    this.scene.freeze = c.freeze;
    this.scene.acc = c.accumulator;
    this.scene.cleared = c.cleared;
    for (const door of this.scene.doors) {
      door.setActive(c.cleared);
    }
    this.scene.bossDeadT = c.bossDeathAge;
  }

  // My body restores in place (respawned only on a hero mismatch); the peer's
  // body is rebuilt from whichever checkpoint player is not me.
  private adoptPlayers(c: ExpeditionCheckpoint) {
    const me = c.players.find((p) => p.id === this.scene.session?.playerId);
    if (me && me.hero !== this.scene.heroName) {
      this.scene.player.destroy();
      this.scene.heroName = me.hero;
      this.scene.player = this.scene.spawnPlayer(
        HEROES[me.hero],
        this.scene.grid,
        me.body.x,
        me.body.y,
      );
    }
    if (me) {
      this.scene.player.body.restore(me.body);
    }
    if (this.scene.controlsPaused || this.scene.neutralOnAdmission) {
      this.scene.player.body.clearInput();
    }
    this.scene.neutralOnAdmission = false;
    this.scene.remote?.destroy();
    this.scene.remote = undefined;
    this.scene.remoteId = null;
    const peerId = this.scene.session?.otherPlayer()?.id;
    const other =
      c.players.find((p) => p.id === peerId) ??
      c.players.find((p) => p.id !== this.scene.session?.playerId);
    if (other) {
      this.scene.remote = this.scene.spawnPlayer(
        HEROES[other.hero],
        this.scene.grid,
        other.body.x,
        other.body.y,
      );
      this.scene.remote.body.restore(other.body);
      this.scene.remoteId = other.id;
    }
  }

  private adoptEnemies(c: ExpeditionCheckpoint): Map<number, Enemy> {
    const byEnemyId = new Map<number, Enemy>();
    for (const data of c.enemies) {
      const e = new Enemy(
        this.scene,
        this.scene.grid,
        ENEMIES[data.name],
        data.body.x,
        data.body.y,
      );
      e.body.restore(data.body);
      e.baseTint = data.tint;
      e.sprite.setTint(data.tint);
      this.scene.enemies.push(e);
      this.scene.hostNet.enemyId.set(e, data.id);
      byEnemyId.set(data.id, e);
      if (data.deathAge !== null) {
        this.scene.deadTimers.set(e, data.deathAge);
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
      const pl = this.scene.seatPlayer(p.id);
      if (!pl) {
        continue;
      }
      this.scene.combatStates.set(pl, {
        ...p.combat,
        hitSpecial: enemiesOf(p.combat.hitSpecial),
        hitSwing: enemiesOf(p.combat.hitSwing),
      });
      this.scene.versus.hitSeq.set(pl, { ...p.versusHits });
    }
  }

  private adoptBoss(boss: BossBodyCheckpoint, biome: number, room: number) {
    this.scene.guest.reconcileBoss(
      {
        clip: "salamander:idle",
        dead: boss.dead,
        flash: false,
        flip: boss.facing < 0,
        hpFrac: 1,
        telegraph: false,
        x: boss.x,
        y: boss.y,
      },
      biome,
      room,
    );
    const view = this.scene.guest.bossPuppet?.view;
    if (view) {
      this.scene.boss = view;
      view.body.restore(boss);
      this.scene.guest.bossPuppet = undefined;
    }
  }

  private adoptProjectiles(c: ExpeditionCheckpoint, byEnemyId: Map<number, Enemy>) {
    for (const a of c.arrows) {
      this.scene.combat.spawnArrow(a.x, a.y, a.vx, a.vy, a.dmg);
      const view = this.scene.arrows.at(-1);
      if (view) {
        view.life = a.life;
      }
    }
    for (const s of c.shots) {
      this.scene.combat.spawnShot(
        s.x,
        s.y,
        s.vx,
        s.vy,
        s.dmg,
        s.owner ? (this.scene.seatPlayer(s.owner) ?? null) : null,
      );
      const view = this.scene.shots.at(-1);
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
            const p = this.scene.seatPlayer(id);
            return p ? [p] : [];
          }),
        );
      }
    }
    for (const h of c.hazards) {
      this.scene.combat.spawnHazard(h.x, h.y, h.vx, h.dmg);
      const view = this.scene.hazards.at(-1);
      if (view) {
        view.life = h.life;
        view.hitPlayer = h.hitPlayer;
      }
    }
  }

  private adoptLastStand(c: ExpeditionCheckpoint) {
    const downed = c.lastStand ? this.scene.seatPlayer(c.lastStand.id) : undefined;
    this.scene.lastStand.live =
      c.lastStand && downed
        ? { bleedT: c.lastStand.bleed, pl: downed, reviveT: c.lastStand.revive }
        : null;
    // A seat the server has already dropped gets the same one-heart relief as a
    // partner leaving mid-last-stand.
    if (
      c.phase.kind !== "dead" &&
      c.lastStand &&
      !downed &&
      !this.scene.session?.players[c.lastStand.id]
    ) {
      this.scene.hearts = Math.max(this.scene.hearts, 1);
    }
  }

  private adoptPhase(c: ExpeditionCheckpoint) {
    this.scene.state = c.phase.kind;
    if (c.phase.kind !== "dead") {
      this.scene.runRecap = null;
    }
    this.scene.deadT = c.phase.kind === "dead" ? c.phase.elapsed : 0;
    this.scene.transT = c.phase.kind === "transition" ? c.phase.elapsed : 0;
    this.scene.transBuilt = c.phase.kind === "transition" && c.phase.built;
    this.scene.pendingOffer = c.phase.kind === "transition" ? { type: c.phase.offer } : null;
    if (c.phase.kind === "dead") {
      this.observeTerminal(c);
    }
  }

  observeTerminal(c: ExpeditionCheckpoint): void {
    // Receipts belong to local storage. An adopted result never banks twice or
    // claims the former host's banked amount as this client's earnings.
    if (!this.scene.runRecap) {
      this.scene.runRecap = {
        biome: c.run.biome,
        depth: c.run.depth,
        gold: c.gold,
        hero: this.scene.heroName,
        kind: "coop-guest",
      };
    }
    this.scene.state = "dead";
    this.scene.deadT = c.phase.kind === "dead" ? c.phase.elapsed : 0;
    this.scene.player.sprite.play(`${this.scene.heroName}:death`);
  }

  syncRoomFeatures(c: ExpeditionCheckpoint, baseline: boolean): void {
    for (let i = 0; i < c.merchant.length; i += 1) {
      const offer = c.merchant[i];
      if (!offer) {
        continue;
      }
      let item = this.scene.merchantItems[i];
      if (!item) {
        const relic = RELICS.find((r) => r.id === offer.relic);
        if (!relic) {
          continue;
        }
        this.scene.rooms.buildMerchantItem(relic, offer.x, offer.y, offer.bought);
        item = this.scene.merchantItems[i];
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
      if (!this.scene.feature) {
        this.scene.rooms.buildFeature(c.feature.x, c.feature.y);
      }
      const f = this.scene.feature;
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
