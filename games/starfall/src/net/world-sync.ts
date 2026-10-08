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
import type { EnemyState, SharedState, UfoState, Vec } from "../shared/constants";
import type { Link } from "../state/link";
import type { EnemyAi } from "../sys/enemy-ai";
import { inWorld, wrapAngle } from "../sys/geometry";
import type { Pickups } from "../sys/pickups";
import type { Shield } from "../sys/shield";
import type { HostDirector } from "./host-director";
import { adoptShared, emptyShared, indexById } from "./shared-world";
import { wireNum } from "./wire-read";
import type { WireRecord } from "./wire-read";
import {
  ASTEROIDS,
  BEACON,
  ENEMY_DETAILS,
  HOT_KEY,
  ITEMS,
  PULLS,
  SHARDS,
  SHOTS,
  UFO,
  bucketKey,
  bucketOf,
  isWorld,
  readAsteroidRow,
  readBeaconRow,
  readBucket,
  readEnemyDetail,
  readEnemyMotion,
  readItemRow,
  readPullRow,
  readShardRow,
  readShotRow,
  readUfoRow,
  toSim,
} from "./world-wire";
import type { Bucket, BucketFamily, BucketTime, EnemyDetail, WireClock } from "./world-wire";

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
/** Snapshot ages are clamped to this (ms): a bucket is re-sent every few
 *  seconds, so anything older is a stale clock, not a real age. */
const MAX_AGE_MS = 10_000;
/** A wire time this close to the one last adopted is the same moment sent
 *  again (ms): it rides as an offset from each share's stamp, so it can
 *  wobble by a millisecond, or a few when the host changes. Arena epochs and
 *  beacon starts are minutes apart. */
const RESEND_SLACK_MS = 1000;
/** Edge cull for enemy shots (the host prunes past it too). */
const SHOT_CULL_MARGIN = 60;

/** One family's rows land in a local list through these. */
interface Fold<T extends { id: string; x: number; y: number }> {
  family: BucketFamily;
  local: T[];
  read: (row: Bucket["rows"][number], at: BucketTime) => T | null;
  /** Copy what the row says onto the local entity (all but its position). */
  update: (cur: T, row: T) => void;
  /** Still alive by this client's own rules (expiry, edge cull) at its
   *  predicted position. */
  keep: (e: T) => boolean;
  /** Ids this client already took (pickups, consumed shots): never re-added. */
  claimed: ReadonlyMap<string, number> | null;
}

/** Host↔guest world sync: seeding the room world, adopting it on host promotion, and on guests the per-frame fold of each changed snapshot bucket into the dead-reckoned working copy. */
export class WorldSync {
  offlineSeeded = false;

  /** Shared-state object last decoded. */
  private decodedRef: WireRecord | null = null;

  /** Bucket key → stamp last folded in. */
  private readonly folded = new Map<string, number>();

  /** Enemy details by id, held until the enemy's first pose arrives. */
  private readonly details = new Map<string, EnemyDetail>();

  /** Residual position error per corrected entity, bled in each frame. */
  private readonly posFix = new Map<Vec, { dx: number; dy: number }>();

  private readonly angleFix = new Map<EnemyState, number>();

  /** The working copy has taken in at least one room snapshot. */
  private worldLive = false;

  /** Wire (server-time) arena epoch and beacon start last adopted: their
   *  local copies change only when the moment itself does, never for
   *  re-send jitter — the boss tracker and the beacon's instance check
   *  compare them exactly. */
  private rawEpoch = Number.NaN;

  private rawBeaconStart = Number.NaN;

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
   *  and pending pickup guards remain owner-controlled. */
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
    // Guests hold the old host's copies, which this encoder never sent: the
    // first share carries every bucket.
    this.host.markWorldDirty();
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
   * clock (Link.connected), and no socket message announces that.
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
   *  flew off by its own clock (the host never sends those removals). */
  advanceWorld(dt: number, now: number): void {
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

  /** Fold the room snapshot into the working copy: every bucket whose stamp
   *  moved, each row aged by the server clock to now. */
  private decode(now: number): void {
    const s = this.link.sharedState;
    if (!s || s === this.decodedRef || !isWorld(s)) {
      return;
    }
    this.decodedRef = s;
    const clock: WireClock = { now, serverNow: this.link.serverAt(now) };
    this.decodeArena(s, clock);
    const w = this.world;
    for (let i = 0; i < ASTEROIDS.buckets; i += 1) {
      w.asteroids = this.fold(s, i, clock, {
        claimed: null,
        family: ASTEROIDS,
        keep: (a) => inWorld(a.x, a.y, ASTEROID_CULL_MARGIN, w.playW, w.playH),
        local: w.asteroids,
        read: readAsteroidRow,
        update: (cur, row) => {
          cur.vx = row.vx;
          cur.vy = row.vy;
          cur.radius = row.radius;
        },
      });
    }
    for (let i = 0; i < SHOTS.buckets; i += 1) {
      w.enemyShots = this.fold(s, i, clock, {
        claimed: this.shield.recentConsumedShots,
        family: SHOTS,
        keep: (shot) =>
          shot.diesAt > now && inWorld(shot.x, shot.y, SHOT_CULL_MARGIN, w.playW, w.playH),
        local: w.enemyShots,
        read: readShotRow,
        update: (cur, row) => {
          cur.vx = row.vx;
          cur.vy = row.vy;
          cur.diesAt = row.diesAt;
        },
      });
    }
    for (let i = 0; i < SHARDS.buckets; i += 1) {
      w.shards = this.fold(s, i, clock, {
        claimed: this.pickups.recentShardPickups,
        family: SHARDS,
        keep: (shard) => shard.diesAt > now,
        local: w.shards,
        read: readShardRow,
        update: (cur, row) => {
          cur.vx = row.vx;
          cur.vy = row.vy;
          cur.diesAt = row.diesAt;
        },
      });
    }
    w.items = this.fold(s, 0, clock, {
      claimed: this.pickups.recentPickups,
      family: ITEMS,
      keep: (it) => it.diesAt > now,
      local: w.items,
      read: readItemRow,
      update: (cur, row) => {
        cur.vx = row.vx;
        cur.vy = row.vy;
        cur.diesAt = row.diesAt;
      },
    });
    this.decodeUfo(s, clock);
    this.decodeStatics(s, clock);
    this.decodeEnemies(s, clock);
    this.worldLive = true;
    this.hud.observeBossEncounters(w);
  }

  /** A bucket that changed since it was last folded in, with its age and
   *  the mapping of its stamp-relative times onto this client's sim clock. */
  private freshBucket(
    s: WireRecord,
    key: string,
    clock: WireClock,
  ): { bucket: Bucket; ageS: number; at: BucketTime } | null {
    const bucket = readBucket(s[key]);
    if (!bucket || this.folded.get(key) === bucket.t) {
      return null;
    }
    this.folded.set(key, bucket.t);
    const ageS = PhaserMath.Clamp(clock.serverNow - bucket.t, 0, MAX_AGE_MS) / 1000;
    const at: BucketTime = (rel) => toSim(bucket.t + rel, clock);
    return { ageS, at, bucket };
  }

  /** Fold one drifting family's bucket: its rows are the bucket's whole
   *  membership, positioned as of its stamp and dead-reckoned to now. */
  private fold<T extends { id: string; x: number; y: number; vx: number; vy: number }>(
    s: WireRecord,
    bucket: number,
    clock: WireClock,
    spec: Fold<T>,
  ): T[] {
    const { family, local, claimed } = spec;
    const fresh = this.freshBucket(s, bucketKey(family, bucket), clock);
    if (!fresh) {
      return local;
    }
    const byId = indexById(local);
    const ids = new Set<string>();
    for (const raw of fresh.bucket.rows) {
      const row = spec.read(raw, fresh.at);
      if (!row || claimed?.has(row.id)) {
        continue;
      }
      row.x += row.vx * fresh.ageS;
      row.y += row.vy * fresh.ageS;
      if (!spec.keep(row)) {
        continue;
      }
      ids.add(row.id);
      const cur = byId.get(row.id);
      if (cur) {
        spec.update(cur, row);
        this.correct(cur, row.x, row.y);
      } else {
        local.push(row);
      }
    }
    return local.filter(
      (e) =>
        (family.buckets > 1 && bucketOf(e.id, family.buckets) !== bucket) ||
        (ids.has(e.id) && !claimed?.has(e.id)),
    );
  }

  private decodeArena(s: WireRecord, clock: WireClock): void {
    const w = this.world;
    const epoch = wireNum(s["arenaEpoch"]);
    if (epoch !== null && !(Math.abs(epoch - this.rawEpoch) <= RESEND_SLACK_MS)) {
      this.rawEpoch = epoch;
      w.arenaEpoch = toSim(epoch, clock);
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

  /** The UFO cruises to its host-picked destination; age it along that leg. */
  private decodeUfo(s: WireRecord, clock: WireClock): void {
    const fresh = this.freshBucket(s, bucketKey(UFO, 0), clock);
    if (!fresh) {
      return;
    }
    const [raw] = fresh.bucket.rows;
    const next = raw ? readUfoRow(raw, fresh.at) : null;
    const w = this.world;
    if (!next) {
      w.ufo = null;
      return;
    }
    stepUfo(next, UFO_SPEED * fresh.ageS);
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
   *  countdowns derive from their (converted) deadlines locally. */
  private decodeStatics(s: WireRecord, clock: WireClock): void {
    const w = this.world;
    const pulls = this.freshBucket(s, bucketKey(PULLS, 0), clock);
    if (pulls) {
      w.pulls = [];
      for (const raw of pulls.bucket.rows) {
        const p = readPullRow(raw, pulls.at);
        if (p) {
          w.pulls.push(p);
        }
      }
    }
    const beacon = this.freshBucket(s, bucketKey(BEACON, 0), clock);
    if (beacon) {
      const [raw] = beacon.bucket.rows;
      const next = raw ? readBeaconRow(raw, beacon.at) : null;
      // The same beacon re-sent (control changed): keep its converted times.
      const start = raw ? beacon.bucket.t + (wireNum(raw[2]) ?? 0) : Number.NaN;
      if (next && w.beacon && Math.abs(start - this.rawBeaconStart) <= RESEND_SLACK_MS) {
        next.activeAt = w.beacon.activeAt;
        next.diesAt = w.beacon.diesAt;
      }
      this.rawBeaconStart = start;
      w.beacon = next;
    }
  }

  /** Enemy details (kind, hp, telegraphs) arrive on change; every enemy's
   *  motion arrives each share and names who is alive. */
  private decodeEnemies(s: WireRecord, clock: WireClock): void {
    const w = this.world;
    const byId = indexById(w.enemies);
    for (let i = 0; i < ENEMY_DETAILS.buckets; i += 1) {
      const detailBucket = this.freshBucket(s, bucketKey(ENEMY_DETAILS, i), clock);
      if (!detailBucket) {
        continue;
      }
      for (const raw of detailBucket.bucket.rows) {
        const d = readEnemyDetail(raw, detailBucket.at);
        if (!d) {
          continue;
        }
        this.details.set(d.id, d);
        const cur = byId.get(d.id);
        if (cur) {
          applyDetail(cur, d);
        }
      }
    }
    const fresh = this.freshBucket(s, HOT_KEY, clock);
    if (!fresh) {
      return;
    }
    const next: EnemyState[] = [];
    const live = new Set<string>();
    for (const raw of fresh.bucket.rows) {
      const m = readEnemyMotion(raw);
      if (!m) {
        continue;
      }
      const px = m.x + m.vx * fresh.ageS;
      const py = m.y + m.vy * fresh.ageS;
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

/** Advance a UFO up to `step` px toward its destination; it parks there
 *  (only the host picks the next one). */
const stepUfo = (u: UfoState, step: number): void => {
  const dx = u.destX - u.x;
  const dy = u.destY - u.y;
  const dist = Math.hypot(dx, dy);
  if (dist > step) {
    u.x += (dx / dist) * step;
    u.y += (dy / dist) * step;
  } else {
    u.x = u.destX;
    u.y = u.destY;
  }
};

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
