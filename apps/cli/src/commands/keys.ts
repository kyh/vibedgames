import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";

function isJsonOutput(args: { json?: boolean }): boolean {
  return Boolean(args.json) || process.env.VG_JSON_OUTPUT === "1";
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function formatDate(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString() : "never";
}

// ---- create -----------------------------------------------------------------

const createCommand = defineCommand({
  meta: {
    name: "create",
    description: "Create an API key for CI / programmatic access (shown once).",
  },
  args: {
    name: {
      type: "positional",
      required: true,
      description: "A label to identify the key (e.g. 'github-actions').",
    },
    "expires-in-days": {
      type: "string",
      description: "Optional expiry in days. Omit for a non-expiring key.",
    },
    json: { type: "boolean", description: "Print structured JSON to stdout." },
  },
  run: async ({ args }) => {
    const expiresRaw = args["expires-in-days"];
    let expiresInDays: number | null = null;
    if (expiresRaw != null && expiresRaw !== "") {
      expiresInDays = Number(expiresRaw);
      if (!Number.isInteger(expiresInDays) || expiresInDays < 1) {
        consola.error("--expires-in-days must be a positive integer.");
        process.exit(1);
      }
    }

    const client = createClient();
    const created = await client.apiKeys.create.mutate({ name: args.name, expiresInDays });

    if (isJsonOutput(args)) {
      writeJson({
        id: created.id,
        name: created.name,
        key: created.key,
        key_prefix: created.keyPrefix,
        created_at: created.createdAt,
        expires_at: created.expiresAt,
      });
      return;
    }

    consola.success(`Created API key "${created.name}"`);
    consola.box(created.key);
    consola.warn("This is the only time the key is shown. Store it now.");
    consola.info(
      "Use it in CI by setting it as the VG_TOKEN environment variable, e.g.:\n" +
        `  VG_TOKEN=${created.keyPrefix}… vg deploy ./dist --slug my-game`,
    );
  },
});

// ---- list --------------------------------------------------------------------

const listCommand = defineCommand({
  meta: { name: "list", description: "List your active API keys." },
  args: {
    json: { type: "boolean", description: "Print structured JSON to stdout." },
  },
  run: async ({ args }) => {
    const client = createClient();
    const { keys } = await client.apiKeys.list.query();

    if (isJsonOutput(args)) {
      writeJson({
        keys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          key_prefix: k.keyPrefix,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
          expires_at: k.expiresAt,
        })),
      });
      return;
    }

    if (keys.length === 0) {
      consola.info("No API keys. Create one with `vg keys create <name>`.");
      return;
    }

    for (const k of keys) {
      consola.log(
        `${k.keyPrefix}…  ${k.name}\n` +
          `  id: ${k.id}\n` +
          `  created: ${formatDate(k.createdAt)}  last used: ${formatDate(k.lastUsedAt)}  expires: ${formatDate(k.expiresAt)}`,
      );
    }
  },
});

// ---- revoke ------------------------------------------------------------------

const revokeCommand = defineCommand({
  meta: { name: "revoke", description: "Revoke an API key by id." },
  args: {
    id: { type: "positional", required: true, description: "The key id (see `vg keys list`)." },
    json: { type: "boolean", description: "Print structured JSON to stdout." },
  },
  run: async ({ args }) => {
    const client = createClient();
    const { id } = await client.apiKeys.revoke.mutate({ id: args.id });

    if (isJsonOutput(args)) {
      writeJson({ id, revoked: true });
      return;
    }

    consola.success(`Revoked API key ${id}`);
  },
});

export const keysCommand = defineCommand({
  meta: {
    name: "keys",
    description: "Manage API keys for CI / programmatic access",
  },
  subCommands: {
    create: createCommand,
    list: listCommand,
    revoke: revokeCommand,
  },
});
