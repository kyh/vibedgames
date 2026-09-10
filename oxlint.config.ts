import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

// Game modules whose payload types must stay `type X = { ... }`. TypeScript
// grants a type alias an implicit index signature but never an interface —
// declaration merging can add members later, so the compiler cannot assume an
// interface's keys. Everything declared here is handed to a JSON-shaped
// index-signature type (`JsonValue`, `JsonRecord`, world-bin's wire trees, a
// `ShaderMaterial` uniform map), which an interface cannot satisfy. The escape
// the rule pushes toward — `[key: string]: unknown` on every interface — is
// strictly worse: it admits any key at all and discards the exact payloads
// these unions exist to enforce. Each game is independent, so each one carries
// its own entries; the fix outside `games/` was to make the consuming boundary
// generic over the payload type instead.
const jsonPayloadModules = [
  "games/battle-arena/src/net/snapshot.ts",
  "games/battle-arena/src/render/fx-bolt.ts",
  "games/battle-arena/src/render/fx-pillar.ts",
  "games/battle-arena/src/render/fx-ribbon.ts",
  "games/battle-arena/src/render/fx-void.ts",
  "games/battle-arena/src/render/telegraph.ts",
  "games/battle-arena/src/sim/types.ts",
  "games/bomberman/src/shared/constants.ts",
  "games/bomberman/src/sim/host-sim.ts",
  "games/crazy-waymo/src/render/sky.ts",
  "games/crazy-waymo/src/shared/types.ts",
  "games/crazy-waymo/src/world/city.ts",
  "games/crazy-waymo/src/world/furniture.ts",
  "games/crazy-waymo/src/world/parcel-pack.ts",
  "games/crazy-waymo/src/world/quantized-geometry.ts",
  "games/crazy-waymo/src/world/world-bin.ts",
  "games/lunerfall/src/data/actor-presentation.ts",
  "games/lunerfall/src/data/animations.ts",
  "games/lunerfall/src/data/relics.ts",
  "games/lunerfall/src/entities/boss-body.ts",
  "games/lunerfall/src/entities/enemy-body.ts",
  "games/lunerfall/src/entities/player-body.ts",
  "games/lunerfall/src/net/checkpoint.ts",
  "games/lunerfall/src/net/snapshot.ts",
  "games/moba/src/net/snapshot.ts",
  "games/moba/src/sim/math.ts",
  "games/moba/src/sim/types.ts",
  "games/starfall/src/shared/constants.ts",
  "games/starfall/src/trailer/trailer-director.ts",
];

export default defineConfig({
  extends: [core, react, antiSlop],
  ignorePatterns: [
    ...(core.ignorePatterns ?? []),
    "*.generated.ts",
    "dist-electron",
    ".wxt",
    ".claude",
    ".codex",
    ".conductor",
    ".playwright-mcp",
    "sandbox",
    "**/scripts/_lib/**",
  ],
  overrides: [
    ...tanstack.overrides.map((override) => ({
      ...override,
      files: override.files.map((glob) => `apps/web/${glob}`),
    })),
    {
      files: jsonPayloadModules,
      rules: { "typescript/consistent-type-definitions": "off" },
    },
  ],
  rules: {
    // Sequential awaits in loops are deliberate here (rate-limited source reads, ordered writes).
    "no-await-in-loop": "off",
  },
});
