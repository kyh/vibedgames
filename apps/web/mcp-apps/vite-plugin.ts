import path from "node:path";

import viteReact from "@vitejs/plugin-react";
import type { Plugin, ViteDevServer } from "vite";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const VIRTUAL_ID = "virtual:mcp-apps";
const RESOLVED_ID = `\0${VIRTUAL_ID}`;

const appsRoot = import.meta.dirname;

const buildView = async (name: string) => {
  const result = await build({
    build: { emptyOutDir: false, write: false },
    configFile: false,
    logLevel: "warn",
    plugins: [viteReact(), viteSingleFile()],
    resolve: { alias: { "@": path.resolve(appsRoot, "../src") } },
    root: path.join(appsRoot, name),
  });

  for (const output of Array.isArray(result) ? result : [result]) {
    if (!("output" in output)) {
      continue;
    }

    for (const file of output.output) {
      if (file.type === "asset" && file.fileName === "index.html") {
        return file.source instanceof Uint8Array
          ? new TextDecoder().decode(file.source)
          : file.source;
      }
    }
  }

  throw new Error(`mcp-apps: building the ${name} view produced no index.html`);
};

const buildApps = async () => ({ gallery: await buildView("gallery") });

const invalidate = (server: ViteDevServer) => {
  for (const environment of Object.values(server.environments)) {
    const module = environment.moduleGraph.getModuleById(RESOLVED_ID);

    if (module) {
      environment.moduleGraph.invalidateModule(module);
    }
  }
};

/**
 * Builds each MCP Apps view under `mcp-apps/<name>/` into one self-contained
 * HTML document and serves them to the Worker as `virtual:mcp-apps`, so every
 * instance answers `resources/read` from its own bundle.
 */
export const mcpApps = () => {
  let built: ReturnType<typeof buildApps> | undefined;

  return {
    configureServer: (server) => {
      server.watcher.add(appsRoot);
      server.watcher.on("change", (file) => {
        if (file.startsWith(appsRoot) && file !== import.meta.filename) {
          built = undefined;
          invalidate(server);
        }
      });
    },
    load: async (id) => {
      if (id !== RESOLVED_ID) {
        return null;
      }

      built ??= buildApps();

      return `export const mcpApps = ${JSON.stringify(await built)};`;
    },
    name: "vibedgames:mcp-apps",
    resolveId: (id) => (id === VIRTUAL_ID ? RESOLVED_ID : null),
  } satisfies Plugin;
};
