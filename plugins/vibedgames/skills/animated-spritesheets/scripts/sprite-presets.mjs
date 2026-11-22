#!/usr/bin/env node
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

const isPlainObject = (v) => Object.prototype.toString.call(v) === "[object Object]";
const isString = (v) => String(v) === v;

const emit = (value, asJson) => {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));

    return;
  }

  if (Array.isArray(value)) {
    for (const row of value) {
      console.log(isString(row) ? row : JSON.stringify(row));
    }

    return;
  }

  if (isPlainObject(value)) {
    for (const [key, nested] of Object.entries(value)) {
      console.log(`${key}: ${formatPythonValue(nested)}`);
    }

    return;
  }

  console.log(String(value));
};

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["json", "list", "list-profiles"],
    values: ["action", "coerce-frames", "profile"],
  });

  const asJson = getFlag(args, "json");

  if (getFlag(args, "list-profiles")) {
    emit(
      canonicalProfiles().map((key) => ({
        actions: [...PROFILES[key].actions],
        description: PROFILES[key].description,
        direction: PROFILES[key].direction,
        profile: PROFILES[key].profile,
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

      if (warning) {
        facts.frameWarning = warning;
      }
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
