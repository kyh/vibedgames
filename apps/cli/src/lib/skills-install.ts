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
import type { JsonValue } from "./types.js";

const SKILLS_REPO = "kyh/vibedgames-plugins";
const SKILLS_TARBALL = `https://codeload.github.com/${SKILLS_REPO}/tar.gz/refs/heads/main`;

/** What `vg init` installs for when no `--agent` is given. */
export const DEFAULT_AGENTS = ["claude-code", "cursor", "codex"];

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

const configHome = (home: string, env: NodeJS.ProcessEnv) =>
  env.XDG_CONFIG_HOME ?? path.join(home, ".config");

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
export const parseAgents = (raw: string) => {
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

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/u;

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
export const fetchSkillsSource = async (env: NodeJS.ProcessEnv = process.env) => {
  const override = env.VG_SKILLS_SOURCE?.trim();

  if (override !== undefined && override !== "" && !/^https?:\/\//iu.test(override)) {
    const root = path.resolve(override);

    if (!existsSync(path.join(root, "plugins"))) {
      throw new Error(`VG_SKILLS_SOURCE=${override} has no plugins/ directory.`);
    }

    return { origin: root, root };
  }

  const url = override === undefined || override === "" ? SKILLS_TARBALL : override;
  const work = mkdtempSync(path.join(tmpdir(), "vg-skills-"));

  const cleanup = () => {
    rmSync(work, { force: true, recursive: true });
  };

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
export const discoverSkills = (root: string) => {
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

const baseDir = (target: InstallTarget) => (target.scope === "global" ? target.home : target.cwd);

const canonicalDir = (target: InstallTarget) => path.join(baseDir(target), ".agents", "skills");

const manifestPath = (target: InstallTarget) =>
  path.join(baseDir(target), ".agents", "vibedgames-skills.json");

const agentSkillsDir = (target: InstallTarget, agent: AgentDirs) =>
  target.scope === "global"
    ? agent.global(target.home, target.env)
    : path.join(target.cwd, agent.project);

const readJson = (file: string) => {
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

/** What vg has installed here, if anything. */
export const readManifest = (target: InstallTarget) => {
  const data = readJson(manifestPath(target));

  if (!isJsonObject(data) || !Array.isArray(data.skills) || !Array.isArray(data.agents)) {
    return null;
  }

  return {
    agents: data.agents.filter((agent) => isJsonString(agent)),
    skills: data.skills.filter((skill) => isJsonString(skill)),
  };
};

const linksTo = (link: string, dir: string) => {
  try {
    return lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(dir);
  } catch {
    return false;
  }
};

const isDanglingLink = (link: string) => {
  try {
    return lstatSync(link).isSymbolicLink() && !existsSync(link);
  } catch {
    return false;
  }
};

const isCopyOf = (copy: string, dir: string) => {
  try {
    return (
      lstatSync(copy).isDirectory() &&
      readFileSync(path.join(copy, "SKILL.md"), "utf-8") ===
        readFileSync(path.join(dir, "SKILL.md"), "utf-8")
    );
  } catch {
    return false;
  }
};

const isMissing = (file: string) => {
  try {
    lstatSync(file);

    return false;
  } catch {
    return true;
  }
};

const resolvesTo = (file: string, dir: string) => {
  try {
    return realpathSync(file) === realpathSync(dir);
  } catch {
    return false;
  }
};

const linkSkill: (link: string, dir: string) => "linked" | "copied" | "unchanged" = (link, dir) => {
  mkdirSync(path.dirname(link), { recursive: true });

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

const copySkill = (from: string, to: string) => {
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
 * Install every skill in `source` for `agents`, and remove the ones vg
 * installed here before that `source` no longer has.
 */
export const installSkills = (source: SkillsSource, target: InstallTarget, agents: string[]) => {
  const skills = discoverSkills(source.root);

  if (skills.length === 0) {
    throw new Error(`No skills found in ${source.origin}.`);
  }

  const canonical = canonicalDir(target);
  const previous = readManifest(target)?.skills ?? [];
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

  for (const name of previous.filter((n) => SKILL_NAME.test(n) && !names.has(n)).toSorted()) {
    const dir = path.join(canonical, name);

    for (const agent of [...LINKED_AGENTS.values()].map((dirs) => agentSkillsDir(target, dirs))) {
      const link = path.join(agent, name);

      if (linksTo(link, dir) || isDanglingLink(link)) {
        unlinkSync(link);
      } else if (isCopyOf(link, dir)) {
        rmSync(link, { force: true, recursive: true });
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
export const syncSkills = async (target: InstallTarget, agents: string[]) => {
  const source = await fetchSkillsSource(target.env);

  try {
    return installSkills(source, target, agents);
  } finally {
    source.cleanup?.();
  }
};

export type SyncOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** Run a sync without letting its failure escape, so a caller can finish other work first. */
export const settleSync: <T>(task: Promise<T>) => Promise<SyncOutcome<T>> = async <T>(
  task: Promise<T>,
) => {
  try {
    return { ok: true, value: await task };
  } catch (error) {
    return { message: error instanceof Error ? error.message : String(error), ok: false };
  }
};

/** The install target for `scope` in this process's directory and home. */
export const targetFor = (scope: Scope) => ({
  cwd: process.cwd(),
  env: process.env,
  home: homedir(),
  scope,
});

/**
 * Where `vg update` should sync: among `scopes`, the first that holds a vg
 * install of our skills, with the agents it was installed for; null when none
 * does.
 */
export const findInstall = (
  scopes: Scope[],
  base: Omit<InstallTarget, "scope"> = targetFor("project"),
) => {
  for (const scope of scopes) {
    const target: InstallTarget = { ...base, scope };
    const manifest = readManifest(target);

    if (manifest) {
      const known = manifest.agents.filter(
        (id) => SHARED_DIR_AGENTS.has(id) || LINKED_AGENTS.has(id),
      );

      return { agents: known.length > 0 ? known : DEFAULT_AGENTS, target };
    }
  }

  return null;
};
