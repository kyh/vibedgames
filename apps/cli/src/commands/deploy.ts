import { defineCommand } from "citty";
import consola from "consola";

export const deployCommand = defineCommand({
  meta: {
    name: "deploy",
    description: "Deploy a game to vibedgames",
  },
  args: {
    dir: {
      type: "positional",
      description: "Directory to deploy",
      required: false,
      default: ".",
    },
  },
  run: () => {
    consola.info("Deploy is coming soon");
  },
});
