import { Math as PhaserMath } from "phaser";
import type { Hud } from "../render/hud";
import { now as simNow } from "../shared/clock";
import {
  ASTEROID_CULL_MARGIN,
  ASTEROID_ROT_SPEED,
  ASTEROID_SEED_COUNT,
  BASE_WORLD_H,
  BASE_WORLD_W,
  UFO_SPEED,
  WORLD_H,
  WORLD_W,
  playHeightForPlayers,
  playWidthForPlayers,
  spawnAsteroidState,
} from "../shared/constants";
import type { EnemyState, SharedState, Vec } from "../shared/constants";
import type { Link } from "../state/link";
import type { EnemyAi } from "../sys/enemy-ai";
import { inWorld, wrapAngle } from "../sys/geometry";
import type { Pickups } from "../sys/pickups";
import type { Shield } from "../sys/shield";
import type { HostDirector } from "./host-director";
import { adoptShared, emptyShared, indexById } from "./shared-world";
import { asWireRecord, wireNum } from "./wire-read";
import type { WireRecord, WireValue } from "./wire-read";
import {
  ASTEROIDS_KEY,
  BEACON_KEY,
  DETAILS_KEY,
  EPOCH_KEY,
  EPOCH_TRACK_MS,
  HOT_KEY,
  ITEMS_KEY,
  PULLS_KEY,
  SHARDS_KEY,
  SHOTS_KEY,
  UFO_KEY,
  isWorld,
  readAsteroidRow,
  readBeaconRow,
  readEnemyDetail,
  readEnemyMotion,
  readHot,
  readItemRow,
  readPullRow,
  readShardRow,
  readShotRow,
  readUfoRow,
  stepUfo,
  toSim,
} from "./world-wire";
import type { Aged, EnemyDetail } from "./world-wire";

export interface WorldSyncDeps {
  world: SharedState;
  link: Link;
  hud: Hud;
  shield: Shield;
  pickups: Pickups;
  host: HostDirector;
  ai: EnemyAi;
}

/** Past this a corrected entity jumps instead of gliding (a spawn, a
 *  teleport, a long stall) — px. */
const SNAP_DIST = 160;
/** Residual error bleeds into a corrected entity at this rate (1/s): ~0.1 s
 *  to settle, smooth however unevenly snapshots arrive. */
const CORRECTION_RATE = 10;
/** A wire epoch this close to the one the game last adopted is the same
 *  arena (ms): it follows the host's clock estimate by a few ms (world-wire
 *  EPOCH_TRACK_MS), which rows map through but play never sees. Arena epochs
 *  are minutes apart. */
const RESEND_SLACK_MS = 1000;
/** Edge cull for enemy shots (the host prunes past it too). */
const SHOT_CULL_MARGIN = 60;
/** Motion this copy may miss or gain against the clock (ms) — the frame
 *  clamp, the engine's smoothed delta — before every row is refolded. */
const LAG_REFOLD_MS = 50;

/** One keyed mover family's rows land in a local list through these. */
interface Fold<T extends { id: string; x: number; y: number; vx: number; vy: number }> {
  key: string;
  local: T[];
  read: (id: string, row: WireValue | undefined, epoch: number) => Aged<T> | null;
  /** Copy what the row says onto the local entity (all but its position). */
  update: (cur: T, row: T) => void;
  /** Still alive by this client's own rules (expiry, edge cull) at its
   *  predicted position. */
  keep: (e: T) => boolean;
  /** Ids already taken (claimed pickups, shots my shield ate): never re-added. */
  taken: ((id: string) => boolean) | null;
}

/** Host↔guest world sync: seeding the room world, adopting it on host promotion, and on guests the per-frame fold of each changed row into the dead-reckoned working copy. */
export class WorldSync {
  offlineSeeded = false;

  /** Shared-state object last decoded. */
  private decodedRef: WireRecord | null = null;

  /** Per row family, the row each entity was last folded from: an untouched
   *  row keeps its identity in the room's state, so it is skipped. */
  private readonly folded = new Map<string, Map<string, WireValue>>();

  /** The room value each single-value key (UFO, beacon, pulls) was last
   *  adopted from. */
  private readonly adopted = new Map<string, WireValue>();

  /** Enemy details by id, held until the enemy's first pose arrives. */
  private readonly details = new Map<string, EnemyDetail>();

  /** Arena time of the enemy motion set last folded in. */
  private hotAt = Number.NaN;

  /** Residual position error per corrected entity, bled in each frame. */
  private readonly posFix = new Map<Vec, { dx: number; dy: number }>();

  private readonly angleFix = new Map<EnemyState, number>();

  /** The working copy has taken in at least one room snapshot. */
  private worldLive = false;

  /** How far the working copy's motion trails the clock (ms): integrated
   *  with the engine's delta, it falls behind its rows on a clamped frame.
   *  Past LAG_REFOLD_MS the next decode refolds every row, not just the
   *  changed ones. */
  private lagMs = 0;

  /** Sim time of the last advance. */
  private advancedAt = Number.NaN;

  /** The epoch, on this clock, every row was last folded through. */
  private foldEpoch = Number.NaN;

  /** Wire (server-time) arena epoch the game last adopted: the local copy
   *  changes only when the arena does, never for a clock's revision of it —
   *  the boss tracker compares it exactly. */
  private rawEpoch = Number.NaN;

  private readonly world: SharedState;

  private readonly link: Link;

  private readonly hud: Hud;

  private readonly shield: Shield;

  private readonly pickups: Pickups;

  private readonly host: HostDirector;

  private readonly ai: EnemyAi;

  constructor(deps: WorldSyncDeps) {
    this.world = deps.world;
    this.link = deps.link;
    this.hud = deps.hud;
    this.shield = deps.shield;
    this.pickups = deps.pickups;
    this.host = deps.host;
    this.ai = deps.ai;
  }

  /** The room holds a world (solo: the local one is it). */
  roomHasWorld(): boolean {
    if (this.link.offline) {
      return this.offlineSeeded;
    }
    const s = this.link.sharedState;
    return s !== null && isWorld(s);
  }

  /** Server election alone is not adoption. Before host commands/ticks, a
   *  newly promoted host folds in the last snapshot it received and then
   *  keeps its OWN working copy: that copy has been dead-reckoned since the
   *  snapshot, while the server's copy is as old as the departing host's
   *  last send (seconds, when its tab went to sleep). Local ship, rewards
   *  and pending pickup guards remain owner-controlled. Its shares then
   *  carry on from the rows the old host wrote, rewriting only those its
   *  working copy no longer matches. */
  prepareHost(): boolean {
    if (this.link.offline) {
      return true;
    }
    if (!this.link.amHost) {
      this.link.hostSnapshotReady = false;
      return false;
    }
    if (this.link.hostSnapshotReady) {
      return true;
    }
    this.decode(simNow());
    if (!this.worldLive) {
      return false;
    }
    this.settleCorrections();
    this.link.hostSnapshotReady = true;
    // Existing migration policy: host-local AI is reconstructed, and the first
    // host tick rearms spawn/beacon cadence instead of bursting overdue spawns.
    this.ai.enemySim.clear();
    this.host.wasHost = false;
    // Admission is a baseline, not evidence that a missed encounter just
    // happened. Fresh events on the admitted world still announce normally.
    this.hud.bossEncounters.reset();
    this.hud.battleBeat.reset();
    this.hud.observeBossEncounters(this.world);
    return true;
  }

  /**
   * The first host to connect seeds the world (arenaEpoch = now + the opening
   * asteroid field). Guests adopt the host's existing state; a guest promoted
   * to host after a migration keeps the live world — and the epoch — instead
   * of resetting it. Polled every frame: an online seed waits for the room
   * clock (Link.connected), and a solo seed for the SDK's offline fallback,
   * and no socket message announces either.
   */
  ensureSeeded(): void {
    // Seed the opening asteroid field within the play bounds for the current
    // player count (so a multi-player arena opens fully populated, not just the
    // base 1-player box).
    const seedField = (s: SharedState): void => {
      const pc = Math.max(1, Object.keys(this.link.peers).length);
      s.playW = playWidthForPlayers(pc);
      s.playH = playHeightForPlayers(pc);
      for (let i = 0; i < ASTEROID_SEED_COUNT; i += 1) {
        s.asteroids.push(spawnAsteroidState(s.playW, s.playH));
      }
    };
    if (this.link.offline) {
      // Solo arena: seed the local world directly, nothing to broadcast.
      if (!this.offlineSeeded) {
        this.offlineSeeded = true;
        const seeded = emptyShared();
        seedField(seeded);
        adoptShared(this.world, seeded);
      }
      return;
    }
    if (this.link.amHost && this.link.connected && !this.roomHasWorld()) {
      const seeded = emptyShared();
      seedField(seeded);
      adoptShared(this.world, seeded);
      // We authored this world: our working copy is the authority from here,
      // so the SDK echo of the seed must not be adopted back over it.
      this.link.hostSnapshotReady = true;
      this.worldLive = true;
      this.host.shareNow(simNow());
    }
  }

  /** Guests, once per frame after the world advanced: fold in whatever the
   *  host sent since the last frame. */
  reconcile(now: number): void {
    if (!this.link.amHost) {
      this.decode(now);
    }
  }

  /** Movement integration — runs on every client for 60fps-smooth motion. A
   *  guest also bleeds in snapshot corrections and drops what expired or
   *  flew off by its own clock (the host deletes those rows too). */
  advanceWorld(dt: number, now: number): void {
    // Motion this copy missed (or gained) against the clock: a guest catches
    // up from its rows once it adds up, and a host's rows follow its copy
    // (world-wire DRIFT_PX).
    if (Number.isFinite(this.advancedAt)) {
      this.lagMs += now - this.advancedAt - dt * 1000;
    }
    this.advancedAt = now;
    const w = this.world;
    for (const a of w.asteroids) {
      a.x += a.vx * dt;
      a.y += a.vy * dt;
      a.rot += ASTEROID_ROT_SPEED * dt;
    }
    const u = w.ufo;
    if (u) {
      stepUfo(u, UFO_SPEED * dt);
    }
    for (const it of w.items) {
      it.x += it.vx * dt;
      it.y += it.vy * dt;
    }
    for (const s of w.shards) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    for (const e of w.enemies) {
      e.x = PhaserMath.Clamp(e.x + e.vx * dt, -40, w.playW + 40);
      e.y = PhaserMath.Clamp(e.y + e.vy * dt, -40, w.playH + 40);
    }
    for (const s of w.enemyShots) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
    }
    if (this.link.amHost) {
      return;
    }
    this.bleedCorrections(dt);
    w.asteroids = w.asteroids.filter((a) =>
      inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
    );
    w.enemyShots = w.enemyShots.filter(
      (s) => s.diesAt > now && inWorld(s.x, s.y, SHOT_CULL_MARGIN, w.playW, w.playH),
    );
    w.items = w.items.filter((it) => it.diesAt > now);
    w.shards = w.shards.filter((s) => s.diesAt > now);
    w.pulls = w.pulls.filter((p) => p.until > now);
    // The host drops an elapsed beacon silently too. Held past its end, a
    // guest promoted to host would find it and pay the hold out again.
    if (w.beacon && w.beacon.diesAt <= now) {
      w.beacon = null;
    }
  }

  private bleedCorrections(dt: number): void {
    const k = 1 - Math.exp(-CORRECTION_RATE * dt);
    for (const [e, fix] of this.posFix) {
      const sx = fix.dx * k;
      const sy = fix.dy * k;
      e.x += sx;
      e.y += sy;
      fix.dx -= sx;
      fix.dy -= sy;
      if (Math.abs(fix.dx) < 0.01 && Math.abs(fix.dy) < 0.01) {
        this.posFix.delete(e);
      }
    }
    for (const [e, da] of this.angleFix) {
      const step = da * k;
      e.angle += step;
      if (Math.abs(da - step) < 0.001) {
        this.angleFix.delete(e);
      } else {
        this.angleFix.set(e, da - step);
      }
    }
  }

  /** Apply every pending correction at once (taking over as host). */
  private settleCorrections(): void {
    for (const [e, fix] of this.posFix) {
      e.x += fix.dx;
      e.y += fix.dy;
    }
    for (const [e, da] of this.angleFix) {
      e.angle += da;
    }
    this.posFix.clear();
    this.angleFix.clear();
  }

  /** Move a local entity toward where the snapshot says it is now. */
  private correct(e: Vec, x: number, y: number): void {
    const dx = x - e.x;
    const dy = y - e.y;
    if (dx * dx + dy * dy > SNAP_DIST * SNAP_DIST) {
      e.x = x;
      e.y = y;
      this.posFix.delete(e);
    } else {
      this.posFix.set(e, { dx, dy });
    }
  }

  /** Fold the room snapshot into the working copy: every row that changed —
   *  every row, once the copy's motion has drifted off the clock or the
   *  epoch maps elsewhere — aged from its arena time to now. */
  private decode(now: number): void {
    const s = this.link.sharedState;
    const wireEpoch = s ? wireNum(s[EPOCH_KEY]) : null;
    if (!s || wireEpoch === null) {
      return;
    }
    // Arena times map through the epoch as this client's server clock reads
    // it now. A revised clock, here or on the host, moves it, and every row
    // folded through the old one is off by as much.
    const epoch = toSim(wireEpoch, { now, serverNow: this.link.serverAt(now) });
    const all =
      Math.abs(this.lagMs) > LAG_REFOLD_MS || !(Math.abs(epoch - this.foldEpoch) <= EPOCH_TRACK_MS);
    if (s === this.decodedRef && !all) {
      return;
    }
    this.decodedRef = s;
    if (all) {
      this.lagMs = 0;
      this.foldEpoch = epoch;
    }
    this.decodeArena(s, wireEpoch, epoch);
    const w = this.world;
    w.asteroids = this.fold(s, epoch, now, all, {
      keep: (a) => inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
      key: ASTEROIDS_KEY,
      local: w.asteroids,
      read: readAsteroidRow,
      taken: null,
      update: (cur, row) => {
        cur.vx = row.vx;
        cur.vy = row.vy;
        cur.radius = row.radius;
      },
    });
    w.enemyShots = this.fold(s, epoch, now, all, {
      keep: (shot) =>
        shot.diesAt > now && inWorld(shot.x, shot.y, SHOT_CULL_MARGIN, w.playW, w.playH),
      key: SHOTS_KEY,
      local: w.enemyShots,
      read: readShotRow,
      taken: (id) => this.shield.recentConsumedShots.has(id),
      update: (cur, row) => {
        cur.vx = row.vx;
        cur.vy = row.vy;
        cur.diesAt = row.diesAt;
      },
    });
    w.shards = this.fold(s, epoch, now, all, {
      keep: (shard) => shard.diesAt > now,
      key: SHARDS_KEY,
      local: w.shards,
      read: readShardRow,
      taken: (id) => this.pickups.shardTaken(id),
      update: (cur, row) => {
        cur.vx = row.vx;
        cur.vy = row.vy;
        cur.diesAt = row.diesAt;
      },
    });
    w.items = this.fold(s, epoch, now, all, {
      keep: (it) => it.diesAt > now,
      key: ITEMS_KEY,
      local: w.items,
      read: readItemRow,
      taken: (id) => this.pickups.itemTaken(id),
      update: (cur, row) => {
        cur.vx = row.vx;
        cur.vy = row.vy;
        cur.diesAt = row.diesAt;
      },
    });
    this.decodeUfo(s, epoch, now, all);
    this.decodeStatics(s, epoch);
    this.decodeEnemies(s, epoch, now);
    this.worldLive = true;
    this.hud.observeBossEncounters(w);
  }

  /** The rows of `key` last folded in, by id. */
  private foldedRows(key: string): Map<string, WireValue> {
    let rows = this.folded.get(key);
    if (!rows) {
      rows = new Map();
      this.folded.set(key, rows);
    }
    return rows;
  }

  /** Fold one keyed mover family: the room's keys are its whole membership,
   *  each row positioned at its own arena time and dead-reckoned to now. A
   *  row the room still holds unchanged was folded in before, so its entity
   *  carries on from the local copy — unless `all`. */
  private fold<T extends { id: string; x: number; y: number; vx: number; vy: number }>(
    s: WireRecord,
    epoch: number,
    now: number,
    all: boolean,
    spec: Fold<T>,
  ): T[] {
    const rows = asWireRecord(s[spec.key]);
    if (!rows) {
      return spec.local;
    }
    const seen = this.foldedRows(spec.key);
    const taken = spec.taken ?? (() => false);
    const byId = indexById(spec.local);
    const next: T[] = [];
    for (const [id, raw] of Object.entries(rows)) {
      if (taken(id)) {
        continue;
      }
      const cur = byId.get(id);
      if (cur && !all && seen.get(id) === raw) {
        next.push(cur);
        continue;
      }
      seen.set(id, raw);
      const row = spec.read(id, raw, epoch);
      if (!row) {
        continue;
      }
      const { e } = row;
      const ageS = Math.max(0, now - row.at) / 1000;
      e.x += e.vx * ageS;
      e.y += e.vy * ageS;
      if (!spec.keep(e)) {
        continue;
      }
      if (cur) {
        spec.update(cur, e);
        this.correct(cur, e.x, e.y);
        next.push(cur);
      } else {
        next.push(e);
      }
    }
    for (const id of seen.keys()) {
      if (!(id in rows)) {
        seen.delete(id);
      }
    }
    return next;
  }

  /** The arena's own fields. `wireEpoch` is the room's epoch, `epoch` the
   *  same moment on this client's sim clock. */
  private decodeArena(s: WireRecord, wireEpoch: number, epoch: number): void {
    const w = this.world;
    if (!(Math.abs(wireEpoch - this.rawEpoch) <= RESEND_SLACK_MS)) {
      this.rawEpoch = wireEpoch;
      w.arenaEpoch = epoch;
    }
    // Boss-guarantee marker (dir-006): adopt like the epoch so a promoted
    // host never double-guarantees.
    const bossIdx = wireNum(s["sectorBossIdx"]);
    if (bossIdx !== null) {
      w.sectorBossIdx = bossIdx;
    }
    // Clamp to valid bounds — never trust an out-of-range value from the host.
    const playW = wireNum(s["playW"]);
    if (playW !== null) {
      w.playW = PhaserMath.Clamp(playW, BASE_WORLD_W, WORLD_W);
    }
    const playH = wireNum(s["playH"]);
    if (playH !== null) {
      w.playH = PhaserMath.Clamp(playH, BASE_WORLD_H, WORLD_H);
    }
  }

  /** The room's `key` holds another value than the one last adopted (or
   *  `all`): adopt it. An unchanged one is never re-adopted, so a beacon or
   *  pull this copy already let elapse stays gone. */
  private changed(s: WireRecord, key: string, all: boolean): boolean {
    const raw = s[key];
    if (raw === undefined || (!all && this.adopted.get(key) === raw)) {
      return false;
    }
    this.adopted.set(key, raw);
    return true;
  }

  /** The UFO cruises to its host-picked destination; age it along that leg. */
  private decodeUfo(s: WireRecord, epoch: number, now: number, all: boolean): void {
    if (!this.changed(s, UFO_KEY, all)) {
      return;
    }
    const w = this.world;
    const row = readUfoRow(s[UFO_KEY], epoch);
    if (!row) {
      w.ufo = null;
      return;
    }
    const next = row.e;
    stepUfo(next, (UFO_SPEED * Math.max(0, now - row.at)) / 1000);
    const cur = w.ufo;
    if (!cur || cur.id !== next.id) {
      w.ufo = next;
      return;
    }
    cur.hp = next.hp;
    cur.blinkUntil = Math.max(cur.blinkUntil, next.blinkUntil);
    cur.destX = next.destX;
    cur.destY = next.destY;
    this.correct(cur, next.x, next.y);
  }

  /** Pulls and the beacon hold still: adopt them as sent. Phases and
   *  countdowns derive from their deadlines locally. */
  private decodeStatics(s: WireRecord, epoch: number): void {
    const w = this.world;
    if (this.changed(s, PULLS_KEY, false)) {
      const pulls = asWireRecord(s[PULLS_KEY]) ?? {};
      w.pulls = [];
      for (const [id, raw] of Object.entries(pulls)) {
        const p = readPullRow(id, raw, epoch);
        if (p) {
          w.pulls.push(p);
        }
      }
    }
    if (this.changed(s, BEACON_KEY, false)) {
      w.beacon = readBeaconRow(s[BEACON_KEY], epoch);
    }
  }

  /** Enemy details (kind, hp, telegraphs) arrive on change; every enemy's
   *  motion arrives each share and names who is alive. */
  private decodeEnemies(s: WireRecord, epoch: number, now: number): void {
    const w = this.world;
    const byId = indexById(w.enemies);
    const details = asWireRecord(s[DETAILS_KEY]);
    if (details) {
      const seen = this.foldedRows(DETAILS_KEY);
      for (const [id, raw] of Object.entries(details)) {
        if (seen.get(id) === raw) {
          continue;
        }
        seen.set(id, raw);
        const d = readEnemyDetail(id, raw, epoch);
        if (!d) {
          continue;
        }
        this.details.set(id, d);
        const cur = byId.get(id);
        if (cur) {
          applyDetail(cur, d);
        }
      }
      for (const id of seen.keys()) {
        if (!(id in details)) {
          seen.delete(id);
        }
      }
    }
    const hot = readHot(s[HOT_KEY]);
    if (!hot || hot.t === this.hotAt) {
      return;
    }
    this.hotAt = hot.t;
    const ageS = Math.max(0, now - (epoch + hot.t)) / 1000;
    const next: EnemyState[] = [];
    const live = new Set<string>();
    for (const raw of hot.rows) {
      const m = readEnemyMotion(raw);
      if (!m) {
        continue;
      }
      const px = m.x + m.vx * ageS;
      const py = m.y + m.vy * ageS;
      let e = byId.get(m.id);
      if (e) {
        this.correct(e, px, py);
        const da = wrapAngle(m.angle - e.angle);
        if (Math.abs(da) > 0.001) {
          this.angleFix.set(e, da);
        }
      } else {
        const d = this.details.get(m.id);
        // No details yet (they ride the same patch as a spawn): wait.
        if (!d) {
          continue;
        }
        e = { ...d, angle: m.angle, lances: [...d.lances], vx: m.vx, vy: m.vy, x: px, y: py };
      }
      e.vx = m.vx;
      e.vy = m.vy;
      live.add(m.id);
      next.push(e);
    }
    w.enemies = next;
    for (const id of this.details.keys()) {
      if (!live.has(id)) {
        this.details.delete(id);
      }
    }
  }
}

const applyDetail = (e: EnemyState, d: EnemyDetail): void => {
  e.hp = d.hp;
  e.maxHp = d.maxHp;
  e.shielded = d.shielded;
  e.telegraphUntil = d.telegraphUntil;
  e.chargeUntil = d.chargeUntil;
  e.attackAt = d.attackAt;
  // Keep the most pessimistic blink (local prediction may be ahead).
  e.blinkUntil = Math.max(e.blinkUntil, d.blinkUntil);
  e.graceUntil = d.graceUntil;
  // sniper/boss laser sights
  e.lances = d.lances;
};
