import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { run } from "../run.js";
import type { RunResult } from "../run.js";
import { isJsonObject } from "../types.js";
import type { JsonObject, JsonValue } from "../types.js";
import {
  mainActivitySource,
  readApplicationId,
  setGradleVersion,
  setManifest,
} from "./android-shell.js";
import type { DistributeProject, NativeConfig } from "./config.js";
import { iosPlistEntries, setPlistEntries, setXcodeBuildSettings } from "./ios-shell.js";
import { readPngSize } from "./png.js";

export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface ShellInput {
  project: DistributeProject;
  native: NativeConfig;
  /** The built game, a folder inside the project. */
  buildDir: string;
  platform: Platform;
  say: (message: string) => void;
}

export interface ShellResult {
  /** The project to open in Xcode or Android Studio, relative to the project root. */
  project: string;
  /** False when the shell still carries Capacitor's placeholder icon. */
  icon: boolean;
}

// One Capacitor major across core, CLI and both platforms: they refuse to sync
// against each other otherwise.
const CAPACITOR = "^8.0.0";
const ASSETS = "@capacitor/assets@^4.0.0";
const MIN_ICON = 1024;
const OUTPUT_TAIL = 2000;

interface PackageManagerCommand {
  bin: string;
  /** The arguments that add a dev dependency. */
  add: string[];
}

const LOCKFILES: [string, PackageManagerCommand][] = [
  ["pnpm-lock.yaml", { add: ["add", "-D"], bin: "pnpm" }],
  ["yarn.lock", { add: ["add", "-D"], bin: "yarn" }],
  ["bun.lock", { add: ["add", "-d"], bin: "bun" }],
  ["bun.lockb", { add: ["add", "-d"], bin: "bun" }],
  ["package-lock.json", { add: ["install", "-D"], bin: "npm" }],
];

/** The package manager that owns the project: the nearest lockfile, npm without one. */
const projectPackageManager = (root: string): PackageManagerCommand => {
  let current = root;
  while (true) {
    for (const [lockfile, manager] of LOCKFILES) {
      if (existsSync(path.join(current, lockfile))) {
        return manager;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return { add: ["install", "-D"], bin: "npm" };
    }
    current = parent;
  }
};

const readJsonObject = (file: string): JsonObject => {
  const parsed: JsonValue = JSON.parse(readFileSync(file, "utf-8"));
  if (!isJsonObject(parsed)) {
    throw new Error(`${file} must hold a JSON object.`);
  }
  return parsed;
};

const expectOk = (result: RunResult, doing: string): void => {
  if (result.code !== 0) {
    throw new Error(`${doing} failed:\n${result.output.slice(-OUTPUT_TAIL).trim()}`);
  }
};

const declaredPackages = (manifest: JsonObject): Set<string> => {
  const names = new Set<string>();
  for (const field of ["dependencies", "devDependencies"]) {
    const block = manifest[field];
    if (isJsonObject(block)) {
      for (const name of Object.keys(block)) {
        names.add(name);
      }
    }
  }
  return names;
};

const ensureCapacitor = async ({ project, platform, say }: ShellInput): Promise<void> => {
  const manifestPath = path.join(project.root, "package.json");
  if (!existsSync(manifestPath)) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ name: project.slug, private: true }, null, 2)}\n`,
    );
  }
  const declared = declaredPackages(readJsonObject(manifestPath));
  const wanted = ["@capacitor/core", "@capacitor/cli", `@capacitor/${platform}`].filter(
    (name) => !declared.has(name),
  );
  if (wanted.length === 0) {
    return;
  }
  const manager = projectPackageManager(project.root);
  say(`Installing ${wanted.join(", ")} with ${manager.bin}`);
  expectOk(
    await run(
      manager.bin,
      [...manager.add, ...wanted.map((name) => `${name}@${CAPACITOR}`)],
      project.root,
    ),
    `${manager.bin} ${manager.add.join(" ")}`,
  );
};

const CODE_CONFIGS = ["capacitor.config.ts", "capacitor.config.js", "capacitor.config.mjs"];

/**
 * Capacitor's own config, kept to what vibedgames.json decides. Keys this does
 * not manage (a plugin's settings) are left as written.
 */
const writeCapacitorConfig = ({ project, native, buildDir }: ShellInput): void => {
  const code = CODE_CONFIGS.find((name) => existsSync(path.join(project.root, name)));
  if (code !== undefined) {
    throw new Error(
      `${code} is in the way: \`vg distribute\` writes capacitor.config.json from vibedgames.json, and Capacitor reads the code config first. Move its settings into capacitor.config.json and delete it.`,
    );
  }
  const file = path.join(project.root, "capacitor.config.json");
  const existing = existsSync(file) ? readJsonObject(file) : {};
  const config: JsonObject = {
    ...existing,
    appId: native.appId,
    appName: project.name,
    backgroundColor: native.backgroundColor,
    webDir: path.relative(project.root, buildDir).split(path.sep).join("/"),
  };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
};

const cap = (root: string, args: string[]): Promise<RunResult> =>
  run("npx", ["--no-install", "cap", ...args], root);

const rewrite = (file: string, transform: (text: string) => string): void => {
  if (!existsSync(file)) {
    throw new Error(`${file} is missing: delete the platform folder and run this again.`);
  }
  writeFileSync(file, transform(readFileSync(file, "utf-8")));
};

const applyIos = ({ project, native }: ShellInput): string => {
  const app = path.join(project.root, "ios", "App");
  rewrite(path.join(app, "App", "Info.plist"), (plist) =>
    setPlistEntries(plist, iosPlistEntries(native)),
  );
  rewrite(path.join(app, "App.xcodeproj", "project.pbxproj"), (pbxproj) =>
    setXcodeBuildSettings(pbxproj, native),
  );
  return "ios/App/App.xcodeproj";
};

const applyAndroid = ({ project, native }: ShellInput): string => {
  const app = path.join(project.root, "android", "app");
  const gradle = path.join(app, "build.gradle");
  const created = existsSync(gradle) ? readApplicationId(readFileSync(gradle, "utf-8")) : null;
  if (created !== null && created !== native.appId) {
    // The id is also the Java package and its folder path, so it cannot be
    // patched in place the way the iOS bundle id can.
    throw new Error(
      `android/ was created as ${created}, but vibedgames.json now says ${native.appId}. Delete android/ and run this again.`,
    );
  }
  rewrite(gradle, (text) => setGradleVersion(text, native));
  rewrite(path.join(app, "src", "main", "AndroidManifest.xml"), (manifest) =>
    setManifest(manifest, native),
  );
  const activityDir = path.join(app, "src", "main", "java", ...native.appId.split("."));
  mkdirSync(activityDir, { recursive: true });
  writeFileSync(path.join(activityDir, "MainActivity.java"), mainActivitySource(native.appId));
  return "android";
};

const generateIcons = async ({ project, native, platform, say }: ShellInput): Promise<boolean> => {
  if (native.icon === null) {
    return false;
  }
  const source = path.resolve(project.root, native.icon);
  if (!existsSync(source)) {
    throw new Error(`distribute.icon points at ${native.icon}, which does not exist.`);
  }
  const size = readPngSize(source);
  if (size === null || size.width !== size.height || size.width < MIN_ICON) {
    throw new Error(
      `${native.icon} must be a square PNG of ${MIN_ICON}px or more${size ? ` (it is ${size.width}×${size.height})` : ""}.`,
    );
  }
  say("Generating icons and splash screens");
  // The generator's one-image mode reads a file named `logo.png` from a folder.
  const staging = mkdtempSync(path.join(tmpdir(), "vg-distribute-"));
  try {
    copyFileSync(source, path.join(staging, "logo.png"));
    const color = native.backgroundColor;
    expectOk(
      await run(
        "npx",
        [
          "--yes",
          ASSETS,
          "generate",
          `--${platform}`,
          "--assetPath",
          staging,
          "--iconBackgroundColor",
          color,
          "--iconBackgroundColorDark",
          color,
          "--splashBackgroundColor",
          color,
          "--splashBackgroundColorDark",
          color,
        ],
        project.root,
      ),
      "Icon generation",
    );
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
  return true;
};

/**
 * Create the platform's Capacitor project if it is not there, copy the build
 * into it, and bring its identity, version, orientation, permissions and icons
 * in line with vibedgames.json. Safe to run after every build.
 */
export const prepareShell = async (input: ShellInput): Promise<ShellResult> => {
  const { project, platform, buildDir, say } = input;
  if (path.resolve(buildDir) === path.resolve(project.root)) {
    throw new Error(
      "The game must sit in its own folder (dist/, build/ or out/): the shell copies that whole folder into the app, and the project root holds the shell itself.",
    );
  }
  await ensureCapacitor(input);
  writeCapacitorConfig(input);
  if (!existsSync(path.join(project.root, platform))) {
    say(`Creating the ${platform} project`);
    expectOk(await cap(project.root, ["add", platform]), `cap add ${platform}`);
  }
  say("Copying the build into the shell");
  expectOk(await cap(project.root, ["sync", platform]), `cap sync ${platform}`);
  const shell = platform === "ios" ? applyIos(input) : applyAndroid(input);
  return { icon: await generateIcons(input), project: shell };
};
