import assert from "node:assert/strict";
import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, test } from "node:test";

import { create as tarCreate } from "tar";

import {
  discoverSkills,
  fetchSkillsSource,
  findInstall,
  installSkills,
  parseAgents,
  readManifest,
  SKILLS_REPO,
  SUPPORTED_AGENTS,
} from "../src/lib/skills-install.js";
import type { InstallTarget, SkillsSource } from "../src/lib/skills-install.js";
import { isJsonObject } from "../src/lib/types.js";
import { makeCleanups, makeTestServer, makeTmpDir } from "./_helpers.js";

const { cleanups, drain } = makeCleanups();
afterEach(drain);

/** A plugins checkout holding `names`, each with an executable script. */
const makeSource = (names: string[]): SkillsSource => {
  const root = makeTmpDir(cleanups, "vg-skills-src-");
  for (const name of names) {
    const dir = path.join(root, "plugins", "vibedgames", "skills", name);
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
    writeFileSync(path.join(dir, "scripts", "run.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
  }
  return { origin: root, root };
};

const projectTarget = (): InstallTarget => ({
  cwd: makeTmpDir(cleanups, "vg-project-"),
  env: {},
  home: makeTmpDir(cleanups, "vg-home-"),
  scope: "project",
});

const readJsonObject = (file: string) => {
  const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
  assert.ok(isJsonObject(data));
  return data;
};

test("installs one copy per skill and links it for Claude Code", () => {
  const target = projectTarget();
  const report = installSkills(makeSource(["deploy", "phaser"]), target, [
    "claude-code",
    "cursor",
    "codex",
  ]);

  assert.deepEqual(report.installed, ["deploy", "phaser"]);
  assert.deepEqual(report.removed, []);
  const canonical = path.join(target.cwd, ".agents", "skills", "deploy");
  assert.ok(statSync(path.join(canonical, "SKILL.md")).isFile());
  // Scripts stay executable.
  assert.doesNotThrow(() => accessSync(path.join(canonical, "scripts", "run.mjs"), constants.X_OK));

  const link = path.join(target.cwd, ".claude", "skills", "deploy");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.equal(readlinkSync(link), path.join("..", "..", ".agents", "skills", "deploy"));
  // Cursor and Codex read .agents/skills themselves.
  assert.equal(existsSync(path.join(target.cwd, ".cursor")), false);
  assert.equal(existsSync(path.join(target.cwd, ".codex")), false);

  assert.deepEqual(readManifest(target), {
    agents: ["claude-code", "cursor", "codex"],
    skills: ["deploy", "phaser"],
  });
});

test("a re-sync removes skills dropped upstream, links included", () => {
  const target = projectTarget();
  installSkills(makeSource(["deploy", "image-to-threejs"]), target, ["claude-code"]);
  const report = installSkills(makeSource(["deploy"]), target, ["claude-code"]);

  assert.deepEqual(report.removed, ["image-to-threejs"]);
  assert.equal(existsSync(path.join(target.cwd, ".agents", "skills", "image-to-threejs")), false);
  assert.throws(() => lstatSync(path.join(target.cwd, ".claude", "skills", "image-to-threejs")));
  assert.ok(existsSync(path.join(target.cwd, ".agents", "skills", "deploy", "SKILL.md")));
});

test("takes over an `npx skills` install: prunes from its lock, then drops our entries", () => {
  const target = projectTarget();
  const lockFile = path.join(target.cwd, "skills-lock.json");
  writeFileSync(
    lockFile,
    JSON.stringify({
      skills: {
        deploy: { source: SKILLS_REPO, sourceType: "github" },
        "old-skill": { source: SKILLS_REPO, sourceType: "github" },
        theirs: { source: "someone/else", sourceType: "github" },
      },
      version: 1,
    }),
  );
  const old = path.join(target.cwd, ".agents", "skills", "old-skill");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "SKILL.md"), "---\nname: old-skill\n---\n");
  mkdirSync(path.join(target.cwd, ".claude", "skills"), { recursive: true });
  symlinkSync(
    "../../.agents/skills/old-skill",
    path.join(target.cwd, ".claude", "skills", "old-skill"),
  );
  // A real copy from a pre-symlink install sits where the link goes.
  const stale = path.join(target.cwd, ".claude", "skills", "deploy");
  mkdirSync(stale, { recursive: true });
  writeFileSync(path.join(stale, "SKILL.md"), "stale");

  const report = installSkills(makeSource(["deploy"]), target, ["claude-code"]);

  assert.deepEqual(report.removed, ["old-skill"]);
  assert.equal(existsSync(old), false);
  assert.throws(() => lstatSync(path.join(target.cwd, ".claude", "skills", "old-skill")));
  assert.ok(lstatSync(stale).isSymbolicLink());
  assert.match(readFileSync(path.join(stale, "SKILL.md"), "utf-8"), /name: deploy/u);
  const lock = readJsonObject(lockFile);
  assert.deepEqual(lock.skills, { theirs: { source: "someone/else", sourceType: "github" } });

  // With only our entries, the project lock goes away entirely.
  const solo = projectTarget();
  const soloLock = path.join(solo.cwd, "skills-lock.json");
  writeFileSync(
    soloLock,
    JSON.stringify({ skills: { deploy: { source: SKILLS_REPO } }, version: 1 }),
  );
  installSkills(makeSource(["deploy"]), solo, ["claude-code"]);
  assert.equal(existsSync(soloLock), false);
});

test("--global installs under the home directory and honours CLAUDE_CONFIG_DIR", () => {
  const home = makeTmpDir(cleanups, "vg-home-");
  const claudeConfig = path.join(home, "claude-config");
  const target: InstallTarget = {
    cwd: makeTmpDir(cleanups, "vg-project-"),
    env: { CLAUDE_CONFIG_DIR: claudeConfig },
    home,
    scope: "global",
  };
  installSkills(makeSource(["deploy"]), target, ["claude-code", "codex"]);

  assert.ok(existsSync(path.join(home, ".agents", "skills", "deploy", "SKILL.md")));
  const link = path.join(claudeConfig, "skills", "deploy");
  assert.ok(lstatSync(link).isSymbolicLink());
  assert.match(readFileSync(path.join(link, "SKILL.md"), "utf-8"), /name: deploy/u);
  assert.equal(existsSync(path.join(target.cwd, ".agents")), false);
});

test("findInstall prefers the project, then home, else null", () => {
  const target = projectTarget();
  const base = { cwd: target.cwd, env: {}, home: target.home };
  assert.equal(findInstall(["project", "global"], base), null);

  // A legacy global lock counts, with the default agents.
  mkdirSync(path.join(target.home, ".agents"), { recursive: true });
  writeFileSync(
    path.join(target.home, ".agents", ".skill-lock.json"),
    JSON.stringify({ skills: { deploy: { source: SKILLS_REPO } }, version: 3 }),
  );
  const global = findInstall(["project", "global"], base);
  assert.equal(global?.target.scope, "global");
  assert.deepEqual(global?.agents, ["claude-code", "cursor", "codex"]);

  installSkills(makeSource(["deploy"]), target, ["windsurf"]);
  const project = findInstall(["project", "global"], base);
  assert.equal(project?.target.scope, "project");
  assert.deepEqual(project?.agents, ["windsurf"]);
  assert.equal(findInstall(["global"], base)?.target.scope, "global");
});

test("parseAgents accepts known ids and * and names the unknown ones", () => {
  assert.deepEqual(parseAgents("claude-code, Cursor,codex,codex"), [
    "claude-code",
    "cursor",
    "codex",
  ]);
  assert.deepEqual(parseAgents("*"), SUPPORTED_AGENTS);
  assert.throws(() => parseAgents("claude-code,nope"), /Unknown agent: nope/u);
});

test("discoverSkills keeps only well-named skill dirs with a SKILL.md", () => {
  const source = makeSource(["deploy"]);
  const skills = path.join(source.root, "plugins", "vibedgames", "skills");
  mkdirSync(path.join(skills, "no-skill-md"));
  mkdirSync(path.join(skills, "Bad_Name"));
  writeFileSync(path.join(skills, "Bad_Name", "SKILL.md"), "");
  assert.deepEqual(
    discoverSkills(source.root).map((skill) => skill.name),
    ["deploy"],
  );
});

test("fetchSkillsSource downloads and unpacks a GitHub-shaped tarball", async () => {
  const source = makeSource(["deploy"]);
  // GitHub wraps the tree in a single <repo>-<ref>/ directory.
  const wrapper = makeTmpDir(cleanups, "vg-tar-");
  cpSync(
    path.join(source.root, "plugins"),
    path.join(wrapper, "vibedgames-plugins-main", "plugins"),
    {
      recursive: true,
    },
  );
  const tarball = path.join(wrapper, "main.tar.gz");
  await tarCreate({ cwd: wrapper, file: tarball, gzip: true, portable: true }, [
    "vibedgames-plugins-main",
  ]);
  const port = await makeTestServer(cleanups, (_req, res) => {
    res.writeHead(200, { "content-type": "application/gzip" });
    res.end(readFileSync(tarball));
  });

  const fetched = await fetchSkillsSource({
    VG_SKILLS_SOURCE: `http://127.0.0.1:${port}/x.tar.gz`,
  });
  try {
    assert.deepEqual(
      discoverSkills(fetched.root).map((skill) => skill.name),
      ["deploy"],
    );
  } finally {
    fetched.cleanup?.();
  }
  assert.equal(existsSync(fetched.root), false);

  const missing = await makeTestServer(cleanups, (_req, res) => {
    res.writeHead(404);
    res.end();
  });
  await assert.rejects(
    fetchSkillsSource({ VG_SKILLS_SOURCE: `http://127.0.0.1:${missing}/x.tar.gz` }),
    /HTTP 404/u,
  );
});

test("fetchSkillsSource uses a local checkout from VG_SKILLS_SOURCE", async () => {
  const source = makeSource(["deploy"]);
  const local = await fetchSkillsSource({ VG_SKILLS_SOURCE: source.root });
  assert.equal(local.root, source.root);
  await assert.rejects(
    fetchSkillsSource({ VG_SKILLS_SOURCE: makeTmpDir(cleanups, "vg-empty-") }),
    /has no plugins\/ directory/u,
  );
});
