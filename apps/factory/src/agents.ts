import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Filesystem-first agent definitions. Each subagent is a directory under
 * `apps/factory/agents/<role>/` holding an `AGENT.md` — a file's name and place
 * in the tree IS its definition. `charter.md` is the shared system prompt
 * prepended to every subagent. Editing the markdown (prompt, emoji, tool scope)
 * re-defines a subagent with no code change.
 */

export type RoleName = "director" | "designer" | "engineer" | "artist" | "qa" | "shipper";

export type Role = {
  name: RoleName;
  emoji: string;
  /** Appended to Claude Code's system prompt for every invocation in this role. */
  system: string;
  /** Tool scope for the subagent (empty = the full toolbelt). */
  allowedTools: string[];
  disallowedTools: string[];
};

const ROLE_NAMES: readonly RoleName[] = [
  "director",
  "designer",
  "engineer",
  "artist",
  "qa",
  "shipper",
];

/** Absolute path to `apps/factory/agents/` (this file lives at src/agents.ts). */
function agentsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../agents");
}

type FrontMatter = { emoji?: string; allowedTools?: string[]; disallowedTools?: string[] };

/**
 * Split a markdown file into its leading `--- … ---` frontmatter and body.
 * Frontmatter is a few `key: value` lines; list values are comma-separated.
 * Dependency-free on purpose — the fields we read are simple scalars/lists.
 */
function parseAgentFile(raw: string): { meta: FrontMatter; body: string } {
  const normalized = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };

  const meta: FrontMatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === "emoji") {
      if (value) meta.emoji = value;
    } else if (key === "allowedTools" || key === "disallowedTools") {
      meta[key] = value
        ? value
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean)
        : [];
    }
  }
  return { meta, body: match[2]!.trim() };
}

/**
 * Load every subagent definition from disk and compose each system prompt as
 * `charter + role body`. Read once at startup; the tree is the source of truth.
 */
export function loadRoles(): Record<RoleName, Role> {
  const dir = agentsDir();
  const charter = readFileSync(resolve(dir, "charter.md"), "utf8").trim();

  const present = new Set(readdirSync(dir, { withFileTypes: true }).map((d) => d.name));
  const roles = {} as Record<RoleName, Role>;
  for (const name of ROLE_NAMES) {
    if (!present.has(name)) {
      throw new Error(`Missing agent definition: apps/factory/agents/${name}/AGENT.md`);
    }
    const { meta, body } = parseAgentFile(readFileSync(resolve(dir, name, "AGENT.md"), "utf8"));
    roles[name] = {
      name,
      emoji: meta.emoji ?? "🤖",
      system: `${charter}\n\n${body}`,
      allowedTools: meta.allowedTools ?? [],
      disallowedTools: meta.disallowedTools ?? [],
    };
  }
  return roles;
}

/** The subagent roster, loaded from the filesystem-first definitions. */
export const ROLES: Record<RoleName, Role> = loadRoles();
