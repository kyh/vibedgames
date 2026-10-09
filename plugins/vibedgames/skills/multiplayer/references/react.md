# React usage

`PARTY_HOST` is the constant defined in [SKILL.md](../SKILL.md) → Party host.

```tsx
import {
  useMultiplayerRoom,
  useMultiplayerState,
  usePlayerState,
  useIsHost,
} from "@vibedgames/multiplayer/react";

const room = useMultiplayerRoom({
  host: PARTY_HOST,
  party: "vg-server",
  room: "my-game-room",
});

const [world, setWorld] = useMultiplayerState(room, { score: 0 });
const [me, setMe] = usePlayerState(room, { x: 0, y: 0 });
const isHost = useIsHost(room);
```

## Shared state

```tsx
if (isHost) setWorld({ score: world.score + 10 });

// Any player asks; the host applies it in onEvent (its own at once, no round trip).
room.sendToHost("score_request", { delta: 10 });
```

## Player state

```tsx
const onPointerMove = (e: PointerEvent) => {
  setMe({ x: e.clientX, y: e.clientY });
};
```

## Events

```tsx
room.sendEvent("explosion", { x: 100, y: 200 });

// Target specific players instead of broadcasting: `to` delivers only to those
// ids (sender included only if listed), `except` excludes ids.
room.sendEvent("you_died", { by: killerId }, { to: victimId });
room.sendEvent("taunt", { line }, { except: room.playerId ?? [] });

// Coalesce high-frequency annotations (damage numbers, cursor pings) where
// only the latest value matters: rapid same-type sends collapse into one wire
// message, flushed on the next microtask. Never reorders relative to state
// patches, and composes with targeting (per-target coalescing).
room.sendEvent("damage_popup", { amount }, { to: victimId, coalesce: true });

// Receive via onEvent config:
const room = useMultiplayerRoom({
  host,
  party,
  room,
  onEvent: (event, payload, from) => {
    /* handle */
  },
});
```

## Room metadata

```tsx
const status = room.connectionStatus; // "connecting" | "connected" | "reconnecting" | "offline"
const players = Object.values(room.players);
const myId = room.playerId;
const actualRoom = room.room; // may be an overflow sibling when `maxPlayers` is set
const { locked, meta } = room.roomInfo; // what the host published
room.setRoomInfo({ locked: true, meta: { mode: "ffa" } }); // host only
```

Each `Player` carries `id`, an auto-assigned `color`/`hue`, its state, and
`connected` — `false` while a dropped player's seat is being held. Render that
as "reconnecting…", not as a leave.

## Offline

```tsx
const room = useMultiplayerRoom({ host, party, room: "arena", fallbackMs: 6000 });
room.goOffline(); // a "play solo" button: leave, and play on alone
```

With `fallbackMs`, a room that doesn't admit the client in time turns it into
a local room of one: `connectionStatus` is `"offline"`, this player hosts, and
state, events and `sendToHost` all work locally. `offline: true` never dials.
See [architecture.md](architecture.md) → Offline fallback.
