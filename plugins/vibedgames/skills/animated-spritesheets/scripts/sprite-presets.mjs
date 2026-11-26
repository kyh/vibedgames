#!/usr/bin/env node
// @ts-check
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
  resolveProfile,
} from "./_lib/asset-tools.mjs";

main(() => {
  const args = parseArgs(process.argv.slice(2), {
    booleans: ["json", "list", "list-profiles"],
    values: ["action", "coerce-frames", "profile"],
  });

  const asJson = getFlag(args, "json");

  const emit = (json = "", lines = [""]) => {
    if (asJson) {
      console.log(json);

      return;
    }

    for (const line of lines) {
      console.log(line);
    }
  };

  if (getFlag(args, "list-profiles")) {
    const rows = canonicalProfiles().map((key) => {
      const entry = resolveProfile(key);

      return {
        actions: [...entry.actions],
        description: entry.description,
        direction: entry.direction,
        profile: entry.profile,
      };
    });

    emit(
      JSON.stringify(rows, null, 2),
      rows.map((row) => JSON.stringify(row)),
    );

    return;
  }

  const profileId = getString(args, "profile") ?? "";
  const profile = profileId === "" ? null : resolveProfile(profileId);
  const actionId = getString(args, "action") ?? "";

  if (actionId !== "") {
    const facts = actionFacts(actionId, profile);

    if (getString(args, "coerce-frames") !== undefined) {
      const requested = getInt(args, "coerce-frames", 0);
      const { frames, warning } = coerceFrameCount(actionId, requested);
      facts.requestedFrames = requested;
      facts.coercedFrames = frames;

      if (warning !== null && warning !== "") {
        facts.frameWarning = warning;
      }
    }

    emit(
      JSON.stringify(facts, null, 2),
      Object.entries({ ...facts }).map(([key, nested]) => `${key}: ${formatPythonValue(nested)}`),
    );

    return;
  }

  if (getFlag(args, "list")) {
    const ids = profile === null ? Object.keys(ACTIONS) : profile.actions;
    const rows = ids.map((id) => actionFacts(id, profile));

    emit(
      JSON.stringify(rows, null, 2),
      rows.map((row) => JSON.stringify(row)),
    );

    return;
  }

  console.log("Usage: node sprite-presets.mjs --action <id> | --list | --list-profiles [--json]");
  process.exit(2);
});
