import { Server } from "partyserver";

import type { JsonValue, RoomListing } from "@vibedgames/multiplayer";
import { MAX_ROOM_CAP } from "@vibedgames/multiplayer";

/** How a room stands, as it reports itself to its lobby. */
export type RoomReport = Omit<RoomListing, "room">;

interface LobbyEntry extends RoomListing {
  at: number;
}

const LISTING_TTL_MS = 75_000;
const HOLD_MS = 10_000;
const MAX_LISTED = 100;
const ENTRY_PREFIX = "room:";

const entryKey = (room: string) => `${ENTRY_PREFIX}${room}`;

const readCapacity = (body: string) => {
  let cap: JsonValue | undefined;

  try {
    const parsed = JSON.parse(body) as JsonValue;
    cap = parsed instanceof Object && !Array.isArray(parsed) ? parsed.maxPlayers : undefined;
  } catch {
    return null;
  }

  return Number.isSafeInteger(cap) && Number(cap) > 0 ? Math.min(Number(cap), MAX_ROOM_CAP) : null;
};

/**
 * A lobby: the rooms a game lists under one name, and quick matches into
 * them. Rooms list themselves — a room created with `lobby` reports how it
 * stands here — so this holds no player data, only counts and what each
 * host chose to publish. `GET /parties/vg-lobby/:lobby` lists the rooms;
 * `POST` matches a player into the fullest open room with space, or names a
 * new one.
 *
 * A Durable Object per lobby serializes matches, so two players matching at
 * once never both open a new room: the first match records the room it
 * names, and the second finds it.
 */
export class VgLobby extends Server {
  private readonly rooms = new Map<string, LobbyEntry>();
  private readonly holds = new Map<string, number[]>();

  /** Rehydrate the listing (partyserver awaits this before any request or RPC). */
  async onStart() {
    const stored = await this.ctx.storage.list<LobbyEntry>({ prefix: ENTRY_PREFIX });

    for (const entry of stored.values()) {
      this.rooms.set(entry.room, entry);
    }
  }

  /** A room's report, over RPC: how it stands, or null when it emptied. */
  async report(room: string, report: RoomReport | null) {
    if (report === null) {
      this.rooms.delete(room);
      this.holds.delete(room);
      await this.ctx.storage.delete(entryKey(room));

      return;
    }

    const arrived = report.players - (this.rooms.get(room)?.players ?? 0);

    if (arrived > 0) {
      this.holds.set(room, (this.holds.get(room) ?? []).slice(arrived));
    }

    const entry: LobbyEntry = { ...report, at: Date.now(), room };
    this.rooms.set(room, entry);
    await this.ctx.storage.put(entryKey(room), entry);
  }

  async onRequest(request: Request) {
    if (request.method === "GET") {
      const rooms: RoomListing[] = this.live()
        .toSorted((a, b) => b.players - a.players)
        .slice(0, MAX_LISTED)
        .map(({ capacity, locked, meta, players, room }) => ({
          capacity,
          locked,
          meta,
          players,
          room,
        }));

      return Response.json({ rooms });
    }

    if (request.method === "POST") {
      return Response.json({ room: this.match(readCapacity(await request.text())) });
    }

    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  private live() {
    const stale = Date.now() - LISTING_TTL_MS;
    const live: LobbyEntry[] = [];

    for (const entry of this.rooms.values()) {
      if (entry.at >= stale) {
        live.push(entry);
        continue;
      }

      this.rooms.delete(entry.room);
      this.holds.delete(entry.room);
      void this.ctx.storage.delete(entryKey(entry.room));
    }

    return live;
  }

  private taken(room: LobbyEntry, now: number) {
    const holds = (this.holds.get(room.room) ?? []).filter((until) => until > now);
    this.holds.set(room.room, holds);

    return room.players + holds.length;
  }

  private match(capacity: number | null) {
    const now = Date.now();
    let best: LobbyEntry | null = null;
    let bestTaken = -1;

    for (const entry of this.live()) {
      const taken = this.taken(entry, now);

      if (entry.locked || (entry.capacity !== null && taken >= entry.capacity)) {
        continue;
      }

      if (taken > bestTaken) {
        best = entry;
        bestTaken = taken;
      }
    }

    if (best === null) {
      const room = `${this.name}-${crypto.randomUUID().slice(0, 8)}`;
      best = { at: now, capacity, locked: false, meta: {}, players: 0, room };
      this.rooms.set(room, best);
    }

    this.holds.set(best.room, [...(this.holds.get(best.room) ?? []), now + HOLD_MS]);

    return best.room;
  }
}
