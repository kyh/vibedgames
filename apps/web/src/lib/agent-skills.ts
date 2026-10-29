import { z } from "zod";

import { siteConfig } from "@/lib/site-config";

/**
 * Agent Skills Discovery index (RFC v0.2.0).
 *
 * vibedgames bundles Claude Code skills under `plugins/vibedgames/skills/<skill>/SKILL.md`.
 * We publish them at `/.well-known/agent-skills/index.json` so an agent
 * visiting the site can discover the full game-studio toolkit, and serve each
 * `SKILL.md` verbatim at `/.well-known/agent-skills/{name}/SKILL.md`. `/mcp`
 * serves the same skills, supporting files included, as `skill://` resources.
 *
 * Every file is read at build time via `import.meta.glob(...?raw)` and inlined
 * — no filesystem access at request time. Each index entry's `digest` is the
 * SHA-256 of the exact bytes served at its `url`, so the index stays honest by
 * construction.
 */
const modules = import.meta.glob<string>("../../../../plugins/*/skills/*/**/*", {
  eager: true,
  import: "default",
  query: "?raw",
});

/** A skill's file other than `SKILL.md`, by its path inside the skill. */
export interface AgentSkillFile {
  content: string;
  path: string;
}

/** A YAML frontmatter value as the skills write them: a scalar, or one level of `key: value`. */
export type FrontmatterValue = string | { [key: string]: string };

/** A SKILL.md's frontmatter as JSON, as the Skills extension lists it. */
export interface Frontmatter {
  [key: string]: FrontmatterValue;
}

export interface AgentSkill {
  name: string;
  description: string;
  content: string;
  files: AgentSkillFile[];
  frontmatter: Frontmatter;
}

const unquote = (raw: string): string => {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
};

/**
 * The frontmatter block as JSON: top-level `key: value` lines, and a key with
 * no value takes the indented `key: value` lines under it as a map.
 */
const parseFrontmatter = (block: string): Frontmatter => {
  const result: Frontmatter = {};
  let nested: { [key: string]: string } | null = null;
  for (const line of block.split(/\r?\n/u)) {
    const match = /^(?<indent>\s*)(?<key>[\w-]+):(?<value>.*)$/u.exec(line);
    if (!match?.groups) {
      continue;
    }
    const { indent = "", key = "", value = "" } = match.groups;
    if (indent.length > 0) {
      if (nested) {
        nested[key] = unquote(value);
      }
      continue;
    }
    if (value.trim().length === 0) {
      nested = {};
      result[key] = nested;
    } else {
      nested = null;
      result[key] = unquote(value);
    }
  }
  return result;
};

const parseSkill = (content: string): Omit<AgentSkill, "files"> | null => {
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---/u.exec(content);
  const block = match?.groups?.frontmatter;
  if (block === undefined) {
    return null;
  }
  const frontmatter = parseFrontmatter(block);
  const required = z
    .looseObject({ description: z.string().min(1), name: z.string().min(1) })
    .safeParse(frontmatter);
  if (!required.success) {
    return null;
  }
  const { description, name } = required.data;
  return { content, description, frontmatter, name };
};

// `.../plugins/<plugin>/skills/<dir>/<path>`
const SKILL_FILE = /\/skills\/(?<dir>[^/]+)\/(?<path>.+)$/u;

const byDir = new Map<string, { content?: string; files: AgentSkillFile[] }>();
for (const [key, content] of Object.entries(modules)) {
  const { dir, path } = SKILL_FILE.exec(key)?.groups ?? {};
  if (dir === undefined || path === undefined) {
    continue;
  }
  const entry = byDir.get(dir) ?? { files: [] };
  if (path === "SKILL.md") {
    entry.content = content;
  } else {
    entry.files.push({ content, path });
  }
  byDir.set(dir, entry);
}

const skillsByName = new Map<string, AgentSkill>();
for (const { content, files } of byDir.values()) {
  const skill = content === undefined ? null : parseSkill(content);
  if (skill) {
    files.sort((a, b) => a.path.localeCompare(b.path));
    skillsByName.set(skill.name, { ...skill, files });
  }
}

export const agentSkills: AgentSkill[] = [...skillsByName.values()].toSorted((a, b) =>
  a.name.localeCompare(b.name),
);

export const getAgentSkill = (name: string): AgentSkill | undefined => skillsByName.get(name);

export const skillUrl = (name: string): string =>
  `${siteConfig.url}/.well-known/agent-skills/${name}/SKILL.md`;

export interface SkillIndexEntry {
  name: string;
  type: "skill-md";
  description: string;
  url: string;
  digest: string;
}

const sha256Hex = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

let indexCache: Promise<SkillIndexEntry[]> | null = null;

/** Build (and memoize) the discovery index entries with content digests. */
export const getSkillIndex = (): Promise<SkillIndexEntry[]> => {
  if (!indexCache) {
    indexCache = Promise.all(
      agentSkills.map(async (skill) => ({
        description: skill.description,
        digest: `sha256:${await sha256Hex(skill.content)}`,
        name: skill.name,
        type: "skill-md" as const,
        url: skillUrl(skill.name),
      })),
    );
  }
  return indexCache;
};
