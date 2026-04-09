import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";

export const listCommand = defineCommand({
  meta: {
    name: "list",
    description: "List your games",
  },
  run: async () => {
    const client = createClient();
    const { builds } = await client.localGame.listBuilds.query({ limit: 50 });

    if (builds.length === 0) {
      consola.info("No games found");
      return;
    }

    for (const build of builds) {
      const fileCount = build.gameBuildFiles.length;
      const updated = new Date(build.updatedAt).toLocaleDateString();
      const title = build.title ?? "(untitled)";
      consola.log(`  ${build.id.slice(0, 8)}  ${title}  ${fileCount} files  ${updated}`);
    }
  },
});
