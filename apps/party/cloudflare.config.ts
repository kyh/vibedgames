import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";

// imported, not named by path, so the generated Env types each stub with its class
import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

const worker = defineWorker({
  compatibilityDate: "2024-09-23",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint,
  exports: {
    // Cloudflare creates new namespaces only SQLite-backed; a lobby uses just the key-value API.
    VgLobby: exports.durableObject({ storage: "sqlite" }),
    // created by wrangler's v1 `new_classes` migration: the live namespace keeps key-value storage
    VgServer: exports.durableObject({ storage: "legacy-kv" }),
  },
  name: "vibedgames-party",
});

// cf sends no code_update_strategy, so the API restarts every live room on deploy; this is
// wrangler's default, which lets a room finish on the old code for up to 5 minutes. Production
// only: Preview uploads refuse unsafe metadata, and a Preview has no live rooms to drain.
const drainLiveRooms = {
  metadata: { code_update_strategy: { max_delay: 300, mode: "deferred" } },
};

export default defineConfig(({ isPreview }) => ({
  worker: {
    ...worker,
    // a Preview gets a fresh VgServer namespace, over the same preview D1 the web Preview uses
    env: {
      DB: isPreview
        ? bindings.d1({ name: "vibedgames-preview" })
        : bindings.d1({ id: "8aba7674-bee1-4532-b5f0-36243172cf81", name: "vibedgames" }),
      // `as const`: cf infers an export name as the union of every Durable Object
      // class the Worker exports, which would type each stub as either class.
      VgLobby: bindings.durableObject({ exportName: "VgLobby" as const, worker }),
      VgServer: bindings.durableObject({ exportName: "VgServer" as const, worker }),
    },
    // A Preview provisions a fresh VgServer namespace, and Cloudflare creates new namespaces only
    // SQLite-backed. VgServer uses just the key-value and alarm APIs, which both backends serve.
    exports: isPreview
      ? {
          VgLobby: exports.durableObject({ storage: "sqlite" }),
          VgServer: exports.durableObject({ storage: "sqlite" }),
        }
      : worker.exports,
    // Previews are served at <alias>-vibedgames-party.<subdomain>.workers.dev. A production deploy
    // with a route and no workers.dev turns Preview URLs off unless this keeps them on.
    previewUrls: true,
    // party.vibedgames.com is the host games connect to. It is more specific than the games
    // Worker's *.vibedgames.com/* route, so it wins; "party" is a reserved slug, so no game can
    // claim it. A Preview must not claim the production hostname.
    triggers: isPreview
      ? []
      : [triggers.fetch({ pattern: "party.vibedgames.com/*", zone: "vibedgames.com" })],
    unsafe: isPreview ? undefined : drainLiveRooms,
  },
}));
