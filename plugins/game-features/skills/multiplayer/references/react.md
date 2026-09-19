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
const isConnected = room.connectionStatus === "connected";
const players = Object.values(room.players);
const myId = room.playerId;
const actualRoom = room.room; // may be an overflow sibling when `maxPlayers` is set
```

Each `Player` carries `id`, an auto-assigned `color`/`hue`, its state, and
`connected` — `false` while a dropped player's seat is being held. Render that
as "reconnecting…", not as a leave.
