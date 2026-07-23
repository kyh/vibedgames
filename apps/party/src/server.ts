import type { Connection, ConnectionContext } from "partyserver";
import { routePartykitRequest, Server } from "partyserver";

import type { ClientMessage, Player, PlayerMap, ServerMessage } from "@vibedgames/multiplayer";
import {
  EVICTION_TIMEOUT_MS,
  HOST_LIVENESS_TIMEOUT_MS,
  PING_INTERVAL_MS,
  RECONNECT_GRACE_MS,
  RECONNECT_TOKEN_QUERY_PARAM,
  ROOM_CAP_QUERY_PARAM,
} from "@vibedgames/multiplayer";
import { getColorById } from "./color";

type Env = {
  VgServer: DurableObjectNamespace<VgServer>;
  DB: D1Database;
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
 *   the owner knows. Absent for pre-grace clients, which get the old
 *   remove-on-close behaviour. Never sent to peers.
 */
type Presence = {
  id: string;
  color: string;
  hue: string;
  seenAt: number;
  aliveAt: number;
  token?: string;
};

/**
 * A seat held for a dropped player during the reconnection grace window:
 * identity + last per-player state, parked when the transport died and handed
 * back if the same secret token returns before `expiresAt`. Persisted under
 * `grace:{token}` so a hibernation mid-window can't silently forget the seat.
 */
type GraceEntry = {
  token: string;
  id: string;
  color: string;
  hue: string;
  state: Record<string, unknown>;
  disconnectedAt: number;
  expiresAt: number;
};

/** Durable, low-frequency room fields, persisted so they survive hibernation. */
const HOST_ID_KEY = "hostId";
const CAP_KEY = "cap";
const GRACE_PREFIX = "grace:";

const graceKey = (token: string): string => `${GRACE_PREFIX}${token}`;

/**
 * Upper bound on a single room's player cap, regardless of what a client
 * requests via the query param. Games are untrusted code, so we never let a
 * client size a room past this ceiling.
 */
const HARD_ROOM_CAP = 64;

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
    if (/^\d+$/.test(suffix)) {
      return `${room.slice(0, idx)}${OVERFLOW_SEP}${Number(suffix) + 1}`;
    }
  }
  return `${room}${OVERFLOW_SEP}2`;
};

/** Read the client-requested player cap, clamped to the hard ceiling. */
const readRoomCap = (ctx: ConnectionContext): number | null => {
  const raw = new URL(ctx.request.url).searchParams.get(ROOM_CAP_QUERY_PARAM);
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(parsed, HARD_ROOM_CAP);
};

/** Read the client's reconnection token, if it sent one (post-grace SDKs do). */
const readReconnectToken = (ctx: ConnectionContext): string | null => {
  const raw = new URL(ctx.request.url).searchParams.get(RECONNECT_TOKEN_QUERY_PARAM);
  return raw && raw.length > 0 ? raw : null;
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
   * - SNAPSHOT (per-player game state + shared state) is the hot channel: kept in
   *   memory, broadcast every tick, never persisted. It self-heals — clients
   *   re-send on reconnect, the host re-streams shared state within a tick, and
   *   the room only hibernates when idle (nobody streaming). Persisting it would
   *   be pure write amplification and risk the 2KB attachment cap.
   * - SESSION (`hostId`, `cap`) changes rarely but MUST persist: a wiped host
   *   makes the real host's `state_patch` get rejected as non-host after a wake;
   *   a wiped cap lets a post-wake join exceed it. Mirrored in memory, written
   *   through to storage, rehydrated in `onStart()`.
   * - GRACE (held seats for dropped players) also persists: entries are written
   *   only on disconnect/reclaim/expiry (never on the hot path), are bounded by
   *   the room cap, and must survive hibernation or a mid-window wake would
   *   silently forget a seat the alarm was scheduled to expire. Mirrored in
   *   memory, rehydrated in `onStart()`.
   */
  private shared: Record<string, unknown> = {};
  private snapshots = new Map<string, Record<string, unknown>>();
  private hostId: string | null = null;
  private cap: number | null = null;
  private grace = new Map<string, GraceEntry>();

  /** Rehydrate durable session fields before any handler runs (partyserver awaits this). */
  async onStart() {
    this.hostId = (await this.ctx.storage.get<string | null>(HOST_ID_KEY)) ?? null;
    this.cap = (await this.ctx.storage.get<number | null>(CAP_KEY)) ?? null;
    this.grace = new Map<string, GraceEntry>();
    const held = await this.ctx.storage.list<GraceEntry>({ prefix: GRACE_PREFIX });
    for (const entry of held.values()) this.grace.set(entry.token, entry);
  }

  private async setHostId(id: string | null): Promise<void> {
    this.hostId = id;
    await this.ctx.storage.put(HOST_ID_KEY, id);
  }

  private async setCap(cap: number | null): Promise<void> {
    this.cap = cap;
    await this.ctx.storage.put(CAP_KEY, cap);
  }

  private toPlayer(presence: Presence): Player {
    return {
      id: presence.id,
      color: presence.color,
      hue: presence.hue,
      state: this.snapshots.get(presence.id) ?? {},
      connected: true,
    };
  }

  /** The presence for a connection id, or undefined if not admitted. */
  private presenceOf(id: string): Presence | undefined {
    const connection = this.getConnection<Presence>(id);
    return connection?.state ?? undefined;
  }

  /** The grace entry holding a seat for this player id, if any. */
  private graceById(id: string): GraceEntry | undefined {
    for (const entry of this.grace.values()) {
      if (entry.id === id) return entry;
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
      if (presence) players[connection.id] = this.toPlayer(presence);
    }
    for (const entry of this.grace.values()) {
      if (entry.id in players) continue;
      players[entry.id] = {
        id: entry.id,
        color: entry.color,
        hue: entry.hue,
        state: entry.state,
        connected: false,
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
    let count = 0;
    for (const connection of this.getConnections<Presence>()) {
      if (connection.id === excludeId) continue;
      if (connection.state) count++;
    }
    for (const entry of this.grace.values()) {
      if (entry.id === excludeId) continue;
      count++;
    }
    return count;
  }

  /**
   * Mark a connection heard-from on the keepalive channel. `seen` is true for a
   * non-pong keepalive (heartbeat) — the signal a backgrounded tab stops sending.
   */
  private touch(connection: Connection<Presence>, seen: boolean) {
    const presence = connection.state;
    if (!presence) return;
    const now = Date.now();
    connection.setState({ ...presence, aliveAt: now, seenAt: seen ? now : presence.seenAt });
  }

  /** Migrate host off a connection we haven't heard from within the liveness
   *  window (it vanished without a clean close). Picks the lowest-id live peer
   *  for determinism. No-op while the host is responsive or no live peer exists. */
  private async checkHostLiveness(): Promise<void> {
    const host = this.hostId;
    if (!host) return;
    const now = Date.now();
    const hostPresence = this.presenceOf(host);
    if (hostPresence && now - hostPresence.seenAt <= HOST_LIVENESS_TIMEOUT_MS) return;
    // A host whose seat is held in grace gets the same liveness window measured
    // from the drop: a short blip keeps the host role (their reconnect resumes
    // seamlessly), while a longer outage migrates it so shared state doesn't
    // freeze for everyone until the grace window lapses.
    if (!hostPresence) {
      const ghost = this.graceById(host);
      if (ghost && now - ghost.disconnectedAt <= HOST_LIVENESS_TIMEOUT_MS) return;
    }

    let next: Connection<Presence> | null = null;
    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      if (!presence || connection.id === host) continue;
      if (now - presence.seenAt > HOST_LIVENESS_TIMEOUT_MS) continue;
      if (!next || connection.id < next.id) next = connection;
    }
    if (!next) return; // nobody healthier to hand off to — keep the current host

    // Grace on the new host so we don't immediately re-migrate.
    const presence = next.state;
    if (presence) next.setState({ ...presence, seenAt: now });
    await this.setHostId(next.id);
    const hostMessage: ServerMessage = { type: "host", data: { id: next.id } };
    this.broadcast(JSON.stringify(hostMessage), []);
  }

  async onConnect(connection: Connection<Presence>, ctx: ConnectionContext) {
    // A returning token reclaims its held seat: that seat already counts
    // against the cap, so a reclaim is never bounced to overflow — it is the
    // same player sitting back down, not a new admission.
    const token = readReconnectToken(ctx);
    const reclaimed = token ? this.grace.get(token) : undefined;
    if (reclaimed) await this.consumeGrace(reclaimed);

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
        type: "room_full",
        data: { room: nextOverflowRoom(this.name), capacity: cap },
      };
      connection.send(JSON.stringify(fullMessage));
      connection.close(4001, "room_full");
      return;
    }

    // Admitted: establish the room's cap stickily from the first admitted
    // client that advertises one, so a later join that omits `_maxPlayers` (a
    // rogue or stale client) can't bypass the cap legit clients set.
    if (this.cap === null && requestedCap !== null) {
      await this.setCap(requestedCap);
    }

    const now = Date.now();
    // A reclaim keeps its old color for continuity (same value when the
    // connection id is unchanged — getColorById is deterministic — but also
    // when PartySocket hands the client a fresh id).
    const { color, hue } = reclaimed ?? getColorById(connection.id);
    const presence: Presence = {
      id: connection.id,
      color,
      hue,
      seenAt: now,
      aliveAt: now,
      token: token ?? undefined,
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
      const leftMessage: ServerMessage = { type: "player_left", data: { id: reclaimed.id } };
      this.broadcast(JSON.stringify(leftMessage), [connection.id]);
      if (this.hostId === reclaimed.id) {
        await this.setHostId(connection.id);
        const hostMessage: ServerMessage = { type: "host", data: { id: connection.id } };
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
      type: "sync",
      data: {
        players: this.players(),
        state: this.shared,
        hostId: this.hostId ?? connection.id,
      },
    };
    connection.send(JSON.stringify(syncMessage));

    const joinedMessage: ServerMessage = {
      type: "player_joined",
      data: this.toPlayer(presence),
    };
    this.broadcast(JSON.stringify(joinedMessage), [connection.id]);
  }

  async onMessage(sender: Connection<Presence>, rawMessage: string): Promise<void> {
    try {
      // Admission gate: presence lives in the attachment, so a connection that
      // survived hibernation is still admitted even though its in-memory
      // snapshot was wiped — the next patch just re-fills it. A capacity-refused
      // connection carries no presence, so it cannot broadcast into the room.
      const presence = sender.state;
      if (!presence) return;

      const message = JSON.parse(rawMessage) as ClientMessage;

      switch (message.type) {
        case "player_state_patch": {
          // Hot path: snapshot + broadcast only. Liveness rides the heartbeat/
          // pong keepalive channel, so a per-tick stream costs no attachment write.
          const next = { ...(this.snapshots.get(sender.id) ?? {}), ...message.data };
          this.snapshots.set(sender.id, next);
          const updateMessage: ServerMessage = {
            type: "player_state",
            data: { id: sender.id, state: next },
          };
          this.broadcast(JSON.stringify(updateMessage), [sender.id]);
          break;
        }
        case "state_patch": {
          // Shared state is host-authoritative: only the elected host can write.
          // Non-host writes get a `state` echo back so the client can rewind its
          // local mirror, and we drop the patch instead of relaying. Also a hot
          // path (host streams ~30×/s), so no attachment write here either.
          if (sender.id !== this.hostId) {
            const echo: ServerMessage = {
              type: "state_patch",
              data: this.shared,
            };
            sender.send(JSON.stringify(echo));
            break;
          }
          this.shared = {
            ...this.shared,
            ...message.data,
          };
          const broadcastMessage: ServerMessage = {
            type: "state_patch",
            data: message.data,
          };
          this.broadcast(JSON.stringify(broadcastMessage), []);
          break;
        }
        case "heartbeat":
          // The keepalive that pauses when a tab is hidden — refreshes both
          // clocks and is the cadence we re-check host liveness on.
          this.touch(sender, true);
          await this.checkHostLiveness();
          break;
        case "pong":
          // Answers a server ping even from a hidden tab: proves reachable
          // (aliveAt) but not running (seenAt untouched).
          this.touch(sender, false);
          break;
        case "emit": {
          this.touch(sender, true);
          const eventMessage: ServerMessage = {
            type: "event",
            data: {
              event: message.data.event,
              payload: message.data.payload,
              from: sender.id,
            },
          };
          this.broadcast(JSON.stringify(eventMessage), []);
          break;
        }
        default:
          this.touch(sender, true);
          break;
      }
    } catch (error) {
      console.error("Error handling message", error);
    }
  }

  onClose(connection: Connection<Presence>, code: number) {
    // 1000 is the SDK's deliberate `destroy()` — an on-purpose leave, so the
    // seat is vacated immediately. Anything else (1006 dropped transport, 1005
    // no-status, 1001 going-away, …) might be a blip, so it gets the grace
    // window.
    if (code === 1000) return this.removePlayer(connection);
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
   * A connection died. If the client presented a reconnection token, park the
   * seat in the grace map for RECONNECT_GRACE_MS instead of removing the player
   * — a network blip becomes "reconnecting…" rather than a leave that wipes
   * per-player state and (accidentally) reshuffles the host. Pre-grace clients
   * keep the old immediate removal.
   */
  private async departPlayer(connection: Connection<Presence>): Promise<void> {
    const presence = connection.state;
    if (!presence) return;

    // If a live reconnect under the same id already superseded this socket
    // (the client re-dialed before the server saw the old transport die), this
    // close is stale — the player is present, not departing. Iterated rather
    // than getConnection(id), which throws on exactly this duplicate-id race.
    for (const other of this.getConnections<Presence>()) {
      if (other.id === connection.id && other !== connection && other.state) return;
    }

    const token = presence.token;
    if (!token) {
      await this.removePlayer(connection);
      return;
    }

    const now = Date.now();
    const entry: GraceEntry = {
      token,
      id: connection.id,
      color: presence.color,
      hue: presence.hue,
      state: this.snapshots.get(connection.id) ?? {},
      disconnectedAt: now,
      expiresAt: now + RECONNECT_GRACE_MS,
    };
    this.grace.set(token, entry);
    this.snapshots.delete(connection.id);
    // Detach presence before the first await: the paired onError/onClose for
    // the same failed transport would otherwise interleave at the storage
    // suspension point, see presence still set, and park the seat twice
    // (re-broadcasting the drop and refreshing expiresAt).
    this.detachPresence(connection);
    await this.ctx.storage.put(graceKey(token), entry);

    const droppedMessage: ServerMessage = {
      type: "player_connection",
      data: { id: connection.id, connected: false },
    };
    this.broadcast(JSON.stringify(droppedMessage), [connection.id]);

    // The alarm must now also cover this seat's expiry — and must run even if
    // this drop left the room with no open connections at all.
    await this.scheduleSweep();
  }

  /**
   * Pings live connections and evicts the ones that have gone silent past the
   * eviction window, then lapses any grace seats whose window ran out. Players
   * are the connections themselves now, so there is no separate map to
   * reconcile — a ghost with no socket cannot exist outside the explicit grace
   * map. Reschedules itself until the room has neither connections nor held
   * seats, at which point the alarm stops and the Durable Object is free to
   * shut down.
   */
  async onAlarm() {
    const now = Date.now();
    const pingMessage = JSON.stringify({ type: "ping" } satisfies ServerMessage);
    const stale: Connection<Presence>[] = [];

    for (const connection of this.getConnections<Presence>()) {
      const presence = connection.state;
      // Not-yet-admitted connections (room_full, closing) aren't players; leave them.
      if (!presence) continue;

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
    for (const entry of [...this.grace.values()]) {
      if (entry.expiresAt > now) continue;
      await this.consumeGrace(entry);
      await this.announceDeparture(entry.id);
    }

    await this.scheduleSweep();
  }

  private async scheduleSweep(): Promise<void> {
    // Reschedule while any connection is still open — read from the socket set
    // (restored across hibernation) rather than an in-memory count, so the ping
    // loop can never stall and starve live idle clients of their pings — or
    // while any grace seat still needs an expiry wake (which must fire even in
    // a room whose last socket just dropped).
    let hasConnections = false;
    for (const _connection of this.getConnections()) {
      hasConnections = true;
      break;
    }

    let target: number | null = hasConnections ? Date.now() + PING_INTERVAL_MS : null;
    for (const entry of this.grace.values()) {
      target = target === null ? entry.expiresAt : Math.min(target, entry.expiresAt);
    }
    if (target === null) return;

    // Keep an earlier pending alarm; pull a later one forward so a grace expiry
    // is never left waiting on the next ping tick.
    const pending = await this.ctx.storage.getAlarm();
    if (pending !== null && pending <= target) return;
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
      room: this.name,
      playerCount: this.playerCount(),
      capacity: this.cap,
      hasHost: this.hostId !== null,
    });
  }

  /** Clear a connection's presence, tolerating an already-dead socket. */
  private detachPresence(connection: Connection<Presence>): void {
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
    if (!presence) return;
    // Detach presence first: the eviction sweep calls this before close(), and
    // the close's own async onClose must find nothing left to grace — otherwise
    // an evicted player would come straight back as a held seat.
    this.detachPresence(connection);
    // Forfeit a held seat only if this connection OWNS it (token match).
    // Matching by player id would let anyone destroy a held seat: ids are
    // public (broadcast to every peer), so a rogue client could join under the
    // ghost's id and cleanly leave, reaping a seat it never held.
    const held = presence.token ? this.grace.get(presence.token) : undefined;
    if (held) await this.consumeGrace(held);
    await this.announceDeparture(connection.id);
  }

  /**
   * A player id is actually leaving the room (immediate removal, or a grace
   * window that lapsed): announce it, hand off host if they held it, and reset
   * the room once truly empty.
   */
  private async announceDeparture(id: string): Promise<void> {
    this.snapshots.delete(id);

    const leftMessage: ServerMessage = {
      type: "player_left",
      data: { id },
    };
    this.broadcast(JSON.stringify(leftMessage), [id]);

    // Remaining admitted players, now that this seat is gone. Host handoff
    // targets live connections only — a seat in grace has no transport to
    // stream shared state, so it can hold a seat but never inherit the host.
    let firstRemaining: string | null = null;
    let remainingCount = 0;
    for (const other of this.getConnections<Presence>()) {
      if (other.id === id || !other.state) continue;
      remainingCount++;
      if (firstRemaining === null || other.id < firstRemaining) firstRemaining = other.id;
    }

    if (this.hostId === id) {
      await this.setHostId(firstRemaining);
      if (firstRemaining) {
        const hostMessage: ServerMessage = {
          type: "host",
          data: { id: firstRemaining },
        };
        this.broadcast(JSON.stringify(hostMessage), []);
      }
    }

    // Reset the sticky cap AND the shared state once the room empties so the
    // next session starts fresh. Otherwise state set by an earlier session
    // outlives it on the (still-warm) Durable Object: a wrong cap for a session
    // that wants the unlimited default, and ghost world state (eaten pellets,
    // scores, farm tiles) that the next session's clients adopt before their new
    // host's first broadcast. A room with seats still held in grace is NOT
    // empty — its dropped players may be seconds from returning.
    if (remainingCount === 0 && this.grace.size === 0) {
      await this.setCap(null);
      this.shared = {};
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
