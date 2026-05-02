import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";

type ModelEntry = {
  id: string;
  alias?: string;
  supports: ("generate" | "edit")[];
};

type ProviderEntry = {
  provider: string;
  configured: boolean;
  models: ModelEntry[];
};

export const modelsCommand = defineCommand({
  meta: {
    name: "models",
    description: "List image providers and well-known models.",
  },
  args: {
    json: {
      type: "boolean",
      description: "Print as JSON.",
    },
  },
  run: async ({ args }) => {
    const client = createClient();
    let entries: ProviderEntry[];
    try {
      entries = (await client.image.list.query()) as ProviderEntry[];
    } catch (err) {
      consola.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }

    if (args.json) {
      process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      return;
    }

    for (const entry of entries) {
      const status = entry.configured ? "configured" : "not configured";
      consola.log(`\n${entry.provider}  (${status})`);
      for (const model of entry.models) {
        const tasks = model.supports.join("/");
        const aliasPart = model.alias ? `  alias: ${model.alias}` : "";
        consola.log(`  ${model.id}  [${tasks}]${aliasPart}`);
      }
    }
  },
});
