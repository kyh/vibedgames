#!/usr/bin/env node
/**
 * Action timing semantics + genre profiles for sprite animation.
 *
 * Single source of truth for *how* each animation should be generated and
 * curated: an animation's type drives both its frame budget and which frames
 * carry the meaningful action.
 *
 * Usage:
 *   node sprite-presets.mjs --action walk [--profile platformer] [--json]
 *   node sprite-presets.mjs --profile fighting-game --list [--json]
 *   node sprite-presets.mjs --list-profiles [--json]
 */
import {
  ACTIONS,
  actionFacts,
  canonicalProfiles,
  coerceFrameCount,
  formatPythonValue,
  getFlag,
  getInt,
  getString,
  main,
  parseArgs,
  PROFILES,
  resolveProfile,
} from "./_lib/asset-tools.mjs";

/** `--json` prints structured output; otherwise dicts print as `key: value`. */
function emit(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const row of value) {
      console.log(typeof row === "string" ? row : JSON.stringify(row));
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      console.log(`${key}: ${formatPythonValue(nested)}`);
    }
    return;
  }
  console.log(String(value));
}

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    values: ["action", "coerce-frames", "profile"],
    booleans: ["json", "list", "list-profiles"],
  });
  const asJson = getFlag(args, "json");

  if (getFlag(args, "list-profiles")) {
    emit(
      canonicalProfiles().map((key) => ({
        profile: PROFILES[key].profile,
        description: PROFILES[key].description,
        direction: PROFILES[key].direction,
        actions: [...PROFILES[key].actions],
      })),
      asJson,
    );
    return;
  }

  const profileId = getString(args, "profile");
  const profile = profileId ? resolveProfile(profileId) : null;

  const actionId = getString(args, "action");
  if (actionId) {
    const facts = actionFacts(actionId, profile);
    if (getString(args, "coerce-frames") !== undefined) {
      const requested = getInt(args, "coerce-frames", 0);
      const { frames, warning } = coerceFrameCount(actionId, requested);
      facts.requestedFrames = requested;
      facts.coercedFrames = frames;
      if (warning) facts.frameWarning = warning;
    }
    emit(facts, asJson);
    return;
  }

  if (getFlag(args, "list")) {
    const ids = profile ? profile.actions : Object.keys(ACTIONS);
    emit(
      ids.map((id) => actionFacts(id, profile)),
      asJson,
    );
    return;
  }

  console.log("Usage: node sprite-presets.mjs --action <id> | --list | --list-profiles [--json]");
  process.exit(2);
});
