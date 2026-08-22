import artistMd from "../agents/artist/AGENT.md" with { type: "text" };
import charterMd from "../agents/charter.md" with { type: "text" };
import designerMd from "../agents/designer/AGENT.md" with { type: "text" };
import directorMd from "../agents/director/AGENT.md" with { type: "text" };
import engineerMd from "../agents/engineer/AGENT.md" with { type: "text" };
import qaMd from "../agents/qa/AGENT.md" with { type: "text" };
import shipperMd from "../agents/shipper/AGENT.md" with { type: "text" };

/**
 * Filesystem-first agent definitions. Each subagent is a directory under
 * `apps/factory/agents/<role>/` holding an `AGENT.md` — a file's name and place
 * in the tree IS its definition. `charter.md` is the shared system prompt
 * prepended to every subagent. Editing the markdown (prompt or emoji)
 * re-defines a subagent with no code change (restart to pick it up). The files
 * are bundled as Bun text imports so compiled binaries carry them too.
 */

export type RoleName = "director" | "designer" | "engineer" | "artist" | "qa" | "shipper";

export type Role = {
  name: RoleName;
  emoji: string;
  /** Appended to Claude Code's system prompt for every invocation in this role. */
  system: string;
};

const ROLE_SOURCES = {
  director: directorMd,
  designer: designerMd,
  engineer: engineerMd,
  artist: artistMd,
  qa: qaMd,
  shipper: shipperMd,
} satisfies Record<RoleName, string>;

type FrontMatter = { emoji?: string };

type ParsedAgentFile = { meta: FrontMatter; body: string };

/**
 * Split a markdown file into its leading `--- … ---` frontmatter and body.
 * Frontmatter is a few `key: value` lines. Dependency-free on purpose — the
 * only field we read is a simple scalar.
 */
function parseAgentFile(raw: string): ParsedAgentFile {
  const normalized = raw.replace(/^﻿/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(normalized);
  if (!match) return { meta: {}, body: normalized.trim() };

  const meta: FrontMatter = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    if (kv[1] === "emoji" && kv[2]!.trim()) meta.emoji = kv[2]!.trim();
  }
  return { meta, body: match[2]!.trim() };
}

/**
 * Compose each subagent's system prompt as `charter + role body`, built once
 * at startup from the bundled definitions.
 */
export function loadRoles() {
  const charter = charterMd.trim();
  const build = (name: RoleName): Role => {
    const { meta, body } = parseAgentFile(ROLE_SOURCES[name]);
    return {
      name,
      emoji: meta.emoji ?? "🤖",
      system: `${charter}\n\n${body}`,
    };
  };
  return {
    director: build("director"),
    designer: build("designer"),
    engineer: build("engineer"),
    artist: build("artist"),
    qa: build("qa"),
    shipper: build("shipper"),
  } satisfies Record<RoleName, Role>;
}

/** The subagent roster, loaded from the filesystem-first definitions. */
export const ROLES: Record<RoleName, Role> = loadRoles();
