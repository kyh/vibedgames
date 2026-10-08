import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { extract as tarExtract } from "tar";

import { isJsonObject, isJsonString } from "./types.js";
import type { JsonObject, JsonValue } from "./types.js";

/**
 * `vg init` / `vg update`: install the vibedgames skills without a
 * third-party installer.
 *
 * The layout matches what `npx skills add` wrote before, so an existing
 * install is updated in place: one real copy per skill in
 * `<base>/.agents/skills/<name>` (Codex, Cursor and the other agents that read
 * `.agents/skills` natively need nothing more), plus a per-skill symlink for
 * agents with a skills dir of their own (`.claude/skills/<name>` for Claude
 * Code). `<base>` is the project directory, or the home directory with
 * `--global`.
 *
 * Unlike `skills update`, a sync also removes skills that were dropped
 * upstream, and nothing is sent anywhere but the download itself.
 */

export const SKILLS_REPO = "kyh/vibedgames-plugins";
const SKILLS_TARBALL = `https://codeload.github.com/${SKILLS_REPO}/tar.gz/refs/heads/main`;

/** What `vg init` installs for when no `--agent` is given. */
export const DEFAULT_AGENTS = ["claude-code", "cursor", "codex"];

// Agents that read `<base>/.agents/skills` themselves: the canonical copy is
// all they need.
const SHARED_DIR_AGENTS = new Set([
  "amp",
  "antigravity",
  "cline",
  "codex",
  "cursor",
  "gemini-cli",
  "github-copilot",
  "kilo",
  "opencode",
  "replit",
  "warp",
  "zed",
]);

interface AgentDirs {
  project: string;
  global: (home: string, env: NodeJS.ProcessEnv) => string;
}

const configHome = (home: string, env: NodeJS.ProcessEnv): string =>
  env.XDG_CONFIG_HOME ?? path.join(home, ".config");

// Agents with a skills dir of their own: each skill gets a symlink there,
// pointing at its canonical copy.
const LINKED_AGENTS = new Map<string, AgentDirs>([
  [
    "claude-code",
    {
      global: (home, env) =>
        path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), "skills"),
      project: ".claude/skills",
    },
  ],
  ["augment", { global: (home) => path.join(home, ".augment/skills"), project: ".augment/skills" }],
  [
    "continue",
    { global: (home) => path.join(home, ".continue/skills"), project: ".continue/skills" },
  ],
  [
    "crush",
    {
      global: (home, env) => path.join(configHome(home, env), "crush/skills"),
      project: ".crush/skills",
    },
  ],
  [
    "goose",
    {
      global: (home, env) => path.join(configHome(home, env), "goose/skills"),
      project: ".goose/skills",
    },
  ],
  ["junie", { global: (home) => path.join(home, ".junie/skills"), project: ".junie/skills" }],
  ["kiro-cli", { global: (home) => path.join(home, ".kiro/skills"), project: ".kiro/skills" }],
  [
    "openhands",
    { global: (home) => path.join(home, ".openhands/skills"), project: ".openhands/skills" },
  ],
  ["qwen-code", { global: (home) => path.join(home, ".qwen/skills"), project: ".qwen/skills" }],
  ["roo", { global: (home) => path.join(home, ".roo/skills"), project: ".roo/skills" }],
  ["trae", { global: (home) => path.join(home, ".trae/skills"), project: ".trae/skills" }],
  [
    "windsurf",
    {
      global: (home) => path.join(home, ".codeium/windsurf/skills"),
      project: ".windsurf/skills",
    },
  ],
]);

export const SUPPORTED_AGENTS = [...SHARED_DIR_AGENTS, ...LINKED_AGENTS.keys()].toSorted();

/** Resolve `--agent` (comma list, or `*` for every supported agent). */
export const parseAgents = (raw: string): string[] => {
  const ids = raw
    .split(",")
    .map((id) => id.trim().toLowerCase())
    .filter(Boolean);
  if (ids.includes("*")) {
    return SUPPORTED_AGENTS;
  }
  const unknown = ids.filter((id) => !SHARED_DIR_AGENTS.has(id) && !LINKED_AGENTS.has(id));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown agent: ${unknown.join(", ")}. Supported: ${SUPPORTED_AGENTS.join(", ")}. ` +
        "Any other agent can read the skills from .agents/skills (or ~/.agents/skills with --global).",
    );
  }
  return [...new Set(ids)];
};

// Skill directory names come from a downloaded archive and become paths we
// delete and recreate, so nothing that could climb out of the skills dir.
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;

// What never belongs in an installed skill.
const SKIPPED_ENTRIES = new Set([".DS_Store", ".git", "__pycache__", "node_modules"]);

export interface SkillsSource {
  /** Root of the plugins checkout: holds `plugins/<plugin>/skills/<name>/SKILL.md`. */
  root: string;
  /** Where it came from, for messages. */
  origin: string;
  /** Removes the download, when there was one. */
  cleanup?: () => void;
}

/**
 * Fetch the skills. `VG_SKILLS_SOURCE` may name a local checkout (or any
 * directory with the same `plugins/` layout) or another tarball URL;
 * otherwise this downloads the plugins mirror's `main` branch from GitHub.
 */
export const fetchSkillsSource = async (
  env: NodeJS.ProcessEnv = process.env,
): Promise<SkillsSource> => {
  const override = env.VG_SKILLS_SOURCE?.trim();
  if (override && !/^https?:\/\//iu.test(override)) {
    const root = path.resolve(override);
    if (!existsSync(path.join(root, "plugins"))) {
      throw new Error(`VG_SKILLS_SOURCE=${override} has no plugins/ directory.`);
    }
    return { origin: root, root };
  }
  const url = override || SKILLS_TARBALL;
  const work = mkdtempSync(path.join(tmpdir(), "vg-skills-"));
  const cleanup = () => rmSync(work, { force: true, recursive: true });
  try {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    } catch (error) {
      throw new Error(
        `Couldn't download the skills from ${url}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (!res.ok) {
      throw new Error(`Couldn't download the skills from ${url}: HTTP ${res.status}.`);
    }
    const tarball = path.join(work, "skills.tar.gz");
    writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
    const root = path.join(work, "src");
    mkdirSync(root);
    // GitHub wraps the tree in one `<repo>-<ref>/` directory.
    await tarExtract({ cwd: root, file: tarball, strip: 1 });
    return { cleanup, origin: url, root };
  } catch (error) {
    cleanup();
    throw error;
  }
};

export interface Skill {
  name: string;
  dir: string;
}

/** Every `plugins/<plugin>/skills/<name>` that holds a SKILL.md. */
export const discoverSkills = (root: string): Skill[] => {
  const pluginsDir = path.join(root, "plugins");
  const skills = new Map<string, Skill>();
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
    const skillsDir = path.join(pluginsDir, plugin.name, "skills");
    if (!plugin.isDirectory() || !existsSync(skillsDir)) {
      continue;
    }
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      const dir = path.join(skillsDir, entry.name);
      if (
        entry.isDirectory() &&
        SKILL_NAME.test(entry.name) &&
        existsSync(path.join(dir, "SKILL.md")) &&
        !skills.has(entry.name)
      ) {
        skills.set(entry.name, { dir, name: entry.name });
      }
    }
  }
  return [...skills.values()].toSorted((a, b) => a.name.localeCompare(b.name));
};

export type Scope = "project" | "global";

export interface InstallTarget {
  scope: Scope;
  /** The project directory (project scope). */
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
}

const baseDir = (target: InstallTarget): string =>
  target.scope === "global" ? target.home : target.cwd;

const canonicalDir = (target: InstallTarget): string =>
  path.join(baseDir(target), ".agents", "skills");

const manifestPath = (target: InstallTarget): string =>
  path.join(baseDir(target), ".agents", "vibedgames-skills.json");

const agentSkillsDir = (target: InstallTarget, agent: AgentDirs): string =>
  target.scope === "global"
    ? agent.global(target.home, target.env)
    : path.join(target.cwd, agent.project);

/**
 * The lock `npx skills` kept for this scope. Entries for our repo are read so
 * skills it installed can be pruned, then dropped: vg manages them now.
 */
const legacyLockPath = (target: InstallTarget): string => {
  if (target.scope === "project") {
    return path.join(target.cwd, "skills-lock.json");
  }
  const state = target.env.XDG_STATE_HOME;
  return state
    ? path.join(state, "skills", ".skill-lock.json")
    : path.join(target.home, ".agents", ".skill-lock.json");
};

const readJson = (file: string): JsonValue | null => {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const value: JsonValue = JSON.parse(readFileSync(file, "utf-8"));
    return value;
  } catch {
    return null;
  }
};

export interface Manifest {
  skills: string[];
  agents: string[];
}

/** What vg installed here before, if anything. */
export const readManifest = (target: InstallTarget): Manifest | null => {
  const data = readJson(manifestPath(target));
  if (!isJsonObject(data) || !Array.isArray(data.skills) || !Array.isArray(data.agents)) {
    return null;
  }
  return {
    agents: data.agents.filter((agent) => isJsonString(agent)),
    skills: data.skills.filter((skill) => isJsonString(skill)),
  };
};

/** Skill names a legacy `npx skills` lock holds for our repo. */
const legacyLockSkills = (target: InstallTarget): string[] => {
  const lock = readJson(legacyLockPath(target));
  if (!isJsonObject(lock) || !isJsonObject(lock.skills)) {
    return [];
  }
  return Object.entries(lock.skills)
    .filter(([, entry]) => isJsonObject(entry) && entry.source === SKILLS_REPO)
    .map(([name]) => name);
};

/** Drop our repo's entries from the legacy lock; delete a project lock left empty. */
const releaseLegacyLock = (target: InstallTarget): void => {
  const file = legacyLockPath(target);
  const lock = readJson(file);
  if (!isJsonObject(lock) || !isJsonObject(lock.skills)) {
    return;
  }
  const skills: JsonObject = {};
  let dropped = false;
  for (const [name, entry] of Object.entries(lock.skills)) {
    if (isJsonObject(entry) && entry.source === SKILLS_REPO) {
      dropped = true;
    } else {
      skills[name] = entry;
    }
  }
  if (!dropped) {
    return;
  }
  if (target.scope === "project" && Object.keys(skills).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, `${JSON.stringify({ ...lock, skills }, null, 2)}\n`);
};

/** True when `link` is a symlink that resolves to `dir`. */
const linksTo = (link: string, dir: string): boolean => {
  try {
    return lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(dir);
  } catch {
    return false;
  }
};

/** True when `link` is a symlink whose target no longer exists. */
const isDanglingLink = (link: string): boolean => {
  try {
    return lstatSync(link).isSymbolicLink() && !existsSync(link);
  } catch {
    return false;
  }
};

const isMissing = (file: string): boolean => {
  try {
    lstatSync(file);
    return false;
  } catch {
    return true;
  }
};

/** True when `file` resolves to `dir`; false for a dangling link or a missing path. */
const resolvesTo = (file: string, dir: string): boolean => {
  try {
    return realpathSync(file) === realpathSync(dir);
  } catch {
    return false;
  }
};

/**
 * Point `link` at `dir`: relative on POSIX, a junction on Windows, and a copy
 * when the filesystem refuses links. Returns how it was done.
 */
const linkSkill = (link: string, dir: string): "linked" | "copied" | "unchanged" => {
  mkdirSync(path.dirname(link), { recursive: true });
  // Already the same directory, e.g. a correct link from an earlier install, or
  // .claude/skills itself being a link to .agents/skills.
  if (resolvesTo(link, dir)) {
    return "unchanged";
  }
  if (!isMissing(link)) {
    rmSync(link, { force: true, recursive: true });
  }
  try {
    if (process.platform === "win32") {
      symlinkSync(dir, link, "junction");
    } else {
      symlinkSync(path.relative(realpathSync(path.dirname(link)), realpathSync(dir)), link);
    }
    return "linked";
  } catch {
    cpSync(dir, link, { recursive: true });
    return "copied";
  }
};

const copySkill = (from: string, to: string): void => {
  rmSync(to, { force: true, recursive: true });
  cpSync(from, to, {
    dereference: true,
    filter: (source) => !SKIPPED_ENTRIES.has(path.basename(source)),
    recursive: true,
  });
};

export interface InstallReport {
  scope: Scope;
  /** Where the canonical copies live. */
  dir: string;
  installed: string[];
  removed: string[];
  agents: string[];
  /** Agents whose links fell back to copies (no symlink support). */
  copiedFor: string[];
}

/**
 * Install every skill in `source` for `agents`, and remove the ones a
 * previous install (by vg or by `npx skills`) put here that `source` no
 * longer has.
 */
export const installSkills = (
  source: SkillsSource,
  target: InstallTarget,
  agents: string[],
): InstallReport => {
  const skills = discoverSkills(source.root);
  if (skills.length === 0) {
    throw new Error(`No skills found in ${source.origin}.`);
  }
  const canonical = canonicalDir(target);
  const previous = new Set([...(readManifest(target)?.skills ?? []), ...legacyLockSkills(target)]);
  const names = new Set(skills.map((skill) => skill.name));
  const linked = agents.flatMap((id) => {
    const dirs = LINKED_AGENTS.get(id);
    return dirs ? [{ dir: agentSkillsDir(target, dirs), id }] : [];
  });

  const copiedFor = new Set<string>();
  mkdirSync(canonical, { recursive: true });
  for (const skill of skills) {
    const dir = path.join(canonical, skill.name);
    copySkill(skill.dir, dir);
    for (const agent of linked) {
      if (linkSkill(path.join(agent.dir, skill.name), dir) === "copied") {
        copiedFor.add(agent.id);
      }
    }
  }

  const removed: string[] = [];
  for (const name of [...previous].filter((n) => SKILL_NAME.test(n) && !names.has(n)).toSorted()) {
    const dir = path.join(canonical, name);
    for (const agent of [...LINKED_AGENTS.values()].map((dirs) => agentSkillsDir(target, dirs))) {
      const link = path.join(agent, name);
      if (linksTo(link, dir) || isDanglingLink(link)) {
        unlinkSync(link);
      }
    }
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      rmSync(dir, { force: true, recursive: true });
      removed.push(name);
    }
  }

  writeFileSync(
    manifestPath(target),
    `${JSON.stringify(
      {
        agents,
        skills: [...names],
        source: SKILLS_REPO,
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      null,
      2,
    )}\n`,
  );
  releaseLegacyLock(target);

  return {
    agents,
    copiedFor: [...copiedFor],
    dir: canonical,
    installed: [...names],
    removed,
    scope: target.scope,
  };
};

/** Download the skills and install them into `target` for `agents`. */
export const syncSkills = async (
  target: InstallTarget,
  agents: string[],
): Promise<InstallReport> => {
  const source = await fetchSkillsSource(target.env);
  try {
    return installSkills(source, target, agents);
  } finally {
    source.cleanup?.();
  }
};

export type SyncOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Run a sync without letting its failure escape, so a caller can finish other work first. */
export const settleSync = async <T>(task: Promise<T>): Promise<SyncOutcome<T>> => {
  try {
    return { ok: true, value: await task };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), ok: false };
  }
};

/** The install target for `scope` in this process's directory and home. */
export const targetFor = (scope: Scope): InstallTarget => ({
  cwd: process.cwd(),
  env: process.env,
  home: homedir(),
  scope,
});

/**
 * Where `vg update` should sync: among `scopes`, the first that holds a vg (or
 * legacy `npx skills`) install of our skills — with the agents it was
 * installed for — or null when none does.
 */
export const findInstall = (
  scopes: Scope[],
  base: Omit<InstallTarget, "scope"> = targetFor("project"),
): { target: InstallTarget; agents: string[] } | null => {
  for (const scope of scopes) {
    const target: InstallTarget = { ...base, scope };
    const manifest = readManifest(target);
    if (manifest || legacyLockSkills(target).length > 0) {
      const known = (manifest?.agents ?? []).filter(
        (id) => SHARED_DIR_AGENTS.has(id) || LINKED_AGENTS.has(id),
      );
      return { agents: known.length > 0 ? known : DEFAULT_AGENTS, target };
    }
  }
  return null;
};
