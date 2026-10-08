import type { Connection, ConnectionContext } from "partyserver";
import { routePartykitRequest, Server } from "partyserver";

import type {
  ClaimMap,
  InterestRule,
  Player,
  PlayerLimit,
  PlayerMap,
  RoomRules,
  ServerMessage,
  TickSync,
} from "@vibedgames/multiplayer";
import {
  EVICTION_TIMEOUT_MS,
  findStructuralIssue,
  HOST_LIVENESS_TIMEOUT_MS,
  MAX_CLAIM_KEY_LENGTH,
  MAX_CLAIM_TTL_MS,
  MAX_CLAIMS,
  MAX_INPUT_BYTES,
  MAX_INPUT_LEAD_TICKS,
  MAX_MESSAGE_BYTES,
  MAX_TICK_HISTORY,
  MAX_TICK_RATE,
  PING_INTERVAL_MS,
  RECONNECT_GRACE_MS,
  RECONNECT_TOKEN_QUERY_PARAM,
  ROOM_CAP_QUERY_PARAM,
  ROOM_RULES_QUERY_PARAM,
} from "@vibedgames/multiplayer";
import { getColorById } from "./color";

/**
 * Boundary types for untrusted client JSON. `JSON.parse` gives back `any`;
 * everything read off the wire funnels through these so game state stays a
 * concrete JSON shape instead of `unknown`.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** A state patch / snapshot: a plain JSON object keyed by game-owned fields. */
interface StateMap {
  [key: string]: JsonValue;
}

// `String(v) === v` holds exactly for primitive strings (strict equality
// never coerces), so this predicate is sound without a runtime `typeof`.
const isJsonString = (value: JsonValue | undefined): value is string => String(value) === value;

// JSON can only carry finite numbers, so this is the exact number test.
const isJsonNumber = (value: JsonValue | undefined): value is number => Number.isFinite(value);

const asStateMap = (value: JsonValue | undefined): StateMap | undefined =>
  value instanceof Object && !Array.isArray(value) ? value : undefined;

/**
 * A client message decoded at the wire boundary. Patch payloads stay raw
 * (`JsonValue`) here — the structural guard that accepts or drops them runs in
 * the handler so its logging stays with the decision. Unrecognized frames
 * still count as liveness.
 */
type IncomingMessage =
  | { type: "state_patch"; data: JsonValue | undefined }
  | { type: "player_state_patch"; data: JsonValue | undefined }
  | {
      type: "emit";
      data: {
        event: string;
        payload: JsonValue;
        to: JsonValue | undefined;
        except: JsonValue | undefined;
      };
    }
  | { type: "heartbeat" }
  | { type: "pong" }
  | { type: "time"; c: number }
  | { type: "claim"; key: string; ttl: number | null }
  | { type: "release"; key: string }
  | { type: "clear_claims"; prefix: string }
  | { type: "input"; v: JsonValue; n: number | null }
  | { type: "unrecognized" };

const isClaimKey = (value: JsonValue | undefined): value is string =>
  isJsonString(value) && value.length > 0 && value.length <= MAX_CLAIM_KEY_LENGTH;

/** Decode the room-feature messages: server time, claims, tick inputs. */
const decodeRoomMessage = (
  type: JsonValue | undefined,
  data: StateMap | undefined,
): IncomingMessage => {
  if (!data) {
    return { type: "unrecognized" };
  }
  switch (type) {
    case "time": {
      return isJsonNumber(data.c) ? { c: data.c, type: "time" } : { type: "unrecognized" };
    }
    case "claim": {
      const { key, ttl } = data;
      if (!isClaimKey(key)) {
        return { type: "unrecognized" };
      }
      return {
        key,
        ttl: isJsonNumber(ttl) && ttl > 0 ? Math.min(ttl, MAX_CLAIM_TTL_MS) : null,
        type: "claim",
      };
    }
    case "release": {
      return isClaimKey(data.key) ? { key: data.key, type: "release" } : { type: "unrecognized" };
    }
    case "clear_claims": {
      return isJsonString(data.prefix)
        ? { prefix: data.prefix, type: "clear_claims" }
        : { type: "unrecognized" };
    }
    case "input": {
      const { n } = data;
      return {
        n: isJsonNumber(n) && Number.isSafeInteger(n) ? n : null,
        type: "input",
        v: data.v ?? null,
      };
    }
    default: {
      return { type: "unrecognized" };
    }
  }
};

const decodeIncoming = (raw: JsonValue): IncomingMessage => {
  const message = asStateMap(raw);
  if (!message) {
    return { type: "unrecognized" };
  }
  const data = asStateMap(message.data);
  switch (message.type) {
    case "state_patch":
    case "player_state_patch": {
      return { data: message.data, type: message.type };
    }
    case "emit": {
      if (!data || !isJsonString(data.event)) {
        return { type: "unrecognized" };
      }
      return {
        // The wire contract types payload as required JSON; only a
        // hand-rolled client can omit it, and that relays as null.
        data: {
          event: data.event,
          except: data.except,
          payload: data.payload ?? null,
          to: data.to,
        },
        type: "emit",
      };
    }
    case "heartbeat":
    case "pong": {
      return { type: message.type };
    }
    default: {
      return decodeRoomMessage(message.type, data);
    }
  }
};

/**
 * Durable presence: identity plus the two liveness clocks, kept in the
 * connection's attachment so it survives Cloudflare's WebSocket hibernation
 * (which evicts the Durable Object instance but keeps the sockets). Tiny and
 * bounded — deliberately NOT the per-frame game state, which would risk the 2KB
 * attachment cap and cost a serialize every tick.
 *
 * - `aliveAt`: last time we heard *anything* on the keepalive channel (heartbeat
 *   or pong) — drives eviction. A hidden tab still pongs, so backgrounding never
 *   removes a player.
 * - `seenAt`: last time we heard a *non-pong* keepalive (heartbeat) — drives
 *   host-liveness migration. A hidden tab's rAF heartbeat pauses while it still
 *   pongs, so a backgrounded host loses the host role but keeps its seat.
 * - `token`: the client's secret reconnection token (query param), kept so a
 *   transport drop can park the seat in the grace map keyed by something only
 *   the owner knows. Never sent to peers.
 */
interface Presence {
  id: string;
  color: string;
  hue: string;
  seenAt: number;
  aliveAt: number;
  token: string;
}

/**
 * A seat held for a dropped player during the reconnection grace window:
 * identity + last per-player state, parked when the transport died and handed
 * back if the same secret token returns before `expiresAt`. Persisted under
 * `grace:{token}` so a hibernation mid-window can't silently forget the seat.
 */
interface GraceEntry {
  token: string;
  id: string;
  color: string;
  hue: string;
  state: StateMap;
  disconnectedAt: number;
  expiresAt: number;
}

/** A claimed key: who holds it, and until when (server ms) for a claim with a TTL. */
interface Claim {
  owner: string;
  until: number | null;
}

/** What survives a Durable Object restart mid-session (a deploy): the world and its claims. */
interface RoomSnapshot {
  shared: StateMap;
  claims: [string, Claim][];
}

/** One tick's input changes, as logged for replay. */
interface TickEntry {
  n: number;
  changes: Record<string, JsonValue>;
  /** Serialized size, for the log's budget. */
  chars: number;
}

/**
 * A tick room's clock and inputs. Not persisted: a restarted room starts a new
 * tick epoch. The log keeps the recent changes so a client back from a
 * transport blip replays the ticks it missed instead of losing sync.
 */
interface Ticker {
  epoch: number;
  ms: number;
  /** The last tick broadcast. */
  n: number;
  /** Every player's held input as of tick `n`. */
  held: Map<string, JsonValue>;
  /** The tick the log starts after, and every held input as of it. */
  base: number;
  baseHeld: Map<string, JsonValue>;
  /** Every tick after `base` whose inputs changed, oldest first. */
  log: TickEntry[];
  logChars: number;
  /** Input changes scheduled for future ticks (null = clear the player's input). */
  pending: Map<number, Map<string, JsonValue>>;
  timer: ReturnType<typeof setInterval>;
}

/** Fold one tick's changes into held inputs (null clears a player's). */
const applyInputChanges = (
  held: Map<string, JsonValue>,
  changes: Record<string, JsonValue>,
): void => {
  for (const [id, input] of Object.entries(changes)) {
    if (input === null) {
      held.delete(id);
    } else {
      held.set(id, input);
    }
  }
};

/** Durable, low-frequency room fields, persisted so they survive hibernation. */
const HOST_ID_KEY = "hostId";
const CAP_KEY = "cap";
const RULES_KEY = "rules";
const ROOM_KEY = "room";
const GRACE_PREFIX = "grace:";

const graceKey = (token: string): string => `${GRACE_PREFIX}${token}`;

/**
 * Upper bound on a single room's player cap, regardless of what a client
 * requests via the query param. Games are untrusted code, so we never let a
 * client size a room past this ceiling.
 */
const HARD_ROOM_CAP = 64;

/** Room snapshots are written at most this often, and never on the hot path. */
const PERSIST_DEBOUNCE_MS = 1000;
/** A snapshot larger than this is not persisted (one storage value's limit, with margin). */
const MAX_PERSISTED_BYTES = 120_000;
/** The tick log's budget: past it the oldest entries fold into the base, history or not. */
const MAX_TICK_LOG_CHARS = 64_000;
/** Bounded room rules: at most this many limited keys, keys this long. */
const MAX_LIMITS = 32;
const MAX_RULE_KEY_LENGTH = 64;

/** Separator for overflow sibling rooms: `home` → `home~2` → `home~3`. */
const OVERFLOW_SEP = "~";

/**
 * Given a room id, return the next overflow sibling. Picks an unusual
 * separator so a normal slug like `level-1` is never mistaken for an
 * overflow room (which would alias two distinct games onto one room).
 */
const nextOverflowRoom = (room: string): string => {
  const idx = room.lastIndexOf(OVERFLOW_SEP);
  if (idx !== -1) {
    const suffix = room.slice(idx + OVERFLOW_SEP.length);
    if (/^\d+$/u.test(suffix)) {
      return `${room.slice(0, idx)}${OVERFLOW_SEP}${Number(suffix) + 1}`;
    }
  }
  return `${room}${OVERFLOW_SEP}2`;
};

/**
 * Read a `to`/`except` id list off an untrusted client message: only a real
 * array counts (null = field absent or malformed), and non-string entries are
 * dropped rather than failing the whole event.
 */
const readIdList = (value: JsonValue | undefined): string[] | null => {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter(isJsonString);
};

/** A single query param off the connect request (untrusted client input).
 *  Shared by every param reader so the URL parse/shape lives in one place. */
const searchParam = (ctx: ConnectionContext, key: string): string | null =>
  new URL(ctx.request.url).searchParams.get(key);

/** Read the client-requested player cap, clamped to the hard ceiling. */
const readRoomCap = (ctx: ConnectionContext): number | null => {
  const raw = searchParam(ctx, ROOM_CAP_QUERY_PARAM);
  if (!raw) {
    return null;
  }
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- query string may carry trailing garbage; parseInt reads the leading digits, Number would give NaN
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(parsed, HARD_ROOM_CAP);
};

/** Read the client's reconnection token. Every SDK client sends one. */
const readReconnectToken = (ctx: ConnectionContext): string | null => {
  const raw = searchParam(ctx, RECONNECT_TOKEN_QUERY_PARAM);
  return raw && raw.length > 0 ? raw : null;
};

const isRuleKey = (value: JsonValue | undefined): value is string =>
  isJsonString(value) && value.length > 0 && value.length <= MAX_RULE_KEY_LENGTH;

const readInterest = (raw: JsonValue | undefined): InterestRule | null => {
  const rule = asStateMap(raw);
  const radius = rule?.radius;
  if (!rule || !isJsonNumber(radius) || radius <= 0) {
    return null;
  }
  return {
    radius,
    x: isRuleKey(rule.x) ? rule.x : "x",
    y: isRuleKey(rule.y) ? rule.y : "y",
  };
};

const readLimits = (raw: JsonValue | undefined): Record<string, PlayerLimit> | null => {
  const source = asStateMap(raw);
  if (!source) {
    return null;
  }
  const limits: Record<string, PlayerLimit> = {};
  for (const [key, value] of Object.entries(source).slice(0, MAX_LIMITS)) {
    const limit = asStateMap(value);
    if (!isRuleKey(key) || !limit) {
      continue;
    }
    const bounds: PlayerLimit = {};
    if (isJsonNumber(limit.min)) {
      bounds.min = limit.min;
    }
    if (isJsonNumber(limit.max)) {
      bounds.max = limit.max;
    }
    limits[key] = bounds;
  }
  return Object.keys(limits).length > 0 ? limits : null;
};

/** Read the room rules a client advertises (untrusted JSON), sanitized and bounded. */
const readRoomRules = (ctx: ConnectionContext): RoomRules | null => {
  const raw = searchParam(ctx, ROOM_RULES_QUERY_PARAM);
  if (!raw || raw.length > 4096) {
    return null;
  }
  let parsed: JsonValue;
  try {
    // SAFETY: JSON.parse output is a JSON value by construction.
    parsed = JSON.parse(raw) as JsonValue;
  } catch {
    return null;
  }
  const source = asStateMap(parsed);
  if (!source) {
    return null;
  }
  const rules: RoomRules = {};
  const { tickRate } = source;
  if (isJsonNumber(tickRate) && tickRate > 0) {
    rules.tickRate = Math.min(MAX_TICK_RATE, Math.max(1, tickRate));
  }
  const interest = readInterest(source.interest);
  if (interest) {
    rules.interest = interest;
  }
  const limits = readLimits(source.limits);
  if (limits) {
    rules.limits = limits;
  }
  return Object.keys(rules).length > 0 ? rules : null;
};

/** Whether a patch keeps every limited key in bounds (unlimited keys always pass). */
const withinLimits = (
  patch: StateMap,
  limits: Record<string, PlayerLimit> | undefined,
): boolean => {
  if (!limits) {
    return true;
  }
  for (const [key, limit] of Object.entries(limits)) {
    if (!(key in patch)) {
      continue;
    }
    const value = patch[key];
    if (!isJsonNumber(value)) {
      return false;
    }
    if (
      (limit.min !== undefined && value < limit.min) ||
      (limit.max !== undefined && value > limit.max)
    ) {
      return false;
    }
  }
  return true;
};

export class VgServer extends Server {
  /**
   * Room state is split by how it must behave under Cloudflare's WebSocket
   * Hibernation API, which partyserver uses: an idle Durable Object is evicted
   * and its instance destroyed, but the open sockets — and their attachments —
   * survive. The split also mirrors how game netcode separates a high-frequency,
   * drop-tolerant snapshot channel from low-frequency reliable bookkeeping.
   *
   * - PRESENCE (identity + liveness) lives on each connection's attachment (see
   *   `Presence`), NOT an instance map. A parallel map was emptied on every
   *   hibernation, after which `onMessage` dropped every surviving connection's
   *   messages (they were no longer "admitted"), freezing those players into
   *   ghosts. Deriving presence from the live sockets makes that unrepresentable.
   * - SNAPSHOT (per-player game state) is the hot channel: kept in memory,
   *   broadcast every tick, never persisted. It self-heals — clients re-send on
   *   reconnect. Persisting it would be pure write amplification.
   * - ROOM (shared state + claims) changes at most a few times a second, and is
   *   persisted debounced (PERSIST_DEBOUNCE_MS) and unconfirmed — never holding
   *   back a message — so a room survives a restart mid-session (a deploy)
   *   with its world intact.
   * - SESSION (`hostId`, `cap`, `rules`) changes rarely but MUST persist: a
   *   wiped host makes the real host's `state_patch` get rejected as non-host
   *   after a wake; a wiped cap lets a post-wake join exceed it. Mirrored in
   *   memory, written through to storage, rehydrated in `onStart()`.
   * - GRACE (held seats for dropped players) also persists: entries are written
   *   only on disconnect/reclaim/expiry (never on the hot path), are bounded by
   *   the room cap, and must survive hibernation or a mid-window wake would
   *   silently forget a seat the alarm was scheduled to expire. Mirrored in
   *   memory, rehydrated in `onStart()`.
   */
  private shared: StateMap = {};
  private snapshots = new Map<string, StateMap>();
  private hostId: string | null = null;
  private cap: number | null = null;
  private rules: RoomRules | null = null;
  private grace = new Map<string, GraceEntry>();
  private claims = new Map<string, Claim>();
  /**
   * Interest: each player's last position, and what each recipient has been
   * told about each other player — true visible, false hidden, absent unknown.
   * In memory only: after hibernation every pair is unknown, and the next
   * patch re-decides it with the whole state rather than a delta.
   */
  private positions = new Map<string, { x: number; y: number }>();
  private views = new Map<string, Map<string, boolean>>();
  private ticker: Ticker | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Rehydrate durable room fields before any handler runs (partyserver awaits this). */
  async onStart() {
    this.hostId = (await this.ctx.storage.get<string | null>(HOST_ID_KEY)) ?? null;
    this.cap = (await this.ctx.storage.get<number | null>(CAP_KEY)) ?? null;
    this.rules = (await this.ctx.storage.get<RoomRules | null>(RULES_KEY)) ?? null;
    const room = await this.ctx.storage.get<RoomSnapshot>(ROOM_KEY);
    if (room) {
      this.shared = room.shared;
      this.claims = new Map(room.claims);
    }
    this.grace = new Map<string, GraceEntry>();
    const held = await this.ctx.storage.list<GraceEntry>({ prefix: GRACE_PREFIX });
    for (const entry of held.values()) {
      this.grace.set(entry.token, entry);
    }
  }

  private async setHostId(id: string | null): Promise<void> {
    const previous = this.hostId;
    this.hostId = id;
    await this.ctx.storage.put(HOST_ID_KEY, id);
    // The host sees everyone, whatever the interest rule: it may be simulating
    // players far from its own avatar.
    if (id !== null && id !== previous) {
      this.revealAllTo(id);
    }
  }

  private async setCap(cap: number | null): Promise<void> {
    this.cap = cap;
    await this.ctx.storage.put(CAP_KEY, cap);
  }

  private async setRules(rules: RoomRules | null): Promise<void> {
    this.rules = rules;
    await this.ctx.storage.put(RULES_KEY, rules);
  }

  private toPlayer(presence: Presence): Player {
    return {
      color: presence.color,
      connected: true,
      hue: presence.hue,
      id: presence.id,
      state: this.snapshots.get(presence.id) ?? {},
    };
  }

  /**
   * The presence for a connection id, or undefined if not admitted. Iterated
   * rather than getConnection(id): partyserver's hibernating lookup THROWS
   * when two live sockets share an id — exactly the fast-reconnect race where
   * a client re-dials before the server sees the old transport die. Returning
   * the first socket that still has presence attached picks the live one; a
   * superseded socket has had its presence detached.
   */
  private presenceOf(id: string): Presence | undefined {
    return this.connectionOf(id)?.state ?? undefined;
  }

  /** The live, admitted connection for a player id (see presenceOf). */
  private connectionOf(id: string): Connection<Presence> | undefined {
    for (const connection of this.getConnections<Presence>()) {
      if (connection.id === id && connection.state) {
        return connection;
      }
    }
    return undefined;
  }

  /** The grace entry holding a seat for this player id, if any. */
  private graceById(id: string): GraceEntry | undefined {
    for (const entry of this.grace.values()) {
      if (entry.id === id) {
        return entry;
      }
    }
    return undefined;
  }

  /** Drop a held seat from the grace map and its persisted mirror. */
  private async consumeGrace(entry: GraceEntry): Promise<void> {
    this.grace.delete(entry.token);
    await this.ctx.storage.delete(graceKey(entry.token));
  }

  /**
   * Public player map: live connections (identity from the attachment, state
   * from the snapshot) plus held seats from the grace map, so a player mid-drop
   * is still in the room — just `connected: false` — and a late joiner's sync
   * includes them.
   */
  private players(): PlayerMap {
    const players: PlayerMap = {};
    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      if (presence) {
        players[connection.id] = this.toPlayer(presence);
      }
    }
    for (const entry of this.grace.values()) {
      if (entry.id in players) {
        continue;
      }
      players[entry.id] = {
        color: entry.color,
        connected: false,
        hue: entry.hue,
        id: entry.id,
        state: entry.state,
      };
    }
    return players;
  }

  /**
   * Count of seats in use — admitted connections plus seats held in grace —
   * optionally minus one connection id. Held seats count against the room cap;
   * that's what "keeping the slot" means.
   */
  private playerCount(excludeId?: string): number {
    // Seats are counted by player id, not per connection: during a fast
    // reconnect the re-dial and the not-yet-closed old socket briefly coexist
    // under one id, and counting both would spuriously bounce a joiner at
    // cap. The set also collapses a held seat with a live connection of the
    // same id, matching how players() presents the room.
    const seated = new Set<string>();
    for (const connection of this.getConnections<Presence>()) {
      if (connection.state) {
        seated.add(connection.id);
      }
    }
    for (const entry of this.grace.values()) {
      seated.add(entry.id);
    }
    if (excludeId !== undefined) {
      seated.delete(excludeId);
    }
    return seated.size;
  }

  /**
   * Per-recipient fan-out over admitted connections: `pick` returns the
   * serialized message for a recipient, or null to skip it. Serialization
   * stays with the caller (memoize via `??=` when variants repeat). A dead
   * socket never aborts the fan-out — the alarm sweep reaps it later.
   */
  private sendToEach(pick: (connection: Connection<Presence>) => string | null): void {
    for (const connection of this.getConnections<Presence>()) {
      if (!connection.state) {
        continue;
      }
      const raw = pick(connection);
      if (raw === null) {
        continue;
      }
      VgServer.sendTo(connection, raw);
    }
  }

  /** Send to one connection, tolerating a socket whose peer is already gone. */
  private static sendTo(connection: Connection<Presence>, raw: string): void {
    try {
      connection.send(raw);
    } catch {
      /* peer already gone */
    }
  }

  /**
   * Structural guard for an untrusted patch payload: the typed patch when it
   * passes, or null to drop the message. Shared by both patch handlers so the
   * check and its logging can't drift apart.
   */
  private static parsePatch(
    sender: Connection<Presence>,
    data: JsonValue | undefined,
    label: string,
  ): StateMap | null {
    const issue = findStructuralIssue(data ?? null);
    if (issue !== null) {
      console.warn(`Dropping ${label} from ${sender.id}: ${issue}`);
      return null;
    }
    // findStructuralIssue === null guarantees a plain object root.
    return asStateMap(data) ?? null;
  }

  /**
   * Mark a connection heard-from on the keepalive channel. `seen` is true for a
   * non-pong keepalive (heartbeat) — the signal a backgrounded tab stops sending.
   */
  private static touch(connection: Connection<Presence>, seen: boolean) {
    const presence = connection.state;
    if (!presence) {
      return;
    }
    const now = Date.now();
    connection.setState({ ...presence, aliveAt: now, seenAt: seen ? now : presence.seenAt });
  }

  /** Migrate host off a connection we haven't heard from within the liveness
   *  window (it vanished without a clean close). Picks the lowest-id live peer
   *  for determinism. No-op while the host is responsive or no live peer exists. */
  private async checkHostLiveness(): Promise<void> {
    const host = this.hostId;
    if (!host) {
      return;
    }
    const now = Date.now();
    const hostPresence = this.presenceOf(host);
    if (hostPresence && now - hostPresence.seenAt <= HOST_LIVENESS_TIMEOUT_MS) {
      return;
    }
    // A host whose seat is held in grace gets the same liveness window measured
    // from the drop: a short blip keeps the host role (their reconnect resumes
    // seamlessly), while a longer outage migrates it so shared state doesn't
    // freeze for everyone until the grace window lapses.
    if (!hostPresence) {
      const ghost = this.graceById(host);
      if (ghost && now - ghost.disconnectedAt <= HOST_LIVENESS_TIMEOUT_MS) {
        return;
      }
    }

    let next: Connection<Presence> | null = null;
    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      if (!presence || connection.id === host) {
        continue;
      }
      if (now - presence.seenAt > HOST_LIVENESS_TIMEOUT_MS) {
        continue;
      }
      if (!next || connection.id < next.id) {
        next = connection;
      }
    }
    if (!next) {
      return;
      // nobody healthier to hand off to — keep the current host
    }

    // Grace on the new host so we don't immediately re-migrate.
    const presence = next.state;
    if (presence) {
      next.setState({ ...presence, seenAt: now });
    }
    await this.setHostId(next.id);
    const hostMessage: ServerMessage = { data: { id: next.id }, type: "host" };
    this.broadcast(JSON.stringify(hostMessage), []);
  }

  async onConnect(connection: Connection<Presence>, ctx: ConnectionContext) {
    // Every SDK client presents a reconnection token; without one there is no
    // seat to hold across a drop, and nothing else in the room can work.
    const token = readReconnectToken(ctx);
    if (!token) {
      connection.close(4002, "reconnect_token_required");
      return;
    }
    // A returning token reclaims its held seat: that seat already counts
    // against the cap, so a reclaim is never bounced to overflow — it is the
    // same player sitting back down, not a new admission.
    const reclaimed = this.grace.get(token);
    if (reclaimed) {
      await this.consumeGrace(reclaimed);
    }

    // The room's effective cap for this admission decision: the sticky cap an
    // earlier admitted client established, or — if none yet — the cap this
    // client advertises. We don't persist the requested cap until we've
    // decided to admit (below), so a refused over-cap join can't retroactively
    // cap a room that never accepted it — which would otherwise also bounce
    // later, even uncapped, joins to overflow.
    const requestedCap = readRoomCap(ctx);
    const cap = this.cap ?? requestedCap;

    // Enforce the room cap before admitting the player. If full, point the
    // client at the overflow sibling and close — the SDK reconnects there.
    if (!reclaimed && cap !== null && this.playerCount(connection.id) >= cap) {
      const fullMessage: ServerMessage = {
        data: { capacity: cap, room: nextOverflowRoom(this.name) },
        type: "room_full",
      };
      connection.send(JSON.stringify(fullMessage));
      connection.close(4001, "room_full");
      return;
    }

    // Admitted: establish the room's cap and rules stickily from the first
    // admitted client that advertises them, so a later join that omits or
    // differs (a rogue or stale client) can't change how the room runs.
    if (this.cap === null && requestedCap !== null) {
      await this.setCap(requestedCap);
    }
    if (this.rules === null) {
      const rules = readRoomRules(ctx);
      if (rules) {
        await this.setRules(rules);
      }
    }
    this.ensureTicker();

    const now = Date.now();
    // A reclaim keeps its old color for continuity (same value when the
    // connection id is unchanged — getColorById is deterministic — but also
    // when PartySocket hands the client a fresh id).
    const { color, hue } = reclaimed ?? getColorById(connection.id);
    const presence: Presence = {
      aliveAt: now,
      color,
      hue,
      id: connection.id,
      seenAt: now,
      token,
    };
    connection.setState(presence);
    // Seat state: a reclaim resumes the held snapshot; a plain reconnect under
    // the same id (blip the server never saw close) keeps what's already there;
    // a genuinely new player starts empty.
    this.snapshots.set(
      connection.id,
      reclaimed ? reclaimed.state : (this.snapshots.get(connection.id) ?? {}),
    );

    // PartySocket normally reuses its connection id across reconnects, but if
    // the reclaim arrived under a fresh id, retire the old seat explicitly:
    // peers key everything by player id, so the old id must leave and — if it
    // held host — hand the role to the new id rather than to a bystander.
    if (reclaimed && reclaimed.id !== connection.id) {
      this.snapshots.delete(reclaimed.id);
      this.forgetPlayer(reclaimed.id);
      this.transferClaims(reclaimed.id, connection.id);
      const leftMessage: ServerMessage = { data: { id: reclaimed.id }, type: "player_left" };
      this.broadcast(JSON.stringify(leftMessage), [connection.id]);
      if (this.hostId === reclaimed.id) {
        await this.setHostId(connection.id);
        const hostMessage: ServerMessage = { data: { id: connection.id }, type: "host" };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }

    void this.scheduleSweep();
    if (!this.hostId) {
      await this.setHostId(connection.id);
    }
    // a fresh join is a good moment to evict a host that vanished while the room
    // was idle — so the newcomer lands in a live game, not a frozen one
    await this.checkHostLiveness();

    const syncMessage: ServerMessage = {
      data: {
        claims: this.claimMap(now),
        hostId: this.hostId ?? connection.id,
        players: this.players(),
        state: this.shared,
        tick: this.tickSync(),
        time: now,
      },
      type: "sync",
    };
    connection.send(JSON.stringify(syncMessage));

    const joinedMessage: ServerMessage = {
      data: this.toPlayer(presence),
      type: "player_joined",
    };
    this.broadcast(JSON.stringify(joinedMessage), [connection.id]);
    // The sync and the join carried whole states both ways, so in an interest
    // room every pair with the newcomer starts out visible.
    this.markVisibleBothWays(connection.id);
  }

  async onMessage(sender: Connection<Presence>, rawMessage: string): Promise<void> {
    try {
      // Admission gate: presence lives in the attachment, so a connection that
      // survived hibernation is still admitted even though its in-memory
      // snapshot was wiped — the next patch just re-fills it. A capacity-refused
      // connection carries no presence, so it cannot broadcast into the room.
      const presence = sender.state;
      if (!presence) {
        return;
      }

      // Refuse oversized frames before parsing: the platform would drop a
      // >1 MiB frame anyway, and parsing near-limit garbage burns DO CPU.
      if (rawMessage.length > MAX_MESSAGE_BYTES) {
        console.warn(`Dropping oversized message (${rawMessage.length} units) from ${sender.id}`);
        return;
      }

      const message = decodeIncoming(JSON.parse(rawMessage));

      switch (message.type) {
        case "player_state_patch": {
          // Hot path: snapshot + broadcast only. Liveness rides the heartbeat/
          // pong keepalive channel, so a per-tick stream costs no attachment write.
          const patch = VgServer.parsePatch(sender, message.data, "player_state_patch");
          if (patch === null) {
            break;
          }
          if (!withinLimits(patch, this.rules?.limits)) {
            console.warn(`Dropping out-of-bounds player_state_patch from ${sender.id}`);
            break;
          }
          const next = { ...this.snapshots.get(sender.id), ...patch };
          this.snapshots.set(sender.id, next);
          this.relayPlayerState(sender, patch, next);
          break;
        }
        case "state_patch": {
          // Shared state is host-authoritative: only the elected host can write.
          // Non-host writes get a `state` echo back so the client can rewind its
          // local mirror, and we drop the patch instead of relaying. Also a hot
          // path (host streams ~30×/s), so no attachment write here either.
          if (sender.id !== this.hostId) {
            const echo: ServerMessage = {
              data: this.shared,
              type: "state_patch",
            };
            sender.send(JSON.stringify(echo));
            break;
          }
          // The merge below spreads `data` into shared state, so a non-object
          // root (string/array) would scatter index keys into every room's
          // state; depth/forbidden-key checks bound what untrusted games store.
          const patch = VgServer.parsePatch(sender, message.data, "state_patch");
          if (patch === null) {
            break;
          }
          this.shared = {
            ...this.shared,
            ...patch,
          };
          const broadcastMessage: ServerMessage = {
            data: patch,
            type: "state_patch",
          };
          // Not echoed to the host: it applied this patch locally before
          // sending, so the echo is pure downlink — a whole-world snapshot
          // streamed at 30 Hz comes straight back at it — and an echo that
          // lands after a newer local write rolls the host's mirror back,
          // which then also hides the next real change from the SDK's diff.
          this.broadcast(JSON.stringify(broadcastMessage), [sender.id]);
          this.markRoomDirty();
          break;
        }
        case "heartbeat": {
          // The keepalive that pauses when a tab is hidden — refreshes both
          // clocks and is the cadence we re-check host liveness on.
          VgServer.touch(sender, true);
          await this.checkHostLiveness();
          break;
        }
        case "pong": {
          // Answers a server ping even from a hidden tab: proves reachable
          // (aliveAt) but not running (seenAt untouched).
          VgServer.touch(sender, false);
          break;
        }
        case "time": {
          // Server-clock probe: answered at once with this instant's clock, so
          // the client can read the offset off the round trip.
          const reply: ServerMessage = { data: { c: message.c, s: Date.now() }, type: "time" };
          sender.send(JSON.stringify(reply));
          break;
        }
        case "claim": {
          this.handleClaim(sender, message.key, message.ttl);
          break;
        }
        case "release": {
          this.handleRelease(sender, message.key);
          break;
        }
        case "clear_claims": {
          this.handleClearClaims(sender, message.prefix);
          break;
        }
        case "input": {
          this.handleInput(sender, message.v, message.n);
          break;
        }
        case "emit": {
          VgServer.touch(sender, true);
          this.relayEvent(sender, message.data);
          break;
        }
        default: {
          VgServer.touch(sender, true);
          break;
        }
      }
    } catch (error) {
      console.error("Error handling message", error);
    }
  }

  /** Relay a game event: to everyone (sender included) or to the `to` list, minus `except`. */
  private relayEvent(
    sender: Connection<Presence>,
    data: Extract<IncomingMessage, { type: "emit" }>["data"],
  ): void {
    const eventMessage: ServerMessage = {
      data: { event: data.event, from: sender.id, payload: data.payload },
      type: "event",
    };
    const raw = JSON.stringify(eventMessage);
    // Ids come from an untrusted client, so re-validate the shape instead of
    // trusting the parsed type.
    const to = readIdList(data.to);
    const except = readIdList(data.except);
    if (to === null) {
      this.broadcast(raw, except ?? []);
      return;
    }
    // `to` wins, minus `except`; deliver only to admitted players so a
    // capacity-refused connection can never be reached by id.
    const targets = new Set(to);
    const excluded = new Set(except);
    this.sendToEach((connection) =>
      targets.has(connection.id) && !excluded.has(connection.id) ? raw : null,
    );
  }

  // -- Interest ------------------------------------------------------------

  /** Record a player's position from its merged state (interest rooms only). */
  private updatePosition(id: string, state: StateMap): void {
    const rule = this.rules?.interest;
    if (!rule) {
      return;
    }
    const x = state[rule.x ?? "x"];
    const y = state[rule.y ?? "y"];
    if (isJsonNumber(x) && isJsonNumber(y)) {
      this.positions.set(id, { x, y });
    }
  }

  /** Whether `recipient` should receive `subject`'s player state. */
  private inRange(recipient: string, subject: string): boolean {
    const rule = this.rules?.interest;
    if (!rule || recipient === this.hostId) {
      return true;
    }
    const a = this.positions.get(recipient);
    const b = this.positions.get(subject);
    if (!a || !b) {
      return true;
    }
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= rule.radius ** 2;
  }

  private viewOf(recipient: string): Map<string, boolean> {
    let view = this.views.get(recipient);
    if (!view) {
      view = new Map();
      this.views.set(recipient, view);
    }
    return view;
  }

  /** In interest rooms, record that `id` and every admitted player see each other. */
  private markVisibleBothWays(id: string): void {
    if (!this.rules?.interest) {
      return;
    }
    const own = this.viewOf(id);
    for (const connection of this.getConnections<Presence>()) {
      if (connection.state && connection.id !== id) {
        own.set(connection.id, true);
        this.viewOf(connection.id).set(id, true);
      }
    }
  }

  /** Bring `subject` into `recipient`'s view: its whole state, then the flag. */
  private reveal(recipient: Connection<Presence>, subject: string): void {
    this.viewOf(recipient.id).set(subject, true);
    const state: ServerMessage = {
      data: { id: subject, state: this.snapshots.get(subject) ?? {} },
      type: "player_state",
    };
    const visible: ServerMessage = {
      data: { id: subject, visible: true },
      type: "player_visibility",
    };
    VgServer.sendTo(recipient, JSON.stringify(state));
    VgServer.sendTo(recipient, JSON.stringify(visible));
  }

  private conceal(recipient: Connection<Presence>, subject: string): void {
    this.viewOf(recipient.id).set(subject, false);
    const message: ServerMessage = {
      data: { id: subject, visible: false },
      type: "player_visibility",
    };
    VgServer.sendTo(recipient, JSON.stringify(message));
  }

  /** A new host sees everyone again. */
  private revealAllTo(id: string): void {
    const view = this.views.get(id);
    const connection = this.connectionOf(id);
    if (!view || !connection) {
      return;
    }
    for (const [subject, visible] of view) {
      if (!visible) {
        this.reveal(connection, subject);
      }
    }
  }

  /**
   * Fan a player-state patch out: the keyed delta to everyone in range, and —
   * in interest rooms — visibility changes both ways: who can now see the
   * sender, and (the sender having moved) whom the sender can now see. A pair
   * whose visibility is unknown (after hibernation) is re-decided with the
   * whole state, never a delta the recipient could not merge.
   */
  private relayPlayerState(sender: Connection<Presence>, patch: StateMap, next: StateMap): void {
    const delta = JSON.stringify({
      data: { id: sender.id, state: patch },
      type: "player_state",
    } satisfies ServerMessage);
    if (!this.rules?.interest) {
      this.sendToEach((connection) => (connection.id === sender.id ? null : delta));
      return;
    }
    this.updatePosition(sender.id, next);
    const senderView = this.viewOf(sender.id);
    for (const connection of this.getConnections<Presence>()) {
      if (!connection.state || connection.id === sender.id) {
        continue;
      }
      const shown = this.viewOf(connection.id).get(sender.id);
      if (!this.inRange(connection.id, sender.id)) {
        if (shown !== false) {
          this.conceal(connection, sender.id);
        }
      } else if (shown === true) {
        VgServer.sendTo(connection, delta);
      } else {
        this.reveal(connection, sender.id);
      }
      // What the sender sees changes with its own position, even of players
      // who are standing still and sending nothing.
      const sees = this.inRange(sender.id, connection.id);
      const seen = senderView.get(connection.id);
      if (sees && seen !== true) {
        this.reveal(sender, connection.id);
      } else if (!sees && seen !== false) {
        this.conceal(sender, connection.id);
      }
    }
  }

  /** Drop a departed player from every interest index. */
  private forgetPlayer(id: string): void {
    this.positions.delete(id);
    this.views.delete(id);
    for (const view of this.views.values()) {
      view.delete(id);
    }
  }

  // -- Claims --------------------------------------------------------------

  /** Live claims as the wire map, dropping (not announcing) any that lapsed. */
  private claimMap(now: number): ClaimMap {
    const map: ClaimMap = {};
    for (const [key, claim] of this.claims) {
      if (claim.until !== null && claim.until <= now) {
        continue;
      }
      map[key] =
        claim.until === null ? { owner: claim.owner } : { owner: claim.owner, until: claim.until };
    }
    return map;
  }

  private static claimMessage(key: string, claim: Claim | null): string {
    const message: ServerMessage = {
      data:
        claim?.until === null || claim?.until === undefined
          ? { key, owner: claim?.owner ?? null }
          : { key, owner: claim.owner, until: claim.until },
      type: "claim",
    };
    return JSON.stringify(message);
  }

  /** A player reclaimed its seat under a fresh id: its claims follow it. */
  private transferClaims(from: string, to: string): void {
    for (const [key, claim] of this.claims) {
      if (claim.owner === from) {
        const moved: Claim = { owner: to, until: claim.until };
        this.claims.set(key, moved);
        this.broadcast(VgServer.claimMessage(key, moved), []);
        this.markRoomDirty();
      }
    }
  }

  /**
   * First come, first served: a free (or lapsed) key goes to the claimer and
   * everyone hears it; a held key stays put and only the claimer hears who
   * holds it. One hop, and the host has no edge over anyone.
   */
  private handleClaim(sender: Connection<Presence>, key: string, ttl: number | null): void {
    const now = Date.now();
    const current = this.claims.get(key);
    const live = current && (current.until === null || current.until > now) ? current : null;
    if (live && live.owner !== sender.id) {
      VgServer.sendTo(sender, VgServer.claimMessage(key, live));
      return;
    }
    if (!current && this.claims.size >= MAX_CLAIMS) {
      VgServer.sendTo(sender, VgServer.claimMessage(key, null));
      return;
    }
    const claim: Claim = { owner: sender.id, until: ttl === null ? null : now + ttl };
    this.claims.set(key, claim);
    this.broadcast(VgServer.claimMessage(key, claim), []);
    this.markRoomDirty();
    if (claim.until !== null) {
      // Wake for the expiry, so everyone hears the release on time.
      void this.scheduleSweep();
    }
  }

  private handleRelease(sender: Connection<Presence>, key: string): void {
    const current = this.claims.get(key);
    if (!current || (current.owner !== sender.id && sender.id !== this.hostId)) {
      return;
    }
    this.claims.delete(key);
    this.broadcast(VgServer.claimMessage(key, null), []);
    this.markRoomDirty();
  }

  private handleClearClaims(sender: Connection<Presence>, prefix: string): void {
    if (sender.id !== this.hostId) {
      return;
    }
    for (const key of this.claims.keys()) {
      if (key.startsWith(prefix)) {
        this.claims.delete(key);
      }
    }
    const message: ServerMessage = { data: { prefix }, type: "claims_cleared" };
    this.broadcast(JSON.stringify(message), []);
    this.markRoomDirty();
  }

  /** Release lapsed claims and tell everyone (the alarm wakes for the earliest expiry). */
  private expireClaims(now: number): void {
    for (const [key, claim] of this.claims) {
      if (claim.until !== null && claim.until <= now) {
        this.claims.delete(key);
        this.broadcast(VgServer.claimMessage(key, null), []);
        this.markRoomDirty();
      }
    }
  }

  // -- Ticks ---------------------------------------------------------------

  /** Start the tick loop if the room runs on ticks and it isn't running yet. */
  private ensureTicker(): void {
    const rate = this.rules?.tickRate;
    if (!rate || this.ticker) {
      return;
    }
    const ms = 1000 / rate;
    const ticker: Ticker = {
      base: 0,
      baseHeld: new Map(),
      epoch: Date.now(),
      held: new Map(),
      log: [],
      logChars: 0,
      ms,
      n: 0,
      pending: new Map(),
      // Checked twice per tick, so a late timer is never a whole tick late.
      timer: setInterval(() => {
        this.runTicks();
      }, ms / 2),
    };
    this.ticker = ticker;
  }

  private stopTicker(): void {
    if (this.ticker) {
      clearInterval(this.ticker.timer);
      this.ticker = null;
    }
  }

  private tickSync(): TickSync | null {
    const { ticker } = this;
    if (!ticker) {
      return null;
    }
    return {
      base: ticker.base,
      epoch: ticker.epoch,
      held: Object.fromEntries(ticker.baseHeld),
      log: ticker.log.map((entry) => [entry.n, entry.changes]),
      ms: ticker.ms,
      n: ticker.n,
    };
  }

  /** Broadcast every tick that is due, in order and without gaps. */
  private runTicks(): void {
    const { ticker } = this;
    if (!ticker) {
      return;
    }
    const due = Math.floor((Date.now() - ticker.epoch) / ticker.ms);
    while (ticker.n < due) {
      ticker.n += 1;
      const changes = Object.fromEntries(ticker.pending.get(ticker.n) ?? []);
      ticker.pending.delete(ticker.n);
      applyInputChanges(ticker.held, changes);
      const message: ServerMessage = { data: { i: changes, n: ticker.n }, type: "tick" };
      const raw = JSON.stringify(message);
      if (Object.keys(changes).length > 0) {
        ticker.log.push({ changes, chars: raw.length, n: ticker.n });
        ticker.logChars += raw.length;
      }
      VgServer.trimTickLog(ticker);
      this.broadcast(raw, []);
    }
  }

  /** Fold log entries older than the history (or over budget) into the base. */
  private static trimTickLog(ticker: Ticker): void {
    const oldest = ticker.n - MAX_TICK_HISTORY;
    let [entry] = ticker.log;
    while (entry && (entry.n <= oldest || ticker.logChars > MAX_TICK_LOG_CHARS)) {
      ticker.log.shift();
      applyInputChanges(ticker.baseHeld, entry.changes);
      ticker.base = entry.n;
      ticker.logChars -= entry.chars;
      [entry] = ticker.log;
    }
  }

  /** Schedule an input change: at tick `n` if that is still ahead, else the next tick. */
  private schedule(id: string, input: JsonValue, n: number | null): void {
    const { ticker } = this;
    if (!ticker) {
      return;
    }
    const next = ticker.n + 1;
    const target = n === null ? next : Math.min(Math.max(n, next), ticker.n + MAX_INPUT_LEAD_TICKS);
    let inputs = ticker.pending.get(target);
    if (!inputs) {
      inputs = new Map();
      ticker.pending.set(target, inputs);
    }
    inputs.set(id, input);
  }

  private handleInput(sender: Connection<Presence>, input: JsonValue, n: number | null): void {
    // Inputs are re-sent in every sync, so they stay small and plain.
    if (
      findStructuralIssue({ v: input }) !== null ||
      JSON.stringify(input).length > MAX_INPUT_BYTES
    ) {
      console.warn(`Dropping malformed or oversized input from ${sender.id}`);
      return;
    }
    // null on the wire means "this player is gone"; a live player's empty input is false.
    this.schedule(sender.id, input === null ? false : input, n);
  }

  // -- Persistence ---------------------------------------------------------

  /** Persist the room's world and claims soon — at most once per PERSIST_DEBOUNCE_MS. */
  private markRoomDirty(): void {
    if (this.persistTimer !== null) {
      return;
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistRoom();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistRoom(): Promise<void> {
    const snapshot: RoomSnapshot = { claims: [...this.claims], shared: this.shared };
    if (JSON.stringify(snapshot).length > MAX_PERSISTED_BYTES) {
      // Too big for one value; a restart mid-session would lose the world.
      // Rare (a room this size is streaming it anyway) and never worth a
      // multi-value write on every change.
      return;
    }
    // Unconfirmed: a write never holds back the messages that follow it. A
    // crash in the gap loses at most a second of world — the host re-sends.
    try {
      await this.ctx.storage.put(ROOM_KEY, snapshot, { allowUnconfirmed: true });
    } catch (error) {
      console.warn("Room snapshot not persisted", error);
    }
  }

  onClose(connection: Connection<Presence>, code: number) {
    // 1000 is the SDK's deliberate `destroy()` — an on-purpose leave, so the
    // seat is vacated immediately. Anything else (1006 dropped transport, 1005
    // no-status, 1001 going-away, …) might be a blip, so it gets the grace
    // window.
    if (code === 1000) {
      return this.removePlayer(connection);
    }
    return this.departPlayer(connection);
  }

  /**
   * partyserver routes a clean disconnect to `onClose`, but a mid-connection
   * transport failure (dropped wifi, slept laptop, lost radio) to `onError`.
   * Both tear the connection down, so both must process the departure —
   * otherwise the error path leaks a ghost that keeps occupying a slot against
   * the room cap. An errored transport is exactly what grace exists for.
   */
  onError(connection: Connection<Presence>) {
    return this.departPlayer(connection);
  }

  /**
   * A connection died: park the seat in the grace map for RECONNECT_GRACE_MS
   * instead of removing the player — a network blip becomes "reconnecting…"
   * rather than a leave that wipes per-player state and (accidentally)
   * reshuffles the host.
   */
  private async departPlayer(connection: Connection<Presence>): Promise<void> {
    const presence = connection.state;
    if (!presence) {
      return;
    }

    // If a live reconnect under the same id already superseded this socket
    // (the client re-dialed before the server saw the old transport die), this
    // close is stale — the player is present, not departing. Iterated rather
    // than getConnection(id), which throws on exactly this duplicate-id race.
    for (const other of this.getConnections<Presence>()) {
      if (other.id === connection.id && other !== connection && other.state) {
        return;
      }
    }

    const now = Date.now();
    const { token } = presence;
    const entry: GraceEntry = {
      color: presence.color,
      disconnectedAt: now,
      expiresAt: now + RECONNECT_GRACE_MS,
      hue: presence.hue,
      id: connection.id,
      state: this.snapshots.get(connection.id) ?? {},
      token,
    };
    this.grace.set(token, entry);
    this.snapshots.delete(connection.id);
    // A dropped player sends nothing; don't keep replaying its last input.
    this.schedule(connection.id, null, null);
    // Detach presence before the first await: the paired onError/onClose for
    // the same failed transport would otherwise interleave at the storage
    // suspension point, see presence still set, and park the seat twice
    // (re-broadcasting the drop and refreshing expiresAt).
    VgServer.detachPresence(connection);
    await this.ctx.storage.put(graceKey(token), entry);

    const droppedMessage: ServerMessage = {
      data: { connected: false, id: connection.id },
      type: "player_connection",
    };
    this.broadcast(JSON.stringify(droppedMessage), [connection.id]);

    // The alarm must now also cover this seat's expiry — and must run even if
    // this drop left the room with no open connections at all.
    await this.scheduleSweep();
  }

  /**
   * Pings live connections and evicts the ones that have gone silent past the
   * eviction window, then lapses any grace seats whose window ran out, and any
   * claims whose TTL did. Players are the connections themselves, so there is
   * no separate map to reconcile — a ghost with no socket cannot exist outside
   * the explicit grace map. Reschedules itself until the room has neither
   * connections nor held seats, at which point the alarm stops and the Durable
   * Object is free to shut down.
   */
  async onAlarm() {
    const now = Date.now();
    const pingMessage = JSON.stringify({ type: "ping" } satisfies ServerMessage);
    const stale: Connection<Presence>[] = [];

    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      // Not-yet-admitted connections (room_full, closing) aren't players; leave them.
      if (!presence) {
        continue;
      }

      if (now - presence.aliveAt > EVICTION_TIMEOUT_MS) {
        stale.push(connection);
        continue;
      }
      try {
        connection.send(pingMessage);
      } catch {
        // A send to a socket whose peer is already gone throws — reap it, and
        // don't let one dead connection abort the sweep (and its reschedule).
        stale.push(connection);
      }
    }

    // Evict unreachable peers. Closing may not fire `onClose` for a peer that
    // is already gone, so reap explicitly; the departure path is idempotent if
    // it does. An evicted peer stopped answering pongs for 75s — far past the
    // grace window — so this is a hard removal, not a held seat.
    for (const connection of stale) {
      try {
        connection.close(1001, "idle");
      } catch {
        /* already gone */
      }
      await this.removePlayer(connection);
    }

    // Lapse held seats whose owner never came back: only now do they actually
    // leave the room (player_left, host handoff, empty-room reset).
    const lapsed = [...this.grace.values()].filter((entry) => entry.expiresAt <= now);
    for (const entry of lapsed) {
      await this.consumeGrace(entry);
      await this.announceDeparture(entry.id);
    }

    this.expireClaims(now);
    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    // Reschedule while any connection is still open — read from the socket set
    // (restored across hibernation) rather than an in-memory count, so the ping
    // loop can never stall and starve live idle clients of their pings — or
    // while any grace seat still needs an expiry wake (which must fire even in
    // a room whose last socket just dropped).
    const hasConnections = !this.getConnections()[Symbol.iterator]().next().done;

    let target: number | null = hasConnections ? Date.now() + PING_INTERVAL_MS : null;
    for (const entry of this.grace.values()) {
      target = target === null ? entry.expiresAt : Math.min(target, entry.expiresAt);
    }
    // Claim expiries only matter to a room someone is in.
    if (target !== null) {
      for (const claim of this.claims.values()) {
        if (claim.until !== null) {
          target = Math.min(target, claim.until);
        }
      }
    }
    if (target === null) {
      return;
    }

    // Keep an earlier pending alarm; pull a later one forward so a grace expiry
    // is never left waiting on the next ping tick.
    const pending = await this.ctx.storage.getAlarm();
    if (pending !== null && pending <= target) {
      return;
    }
    await this.ctx.storage.setAlarm(target);
  }

  /**
   * HTTP room inspection: `GET /parties/vg-server/:room` returns aggregate
   * stats for that room. Rooms are addressed by guessable slugs and games are
   * untrusted code, so this exposes counts only — never player ids, colors, or
   * game state. Inspecting a room wakes its Durable Object; with no open
   * connections it goes right back to sleep.
   */
  onRequest(request: Request): Response {
    if (request.method !== "GET") {
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    }
    return Response.json({
      capacity: this.cap,
      hasHost: this.hostId !== null,
      playerCount: this.playerCount(),
      room: this.name,
      rules: this.rules,
    });
  }

  /** Clear a connection's presence, tolerating an already-dead socket. */
  private static detachPresence(connection: Connection<Presence>): void {
    try {
      connection.setState(null);
    } catch {
      /* socket already gone */
    }
  }

  private async removePlayer(connection: Connection<Presence>): Promise<void> {
    // A connection refused at capacity (room_full) is closed before being
    // admitted, so it carries no presence and no client saw it join. Skip the
    // announce so we don't broadcast a spurious player_left. `player_left` is
    // idempotent on the client anyway, so a trailing onClose after a sweep is
    // harmless.
    const presence = connection.state;
    if (!presence) {
      return;
    }
    // Detach presence first: the eviction sweep calls this before close(), and
    // the close's own async onClose must find nothing left to grace — otherwise
    // an evicted player would come straight back as a held seat.
    VgServer.detachPresence(connection);
    // Forfeit a held seat only if this connection OWNS it (token match).
    // Matching by player id would let anyone destroy a held seat: ids are
    // public (broadcast to every peer), so a rogue client could join under the
    // ghost's id and cleanly leave, reaping a seat it never held.
    const held = this.grace.get(presence.token);
    if (held) {
      await this.consumeGrace(held);
    }
    await this.announceDeparture(connection.id);
  }

  /**
   * A player id is actually leaving the room (immediate removal, or a grace
   * window that lapsed): announce it, hand off host if they held it, and reset
   * the room once truly empty.
   */
  private async announceDeparture(id: string): Promise<void> {
    this.snapshots.delete(id);
    this.forgetPlayer(id);
    // Tick rooms: the departed player's input clears on the next tick.
    this.schedule(id, null, null);

    const leftMessage: ServerMessage = {
      data: { id },
      type: "player_left",
    };
    this.broadcast(JSON.stringify(leftMessage), [id]);

    // Remaining admitted players, now that this seat is gone. Host handoff
    // targets live connections only — a seat in grace has no transport to
    // stream shared state, so it can hold a seat but never inherit the host.
    let firstRemaining: string | null = null;
    let remainingCount = 0;
    for (const other of this.getConnections<Presence>()) {
      if (other.id === id || !other.state) {
        continue;
      }
      remainingCount += 1;
      if (firstRemaining === null || other.id < firstRemaining) {
        firstRemaining = other.id;
      }
    }

    if (this.hostId === id) {
      await this.setHostId(firstRemaining);
      if (firstRemaining) {
        const hostMessage: ServerMessage = {
          data: { id: firstRemaining },
          type: "host",
        };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }

    // Reset the room once it empties so the next session starts fresh:
    // otherwise state set by an earlier session outlives it on the (still-warm)
    // Durable Object — a wrong cap or rules for a session that wants other
    // ones, ghost world state and claims (eaten pellets, scores, farm tiles)
    // that the next session's clients adopt before their new host's first
    // broadcast. A room with seats still held in grace is NOT empty — its
    // dropped players may be seconds from returning.
    if (remainingCount === 0 && this.grace.size === 0) {
      await this.setCap(null);
      await this.setRules(null);
      this.shared = {};
      this.claims.clear();
      this.positions.clear();
      this.views.clear();
      this.stopTicker();
      if (this.persistTimer !== null) {
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
      }
      await this.ctx.storage.delete(ROOM_KEY);
    }
  }
}

export default {
  async fetch(request: Request, env: Env) {
    // Liveness probe. Answered at the Worker layer so it never wakes a
    // Durable Object — cheap enough for an uptime monitor to hammer.
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "vibedgames-party" });
    }
    return (await routePartykitRequest(request, env)) || new Response("Not Found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
