# @repo/games

Cloudflare Worker that serves deployed games from R2.

Routes `{slug}.vibedgames.com/*` requests to game files stored in R2, with metadata from D1.

## How it works

1. Extract slug from subdomain
2. Look up game + current deployment in D1
3. Stream file from R2 at `games/{gameId}/{deploymentId}/{path}`
4. Cache headers: 1 min for `index.html`, 1 year immutable for assets

R2 keys are immutable per deployment, so a new deploy is a new prefix — that's
what makes the long asset cache safe.

## HTML injection

Served `index.html` gets two additions, both no-ops for pages that already
handle themselves:

- **Freshness** (`freshness.ts`) — a tiny script that, when a tab returns after
  being hidden ≥5 min or is restored from bfcache, asks `/__vg/version` for the
  current deployment id and reloads only if a new build shipped. A restored
  mobile tab can otherwise run a weeks-old build forever. Never fires mid-play.
- **Share meta** (`share-meta.ts`) — Open Graph tags for pages that ship none:
  title from the game record, the page's own description, and a cover image
  (`og.{jpg,png,webp}` at the deployment root, else the platform card). If the
  HTML contains _any_ `og:` property, the author owns share meta and the page is
  served untouched.

## Development

```sh
pnpm dev:games
```

Runs on `http://localhost:3002`.
