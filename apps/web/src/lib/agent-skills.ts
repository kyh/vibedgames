import { siteConfig } from "@/lib/site-config";

/**
 * Agent Skills Discovery index (RFC v0.2.0).
 *
 * vibedgames bundles Claude Code skills under `plugins/*​/skills/*​/SKILL.md`.
 * We publish them at `/.well-known/agent-skills/index.json` so an agent
 * visiting the site can discover the full game-studio toolkit, and serve each
 * `SKILL.md` verbatim at `/.well-known/agent-skills/{name}/SKILL.md`.
 *
 * The `SKILL.md` files are read at build time via `import.meta.glob(...?raw)`
 * and inlined — no filesystem access at request time. Each index entry's
 * `digest` is the SHA-256 of the exact bytes served at its `url`, so the index
 * stays honest by construction.
 */
const modules = import.meta.glob("../../../../plugins/*/skills/*/SKILL.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

export type AgentSkill = {
  name: string;
  description: string;
  content: string;
};

/** Pull a single-line `key: value` out of a YAML frontmatter block, unquoting. */
function frontmatterValue(block: string, key: string): string | null {
  const line = block.split(/\r?\n/).find((l) => l.startsWith(`${key}:`));
  if (!line) return null;
  let value = line.slice(key.length + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.length > 0 ? value : null;
}

function parseSkill(content: string): AgentSkill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  const block = match?.[1];
  if (block === undefined) return null;
  const name = frontmatterValue(block, "name");
  const description = frontmatterValue(block, "description");
  if (!name || !description) return null;
  return { name, description, content };
}

const skillsByName = new Map<string, AgentSkill>();
for (const content of Object.values(modules)) {
  const skill = parseSkill(content);
  if (skill) skillsByName.set(skill.name, skill);
}

export const agentSkills: AgentSkill[] = [...skillsByName.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
);

export function getAgentSkill(name: string): AgentSkill | undefined {
  return skillsByName.get(name);
}

export function skillUrl(name: string): string {
  return `${siteConfig.url}/.well-known/agent-skills/${name}/SKILL.md`;
}

export type SkillIndexEntry = {
  name: string;
  type: "skill-md";
  description: string;
  url: string;
  digest: string;
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

let indexCache: Promise<SkillIndexEntry[]> | null = null;

/** Build (and memoize) the discovery index entries with content digests. */
export function getSkillIndex(): Promise<SkillIndexEntry[]> {
  if (!indexCache) {
    indexCache = Promise.all(
      agentSkills.map(async (skill) => ({
        name: skill.name,
        type: "skill-md" as const,
        description: skill.description,
        url: skillUrl(skill.name),
        digest: `sha256:${await sha256Hex(skill.content)}`,
      })),
    );
  }
  return indexCache;
}
