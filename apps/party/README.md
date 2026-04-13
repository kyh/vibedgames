# @repo/party

Real-time multiplayer server. Manages rooms, player state, and event broadcasting.

## Stack

- [PartyServer](https://partykit.io) on Cloudflare Durable Objects
- Generic protocol — not game-specific

## Protocol

Clients connect via WebSocket. The server handles:

- **Player join/leave** — auto-assigns colors, host migration
- **Shared state** — `state_patch` messages merged server-side, broadcast to all
- **Player state** — `player_state_patch` per-player, broadcast to others
- **Events** — `emit` pass-through for custom game events

## Development

```sh
pnpm dev-party
```

Runs on `http://localhost:8787`.
