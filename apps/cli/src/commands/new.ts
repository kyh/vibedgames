import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "citty";
import { consola } from "consola";
import tiged from "tiged";
import { SLUG_RE } from "../lib/config-file.js";
import { assertKnownFlags } from "../lib/strict-args.js";
import { isJsonObject, isJsonString } from "../lib/types.js";
import type { JsonObject, JsonValue } from "../lib/types.js";

type EnginePreset =
  | {
      repo: string;
      label: string;
      skill: string;
      postNotes?: string[];
    }
  | {
      inline: true;
      label: string;
      skill: string;
    };

const ENGINES = new Map<string, EnginePreset>([
  // phaserjs/template-vite-ts is the official Phaser 4 + Vite + TypeScript
  // starter (despite the description still saying "Phaser 3" — package.json
  // pins phaser@^4). Pulled fresh on each `vg new`.
  [
    "phaser",
    {
      label: "Phaser 4 + Vite + TypeScript (official)",
      postNotes: [
        "The phaser template ships a `log.js` telemetry shim and uses `vite/config.*.mjs` for build configs — both are upstream, not vibedgames.",
      ],
      repo: "phaserjs/template-vite-ts",
      skill: "phaser",
    },
  ],
  // No officially-blessed Three.js starter exists. Using the most-starred
  // community Vite+TS starter that's been kept current.
  [
    "threejs",
    {
      label: "Three.js + Vite + TypeScript (community)",
      postNotes: [
        "The demo scene (src/scene.ts) wires lil-gui, stats.js and Drag/OrbitControls as a showcase — replace it with your game and drop the debug deps for production.",
      ],
      repo: "pachoclo/vite-threejs-ts-template",
      skill: "threejs",
    },
  ],
  // React Three Fiber. Same author as the threejs preset — Vite + TS +
  // React 18 + R3F 8 + drei, with leva and r3f-perf wired up for debug.
  // The pmndrs org doesn't ship an official R3F starter (its templates
  // are all Next.js-based), and the highest-starred R3F template on
  // GitHub is still on CRA + React 17, so this is the cleanest current
  // option for an agent.
  [
    "react-r3f",
    {
      label: "React + React Three Fiber + Vite + TypeScript (community)",
      repo: "pachoclo/vite-r3f-ts-template",
      skill: "threejs",
    },
  ],
  // Engine-agnostic fallback for "I'll wire it up myself" / non-canvas
  // games. Stays inline so we don't get blocked on a network fetch when
  // the user explicitly asked for a minimal start.
  [
    "none",
    {
      inline: true,
      label: "minimal Vite + TypeScript canvas",
      skill: "deploy",
    },
  ],
]);

const NONE_FILES: readonly { path: string; content: (slug: string) => string }[] = [
  {
    content: (slug) =>
      `${JSON.stringify(
        {
          devDependencies: { typescript: "^5.6.0", vite: "^7.0.0" },
          name: slug,
          private: true,
          scripts: {
            build: "vite build",
            dev: "vite",
            preview: "vite preview",
          },
          type: "module",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
    path: "package.json",
  },
  {
    content: () =>
      `${JSON.stringify(
        {
          compilerOptions: {
            esModuleInterop: true,
            isolatedModules: true,
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            module: "Preserve",
            moduleResolution: "Bundler",
            noEmit: true,
            noUncheckedIndexedAccess: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
            types: ["vite/client"],
          },
          include: ["src", "vite.config.ts"],
        },
        null,
        2,
      )}\n`,
    path: "tsconfig.json",
  },
  {
    content: () =>
      `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  base: "./",\n  server: { port: 5173 },\n});\n`,
    path: "vite.config.ts",
  },
  {
    content: (slug) =>
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>${slug}</title>\n    <style>html,body{margin:0;background:#0f1020;color:#fff;font-family:system-ui,sans-serif;}#game{display:flex;align-items:center;justify-content:center;height:100vh;}</style>\n  </head>\n  <body>\n    <div id="game"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
    path: "index.html",
  },
  {
    content: (slug) =>
      `const canvas = document.createElement("canvas");\ncanvas.width = 800;\ncanvas.height = 600;\ndocument.getElementById("game")!.appendChild(canvas);\nconst ctx = canvas.getContext("2d")!;\n\nctx.fillStyle = "#fff";\nctx.textAlign = "center";\nctx.font = "28px system-ui";\nctx.fillText("${slug}", canvas.width / 2, canvas.height / 2 - 8);\nctx.font = "14px system-ui";\nctx.fillStyle = "#aaa";\nctx.fillText("Edit src/main.ts to start building.", canvas.width / 2, canvas.height / 2 + 22);\n`,
    path: "src/main.ts",
  },
  { content: () => `node_modules\ndist\n.DS_Store\n`, path: ".gitignore" },
];

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
      "Override the engine preset and fetch from an arbitrary degit spec (e.g. owner/repo, owner/repo#branch). Skips the engine preset entirely.",
    type: "string",
  },
} as const;

const fetchTemplate = async (repo: string, target: string, force: boolean): Promise<void> => {
  const emitter = tiged(repo, { force, mode: "tar", verbose: false });
  await emitter.clone(target);
};
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
const writeInlineTemplate = (target: string, slug: string, force: boolean): void => {
  for (const file of NONE_FILES) {
    const dest = path.resolve(target, file.path);
    if (existsSync(dest) && !force) {
      continue;
    }
    mkdirSync(dest.slice(0, dest.lastIndexOf("/")), { recursive: true });
    writeFileSync(dest, file.content(slug));
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
      "Scaffold a new browser game. Pulls an engine template (phaser, threejs, react-r3f) or generates a minimal canvas starter.",
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

    const preset: EnginePreset | undefined = args.template
      ? {
          label: `custom: ${args.template}`,
          repo: args.template,
          skill: "deploy",
        }
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

    if ("inline" in preset) {
      writeInlineTemplate(target, slug, args.force);
    } else {
      try {
        await fetchTemplate(preset.repo, target, args.force);
      } catch (error) {
        consola.error(
          `Failed to fetch template ${preset.repo}: ${error instanceof Error ? error.message : String(error)}\n  ` +
            `Check your network connection, or pass --engine none to scaffold a minimal starter offline.`,
        );
        process.exit(1);
      }
    }

    // Post-process: strip template-repo artifacts, then name + vibedgames.json
    // + README link to skills.
    if (!("inline" in preset)) {
      cleanTemplateArtifacts(target);
      ensureViteConfig(target);
      ensureTypecheckScript(target);
    }
    rewritePackageName(target, slug);
    writeVibedgamesJson(target, slug);
    writeReadme(target, slug, preset);

    consola.success(`Scaffolded ${slug} in ${target}`);
    if ("postNotes" in preset && preset.postNotes) {
      for (const n of preset.postNotes) {
        consola.info(n);
      }
    }
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
