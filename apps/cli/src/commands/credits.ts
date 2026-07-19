import { defineCommand } from "citty";
import consola from "consola";

import { createClient } from "../lib/api.js";
import { getToken } from "../lib/config.js";

const MICRO_PER_USD = 1_000_000;
const SUB_CENT_MICRO = MICRO_PER_USD / 100;
const MAX_ENTRIES_SHOWN = 15;

function isJsonOutput(args: { json?: boolean }): boolean {
  return Boolean(args.json) || process.env.VG_JSON_OUTPUT === "1";
}

function writeJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

// Dollars from integer micro-USD. Two decimals normally; four when the
// magnitude is sub-cent so small generation charges don't render as $0.00.
function formatUsd(micro: number): string {
  const abs = Math.abs(micro);
  const decimals = abs > 0 && abs < SUB_CENT_MICRO ? 4 : 2;
  const base = `$${(abs / MICRO_PER_USD).toFixed(decimals)}`;
  return micro < 0 ? `-${base}` : base;
}

function formatSignedUsd(micro: number): string {
  return micro < 0 ? formatUsd(micro) : `+${formatUsd(micro)}`;
}

function kindLabel(kind: string, deltaMicro: number): string {
  switch (kind) {
    case "signup_grant":
      return "Welcome credits";
    case "admin_grant":
      return deltaMicro < 0 ? "Adjustment" : "Credit grant";
    case "generation_hold":
      return "Generation";
    case "generation_settle":
      return "Usage adjustment";
    case "generation_release":
      return "Refund — failed generation";
    default:
      return kind;
  }
}

// Relative for the last week, short date beyond that.
function formatWhen(date: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  if (date.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return date.toLocaleDateString("en-US", opts);
}

function authErrorCode(err: unknown): string | null {
  if (typeof err === "object" && err !== null && "data" in err) {
    const data = err.data;
    if (
      typeof data === "object" &&
      data !== null &&
      "code" in data &&
      typeof data.code === "string"
    ) {
      return data.code;
    }
  }
  return null;
}

export const creditsCommand = defineCommand({
  meta: {
    name: "credits",
    description: "Show your credit balance and recent usage.",
  },
  args: {
    json: { type: "boolean", description: "Print structured JSON to stdout." },
  },
  run: async ({ args }) => {
    const token = getToken();

    if (!token) {
      consola.warn("Not logged in. Run `vg login` to authenticate.");
      process.exit(1);
    }

    const client = createClient();

    try {
      const { balanceMicro, entries } = await client.credits.me.query();

      if (isJsonOutput(args)) {
        writeJson({
          balance_micro: balanceMicro,
          balance_usd: balanceMicro / MICRO_PER_USD,
          entries: entries.map((e) => ({
            id: e.id,
            delta_micro: e.deltaMicro,
            kind: e.kind,
            request_id: e.requestId,
            endpoint_id: e.endpointId,
            note: e.note,
            created_at: e.createdAt.toISOString(),
          })),
        });
        return;
      }

      consola.log(`Balance: ${formatUsd(balanceMicro)}`);

      if (entries.length === 0) {
        consola.log("No activity yet.");
        return;
      }

      const now = new Date();
      const rows = entries.slice(0, MAX_ENTRIES_SHOWN).map((e) => ({
        amount: formatSignedUsd(e.deltaMicro),
        label: kindLabel(e.kind, e.deltaMicro),
        endpoint: e.endpointId ?? "",
        when: formatWhen(e.createdAt, now),
      }));
      const amountWidth = Math.max(...rows.map((r) => r.amount.length));
      const labelWidth = Math.max(...rows.map((r) => r.label.length));
      const endpointWidth = Math.max(...rows.map((r) => r.endpoint.length));

      consola.log("");
      for (const r of rows) {
        const line = [
          `  ${r.amount.padStart(amountWidth)}`,
          r.label.padEnd(labelWidth),
          r.endpoint.padEnd(endpointWidth),
          r.when,
        ].join("  ");
        consola.log(line.trimEnd());
      }
    } catch (err) {
      // Only an auth error means "log in"; surface network/server failures as
      // themselves so they aren't mistaken for a bad credential.
      const code = authErrorCode(err);
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
        consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
      } else {
        consola.error(
          `Failed to fetch credits: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      process.exit(1);
    }
  },
});
