# @repo/web

Main web app for vibedgames. Game hub, authentication, dashboard — and the host
Worker for the tRPC API.

## Stack

- [TanStack Start](https://tanstack.com/start) + React 19
- [Cloudflare Workers](https://workers.cloudflare.com) via `@cloudflare/vite-plugin`
- [better-auth](https://better-auth.com) for authentication
- [tRPC](https://trpc.io) for API layer ([`@repo/api`](../../packages/api) runs inside this Worker)
- [Tailwind CSS 4](https://tailwindcss.com) + [`@repo/ui`](../../packages/ui)

## Surfaces

| Route                                      | What                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| `/`, `/discover`                           | landing + game hub — renders the hardcoded `featuredGames`       |
| `/build`, `/install`                       | how to build with an agent; CLI install                          |
| `/docs`                                    | developer docs index — CLI, API, packages, endpoints             |
| `/about`, `/contact`, `/privacy`           | trust anchors — who runs this, how to reach us, what is stored   |
| `/home`, `/settings`                       | signed-in dashboard: your games, account, credits                |
| `/admin`                                   | admin-only: users, invites                                       |
| `/auth/*`                                  | login, register, password reset, and `cli` (device-code confirm) |
| `/api/trpc/*`, `/api/auth/*`               | tRPC + better-auth handlers                                      |
| `/api/r2-upload`, `/api/r2-download`       | local-dev R2 proxy (HMAC-signed, `localhost` Host only)          |
| `/.well-known/agent-skills/*`              | the vibedgames skills, served for agents to fetch                |
| `/llms.txt`, `/robots.txt`, `/sitemap.xml` | machine-readable site descriptions                               |
| anything else                              | `404` with a markdown recovery note (`src/routes/$.tsx`)         |

## The agent-facing contract

Everything an agent needs to read this site without a browser lives in four
places, and they share one source of truth so they cannot drift:

- **`src/content/*.ts`** — every prose page is authored once as a `Doc`
  (`src/lib/doc.ts`). `components/site/prose` renders it as HTML;
  `docToMarkdown` serializes the same object to markdown. `/build`'s card deck
  and `/discover`'s gallery read the same `Doc` data the markdown does.
- **Markdown content negotiation** — `src/lib/content-negotiation.ts` is a
  spec-correct `Accept` parser (q-values, `q=0` refusals, specificity
  tie-breaks) per [acceptmarkdown.com](https://acceptmarkdown.com). Every prose
  route answers `Accept: text/markdown` with markdown, `406` when it can take
  neither representation, and carries `Vary: Accept, Accept-Encoding` so a CDN
  keeps the variants apart. `/` also varies on `User-Agent`, because named AI
  crawlers get `/install` instead of the page text.
- **`src/lib/structured-data.ts`** — the schema.org `@graph`
  (Organization + WebSite + SoftwareApplication + the featured games), rendered
  server-side in `__root.tsx` so a crawler that never runs JavaScript still
  reads it. Contact fields are emitted only when `siteConfig.contact` is filled
  in; see the comment there before adding an address.
- **`components/site/text-fallback`** — `/` and `/discover` are pictures, so
  they carry an `sr-only` heading and lead plus a `<noscript>` link list. Both
  render the page's own `Doc`; neither changes a pixel.

`pnpm test` (in this package) covers the negotiation vectors, the markdown
serializer, the JSON-LD shape and the content floors for the trust anchors.

Games themselves are **not** served here — they live on
`{slug}.vibedgames.com` via [`@repo/games`](../games). Session cookies are
scoped to the apex domain so untrusted game code on a subdomain can never read
them.

## Development

```sh
pnpm dev:web   # once, to create the local D1, then stop it
pnpm db:local  # push schema + seed dev logins
pnpm dev:web   # http://localhost:5173
```

The local Miniflare D1 and R2 are isolated from production and start empty.
Address the dev worker as `localhost`, never `127.0.0.1`: the local R2 upload
proxy keys off the literal Host header, and `127.0.0.1` presigns against
**production** R2.

Liveness check: `/auth/login` returns 200 — `/` answers 307 (it redirects to a
featured game). Seeded logins and headless auth recipes:
[AGENTS.md](../../AGENTS.md).

## Environment

Worker secrets (`BETTER_AUTH_SECRET`, `R2_*`, `FAL_API_KEY`) go in
`apps/web/.dev.vars` — the Worker never reads `process.env`, so putting them in
the root `.env` silently does nothing. Bindings are declared in `wrangler.jsonc`.
