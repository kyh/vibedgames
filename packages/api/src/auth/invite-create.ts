import type { inviteCode } from "@repo/db/drizzle-schema";

import { normalizeInviteCode } from "./invite-claim";
import { generateShortCode, INVITE_CODE_LENGTH } from "./utils";

export type NewInviteCode = typeof inviteCode.$inferInsert;

/** Most codes mintable in a single batch — guards against pathological inputs. */
export const MAX_INVITE_BATCH = 100;

// Custom codes must match what signup can redeem: exactly INVITE_CODE_LENGTH
// alphanumeric chars (the web auth form's fixed-length OTP field), else the
// code would be unredeemable through the registration UI or a `?invite=` link.
const CUSTOM_CODE_RE = new RegExp(`^[A-Z0-9]{${INVITE_CODE_LENGTH}}$`);

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

/**
 * Normalize a custom code the same way signup does (upper-case, trimmed) and
 * reject anything that wouldn't be redeemable through the registration UI.
 * Throws on an invalid code so callers can surface the reason.
 */
const normalizeCustomCode = (raw: string): string => {
  const code = normalizeInviteCode(raw);
  if (!CUSTOM_CODE_RE.test(code)) {
    throw new Error(
      `Custom invite code must be ${INVITE_CODE_LENGTH} alphanumeric characters ` +
        `(signup only accepts ${INVITE_CODE_LENGTH}-character codes); got "${code}".`,
    );
  }
  return code;
};

/** Validate the requested batch size, defaulting to 1. Throws on bad input. */
const resolveCount = (count: number | undefined): number => {
  const n = count ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_INVITE_BATCH) {
    throw new Error(`count must be an integer between 1 and ${MAX_INVITE_BATCH}; got ${n}.`);
  }
  return n;
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
  const codes = opts.code
    ? [normalizeCustomCode(opts.code)]
    : uniqueCodes(resolveCount(opts.count));
  return codes.map((code) => ({
    id: crypto.randomUUID(),
    code,
    createdBy: opts.createdBy ?? null,
    maxUses: opts.maxUses === undefined ? 1 : opts.maxUses,
    expiresAt: opts.expiresAt ?? null,
    note: opts.note ?? null,
  }));
};
