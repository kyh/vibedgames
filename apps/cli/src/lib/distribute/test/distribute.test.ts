import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { unzipSync } from "fflate";

import {
  mainActivitySource,
  readApplicationId,
  setGradleVersion,
  setManifest,
} from "../android-shell.js";
import { auditBuild, remoteHosts } from "../audit.js";
import type { BuildFile } from "../audit.js";
import { readDistributeProject, writeDistributeFields } from "../config.js";
import type { NativeConfig } from "../config.js";
import { iosPlistEntries, setPlistEntries, setXcodeBuildSettings } from "../ios-shell.js";
import { findPortal } from "../portals.js";
import type { PortalLimits, PortalSdk } from "../portals.js";
import { startPreview } from "../preview.js";
import { withSdkScript } from "../sdk-script.js";
import { makeCleanups, makeTmpDir } from "../../../../test/_helpers.js";

const { cleanups, drain } = makeCleanups();

afterEach(drain);

const CLI = fileURLToPath(new URL("../../../index.ts", import.meta.url));

const TSX = import.meta.resolve("tsx");

const vg = (cwd: string, ...args: string[]) => {
  const res = spawnSync(process.execPath, ["--import", TSX, CLI, "distribute", ...args], {
    cwd,
    encoding: "utf-8",
    env: { ...process.env, VG_NO_AUTO_UPDATE: "1" },
  });

  return { code: res.status, stderr: res.stderr, stdout: res.stdout };
};

const OPEN: PortalLimits = {
  fileName: null,
  maxExtractedBytes: null,
  maxFileBytes: null,
  maxFiles: null,
  maxPathLength: null,
  maxZipBytes: null,
  network: "open",
};

const audit = (
  contents: Record<string, string>,
  limits: PortalLimits = OPEN,
  sdk: PortalSdk | null = null,
) => {
  const files: BuildFile[] = Object.entries(contents).map(([file, text]) => ({
    path: file,
    size: text.length,
  }));

  return auditBuild({ files, limits, readText: (file) => contents[file] ?? "", sdk });
};

const ids = (findings: { id: string }[]) => findings.map((finding) => finding.id);

const NATIVE: NativeConfig = {
  appId: "com.studio.game",
  backgroundColor: "#101010",
  build: 7,
  icon: null,
  orientation: "landscape",
  permissions: { camera: "Steer with <your> hand & arm." },
  version: "1.2.0",
};

test("a relative build passes; a root-relative one names what will 404", () => {
  assert.deepEqual(
    audit({
      "assets/a.js": 'fetch("./assets/ship.png"); const route = "/play";',
      "assets/ship.png": "x",
      "index.html": '<script src="./assets/a.js"></script><a href="//cdn.example.com/x">',
    }),
    [],
  );

  const [finding, ...rest] = audit({
    "assets/a.js": 'fetch("/assets/ship.png")',
    "assets/ship.png": "x",
    "index.html": '<script src="/assets/a.js"></script>',
  });

  assert.deepEqual(rest, []);
  assert.equal(finding?.id, "root-relative-url");
  assert.equal(finding?.level, "error");
  assert.deepEqual(finding?.paths, ["assets/a.js", "index.html"]);
});

test("a build with no index.html stops at that", () => {
  assert.deepEqual(ids(audit({ "game.js": "" })), ["no-index"]);
});

test("a portal's caps, long paths and case collisions are errors", () => {
  const limits: PortalLimits = {
    ...OPEN,
    maxExtractedBytes: 10,
    maxFileBytes: 4,
    maxFiles: 2,
    maxPathLength: 12,
  };

  const findings = audit(
    {
      "Sprite.png": "12345",
      "a/very/long/path.png": "1",
      "index.html": "12345",
      "sprite.png": "1",
    },
    limits,
  );

  assert.deepEqual(ids(findings), [
    "too-many-files",
    "build-too-large",
    "file-too-large",
    "path-too-long",
    "case-collision",
  ]);
  assert.ok(findings.every((finding) => finding.level === "error"));
});

test("source maps and, on a restricted portal, remote hosts are warnings", () => {
  const contents = {
    "a.js":
      'new WebSocket("wss://x"); fetch("https://party.example.com/room"); "http://www.w3.org/2000/svg"',
    "a.js.map": "{}",
    "index.html": "",
  };

  assert.deepEqual(ids(audit(contents)), ["source-maps"]);
  const restricted = audit(contents, { ...OPEN, network: "restricted" });
  assert.deepEqual(ids(restricted), ["source-maps", "remote-hosts"]);
  assert.ok(restricted.every((finding) => finding.level === "warning"));
  assert.deepEqual(
    remoteHosts({
      files: [{ path: "a.js", size: 1 }],
      readText: () => contents["a.js"],
    }),
    ["party.example.com"],
  );
});

test("vg distribute itch packs the build with index.html at the zip root", () => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  writeFileSync(path.join(root, "vibedgames.json"), '{"slug":"my-game"}');
  writeFileSync(path.join(root, "package.json"), "{}");
  mkdirSync(path.join(root, "dist", "assets"), { recursive: true });
  writeFileSync(path.join(root, "dist", "index.html"), '<script src="./assets/a.js"></script>');
  writeFileSync(path.join(root, "dist", "assets", "a.js"), "console.log(1)");

  const first = vg(root, "itch", "--json");
  assert.equal(first.code, 0, first.stderr);
  const result: { zip: string; files: number; ok: boolean } = JSON.parse(first.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.files, 2);
  assert.equal(result.zip, path.join(root, "distribute", "my-game-itch.zip"));
  const packed = readFileSync(result.zip);
  assert.deepEqual(Object.keys(unzipSync(packed)).toSorted(), ["assets/a.js", "index.html"]);

  vg(root, "itch", "--json");
  assert.ok(packed.equals(readFileSync(result.zip)));
});

test("vg distribute web fails, and writes no zip, when the build would break", () => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  writeFileSync(path.join(root, "index.html"), '<script src="/main.js"></script>');
  writeFileSync(path.join(root, "main.js"), "");
  const res = vg(root, "web", "--json");
  assert.equal(res.code, 1);
  const result: { zip: string | null; findings: { id: string }[] } = JSON.parse(res.stdout);
  assert.equal(result.zip, null);
  assert.deepEqual(ids(result.findings), ["root-relative-url"]);
  assert.equal(existsSync(path.join(root, "distribute")), false);

  assert.notEqual(vg(root, "nowhere").code, 0);
  assert.equal(vg(root, "itch", "--prevew").code, 2);
});

test("an unbuilt project is refused rather than packed as source", () => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  writeFileSync(path.join(root, "package.json"), "{}");
  writeFileSync(path.join(root, "index.html"), "");
  const res = vg(root, "web");
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no build output/u);
});

test("a native shell needs an app id, and --app-id is validated before anything is written", () => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  const config = path.join(root, "vibedgames.json");
  writeFileSync(config, '{"slug":"my-game"}');
  const missing = vg(root, "ios");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /--app-id com\.yourstudio\.mygame/u);
  assert.equal(vg(root, "ios", "--app-id", "pong").code, 1);
  assert.equal(readFileSync(config, "utf-8"), '{"slug":"my-game"}');
});

test("the distribute block is parsed with defaults, and written without losing other keys", () => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  const config = path.join(root, "vibedgames.json");
  writeFileSync(config, '{"slug":"my-game","name":"My Game","distribute":{"build":3}}');
  assert.equal(readDistributeProject(root).native, null);

  writeDistributeFields(root, { appId: "com.studio.game" });
  const project = readDistributeProject(root);
  assert.equal(project.name, "My Game");
  assert.deepEqual(project.native, {
    appId: "com.studio.game",
    backgroundColor: "#000000",
    build: 3,
    icon: null,
    orientation: "any",
    permissions: {},
    version: "1.0.0",
  });

  writeDistributeFields(root, { orientation: "sideways" });
  assert.throws(() => readDistributeProject(root), /orientation must be one of/u);
});

const PLIST = `<plist version="1.0">
<dict>
	<key>UISupportedInterfaceOrientations</key>
	<array>
		<string>UIInterfaceOrientationPortrait</string>
	</array>
	<key>UIViewControllerBasedStatusBarAppearance</key>
	<true/>
	<key>CFBundleName</key>
	<string>$(PRODUCT_NAME)</string>
</dict>
</plist>
`;

test("Info.plist entries replace what is there, and applying them twice changes nothing", () => {
  const entries = iosPlistEntries(NATIVE);
  const once = setPlistEntries(PLIST, entries);
  assert.equal(setPlistEntries(once, entries), once);
  assert.equal(once.match(/<key>UISupportedInterfaceOrientations<\/key>/gu)?.length, 1);
  assert.doesNotMatch(once, /UIInterfaceOrientationPortrait</u);
  assert.match(once, /<key>UIViewControllerBasedStatusBarAppearance<\/key>\n\t<false\/>/u);
  assert.match(once, /<string>Steer with &lt;your&gt; hand &amp; arm\.<\/string>/u);
  assert.match(once, /<key>CFBundleName<\/key>/u);
  assert.doesNotMatch(once, /NSMicrophoneUsageDescription/u);
});

test("Xcode build settings take the id, version and build number", () => {
  const pbxproj =
    "MARKETING_VERSION = 1.0;\nCURRENT_PROJECT_VERSION = 1;\nPRODUCT_BUNDLE_IDENTIFIER = com.example.app;\n";

  assert.equal(
    setXcodeBuildSettings(pbxproj, NATIVE),
    "MARKETING_VERSION = 1.2.0;\nCURRENT_PROJECT_VERSION = 7;\nPRODUCT_BUNDLE_IDENTIFIER = com.studio.game;\n",
  );
});

const MANIFEST = `<manifest>
    <application>
        <activity
            android:name=".MainActivity"
            android:exported="true">
        </activity>
    </application>
    <uses-permission android:name="android.permission.INTERNET" />
</manifest>
`;

test("the Android manifest gains orientation and permissions once, and loses them again", () => {
  const once = setManifest(MANIFEST, NATIVE);
  assert.equal(setManifest(once, NATIVE), once);
  assert.match(once, /android:screenOrientation="sensorLandscape"/u);
  assert.match(once, /android\.permission\.CAMERA/u);
  assert.match(once, /android\.hardware\.camera" android:required="false"/u);
  assert.doesNotMatch(once, /RECORD_AUDIO/u);
  assert.equal(setManifest(once, { ...NATIVE, orientation: "any", permissions: {} }), MANIFEST);
});

test("Gradle takes the version; the activity is declared in the app's package", () => {
  const gradle = 'applicationId "com.studio.game"\nversionCode 1\nversionName "1.0"\n';
  assert.equal(readApplicationId(gradle), "com.studio.game");
  assert.equal(
    setGradleVersion(gradle, NATIVE),
    'applicationId "com.studio.game"\nversionCode 7\nversionName "1.2.0"\n',
  );
  assert.match(mainActivitySource("com.studio.game"), /^package com\.studio\.game;/u);
});

test("every portal that needs an SDK or review says so", () => {
  assert.equal(findPortal("poki")?.limits.network, "restricted");
  assert.equal(findPortal("itch")?.limits.maxFiles, 1000);
  assert.equal(findPortal("nowhere"), undefined);
});

const youtube = findPortal("youtube");
const YT_SDK = youtube?.integration ?? null;

test("the SDK tag goes first in <head>, once", () => {
  const url = "https://www.youtube.com/game_api/v1";
  const html = '<html><head lang="en"><script src="./a.js"></script></head></html>';
  const once = withSdkScript(html, url);
  assert.ok(once.indexOf(url) < once.indexOf("./a.js"));
  assert.equal(withSdkScript(once, url), once);
  assert.equal(withSdkScript('<script src="./a.js"></script>', url).indexOf(url), 13);
});

test("YouTube's file-name rule and SDK calls are checked", () => {
  assert.ok(youtube);
  assert.ok(YT_SDK);

  const integrated =
    "y.game.firstFrameReady();y.game.gameReady();y.system.onPause(f);y.system.onResume(f);y.system.isAudioEnabled();";

  assert.deepEqual(audit({ "a.js": integrated, "index.html": "" }, youtube.limits, YT_SDK), []);

  const [missing] = audit(
    { "a.js": "y.game.gameReady();", "index.html": "" },
    youtube.limits,
    YT_SDK,
  );

  assert.equal(missing?.id, "sdk-not-called");
  assert.match(missing?.message ?? "", /firstFrameReady, onPause, onResume, isAudioEnabled/u);

  const named = audit(
    { "a.js": integrated, "index.html": "", "my sprite.png": "" },
    youtube.limits,
    YT_SDK,
  );

  assert.deepEqual(ids(named), ["bad-file-name"]);
});

test("vg distribute youtube adds the SDK tag to the package, not the build", () => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  writeFileSync(
    path.join(root, "index.html"),
    "<html><head></head><body><script>ytgame.game.firstFrameReady();ytgame.game.gameReady();ytgame.system.onPause(f);ytgame.system.onResume(f);ytgame.system.isAudioEnabled();</script></body></html>",
  );
  const res = vg(root, "youtube", "--out", path.join(root, "out", "g.zip"), "--json");
  assert.equal(res.code, 0, res.stdout + res.stderr);
  const packed = unzipSync(readFileSync(path.join(root, "out", "g.zip")));
  assert.match(
    new TextDecoder().decode(packed["index.html"]),
    /<head>\n {4}<script src="https:\/\/www\.youtube\.com\/game_api\/v1"><\/script>/u,
  );
  assert.doesNotMatch(readFileSync(path.join(root, "index.html"), "utf-8"), /game_api/u);
});

test("the preview serves the zip under a folder, with the portal's CSP and the SDK stand-in", async (t) => {
  assert.ok(youtube && YT_SDK);
  const { zipSync } = await import("fflate");

  const zip = zipSync({
    "assets/a.js": new TextEncoder().encode("1"),
    "index.html": new TextEncoder().encode(`<head><script src="${YT_SDK.script}"></script></head>`),
  });

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const preview = await startPreview({ port, portal: youtube, zip });
  t.after(() => preview.close());

  const index = await fetch(preview.gameUrl);
  assert.equal(index.headers.get("content-security-policy"), YT_SDK.csp);
  assert.match(await index.text(), /src="\/__vg\/sdk\.js"/u);
  const stub = await fetch(`http://127.0.0.1:${port}/__vg/sdk.js`);
  assert.match(await stub.text(), /IN_PLAYABLES_ENV: true/u);
  const inFolder = await fetch(`http://127.0.0.1:${port}/play/assets/a.js`);
  assert.equal(inFolder.status, 200);
  const atRoot = await fetch(`http://127.0.0.1:${port}/assets/a.js`);
  assert.equal(atRoot.status, 404);
  const page = await fetch(preview.url);
  assert.match(await page.text(), /src="http:\/\/127\.0\.0\.1:\d+\/play\/index\.html"/u);
});

test("--preview packs, then serves the zip until stopped", async (t) => {
  const root = makeTmpDir(cleanups, "vg-distribute-");
  writeFileSync(path.join(root, "index.html"), "<html><head></head><body>hi</body></html>");
  const port = 20_000 + Math.floor(Math.random() * 20_000);

  const child = spawn(
    process.execPath,
    ["--import", TSX, CLI, "distribute", "web", "--preview", "--port", String(port), "--json"],
    { cwd: root, env: { ...process.env, VG_NO_AUTO_UPDATE: "1" } },
  );

  t.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  const deadline = Date.now() + 15_000;

  while (!stdout.trimEnd().endsWith("}") && Date.now() < deadline) {
    await delay(50);
  }

  const result: { ok: boolean; preview: { url: string; game_url: string } } = JSON.parse(stdout);
  assert.equal(result.ok, true);
  const game = await fetch(result.preview.game_url);
  assert.match(await game.text(), /hi/u);
  const page = await fetch(result.preview.url);
  assert.equal(page.status, 200);
});
