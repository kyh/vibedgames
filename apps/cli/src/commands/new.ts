import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import tiged from "tiged";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

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

const ENGINES: Record<string, EnginePreset> = {
  // phaserjs/template-vite-ts is the official Phaser 4 + Vite + TypeScript
  // starter (despite the description still saying "Phaser 3" — package.json
  // pins phaser@^4). Pulled fresh on each `vg new`.
  phaser: {
    repo: "phaserjs/template-vite-ts",
    label: "Phaser 4 + Vite + TypeScript (official)",
    skill: "phaser",
    postNotes: [
      "The phaser template ships a `log.js` telemetry shim and uses `vite/config.*.mjs` for build configs — both are upstream, not vibedgames.",
    ],
  },
  // No officially-blessed Three.js starter exists. Using the most-starred
  // community Vite+TS starter that's been kept current.
  threejs: {
    repo: "pachoclo/vite-threejs-ts-template",
    label: "Three.js + Vite + TypeScript (community)",
    skill: "threejs",
    postNotes: [
      "The demo scene (src/scene.ts) wires lil-gui, stats.js and Drag/OrbitControls as a showcase — replace it with your game and drop the debug deps for production.",
    ],
  },
  // React Three Fiber. Same author as the threejs preset — Vite + TS +
  // React 18 + R3F 8 + drei, with leva and r3f-perf wired up for debug.
  // The pmndrs org doesn't ship an official R3F starter (its templates
  // are all Next.js-based), and the highest-starred R3F template on
  // GitHub is still on CRA + React 17, so this is the cleanest current
  // option for an agent.
  "react-r3f": {
    repo: "pachoclo/vite-r3f-ts-template",
    label: "React + React Three Fiber + Vite + TypeScript (community)",
    skill: "threejs",
  },
  // Engine-agnostic fallback for "I'll wire it up myself" / non-canvas
  // games. Stays inline so we don't get blocked on a network fetch when
  // the user explicitly asked for a minimal start.
  none: {
    inline: true,
    label: "minimal Vite + TypeScript canvas",
    skill: "deploy",
  },
};

const NONE_FILES: ReadonlyArray<{ path: string; content: (slug: string) => string }> = [
  {
    path: "package.json",
    content: (slug) =>
      `${JSON.stringify(
        {
          name: slug,
          version: "0.0.0",
          private: true,
          type: "module",
          scripts: {
            dev: "vite",
            build: "vite build",
            preview: "vite preview",
          },
          devDependencies: { typescript: "^5.6.0", vite: "^7.0.0" },
        },
        null,
        2,
      )}\n`,
  },
  {
    path: "tsconfig.json",
    content: () =>
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022", "DOM", "DOM.Iterable"],
            module: "Preserve",
            moduleResolution: "Bundler",
            strict: true,
            noUncheckedIndexedAccess: true,
            isolatedModules: true,
            esModuleInterop: true,
            skipLibCheck: true,
            noEmit: true,
            types: ["vite/client"],
          },
          include: ["src", "vite.config.ts"],
        },
        null,
        2,
      )}\n`,
  },
  {
    path: "vite.config.ts",
    content: () =>
      `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  base: "./",\n  server: { port: 5173 },\n});\n`,
  },
  {
    path: "index.html",
    content: (slug) =>
      `<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>${slug}</title>\n    <style>html,body{margin:0;background:#0f1020;color:#fff;font-family:system-ui,sans-serif;}#game{display:flex;align-items:center;justify-content:center;height:100vh;}</style>\n  </head>\n  <body>\n    <div id="game"></div>\n    <script type="module" src="/src/main.ts"></script>\n  </body>\n</html>\n`,
  },
  {
    path: "src/main.ts",
    content: (slug) =>
      `const canvas = document.createElement("canvas");\ncanvas.width = 800;\ncanvas.height = 600;\ndocument.getElementById("game")!.appendChild(canvas);\nconst ctx = canvas.getContext("2d")!;\n\nctx.fillStyle = "#fff";\nctx.textAlign = "center";\nctx.font = "28px system-ui";\nctx.fillText("${slug}", canvas.width / 2, canvas.height / 2 - 8);\nctx.font = "14px system-ui";\nctx.fillStyle = "#aaa";\nctx.fillText("Edit src/main.ts to start building.", canvas.width / 2, canvas.height / 2 + 22);\n`,
  },
  { path: ".gitignore", content: () => `node_modules\ndist\n.DS_Store\n` },
];

export const newCommand = defineCommand({
  meta: {
    name: "new",
    description:
      "Scaffold a new browser game. Pulls an official engine template (phaser, threejs) or generates a minimal canvas starter.",
  },
  args: {
    slug: {
      type: "positional",
      description: "Lowercase, hyphenated slug — used as the directory name and deploy subdomain.",
      required: true,
    },
    engine: {
      type: "string",
      description: "Engine preset: phaser (default), threejs, or none.",
      default: "phaser",
    },
    template: {
      type: "string",
      description:
        "Override the engine preset and fetch from an arbitrary degit spec (e.g. owner/repo, owner/repo#branch). Skips the engine preset entirely.",
    },
    here: {
      type: "boolean",
      description: "Write into the current directory instead of creating <slug>/.",
      default: false,
    },
    force: {
      type: "boolean",
      description: "Overwrite an existing target directory.",
      default: false,
    },
  },
  run: async ({ args }) => {
    const slug = args.slug.trim().toLowerCase();
    if (!SLUG_RE.test(slug)) {
      consola.error(
        `Invalid slug: ${args.slug}\n  Use lowercase letters, digits, and hyphens (e.g. "asteroid-belt").`,
      );
      process.exit(1);
    }

    const preset = args.template
      ? ({
          repo: args.template,
          label: `custom: ${args.template}`,
          skill: "deploy",
        } as EnginePreset)
      : ENGINES[args.engine];
    if (!preset) {
      consola.error(
        `Unknown engine: ${args.engine}. Use one of: ${Object.keys(ENGINES).join(", ")}.`,
      );
      process.exit(1);
    }

    const target = args.here ? process.cwd() : resolve(process.cwd(), slug);
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
      } catch (err) {
        consola.error(
          `Failed to fetch template ${preset.repo}: ${err instanceof Error ? err.message : String(err)}\n  ` +
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
      for (const n of preset.postNotes) consola.info(n);
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

async function fetchTemplate(repo: string, target: string, force: boolean): Promise<void> {
  const emitter = tiged(repo, { force, verbose: false, mode: "tar" });
  await emitter.clone(target);
}

/** Remove template-repo artifacts that never apply to a scaffolded game:
 *  the template's own lockfile (wrong for whatever package manager the user
 *  runs) and its CI workflows (reference the template repo, fail elsewhere). */
function cleanTemplateArtifacts(target: string): void {
  for (const f of ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock"]) {
    const p = resolve(target, f);
    if (existsSync(p)) rmSync(p);
  }
  const gh = resolve(target, ".github");
  if (existsSync(gh)) rmSync(gh, { recursive: true });
}

/** Some templates (threejs) ship no vite config at all, which means no
 *  relative `base` — write a minimal one so built asset URLs are relative
 *  and the bundle works wherever it's hosted. Never touches templates that
 *  bring their own config (phaser uses a vite/ config dir wired into its
 *  npm scripts). */
function ensureViteConfig(target: string): void {
  const hasConfig =
    ["vite.config.ts", "vite.config.js", "vite.config.mjs"].some((f) =>
      existsSync(resolve(target, f)),
    ) || existsSync(resolve(target, "vite"));
  if (hasConfig) return;
  writeFileSync(
    resolve(target, "vite.config.ts"),
    `import { defineConfig } from "vite";\n\nexport default defineConfig({\n  base: "./",\n});\n`,
  );
}

/** Agents lean on \`npm run typecheck\` to verify changes without a full
 *  build — add it when the template doesn't define one. */
function ensureTypecheckScript(target: string): void {
  const pkgPath = resolve(target, "package.json");
  if (!existsSync(pkgPath)) return;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
    const scripts =
      typeof pkg.scripts === "object" && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};
    if (typeof scripts.typecheck === "string") return;
    scripts.typecheck = "tsc --noEmit";
    pkg.scripts = scripts;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch {
    // malformed package.json — rewritePackageName will warn about it
  }
}

function writeInlineTemplate(target: string, slug: string, force: boolean): void {
  for (const file of NONE_FILES) {
    const path = resolve(target, file.path);
    if (existsSync(path) && !force) continue;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, file.content(slug));
  }
}

function rewritePackageName(target: string, slug: string): void {
  const pkgPath = resolve(target, "package.json");
  if (!existsSync(pkgPath)) return;
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    pkg.name = slug;
    delete pkg.repository;
    delete pkg.bugs;
    delete pkg.homepage;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  } catch (err) {
    consola.warn(
      `Could not rewrite package.json name to ${slug}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function writeVibedgamesJson(target: string, slug: string): void {
  writeFileSync(
    resolve(target, "vibedgames.json"),
    `${JSON.stringify({ slug, name: slug.replace(/-/g, " ") }, null, 2)}\n`,
  );
}

function writeReadme(target: string, slug: string, preset: EnginePreset): void {
  const readmePath = resolve(target, "README.md");
  // Keep the template's README if present (it usually has engine docs).
  // Append a vibedgames-specific footer so devs see the deploy flow.
  const footer =
    `\n\n---\n\n## Vibedgames\n\n` +
    `This project was scaffolded with \`vg new ${slug}\` (${preset.label}).\n\n` +
    `\`\`\`sh\nnpm install\nnpm run dev      # local preview\nnpm run build\nvg deploy ./dist # ships to ${slug}.vibedgames.com\n\`\`\`\n\n` +
    `For engine-specific work, the \`${preset.skill}\` skill loads automatically in Claude Code.\n`;
  if (existsSync(readmePath)) {
    const existing = readFileSync(readmePath, "utf8");
    if (existing.includes("## Vibedgames")) return;
    writeFileSync(readmePath, existing.replace(/\s*$/, "") + footer);
    return;
  }
  writeFileSync(readmePath, `# ${slug}${footer}`);
}
