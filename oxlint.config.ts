import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import landmines from "ultracite/oxlint/landmines";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

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
  "games/showdown/src/net/presentation.ts",
  "games/showdown/src/net/snapshot.ts",
];

export default defineConfig({
  extends: [core, react, antiSlop, landmines],
  jsPlugins: landmines.jsPlugins,
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
    "games/strikeforce/src/core/strikeforce-core.js",
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
    "anti-slop/require-safety-comment-for-type-assertion": "off",
    "no-await-in-loop": "off",
    "no-use-before-define": ["error", { functions: false, variables: false }],
  },
});
