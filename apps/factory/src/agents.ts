import { readFileSync } from "node:fs";

/**
 * Filesystem-first agent definitions. Each subagent is a directory under
 * `apps/factory/agents/<role>/` holding an `AGENT.md` — a file's name and place
 * in the tree IS its definition. `charter.md` is the shared system prompt
 * prepended to every subagent. Editing the markdown (prompt or emoji)
 * re-defines a subagent with no code change (restart to pick it up). The
 * published bundle sits one level below the package root exactly like `src/`
 * does, and ships `agents/` beside it, so one relative URL serves both.
 */

export type RoleName = "director" | "designer" | "engineer" | "artist" | "qa" | "shipper";

export interface Role {
  name: RoleName;
  emoji: string;
  /** Appended to Claude Code's system prompt for every invocation in this role. */
  system: string;
}

const readAgentFile = (relativePath: string): string =>
  readFileSync(new URL(`../agents/${relativePath}`, import.meta.url), "utf-8");

interface FrontMatter {
  emoji?: string;
}

interface ParsedAgentFile {
  meta: FrontMatter;
  body: string;
}

/**
 * Split a markdown file into its leading `--- … ---` frontmatter and body.
 * Frontmatter is a few `key: value` lines. Dependency-free on purpose — the
 * only field we read is a simple scalar.
 */
const parseAgentFile = (raw: string): ParsedAgentFile => {
  const normalized = raw.replace(/^﻿/u, "");
  const match = /^---\r?\n(?<front>[\s\S]*?)\r?\n---\r?\n?(?<rest>[\s\S]*)$/u.exec(normalized);
  if (!match?.groups) {
    return { body: normalized.trim(), meta: {} };
  }
  const { front = "", rest = "" } = match.groups;

  const meta: FrontMatter = {};
  for (const line of front.split(/\r?\n/u)) {
    const kv = /^(?<key>[A-Za-z][\w-]*)\s*:\s*(?<value>.*)$/u.exec(line.trim());
    const value = kv?.groups?.value?.trim();
    if (kv?.groups?.key === "emoji" && value) {
      meta.emoji = value;
    }
  }
  return { body: rest.trim(), meta };
};

/**
 * Compose each subagent's system prompt as `charter + role body`, built once
 * at startup from the agent definitions.
 */
export const loadRoles = () => {
  const charter = readAgentFile("charter.md").trim();
  const build = (name: RoleName): Role => {
    const { meta, body } = parseAgentFile(readAgentFile(`${name}/AGENT.md`));
    return {
      emoji: meta.emoji ?? "🤖",
      name,
      system: `${charter}\n\n${body}`,
    };
  };
  return {
    artist: build("artist"),
    designer: build("designer"),
    director: build("director"),
    engineer: build("engineer"),
    qa: build("qa"),
    shipper: build("shipper"),
  } satisfies Record<RoleName, Role>;
};

/** The subagent roster, loaded from the filesystem-first definitions. */
export const ROLES: Record<RoleName, Role> = loadRoles();
