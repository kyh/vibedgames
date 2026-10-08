import { defineCommand } from "citty";
import { consola } from "consola";

import { outputArgs, writeStructured } from "../lib/output.js";
import {
  isSettingKey,
  removeSetting,
  resolveSetting,
  saveSetting,
  SETTING_KEYS,
  SETTINGS,
  settingsPath,
  validate,
} from "../lib/settings.js";
import type { ResolvedSetting, SettingKey } from "../lib/settings.js";
import { assertKnownFlags } from "../lib/strict-args.js";

const keyArg = {
  description: `Setting name: ${SETTING_KEYS.join(", ")}.`,
  required: true,
  type: "positional",
} as const;

const requireKey = (key: string): SettingKey => {
  if (isSettingKey(key)) {
    return key;
  }
  consola.error(`Unknown setting: ${key}. Settings: ${SETTING_KEYS.join(", ")}.`);
  process.exit(1);
};

/** "from VG_X" / "saved" / "default", for the human output. */
const describeSource = (setting: ResolvedSetting): string => {
  if (setting.source === "env") {
    return `from ${SETTINGS[setting.key].env.name}`;
  }
  return setting.source === "config" ? "saved" : "default";
};

const warnIfEnvWins = (setting: ResolvedSetting): void => {
  if (setting.source === "env") {
    consola.warn(
      `${SETTINGS[setting.key].env.name} is set in this environment, so ${setting.key} is ${setting.value} here.`,
    );
  }
};

const listArgs = { ...outputArgs } as const;

const listCommand = defineCommand({
  args: listArgs,
  meta: {
    description: "Show every setting, its value, and where the value comes from.",
    name: "list",
  },
  run: ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, listArgs);
    const settings = SETTING_KEYS.map((key) => {
      const setting = resolveSetting(key);
      const spec = SETTINGS[key];
      return {
        description: spec.description,
        env: spec.env.name,
        key,
        source: setting.source,
        value: setting.value,
        values: spec.values ? [...spec.values] : null,
      };
    });
    if (writeStructured({ path: settingsPath(), settings }, args)) {
      return;
    }
    for (const setting of settings) {
      consola.log(
        `${setting.key} = ${setting.value}  (${describeSource(resolveSetting(setting.key))})`,
      );
    }
    consola.log(`\nSaved settings live in ${settingsPath()}`);
  },
});

const getArgs = { ...outputArgs, key: keyArg } as const;

const getCommand = defineCommand({
  args: getArgs,
  meta: { description: "Print one setting's effective value.", name: "get" },
  run: ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, getArgs);
    const setting = resolveSetting(requireKey(args.key));
    if (writeStructured({ key: setting.key, source: setting.source, value: setting.value }, args)) {
      return;
    }
    // Bare on stdout, so `$(vg config get …)` captures it.
    process.stdout.write(`${setting.value}\n`);
  },
});

const setArgs = {
  ...outputArgs,
  key: keyArg,
  value: { description: "The value to save.", required: true, type: "positional" },
} as const;

const setCommand = defineCommand({
  args: setArgs,
  meta: {
    description:
      "Save a setting for every later vg run (e.g. vg config set generate.provider codex).",
    name: "set",
  },
  run: ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, setArgs);
    const key = requireKey(args.key);
    const value = args.value.trim();
    const problem = validate(key, value);
    if (problem) {
      consola.error(problem);
      process.exit(1);
    }
    saveSetting(key, value);
    const setting = resolveSetting(key);
    if (
      writeStructured(
        { effective: setting.value, key, path: settingsPath(), source: setting.source, value },
        args,
      )
    ) {
      return;
    }
    consola.success(`${key} = ${value}`);
    warnIfEnvWins(setting);
  },
});

const unsetArgs = { ...outputArgs, key: keyArg } as const;

const unsetCommand = defineCommand({
  args: unsetArgs,
  meta: { description: "Remove a saved setting, back to its default.", name: "unset" },
  run: ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, unsetArgs);
    const key = requireKey(args.key);
    const removed = removeSetting(key);
    const setting = resolveSetting(key);
    if (writeStructured({ key, removed, source: setting.source, value: setting.value }, args)) {
      return;
    }
    consola.success(`${key} = ${setting.value}  (${describeSource(setting)})`);
    warnIfEnvWins(setting);
  },
});

export const configCommand = defineCommand({
  // Declared so citty skips `--field <value>` when looking for a subcommand.
  args: outputArgs,
  default: "list",
  meta: {
    description:
      "Show and change saved vg settings, e.g. `vg config set generate.provider codex` to send OpenAI image generation through your own Codex plan.",
    name: "config",
  },
  subCommands: {
    get: getCommand,
    list: listCommand,
    set: setCommand,
    unset: unsetCommand,
  },
});
