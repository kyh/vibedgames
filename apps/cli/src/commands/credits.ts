import { defineCommand } from "citty";
import { consola } from "consola";

import { authErrorCode, createClient } from "../lib/api.js";
import { getToken } from "../lib/config.js";
import { outputArgs, writeStructured } from "../lib/output.js";
import { assertKnownFlags } from "../lib/strict-args.js";

const creditsArgs = { ...outputArgs } as const;

const MICRO_PER_USD = 1_000_000;
const SUB_CENT_MICRO = MICRO_PER_USD / 100;
const MAX_ENTRIES_SHOWN = 15;
// The server's checkout bounds (credits-limits.ts in @repo/contract).
const MIN_PURCHASE_USD = 5;
const MAX_PURCHASE_USD = 500;

// Dollars from integer micro-USD. Two decimals normally; four when the
// magnitude is sub-cent so small generation charges don't render as $0.00.
const formatUsd = (micro: number): string => {
  const abs = Math.abs(micro);
  const decimals = abs > 0 && abs < SUB_CENT_MICRO ? 4 : 2;
  const base = `$${(abs / MICRO_PER_USD).toFixed(decimals)}`;
  return micro < 0 ? `-${base}` : base;
};

const formatSignedUsd = (micro: number): string =>
  micro < 0 ? formatUsd(micro) : `+${formatUsd(micro)}`;

const kindLabel = (kind: string, deltaMicro: number): string => {
  switch (kind) {
    case "signup_grant": {
      return "Welcome credits";
    }
    case "admin_grant": {
      return deltaMicro < 0 ? "Adjustment" : "Credit grant";
    }
    case "code_redeem": {
      return "Code redeemed";
    }
    case "purchase": {
      return "Credit purchase";
    }
    case "generation_hold": {
      return "Generation";
    }
    case "generation_settle": {
      return "Usage adjustment";
    }
    case "generation_release": {
      return "Refund — failed generation";
    }
    default: {
      return kind;
    }
  }
};

// Relative for the last week, short date beyond that.
const formatWhen = (date: Date, now: Date): string => {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
  if (date.getFullYear() !== now.getFullYear()) {
    opts.year = "numeric";
  }
  return date.toLocaleDateString("en-US", opts);
};

const requireLogin = (): void => {
  if (!getToken()) {
    consola.warn("Not logged in. Run `vg login` to authenticate.");
    process.exit(1);
  }
};

const balanceCommand = defineCommand({
  args: creditsArgs,
  meta: {
    description: "Show your credit balance and recent usage (the default).",
    name: "balance",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, creditsArgs);
    requireLogin();

    const client = createClient();

    try {
      const { balanceMicro, entries } = await client.credits.me();

      const payload = {
        balance_micro: balanceMicro,
        balance_usd: balanceMicro / MICRO_PER_USD,
        entries: entries.map((e) => ({
          created_at: e.createdAt.toISOString(),
          delta_micro: e.deltaMicro,
          endpoint_id: e.endpointId,
          id: e.id,
          kind: e.kind,
          note: e.note,
          request_id: e.requestId,
        })),
      };
      if (writeStructured(payload, args)) {
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
        endpoint: e.endpointId ?? "",
        label: kindLabel(e.kind, e.deltaMicro),
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
    } catch (error) {
      // Only an auth error means "log in"; surface network/server failures as
      // themselves so they aren't mistaken for a bad credential.
      const code = authErrorCode(error);
      if (code === "UNAUTHORIZED" || code === "FORBIDDEN") {
        consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
      } else {
        consola.error(
          `Failed to fetch credits: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(1);
    }
  },
});

const redeemArgs = {
  ...outputArgs,
  code: { description: "The credit code to redeem.", required: true, type: "positional" },
} as const;

const redeemCommand = defineCommand({
  args: redeemArgs,
  meta: {
    description: "Redeem a credit code for generation credit (once per account per code).",
    name: "redeem",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, redeemArgs);
    requireLogin();

    try {
      const { balanceMicro, creditedMicro } = await createClient().credits.redeem({
        code: args.code,
      });
      const payload = {
        balance_micro: balanceMicro,
        balance_usd: balanceMicro / MICRO_PER_USD,
        credited_micro: creditedMicro,
        credited_usd: creditedMicro / MICRO_PER_USD,
      };
      if (!writeStructured(payload, args)) {
        consola.success(`Added ${formatUsd(creditedMicro)}. Balance: ${formatUsd(balanceMicro)}`);
      }
    } catch (error) {
      // FORBIDDEN here is the code's verdict (unknown, expired, used up), not
      // a credential problem; the server's message says which case applies.
      if (authErrorCode(error) === "UNAUTHORIZED") {
        consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
      } else {
        consola.error(
          `Could not redeem ${args.code}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(1);
    }
  },
});

const buyArgs = {
  ...outputArgs,
  amount: {
    description: `Whole US dollars of credit to buy (${MIN_PURCHASE_USD}–${MAX_PURCHASE_USD}).`,
    required: true,
    type: "positional",
  },
} as const;

const buyCommand = defineCommand({
  args: buyArgs,
  meta: {
    description:
      "Start a card payment for credits and print the checkout URL. A person opens it to pay; the credit lands once the payment clears.",
    name: "buy",
  },
  run: async ({ args, rawArgs }) => {
    assertKnownFlags(rawArgs, buyArgs);
    const amountUsd = Number(args.amount.replace(/^\$/u, ""));
    // Mirrors the server's checkout bounds so an agent gets the rule, not
    // a bare "Input validation failed".
    if (
      !Number.isInteger(amountUsd) ||
      amountUsd < MIN_PURCHASE_USD ||
      amountUsd > MAX_PURCHASE_USD
    ) {
      consola.error(
        `Amount must be whole dollars from ${MIN_PURCHASE_USD} to ${MAX_PURCHASE_USD}, e.g. \`vg credits buy 25\`; got "${args.amount}".`,
      );
      process.exit(2);
    }
    requireLogin();

    try {
      const { url } = await createClient().credits.checkout({ amountUsd });
      if (writeStructured({ amount_usd: amountUsd, url }, args)) {
        return;
      }
      consola.log(`Open this link to pay $${amountUsd} by card:\n\n  ${url}\n`);
      consola.log("Credits are added once the payment clears — check with `vg credits`.");
    } catch (error) {
      if (authErrorCode(error) === "UNAUTHORIZED") {
        consola.warn("Not authenticated. Run `vg login`, or check your VG_TOKEN / API key.");
      } else {
        consola.error(
          `Could not start checkout: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      process.exit(1);
    }
  },
});

export const creditsCommand = defineCommand({
  // Declared so citty skips `--field <value>` when looking for a subcommand.
  args: outputArgs,
  default: "balance",
  meta: {
    description: "Show your credit balance, redeem a code, or buy credits.",
    name: "credits",
  },
  subCommands: {
    balance: balanceCommand,
    buy: buyCommand,
    redeem: redeemCommand,
  },
});
