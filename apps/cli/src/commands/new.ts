import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";
import { SLUG_RE } from "../lib/config-file.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { fetchTemplate, parseTemplateSpec } from "../lib/template-source.js";
import type { TemplateSpec } from "../lib/template-source.js";
import { copyTemplate } from "../lib/templates.js";
import { isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonObject, JsonValue } from "../lib/types.js";

type EnginePreset =
  | {
      // A template shipped inside this package (apps/cli/templates/<template>).
      kind: "bundled";
      template: string;
      label: string;
      skill: string;
    }
  | {
      // `--template owner/repo`: fetched from GitHub, maintained by whoever owns it.
      kind: "remote";
      template: TemplateSpec;
      label: string;
      skill: string;
    };

// Every engine preset ships with the CLI, so `vg new` works offline and scaffolds
// the same files every time.
const ENGINES = new Map<string, EnginePreset>([
  [
    "phaser",
    { kind: "bundled", label: "Phaser 4 + Vite + TypeScript", skill: "phaser", template: "phaser" },
  ],
  [
    "threejs",
    {
      kind: "bundled",
      label: "Three.js + Vite + TypeScript",
      skill: "threejs",
      template: "threejs",
    },
  ],
  [
    "react-r3f",
    {
      kind: "bundled",
      label: "React Three Fiber + drei + Vite + TypeScript",
      skill: "threejs",
      template: "react-r3f",
    },
  ],
  [
    "none",
    {
      kind: "bundled",
      label: "minimal Vite + TypeScript canvas",
      skill: "deploy",
      template: "none",
    },
  ],
]);

// Derived so `--help` and the error message can't drift from the presets again.
const ENGINE_IDS = [...ENGINES.keys()];

const newArgs = {
  engine: {
    default: "phaser",
    description: `Engine preset: ${ENGINE_IDS.join(", ")} (default: phaser).`,
    type: "string",
  },
  force: {
    default: false,
    description: "Overwrite an existing target directory.",
    type: "boolean",
  },
  here: {
    default: false,
    description: "Write into the current directory instead of creating <slug>/.",
    type: "boolean",
  },
  slug: {
    description: "Lowercase, hyphenated slug — used as the directory name and deploy subdomain.",
    required: true,
    type: "positional",
  },
  template: {
    description:
      "Fetch a third-party template from GitHub instead of a bundled preset: owner/repo, owner/repo/sub/dir, either with #branch, #tag or #commit. Needs network; not maintained by vibedgames.",
    type: "string",
  },
} as const;

/** Remove template-repo artifacts that never apply to a scaffolded game:
 *  the template's own lockfile (wrong for whatever package manager the user
 *  runs) and its CI workflows (reference the template repo, fail elsewhere). */
const cleanTemplateArtifacts = (target: string): void => {
  for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"]) {
    const p = path.resolve(target, f);
    if (existsSync(p)) {
      rmSync(p);
    }
  }
  const gh = path.resolve(target, ".github");
  if (existsSync(gh)) {
    rmSync(gh, { recursive: true });
  }
};
/** Some templates (threejs) ship no vite config at all, which means no
 *  relative `base` — write a minimal one so built asset URLs are relative
 *  and the bundle works wherever it's hosted. Never touches templates that
 *  bring their own config (phaser uses a vite/ config dir wired into its
 *  npm scripts). */
const ensureViteConfig = (target: string): void => {
  const hasConfig =
    ["vite.config.ts", "vite.config.js", "vite.config.mjs"].some((f) =>
      existsSync(path.resolve(target, f)),
    ) || existsSync(path.resolve(target, "vite"));
  if (hasConfig) {
    return;
  }
  writeFileSync(
    path.resolve(target, "vite.config.ts"),
    `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  base: "./",\n});\n`,
  );
};
/** Agents lean on \`npm run typecheck\` to verify changes without a full
 *  build — add it when the template doesn't define one. */
const ensureTypecheckScript = (target: string): void => {
  const pkgPath = path.resolve(target, "package.json");
  if (!existsSync(pkgPath)) {
    return;
  }
  try {
    const pkg: JsonValue = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!isJsonObject(pkg)) {
      return;
    }
    const scripts: JsonObject = isJsonObject(pkg.scripts) ? pkg.scripts : {};
    if (isJsonString(scripts.typecheck)) {
      return;
    }
    scripts.typecheck = "tsc --noEmit";
    pkg.scripts = scripts;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch {
    // malformed package.json — rewritePackageName will warn about it
  }
};
const rewritePackageName = (target: string, slug: string): void => {
  const pkgPath = path.resolve(target, "package.json");
  if (!existsSync(pkgPath)) {
    return;
  }
  try {
    const raw = readFileSync(pkgPath, "utf-8");
    const pkg: JsonValue = JSON.parse(raw);
    if (!isJsonObject(pkg)) {
      throw new Error("package.json is not a JSON object");
    }
    pkg.name = slug;
    delete pkg.repository;
    delete pkg.bugs;
    delete pkg.homepage;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (error) {
    consola.warn(
      `Could not rewrite package.json name to ${slug}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const writeVibedgamesJson = (target: string, slug: string): void => {
  writeFileSync(
    path.resolve(target, "vibedgames.json"),
    `${JSON.stringify({ name: slug.replaceAll("-", " "), slug }, null, 2)}\n`,
  );
};
const writeReadme = (target: string, slug: string, preset: EnginePreset): void => {
  const readmePath = path.resolve(target, "README.md");
  // Keep the template's README if present (it usually has engine docs).
  // Append a vibedgames-specific footer so devs see the deploy flow.
  const footer =
    `\n\n---\n\n## Vibedgames\n\n` +
    `This project was scaffolded with \`vg new ${slug}\` (${preset.label}).\n\n` +
    `\`\`\`sh\nnpm install\nnpm run dev      # local preview\nnpm run build\nvg deploy ./dist # ships to ${slug}.vibedgames.com\n\`\`\`\n\n` +
    `For engine-specific work, the \`${preset.skill}\` skill loads automatically in Claude Code.\n`;
  if (existsSync(readmePath)) {
    const existing = readFileSync(readmePath, "utf-8");
    if (existing.includes("## Vibedgames")) {
      return;
    }
    writeFileSync(readmePath, existing.replace(/\s*$/u, "") + footer);
    return;
  }
  writeFileSync(readmePath, `# ${slug}${footer}`);
};
export const newCommand = defineCommand({
  args: newArgs,
  meta: {
    description:
      "Scaffold a new browser game from a template bundled with the CLI (phaser, threejs, react-r3f, none). Works offline.",
    name: "new",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, newArgs);

    const slug = args.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      consola.error(
        `Invalid slug: ${args.slug}\n  Use lowercase letters, digits, and hyphens (e.g. "asteroid-belt").`,
      );
      process.exit(1);
    }

    let template: TemplateSpec | undefined;
    try {
      template = args.template ? parseTemplateSpec(args.template) : undefined;
    } catch (error) {
      consola.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    const preset: EnginePreset | undefined = template
      ? { kind: "remote", label: `custom: ${args.template}`, skill: "deploy", template }
      : ENGINES.get(args.engine);
    if (!preset) {
      consola.error(`Unknown engine: ${args.engine}. Use one of: ${ENGINE_IDS.join(", ")}.`);
      process.exit(1);
    }

    const target = args.here ? process.cwd() : path.resolve(process.cwd(), slug);
    if (!args.here) {
      if (existsSync(target) && !args.force) {
        consola.error(
          `Directory ${target} already exists. Pass --force to overwrite, or pick a different slug.`,
        );
        process.exit(1);
      }
      mkdirSync(target, { recursive: true });
    }

    consola.start(`Scaffolding ${slug} with ${preset.label}`);

    if (preset.kind === "bundled") {
      for (const file of copyTemplate(preset.template, target, slug, args.force)) {
        consola.warn(`Kept the existing ${file} (pass --force to overwrite it).`);
      }
    } else {
      try {
        await fetchTemplate(preset.template, target, args.force);
      } catch (error) {
        consola.error(
          `Failed to fetch template ${args.template}: ${error instanceof Error ? error.message : String(error)}\n  ` +
            `Check your network connection, or drop --template to use a bundled engine preset.`,
        );
        process.exit(1);
      }
      // A third-party repo arrives as its author left it: strip what never
      // applies to a scaffolded game and fill in what deploy relies on.
      cleanTemplateArtifacts(target);
      ensureViteConfig(target);
      ensureTypecheckScript(target);
    }

    rewritePackageName(target, slug);
    writeVibedgamesJson(target, slug);
    writeReadme(target, slug, preset);

    consola.success(`Scaffolded ${slug} in ${target}`);
    consola.log("");
    consola.info("Next steps:");
    consola.log(`  cd ${args.here ? "." : slug}`);
    consola.log("  npm install");
    consola.log("  npm run dev");
    consola.log("  # then: npm run build && vg deploy ./dist");
    consola.log("");
    consola.log(
      `Skill to load for engine work: ${preset.skill}  (Claude Code: triggered automatically by package.json deps)`,
    );
  },
});
