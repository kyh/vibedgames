/**
 * Validate cross-references inside plugin skills.
 *
 * Catches the class of bug where a SKILL.md points at a path that does not
 * exist — a stale `.claude/skills/<name>/...` script path, a moved
 * `references/*.md`, or a renamed sibling skill. Pure stdlib, no deps.
 *
 * Used by scripts/dogfood.ts, which runs this after syncing skills so a broken
 * link surfaces at the moment skills change.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface SkillRefIssue {
  file: string;
  ref: string;
  why: string;
}

export interface SkillRefReport {
  issues: SkillRefIssue[];
  fileCount: number;
}

const DEFAULT_ROOT = path.resolve(import.meta.dirname, "..");

const fileExists = (p: string) => existsSync(p) && statSync(p).isFile();

/** 1. Markdown links to local files: ](./x.md), ](references/y.md), ](../z/SKILL.md) */
const linkIssues = (root: string, file: string, text: string): SkillRefIssue[] => {
  const dir = path.dirname(file);
  const issues: SkillRefIssue[] = [];
  for (const m of text.matchAll(/\]\((?<link>[^)]+)\)/gu)) {
    const [beforeHash = ""] = (m.groups?.link ?? "").split("#");
    const raw = beforeHash.trim();
    if (!raw || /^(?:https?:|mailto:)/u.test(raw)) {
      continue;
    }
    // only file-ish links
    if (!/\.(?:md|py|ts|js|mjs|json|png|sh)$/u.test(raw)) {
      continue;
    }
    const target = raw.startsWith(".claude/skills/")
      ? path.join(root, raw)
      : path.resolve(dir, raw);
    if (!fileExists(target)) {
      issues.push({ file, ref: raw, why: "link target missing" });
    }
  }
  return issues;
};

/** 2. Bare .claude/skills/<name>/... paths in prose or code blocks. */
const skillPathIssues = (
  root: string,
  skills: Set<string>,
  file: string,
  text: string,
): SkillRefIssue[] => {
  const issues: SkillRefIssue[] = [];
  for (const m of text.matchAll(/\.claude\/skills\/(?<name>[a-z0-9-]+)(?<rest>\/[^\s`"')]+)?/gu)) {
    const name = m.groups?.name ?? "";
    if (!skills.has(name)) {
      issues.push({ file, ref: m[0], why: `no such skill "${name}"` });
      continue;
    }
    if (m.groups?.rest && !existsSync(path.join(root, m[0]))) {
      issues.push({ file, ref: m[0], why: "path under skill missing" });
    }
  }
  return issues;
};

export const checkSkillRefs = (root: string = DEFAULT_ROOT): SkillRefReport => {
  const plugins = path.join(root, "plugins");

  // Real skill names, e.g. "aseprite", "model-catalog".
  const skills = new Set<string>();
  for (const plugin of readdirSync(plugins)) {
    const skillsRoot = path.join(plugins, plugin, "skills");
    if (!existsSync(skillsRoot)) {
      continue;
    }
    for (const skill of readdirSync(skillsRoot)) {
      skills.add(skill);
    }
  }

  // Every markdown file under any skill (SKILL.md + references/*.md, recursive).
  const mdFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else if (e.name.endsWith(".md")) {
        mdFiles.push(p);
      }
    }
  };
  for (const plugin of readdirSync(plugins)) {
    const skillsRoot = path.join(plugins, plugin, "skills");
    if (!existsSync(skillsRoot)) {
      continue;
    }
    walk(skillsRoot);
  }

  const issues: SkillRefIssue[] = [];
  for (const file of mdFiles) {
    const text = readFileSync(file, "utf-8");
    issues.push(...linkIssues(root, file, text), ...skillPathIssues(root, skills, file, text));
  }

  return { fileCount: mdFiles.length, issues };
};

/** Pretty-print issues relative to `root`. Returns true when clean. */
export const reportSkillRefs = (result: SkillRefReport, root: string = DEFAULT_ROOT): boolean => {
  if (result.issues.length === 0) {
    console.log(`✓ skill references OK (${result.fileCount} markdown files checked)`);
    return true;
  }
  console.error(`✗ ${result.issues.length} broken skill reference(s):\n`);
  for (const i of result.issues) {
    console.error(`  ${i.file.replace(`${root}/`, "")}`);
    console.error(`    ${i.ref}  — ${i.why}`);
  }
  return false;
};
