import type { inviteCode } from "@repo/db/drizzle-schema";
import { INVITE_CODE_LENGTH, MAX_INVITE_BATCH } from "@repo/contract/auth/auth-limits";

import { generateShortCode } from "./utils";

export type NewInviteCode = typeof inviteCode.$inferInsert;

// Custom codes must match what the settings page can redeem: exactly
// INVITE_CODE_LENGTH alphanumeric chars (its fixed-length OTP field), else the
// code would be unredeemable through the web UI or a `?code=` link.
const CUSTOM_CODE_RE = new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`, "u");

export interface BuildInviteRowsOptions {
  /** Number of random codes to mint. Ignored when `code` is set. */
  count?: number;
  /** Credit one redemption grants, in micro-USD. */
  creditMicro: number;
  /** Uses per code before exhaustion; `null` = unlimited. Defaults to 1. */
  maxUses?: number | null;
  expiresAt?: Date | null;
  note?: string | null;
  /** Who minted the codes; `null` when there's no acting session (e.g. scripts). */
  createdBy?: string | null;
  /** A single explicit code (normalized like signup). Overrides `count`. */
  code?: string | null;
}

/**
 * Normalize a custom code the same way redemption does (upper-case, trimmed)
 * and reject anything that wouldn't be redeemable through the settings page.
 * Throws on an invalid code so callers can surface the reason.
 */
const normalizeCustomCode = (raw: string): string => {
  const code = raw.trim().toUpperCase();
  if (!CUSTOM_CODE_RE.test(code)) {
    throw new Error(
      `Custom credit code must be ${INVITE_CODE_LENGTH} alphanumeric characters ` +
        `(the redeem form only accepts ${INVITE_CODE_LENGTH}-character codes); got "${code}".`,
    );
  }
  return code;
};

/** Validate the requested batch size, defaulting to 1. Throws on bad input. */
const resolveCount = (count = 1): number => {
  const n = count;
  if (!Number.isInteger(n) || n < 1 || n > MAX_INVITE_BATCH) {
    throw new Error(`count must be an integer between 1 and ${MAX_INVITE_BATCH}; got ${n}.`);
  }
  return n;
};

/** `n` distinct random codes — regenerates on the vanishingly rare in-batch repeat. */
const uniqueCodes = (n: number): string[] => {
  const set = new Set<string>();
  while (set.size < n) {
    set.add(generateShortCode());
  }
  return [...set];
};

/**
 * Build credit-code rows ready to INSERT. Single source of truth for code
 * generation, in-batch dedup (the `code` column is UNIQUE, so a repeat would
 * fail the whole INSERT), custom-code normalization, and column defaults —
 * shared by the admin `createInvites` mutation and the `create-invite` script
 * so the two can't drift. Columns not set here (`createdAt`, `usedCount`,
 * `revokedAt`) fall back to their schema defaults.
 */
export const buildInviteRows = (opts: BuildInviteRowsOptions): NewInviteCode[] => {
  const codes = opts.code
    ? [normalizeCustomCode(opts.code)]
    : uniqueCodes(resolveCount(opts.count));
  return codes.map((code) => ({
    code,
    createdBy: opts.createdBy ?? null,
    creditMicro: opts.creditMicro,
    expiresAt: opts.expiresAt ?? null,
    id: crypto.randomUUID(),
    maxUses: opts.maxUses === undefined ? 1 : opts.maxUses,
    note: opts.note ?? null,
  }));
};
