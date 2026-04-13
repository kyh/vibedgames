# @repo/games

Cloudflare Worker that serves deployed games from R2.

Routes `{slug}.vibedgames.com/*` requests to game files stored in R2, with metadata from D1.

## How it works

1. Extract slug from subdomain
2. Look up game + current deployment in D1
3. Stream file from R2 at `games/{gameId}/{deploymentId}/{path}`
4. Cache headers: 1 min for `index.html`, 1 year immutable for assets

## Development

```sh
pnpm dev-games
```
