import { defineCommand } from "citty";
import { consola } from "consola";

import { authErrorCode, createClient } from "../lib/api.js";
import { getToken } from "../lib/config.js";
import { outputArgs, writeStructured } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";

const requireLogin = (): void => {
  if (!getToken()) {
    consola.warn("Not logged in. Run `vg login` to authenticate.");
    process.exit(1);
  }
};

const fail = (doing: string, code: string | null, message: string): never => {
  if (code === "UNAUTHORIZED") {
    consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
  } else {
    consola.error(`${doing}: ${message}`);
  }
  process.exit(1);
};

const listGames = async () => {
  try {
    const { games } = await createClient().deploy.list();
    return games;
  } catch (error) {
    return fail(
      "Could not list your games",
      authErrorCode(error),
      error instanceof Error ? error.message : String(error),
    );
  }
};

const formatBytes = (n: number): string => {
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
};

const listArgs = { ...outputArgs } as const;

const listCommand = defineCommand({
  args: listArgs,
  meta: {
    description: "List your games and their live deployments (the default).",
    name: "list",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, listArgs);
    requireLogin();
    const games = await listGames();
    const rows = games.map((g) => ({
      bytes: g.deployment?.totalBytes ?? null,
      deployed_at: g.deployment?.createdAt.toISOString() ?? null,
      files: g.deployment?.fileCount ?? null,
      id: g.id,
      name: g.name,
      slug: g.slug,
      status: g.deployment?.status ?? null,
    }));
    if (writeStructured({ games: rows }, args)) {
      return;
    }
    if (rows.length === 0) {
      consola.log("No games yet. Ship one with `vg deploy`.");
      return;
    }
    for (const row of rows) {
      const live =
        row.files === null || row.bytes === null
          ? "not deployed"
          : `${row.files} files, ${formatBytes(row.bytes)}, ${row.deployed_at ?? ""}`;
      consola.log(`${row.slug}  ${live}`);
    }
  },
});

const deleteArgs = {
  slug: {
    description: "Slug of the game to delete.",
    required: true,
    type: "positional",
  },
  yes: {
    description: "Delete without asking. Required when there is no TTY (e.g. a coding agent).",
    type: "boolean",
  },
  ...outputArgs,
} as const;

const deleteCommand = defineCommand({
  args: deleteArgs,
  meta: {
    description: "Permanently delete one of your games and all of its deployed files.",
    name: "delete",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, deleteArgs);
    requireLogin();
    const games = await listGames();
    const game = games.find((g) => g.slug === args.slug);
    if (!game) {
      consola.error(`You have no game "${args.slug}". List yours with \`vg deployments\`.`);
      process.exit(1);
    }
    if (!args.yes) {
      if (!process.stdin.isTTY) {
        consola.error(`Deleting is permanent: pass --yes to delete ${args.slug}.`);
        process.exit(2);
      }
      const confirmed = await consola.prompt(
        `Permanently delete ${args.slug} and all of its files?`,
        { type: "confirm" },
      );
      if (confirmed !== true) {
        consola.info("Nothing deleted.");
        return;
      }
    }
    try {
      await createClient().deploy.delete({ gameId: game.id });
    } catch (error) {
      fail(
        `Could not delete ${args.slug}`,
        authErrorCode(error),
        error instanceof Error ? error.message : String(error),
      );
    }
    if (writeStructured({ deleted: true, slug: args.slug }, args)) {
      return;
    }
    consola.success(`Deleted ${args.slug}.`);
  },
});

export const deploymentsCommand = defineCommand({
  // Declared so citty skips `--field <value>` when looking for a subcommand.
  args: outputArgs,
  default: "list",
  meta: {
    description: "List your games, or delete one.",
    name: "deployments",
  },
  subCommands: {
    delete: deleteCommand,
    list: listCommand,
  },
});
