import { defineConfig } from "oxlint";
import antiSlop from "ultracite/oxlint/anti-slop";
import core from "ultracite/oxlint/core";
import react from "ultracite/oxlint/react";
import tanstack from "ultracite/oxlint/tanstack";

export default defineConfig({
  extends: [core, react, antiSlop],
  ignorePatterns: [
    ...core.ignorePatterns,
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
  overrides: tanstack.overrides.map((override) => ({
    ...override,
    files: override.files.map((glob) => `apps/web/${glob}`),
  })),
  rules: {
    // Sequential awaits in loops are deliberate here (rate-limited source reads, ordered writes).
    "no-await-in-loop": "off",
  },
});
