/**
 * Validate cross-references inside plugin skills.
 *
 * Catches the class of bug where a SKILL.md points at a path that does not
 * exist — a stale `.claude/skills/<name>/...` script path, a moved
 * `references/*.md`, or a renamed sibling skill. Pure stdlib, no deps.
 *
 * Run: pnpm check:skills   (exits non-zero on the first broken reference)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGINS = join(ROOT, "plugins");

// Real skill names, e.g. "aseprite", "model-catalog".
const skills = new Set<string>();
for (const plugin of readdirSync(PLUGINS)) {
  const skillsRoot = join(PLUGINS, plugin, "skills");
  if (!existsSync(skillsRoot)) continue;
  for (const skill of readdirSync(skillsRoot)) skills.add(skill);
}

type Issue = { file: string; ref: string; why: string };
const issues: Issue[] = [];

// Every markdown file under any skill (SKILL.md + references/*.md, recursive).
const mdFiles: string[] = [];
const walk = (d: string) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".md")) mdFiles.push(p);
  }
};
for (const plugin of readdirSync(PLUGINS)) {
  const skillsRoot = join(PLUGINS, plugin, "skills");
  if (!existsSync(skillsRoot)) continue;
  walk(skillsRoot);
}

const fileExists = (p: string) => existsSync(p) && statSync(p).isFile();

for (const file of mdFiles) {
  const dir = dirname(file);
  const text = readFileSync(file, "utf8");

  // 1. Markdown links to local files: ](./x.md), ](references/y.md), ](../z/SKILL.md)
  for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
    const raw = m[1].split("#")[0].trim();
    if (!raw || /^(https?:|mailto:)/.test(raw)) continue;
    if (!/\.(md|py|ts|js|json|png|sh)$/.test(raw)) continue; // only file-ish links
    const target = raw.startsWith(".claude/skills/")
      ? join(ROOT, raw)
      : resolve(dir, raw);
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
    if (m[2] && !existsSync(join(ROOT, m[0]))) {
      issues.push({ file, ref: m[0], why: "path under skill missing" });
    }
  }
}

if (issues.length === 0) {
  console.log(`✓ skill references OK (${mdFiles.length} markdown files checked)`);
  process.exit(0);
}

console.error(`✗ ${issues.length} broken skill reference(s):\n`);
for (const i of issues) {
  console.error(`  ${i.file.replace(ROOT + "/", "")}`);
  console.error(`    ${i.ref}  — ${i.why}`);
}
process.exit(1);
