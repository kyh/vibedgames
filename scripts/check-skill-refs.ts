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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SkillRefIssue = { file: string; ref: string; why: string };

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function checkSkillRefs(root: string = DEFAULT_ROOT): {
  issues: SkillRefIssue[];
  fileCount: number;
} {
  const plugins = join(root, "plugins");

  // Real skill names, e.g. "aseprite", "model-catalog".
  const skills = new Set<string>();
  for (const plugin of readdirSync(plugins)) {
    const skillsRoot = join(plugins, plugin, "skills");
    if (!existsSync(skillsRoot)) continue;
    for (const skill of readdirSync(skillsRoot)) skills.add(skill);
  }

  // Every markdown file under any skill (SKILL.md + references/*.md, recursive).
  const mdFiles: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) mdFiles.push(p);
    }
  };
  for (const plugin of readdirSync(plugins)) {
    const skillsRoot = join(plugins, plugin, "skills");
    if (!existsSync(skillsRoot)) continue;
    walk(skillsRoot);
  }

  const fileExists = (p: string) => existsSync(p) && statSync(p).isFile();
  const issues: SkillRefIssue[] = [];

  for (const file of mdFiles) {
    const dir = dirname(file);
    const text = readFileSync(file, "utf8");

    // 1. Markdown links to local files: ](./x.md), ](references/y.md), ](../z/SKILL.md)
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const raw = m[1].split("#")[0].trim();
      if (!raw || /^(https?:|mailto:)/.test(raw)) continue;
      if (!/\.(md|py|ts|js|json|png|sh)$/.test(raw)) continue; // only file-ish links
      const target = raw.startsWith(".claude/skills/") ? join(root, raw) : resolve(dir, raw);
      if (!fileExists(target)) {
        issues.push({ file, ref: raw, why: "link target missing" });
      }
    }

    // 2. Bare .claude/skills/<name>/... paths in prose or code blocks.
    for (const m of text.matchAll(/\.claude\/skills\/([a-z0-9-]+)(\/[^\s`"')]+)?/g)) {
      const name = m[1];
      if (!skills.has(name)) {
        issues.push({ file, ref: m[0], why: `no such skill "${name}"` });
        continue;
      }
      if (m[2] && !existsSync(join(root, m[0]))) {
        issues.push({ file, ref: m[0], why: "path under skill missing" });
      }
    }
  }

  return { issues, fileCount: mdFiles.length };
}

/** Pretty-print issues relative to `root`. Returns true when clean. */
export function reportSkillRefs(
  result: { issues: SkillRefIssue[]; fileCount: number },
  root: string = DEFAULT_ROOT,
): boolean {
  if (result.issues.length === 0) {
    console.log(`✓ skill references OK (${result.fileCount} markdown files checked)`);
    return true;
  }
  console.error(`✗ ${result.issues.length} broken skill reference(s):\n`);
  for (const i of result.issues) {
    console.error(`  ${i.file.replace(root + "/", "")}`);
    console.error(`    ${i.ref}  — ${i.why}`);
  }
  return false;
}
