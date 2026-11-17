import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";

import { resolveBuildDir } from "../lib/build-dir.js";
import { auditBuild, remoteHosts } from "../lib/distribute/audit.js";
import type { Finding } from "../lib/distribute/audit.js";
import {
  APP_ID_RE,
  readDistributeProject,
  writeDistributeFields,
} from "../lib/distribute/config.js";
import type { DistributeProject, NativeConfig } from "../lib/distribute/config.js";
import { PLATFORMS, prepareShell } from "../lib/distribute/native-shell.js";
import type { Platform } from "../lib/distribute/native-shell.js";
import { PORTALS } from "../lib/distribute/portals.js";
import type { Portal } from "../lib/distribute/portals.js";
import { checkToolchain } from "../lib/distribute/toolchain.js";
import { startPreview } from "../lib/distribute/preview.js";
import { withSdkScript } from "../lib/distribute/sdk-script.js";
import { writeZip } from "../lib/distribute/zip.js";
import type { ZipOverrides } from "../lib/distribute/zip.js";
import { buildManifest } from "../lib/manifest.js";
import { isJsonOutput, outputArgs, writeStructured } from "../lib/output.js";
import type { OutputArgs } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";

const OUT_DIR = "distribute";

const fail = (message: string): never => {
  consola.error(message);
  process.exit(1);
};

/** Progress goes quiet whenever stdout is the result rather than a story about it. */
const narrator = (args: OutputArgs): ((message: string) => void) =>
  isJsonOutput(args) || Boolean(args.field)
    ? () => {
        /* empty */
      }
    : (message) => consola.info(message);

const formatBytes = (bytes: number): string =>
  bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The built game under `dir`; exits when there is nothing a player could run. */
const requireBuild = (dir: string): string => {
  if (!existsSync(dir)) {
    return fail(`Directory does not exist: ${dir}`);
  }
  const build = resolveBuildDir(dir);
  if (build.kind === "unbuilt") {
    return fail(
      "This project has no build output (dist/, build/ or out/). Run its build first: the source index.html references files only the dev server can serve.",
    );
  }
  return build.dir;
};

const printFindings = (findings: Finding[]): void => {
  for (const finding of findings) {
    const detail = finding.paths ? `\n  ${finding.paths.slice(0, 10).join("\n  ")}` : "";
    const line = `[${finding.id}] ${finding.message}${detail}`;
    if (finding.level === "error") {
      consola.error(line);
    } else {
      consola.warn(line);
    }
  }
};

// ---- vg distribute <portal> ------------------------------------------------

const DEFAULT_PREVIEW_PORT = 8471;

const portalArgs = {
  dir: {
    default: ".",
    description: "The project, or its build output",
    required: false,
    type: "positional",
  },
  out: {
    description: `Where to write the zip (default: ${OUT_DIR}/<slug>-<platform>.zip in the project).`,
    type: "string",
  },
  port: {
    default: String(DEFAULT_PREVIEW_PORT),
    description: "With --preview: the game's port; the page framing it takes the next one.",
    type: "string",
  },
  preview: {
    default: false,
    description:
      "Then serve the zip the way the platform does (unpacked under a folder, framed from another origin, under its CSP, with a stand-in for its SDK) until stopped.",
    type: "boolean",
  },
  ...outputArgs,
} as const;

/** The project a zip is named after and written into; a bare folder stands in for one. */
const webProject = (dir: string): Pick<DistributeProject, "root" | "slug"> => {
  try {
    return readDistributeProject(dir);
  } catch {
    return { root: dir, slug: path.basename(dir) };
  }
};

const sdkFinding = (portal: Portal): Finding[] =>
  portal.sdk === "required" && portal.integration === null
    ? [
        {
          id: "sdk-required",
          level: "warning",
          message: `${portal.name} only accepts games with its SDK built in. This command packs the build as it is; integrate the SDK first.`,
        },
      ]
    : [];

/** The SDK tag goes into the package only: the build itself stays free of the portal's script. */
const packagedOverrides = (portal: Portal, buildDir: string): ZipOverrides => {
  const overrides: ZipOverrides = new Map();
  if (portal.integration !== null) {
    const html = readFileSync(path.join(buildDir, "index.html"), "utf-8");
    overrides.set(
      "index.html",
      new TextEncoder().encode(withSdkScript(html, portal.integration.script)),
    );
  }
  return overrides;
};

const overZipLimit = (portal: Portal, bytes: number): Finding[] =>
  portal.limits.maxZipBytes !== null && bytes > portal.limits.maxZipBytes
    ? [
        {
          id: "zip-too-large",
          level: "error",
          message: `The zip is ${formatBytes(bytes)}; ${portal.name} accepts ${formatBytes(portal.limits.maxZipBytes)}.`,
        },
      ]
    : [];

const parsePort = (raw: string): number => {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65_534) {
    return fail("--port must be a whole number from 1024 to 65534.");
  }
  return port;
};

interface PackResult {
  bytes: number | null;
  extracted_bytes: number;
  files: number;
  findings: Required<Finding>[];
  hosts: string[];
  ok: boolean;
  platform: string;
  submit_url: string | null;
  zip: string | null;
}

const pack = (portal: Portal, dirArg: string, outArg: string | undefined): PackResult => {
  const dir = path.resolve(dirArg);
  const buildDir = requireBuild(dir);
  const project = webProject(dir);
  const outFile = path.resolve(
    outArg ?? path.join(project.root, OUT_DIR, `${project.slug}-${portal.id}.zip`),
  );

  // A bare folder is its own build, so earlier packages sit inside it.
  const outDir = `${path.dirname(outFile)}${path.sep}`;
  const files = buildManifest(buildDir).filter((file) => !file.absolutePath.startsWith(outDir));
  const input = {
    files,
    readText: (file: string) => readFileSync(path.join(buildDir, file), "utf-8"),
  };
  const findings = [
    ...auditBuild({ ...input, limits: portal.limits, sdk: portal.integration }),
    ...sdkFinding(portal),
  ];

  let bytes: number | null = null;
  if (!findings.some((finding) => finding.level === "error")) {
    ({ bytes } = writeZip(files, outFile, packagedOverrides(portal, buildDir)));
    const tooLarge = overZipLimit(portal, bytes);
    if (tooLarge.length > 0) {
      rmSync(outFile, { force: true });
      bytes = null;
      findings.push(...tooLarge);
    }
  }

  return {
    bytes,
    extracted_bytes: files.reduce((sum, file) => sum + file.size, 0),
    files: files.length,
    findings: findings.map((finding) => ({ ...finding, paths: finding.paths ?? [] })),
    hosts: remoteHosts(input),
    ok: bytes !== null,
    platform: portal.id,
    submit_url: portal.submitUrl,
    zip: bytes === null ? null : outFile,
  };
};

const printPack = (portal: Portal, result: PackResult, previewing: boolean): void => {
  printFindings(result.findings);
  if (result.zip === null || result.bytes === null) {
    return;
  }
  consola.success(`${result.zip} (${result.files} files, ${formatBytes(result.bytes)})`);
  if (!previewing) {
    consola.info(`Try it as ${portal.name} serves it: vg distribute ${portal.id} --preview`);
  }
  if (portal.submitUrl !== null) {
    consola.info(`Upload it at ${portal.submitUrl}`);
  }
  if (result.hosts.length > 0) {
    consola.info(`The game reaches: ${result.hosts.join(", ")}`);
  }
};

interface PreviewResult {
  url: string;
  game_url: string;
  sdk_stub: boolean;
}

/** Serve the zip until the process is stopped. */
const servePreview = async (portal: Portal, zip: string, port: number): Promise<PreviewResult> => {
  let preview;
  try {
    preview = await startPreview({ port, portal, zip: readFileSync(zip) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const stop = async () => {
    await preview.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { game_url: preview.gameUrl, sdk_stub: portal.integration !== null, url: preview.url };
};

const portalCommand = (portal: Portal) =>
  defineCommand({
    args: portalArgs,
    meta: {
      description:
        portal.id === "web"
          ? "Pack the build as a zip for any web host or portal not listed here."
          : `Pack the zip ${portal.name} takes, checked against the rules it publishes.`,
      name: portal.id,
    },
    run: async ({ args, rawArgs }) => {
      assertKnownFlags(rawArgs, portalArgs);
      const port = args.preview ? parsePort(args.port) : null;
      const result = pack(portal, args.dir, args.out);
      if (result.zip === null || port === null) {
        if (!writeStructured(result, args)) {
          printPack(portal, result, false);
        }
        if (!result.ok) {
          process.exit(1);
        }
        return;
      }
      const preview = await servePreview(portal, result.zip, port);
      const served = { game_url: preview.game_url, sdk_stub: preview.sdk_stub, url: preview.url };
      if (writeStructured({ ...result, preview: served }, args)) {
        return;
      }
      printPack(portal, result, true);
      consola.success(`Preview: ${preview.url}, framed from another origin`);
      if (preview.sdk_stub) {
        consola.info(
          "The SDK is a stand-in: window.vgPreview on that page holds its call log (log.calls, log.errors) and pause(), resume(), setAudio(bool).",
        );
      }
      consola.info("Stop with Ctrl-C.");
    },
  });

// ---- vg distribute ios | android -------------------------------------------

const nativeArgs = {
  "app-id": {
    description:
      "Reverse-DNS app id, e.g. com.yourstudio.game. Saved to vibedgames.json; permanent once the app is in a store.",
    type: "string",
  },
  dir: {
    default: ".",
    description: "The project (the folder holding vibedgames.json)",
    required: false,
    type: "positional",
  },
  ...outputArgs,
} as const;

const NEXT_STEPS: Record<Platform, string[]> = {
  android: [
    "npx cap run android",
    "npx cap build android --androidreleasetype AAB --keystorepath <keystore> --keystorepass <pass> --keystorealias <alias> --keystorealiaspass <pass>",
  ],
  ios: ["npx cap run ios", "npx cap open ios"],
};

interface NativeProject {
  project: DistributeProject;
  native: NativeConfig;
}

const requireNative = (dir: string, appId: string | undefined): NativeProject => {
  if (appId !== undefined) {
    if (!APP_ID_RE.test(appId)) {
      return fail(`--app-id must be a reverse-DNS id such as com.yourstudio.game, not "${appId}".`);
    }
    try {
      writeDistributeFields(readDistributeProject(dir).root, { appId });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  }
  try {
    const project = readDistributeProject(dir);
    if (project.native === null) {
      return fail(
        `No app id yet. It is the app's permanent identity in the store, so choose it deliberately:\n  vg distribute <platform> --app-id com.yourstudio.${project.slug.replaceAll("-", "")}`,
      );
    }
    return { native: project.native, project };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
};

const nativeCommand = (platform: Platform, store: string) =>
  defineCommand({
    args: nativeArgs,
    meta: {
      description: `Wrap the build in a native ${platform === "ios" ? "iOS" : "Android"} app for ${store}, generated from vibedgames.json. Run it again after every build.`,
      name: platform,
    },
    run: async ({ args, rawArgs }) => {
      assertKnownFlags(rawArgs, nativeArgs);
      const say = narrator(args);
      const dir = path.resolve(args.dir);
      const { project, native } = requireNative(dir, args["app-id"]);
      const buildDir = requireBuild(project.root);

      let shell;
      try {
        shell = await prepareShell({ buildDir, native, platform, project, say });
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
      const toolchain = await checkToolchain(platform);
      const result = {
        app_id: native.appId,
        build: native.build,
        icon: shell.icon,
        next: NEXT_STEPS[platform],
        platform,
        project: path.join(project.root, shell.project),
        toolchain_missing: toolchain.ready ? [] : toolchain.missing,
        version: native.version,
      };
      if (writeStructured(result, args)) {
        return;
      }
      consola.success(`${result.project} — ${native.appId} ${native.version} (${native.build})`);
      if (!shell.icon) {
        consola.warn(
          "Still the placeholder icon, which no store accepts. Add a square 1024px icon.png to the project (or set distribute.icon) and run this again.",
        );
      }
      for (const missing of result.toolchain_missing) {
        consola.warn(missing);
      }
      consola.info(`Next:\n  ${result.next.join("\n  ")}`);
    },
  });

// ---- vg distribute targets --------------------------------------------------

const targetsArgs = { ...outputArgs } as const;

const targetsCommand = defineCommand({
  args: targetsArgs,
  meta: {
    description:
      "List where a game can go: each portal's limits, and whether this machine can build each store's app.",
    name: "targets",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, targetsArgs);
    const stores = await Promise.all(
      PLATFORMS.map(async (platform) => {
        const toolchain = await checkToolchain(platform);
        return { missing: toolchain.ready ? [] : toolchain.missing, platform };
      }),
    );
    const portals = PORTALS.map((portal) => ({
      access: portal.access,
      id: portal.id,
      limits: {
        max_extracted_bytes: portal.limits.maxExtractedBytes,
        max_file_bytes: portal.limits.maxFileBytes,
        max_files: portal.limits.maxFiles,
        max_path_length: portal.limits.maxPathLength,
        max_zip_bytes: portal.limits.maxZipBytes,
        network: portal.limits.network,
      },
      name: portal.name,
      notes: portal.notes,
      sdk: portal.sdk,
      submit_url: portal.submitUrl,
    }));
    if (writeStructured({ portals, stores }, args)) {
      return;
    }
    for (const portal of portals) {
      consola.log(`${portal.id.padEnd(18)} ${portal.name} — ${portal.notes}`);
    }
    for (const store of stores) {
      consola.log(
        `${store.platform.padEnd(18)} ${store.missing.length === 0 ? "ready to build" : store.missing.join(" ")}`,
      );
    }
  },
});

export const distributeCommand = defineCommand({
  meta: {
    description: `Package a built game for one platform other than vibedgames: ${[...PORTALS.map((portal) => portal.id), ...PLATFORMS].join(", ")}. \`vg distribute targets\` lists each one's rules.`,
    name: "distribute",
  },
  subCommands: {
    ...Object.fromEntries(PORTALS.map((portal) => [portal.id, portalCommand(portal)])),
    android: nativeCommand("android", "Google Play"),
    ios: nativeCommand("ios", "the App Store"),
    targets: targetsCommand,
  },
});
