import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { run } from "../run.js";
import type { Platform } from "./native-shell.js";

/** What this machine still lacks to build a platform's shell, each with its fix. */
export type Toolchain = { ready: true } | { ready: false; missing: string[] };

const STUDIO_JDK = "/Applications/Android Studio.app/Contents/jbr/Contents/Home";

const androidSdkDir = (env: NodeJS.ProcessEnv) => {
  const candidates = [
    env.ANDROID_HOME,
    env.ANDROID_SDK_ROOT,
    path.join(homedir(), "Library/Android/sdk"),
    path.join(homedir(), "Android/Sdk"),
  ];

  return candidates.find((dir) => dir !== undefined && existsSync(dir)) ?? null;
};

const iosMissing = async () => {
  if (process.platform !== "darwin") {
    return ["An iOS build needs a Mac with Xcode; this machine can only prepare the project."];
  }

  const xcode = await run("xcodebuild", ["-version"]);

  return xcode.code === 0
    ? []
    : [
        "Xcode is not installed or not selected: install it, then `sudo xcode-select -s /Applications/Xcode.app`.",
      ];
};

const androidMissing: (env: NodeJS.ProcessEnv) => Promise<string[]> = async (env) => {
  const missing: string[] = [];
  const hasJavaHome = env.JAVA_HOME !== undefined && existsSync(env.JAVA_HOME);
  const java = hasJavaHome ? null : await run("java", ["-version"]);

  if (java !== null && java.code !== 0) {
    missing.push(
      existsSync(STUDIO_JDK)
        ? `No JDK on PATH. Android Studio ships one: export JAVA_HOME="${STUDIO_JDK}"`
        : "No JDK: install JDK 21 (or Android Studio, which bundles one) and set JAVA_HOME.",
    );
  }

  const sdk = androidSdkDir(env);

  if (sdk === null) {
    missing.push("No Android SDK: install Android Studio, or set ANDROID_HOME to an SDK.");
  } else if (env.ANDROID_HOME === undefined && env.ANDROID_SDK_ROOT === undefined) {
    missing.push(`Android SDK found but not exported: export ANDROID_HOME="${sdk}"`);
  }

  return missing;
};

export const checkToolchain: (
  platform: Platform,
  env?: NodeJS.ProcessEnv,
) => Promise<Toolchain> = async (platform, env = process.env) => {
  const missing = platform === "ios" ? await iosMissing() : await androidMissing(env);

  return missing.length === 0 ? { ready: true } : { missing, ready: false };
};
