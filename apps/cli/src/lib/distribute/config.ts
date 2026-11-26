import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SLUG_RE, findProjectRoot, projectConfigPath } from "../config-file.js";
import { isJsonNumber, isJsonObject, isJsonString } from "../types.js";
import type { JsonObject, JsonValue } from "../types.js";

export const ORIENTATIONS = ["any", "portrait", "landscape"] as const;

export type Orientation = (typeof ORIENTATIONS)[number];

/** Why the app asks for a device, in the words the OS shows the player. */
export interface DevicePermissions {
  camera?: string;
  microphone?: string;
}

/**
 * Everything a native shell is generated from. It lives under `distribute` in
 * vibedgames.json and is the shell's only source of truth: `ios/` and
 * `android/` are rewritten from it on every run, never edited to match.
 */
export interface NativeConfig {
  /** Reverse-DNS id, the app's permanent identity in both stores. */
  appId: string;
  /** The version players see, e.g. `1.0.0`. */
  version: string;
  /** Upload counter: each store refuses a build number it has already seen. */
  build: number;
  orientation: Orientation;
  /** Shown behind the web view while it loads, and behind the splash logo. */
  backgroundColor: string;
  /** A square PNG, 1024px or larger, relative to the project root. */
  icon: string | null;
  permissions: DevicePermissions;
}

export interface DistributeProject {
  /** The directory holding vibedgames.json. */
  root: string;
  slug: string;
  name: string;
  native: NativeConfig | null;
}

export const APP_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/u;
const VERSION_RE = /^\d+(?:\.\d+){0,2}$/u;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/u;
const DEFAULT_ICON = "icon.png";

const isOrientation = (value: string): value is Orientation =>
  ORIENTATIONS.some((orientation) => orientation === value);

const readJson = (file: string) => {
  const parsed: JsonValue = JSON.parse(readFileSync(file, "utf-8"));

  if (!isJsonObject(parsed)) {
    throw new Error(`${file} must hold a JSON object.`);
  }

  return parsed;
};

const optionalString = (source: JsonObject, key: string, pattern: RegExp, expected: string) => {
  const value = source[key];

  if (value === undefined) {
    return;
  }

  if (!isJsonString(value) || !pattern.test(value)) {
    throw new Error(`vibedgames.json: distribute.${key} must be ${expected}.`);
  }

  return value;
};

const parsePermissions = (value: JsonValue | undefined) => {
  if (value === undefined) {
    return {};
  }

  if (!isJsonObject(value)) {
    throw new Error("vibedgames.json: distribute.permissions must be an object.");
  }

  const permissions: DevicePermissions = {};

  for (const device of ["camera", "microphone"] as const) {
    const reason = value[device];

    if (reason === undefined) {
      continue;
    }

    if (!isJsonString(reason) || reason.trim().length === 0) {
      throw new Error(
        `vibedgames.json: distribute.permissions.${device} must be the sentence the OS shows when it asks, e.g. "Steer with your hand."`,
      );
    }

    permissions[device] = reason;
  }

  return permissions;
};

const parseBuild = (value: JsonValue | undefined) => {
  if (value === undefined) {
    return 1;
  }

  if (!isJsonNumber(value) || !Number.isInteger(value) || value < 1) {
    throw new Error("vibedgames.json: distribute.build must be a whole number, 1 or more.");
  }

  return value;
};

const parseOrientation: (value: JsonValue | undefined) => Orientation = (value) => {
  if (value === undefined) {
    return "any";
  }

  if (!isJsonString(value) || !isOrientation(value)) {
    throw new Error(
      `vibedgames.json: distribute.orientation must be one of ${ORIENTATIONS.join(", ")}.`,
    );
  }

  return value;
};

const parseNative = (root: string, block: JsonObject) => {
  const appId = optionalString(
    block,
    "appId",
    APP_ID_RE,
    "a reverse-DNS id such as com.yourstudio.game",
  );

  if (appId === undefined) {
    return null;
  }

  const { icon } = block;

  if (icon !== undefined && !isJsonString(icon)) {
    throw new Error("vibedgames.json: distribute.icon must be a path to a square PNG.");
  }

  return {
    appId,
    backgroundColor:
      optionalString(block, "backgroundColor", COLOR_RE, "a #rrggbb colour") ?? "#000000",
    build: parseBuild(block.build),
    icon: icon ?? (existsSync(path.join(root, DEFAULT_ICON)) ? DEFAULT_ICON : null),
    orientation: parseOrientation(block.orientation),
    permissions: parsePermissions(block.permissions),
    version: optionalString(block, "version", VERSION_RE, "a version such as 1.0.0") ?? "1.0.0",
  };
};

/** The project at or above `dir`, or a message saying what is missing. */
export const readDistributeProject = (dir: string) => {
  const root = findProjectRoot(dir);

  if (root === null || root === "") {
    throw new Error(
      `No vibedgames.json at or above ${dir}. Create one: {"slug": "my-game", "name": "My Game"}`,
    );
  }

  const raw = readJson(projectConfigPath(root));

  if (!isJsonString(raw.slug) || !SLUG_RE.test(raw.slug)) {
    throw new Error('vibedgames.json needs a "slug": lowercase letters, digits and hyphens.');
  }

  const block = raw.distribute;

  if (block !== undefined && !isJsonObject(block)) {
    throw new Error("vibedgames.json: distribute must be an object.");
  }

  return {
    name: isJsonString(raw.name) && raw.name.length > 0 ? raw.name : raw.slug,
    native: block ? parseNative(root, block) : null,
    root,
    slug: raw.slug,
  };
};

/** Merge `fields` into vibedgames.json's `distribute` block, leaving every other key as written. */
export const writeDistributeFields = (root: string, fields: JsonObject) => {
  const file = projectConfigPath(root);
  const raw = readJson(file);
  const block = isJsonObject(raw.distribute) ? raw.distribute : {};
  writeFileSync(
    file,
    `${JSON.stringify({ ...raw, distribute: { ...block, ...fields } }, null, 2)}\n`,
  );
};
