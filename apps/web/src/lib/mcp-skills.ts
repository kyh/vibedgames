import type { McpServer } from "@modelcontextprotocol/server";
import { ProtocolError } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Skill } from "@/lib/mcp-tools";

/**
 * The bundled skills over MCP's Skills extension (SEP-2640,
 * `io.modelcontextprotocol/skills`): every file of a skill is a `skill://`
 * resource, `skills/list` is the catalog and `skills/get` one entry, each
 * naming every file with its digest and size so a host can load or verify it.
 * The `skills` tool stays for clients without the extension, which see these
 * resources as ordinary ones.
 */

export const SKILLS_EXTENSION = "io.modelcontextprotocol/skills";

// The skills only change with a deploy.
const cacheHint = { cacheScope: "public", ttlMs: 60 * 60 * 1000 } as const;

const MIME_TYPES = new Map(
  Object.entries({
    html: "text/html",
    js: "text/javascript",
    json: "application/json",
    md: "text/markdown",
    mjs: "text/javascript",
    py: "text/x-python",
    ts: "text/x-typescript",
  }),
);

const mimeTypeOf = (path: string): string =>
  MIME_TYPES.get(path.split(".").pop()?.toLowerCase() ?? "") ?? "text/plain";

const skillUri = (skill: Skill, path = "SKILL.md") => `skill://${skill.name}/${path}`;

interface SkillFileEntry {
  digest: string;
  size: number;
  uri: string;
}

interface SkillEntry {
  frontmatter: Skill["frontmatter"];
  resources: SkillFileEntry[];
  uri: string;
}

const fileEntry = async (uri: string, content: string): Promise<SkillFileEntry> => {
  const bytes = new TextEncoder().encode(content);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return { digest: `sha256:${hex}`, size: bytes.byteLength, uri };
};

const entries = new WeakMap<readonly Skill[], Promise<SkillEntry[]>>();

/** Each skill's catalog entry, hashed once per skill set. */
const entriesOf = (skills: readonly Skill[]): Promise<SkillEntry[]> => {
  let cached = entries.get(skills);
  if (!cached) {
    cached = Promise.all(
      skills.map(async (skill) => ({
        frontmatter: skill.frontmatter,
        resources: await Promise.all([
          fileEntry(skillUri(skill), skill.content),
          ...skill.files.map((file) => fileEntry(skillUri(skill, file.path), file.content)),
        ]),
        uri: skillUri(skill),
      })),
    );
    entries.set(skills, cached);
  }
  return cached;
};

/** Declares the extension and serves `skill://` resources, `skills/list` and `skills/get`. */
export const registerSkills = (server: McpServer, skills: readonly Skill[]) => {
  server.server.registerCapabilities({ extensions: { [SKILLS_EXTENSION]: {} }, resources: {} });

  for (const skill of skills) {
    const files = [{ content: skill.content, path: "SKILL.md" }, ...skill.files];
    for (const file of files) {
      const uri = skillUri(skill, file.path);
      const isSkillMd = file.path === "SKILL.md";
      server.registerResource(
        isSkillMd ? skill.name : `${skill.name}/${file.path}`,
        uri,
        {
          cacheHint,
          description: isSkillMd ? skill.description : undefined,
          mimeType: mimeTypeOf(file.path),
        },
        () => ({ contents: [{ mimeType: mimeTypeOf(file.path), text: file.content, uri }] }),
      );
    }
  }

  server.server.setRequestHandler(
    "skills/list",
    { params: z.looseObject({ cursor: z.string().optional() }) },
    async () => ({ skills: await entriesOf(skills), ...cacheHint }),
  );

  server.server.setRequestHandler(
    "skills/get",
    { params: z.looseObject({ uri: z.string() }) },
    async ({ uri }) => {
      const catalog = await entriesOf(skills);
      const skill = catalog.find((entry) => entry.uri === uri);
      if (!skill) {
        throw new ProtocolError(-32_602, `No skill at ${uri}. Call skills/list for the catalog.`);
      }
      return { skill, ...cacheHint };
    },
  );
};
