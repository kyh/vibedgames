import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";

export const rmCommand = defineCommand({
  meta: {
    name: "rm",
    description: "Remove a game",
  },
  args: {
    id: {
      type: "positional",
      description: "Game build ID to remove",
      required: true,
    },
    force: {
      type: "boolean",
      description: "Skip confirmation",
      default: false,
    },
  },
  run: async ({ args }) => {
    if (!args.force) {
      const confirmed = await consola.prompt(`Remove game ${args.id}?`, {
        type: "confirm",
      });
      if (!confirmed) {
        consola.info("Cancelled");
        return;
      }
    }

    const client = createClient();
    await client.localGame.deleteBuild.mutate({ buildId: args.id });
    consola.success(`Removed ${args.id}`);
  },
});
