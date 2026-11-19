import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";

import * as entrypoint from "./src/server.ts" with { type: "cf-worker" };

const worker = defineWorker({
  compatibilityDate: "2024-09-23",
  compatibilityFlags: ["nodejs_compat"],
  entrypoint,
  exports: {
    VgLobby: exports.durableObject({ storage: "sqlite" }),
    // WARNING: the live VgServer namespace is key-value backed; never switch production to sqlite.
    VgServer: exports.durableObject({ storage: "legacy-kv" }),
  },
  name: "vibedgames-party",
});

const drainLiveRooms = {
  metadata: { code_update_strategy: { max_delay: 300, mode: "deferred" } },
};

export default defineConfig(({ isPreview }) => ({
  worker: {
    ...worker,
    env: {
      DB: isPreview
        ? bindings.d1({ name: "vibedgames-preview" })
        : bindings.d1({ id: "8aba7674-bee1-4532-b5f0-36243172cf81", name: "vibedgames" }),
      VgLobby: bindings.durableObject({ exportName: "VgLobby" as const, worker }),
      VgServer: bindings.durableObject({ exportName: "VgServer" as const, worker }),
    },
    exports: isPreview
      ? {
          VgLobby: exports.durableObject({ storage: "sqlite" }),
          VgServer: exports.durableObject({ storage: "sqlite" }),
        }
      : worker.exports,
    previewUrls: true,
    // WARNING: a Preview must not claim the production hostname.
    triggers: isPreview
      ? []
      : [triggers.fetch({ pattern: "party.vibedgames.com/*", zone: "vibedgames.com" })],
    unsafe: isPreview ? undefined : drainLiveRooms,
  },
}));
