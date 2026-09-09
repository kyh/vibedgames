import { siteConfig } from "@/lib/site-config";

/**
 * Agent Skills Discovery index (RFC v0.2.0).
 *
 * vibedgames bundles Claude Code skills under `plugins/<plugin>/skills/<skill>/SKILL.md`.
 * We publish them at `/.well-known/agent-skills/index.json` so an agent
 * visiting the site can discover the full game-studio toolkit, and serve each
 * `SKILL.md` verbatim at `/.well-known/agent-skills/{name}/SKILL.md`.
 *
 * The `SKILL.md` files are read at build time via `import.meta.glob(...?raw)`
 * and inlined — no filesystem access at request time. Each index entry's
 * `digest` is the SHA-256 of the exact bytes served at its `url`, so the index
 * stays honest by construction.
 */
const modules = import.meta.glob<string>("../../../../plugins/*/skills/*/SKILL.md", {
  eager: true,
  import: "default",
  query: "?raw",
});

export interface AgentSkill {
  name: string;
  description: string;
  content: string;
}

/** Pull a single-line `key: value` out of a YAML frontmatter block, unquoting. */
const frontmatterValue = (block: string, key: string): string | null => {
  const line = block.split(/\r?\n/u).find((l) => l.startsWith(`${key}:`));
  if (!line) {
    return null;
  }
  let value = line.slice(key.length + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : null;
};

const parseSkill = (content: string): AgentSkill | null => {
  const match = /^---\r?\n(?<frontmatter>[\s\S]*?)\r?\n---/u.exec(content);
  const block = match?.groups?.frontmatter;
  if (block === undefined) {
    return null;
  }
  const name = frontmatterValue(block, "name");
  const description = frontmatterValue(block, "description");
  if (!name || !description) {
    return null;
  }
  return { content, description, name };
};

const skillsByName = new Map<string, AgentSkill>();
for (const content of Object.values(modules)) {
  const skill = parseSkill(content);
  if (skill) {
    skillsByName.set(skill.name, skill);
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
