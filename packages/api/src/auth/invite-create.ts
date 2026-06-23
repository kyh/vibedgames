import type { inviteCode } from "@repo/db/drizzle-schema";

import { normalizeInviteCode } from "./invite-claim";
import { generateShortCode } from "./utils";

export type NewInviteCode = typeof inviteCode.$inferInsert;

export type BuildInviteRowsOptions = {
  /** Number of random codes to mint. Ignored when `code` is set. */
  count?: number;
  /** Uses per code before exhaustion; `null` = unlimited. Defaults to 1. */
  maxUses?: number | null;
  expiresAt?: Date | null;
  note?: string | null;
  /** Who minted the codes; `null` when there's no acting session (e.g. scripts). */
  createdBy?: string | null;
  /** A single explicit code (normalized like signup). Overrides `count`. */
  code?: string | null;
};

/** `n` distinct random codes — regenerates on the vanishingly rare in-batch repeat. */
const uniqueCodes = (n: number): string[] => {
  const set = new Set<string>();
  while (set.size < n) set.add(generateShortCode());
  return [...set];
};

/**
 * Build invite-code rows ready to INSERT. Single source of truth for code
 * generation, in-batch dedup (the `code` column is UNIQUE, so a repeat would
 * fail the whole INSERT), custom-code normalization, and column defaults —
 * shared by the admin `createInvites` mutation and the `create-invite` script
 * so the two can't drift. Columns not set here (`createdAt`, `usedCount`,
 * `revokedAt`) fall back to their schema defaults.
 */
export const buildInviteRows = (opts: BuildInviteRowsOptions = {}): NewInviteCode[] => {
  const codes = opts.code ? [normalizeInviteCode(opts.code)] : uniqueCodes(opts.count ?? 1);
  return codes.map((code) => ({
    id: crypto.randomUUID(),
    code,
    createdBy: opts.createdBy ?? null,
    maxUses: opts.maxUses === undefined ? 1 : opts.maxUses,
    expiresAt: opts.expiresAt ?? null,
    note: opts.note ?? null,
  }));
};
